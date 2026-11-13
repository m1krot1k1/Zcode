import { randomBytes } from "node:crypto";
import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthCallbackResult,
  type OAuthProviderId,
  type OAuthStartResponse,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
} from "../providers/configUtils.js";
import { serviceLog } from "./logging.js";
import { clearPendingState, getAdapter, getEnabledAdapter, runSessionMutation } from "./runtime.js";
import { runPendingSessionCompletion } from "./sessionPersistence.js";
import { isUnknownRecord, readTrimmedString } from "./support.js";
import { OAUTH_TIMEOUT_MS, type OAuthFlowEnvelope, type OAuthServiceRuntime } from "./types.js";

export async function startOAuthWithPolling(
  runtime: OAuthServiceRuntime,
  provider: OAuthProviderId,
): Promise<OAuthStartResponse> {
  if (provider !== ZAI_PROVIDER_ID && provider !== BIGMODEL_PROVIDER_ID) {
    return startOAuthInternal(runtime, provider);
  }

  const adapter = getEnabledAdapter(runtime, provider);
  if (!runtime.apiClient) {
    throw new Error("ApiClient 注入缺失：OAuth polling 必须通过 Providers 传入 apiClient");
  }
  // 两个 init 并发时，先发但后返回的旧响应会覆盖较新的 pending flow。
  // generation 让最后一次用户操作拥有 flow，旧响应只结束自己的调用方。
  const startGeneration = ++runtime.oauthFlowStartGeneration;
  runtime.oauthFlowStartProvider = provider;
  clearPendingState(runtime);
  const pollToken = randomBytes(32).toString("hex");
  const initUrl = buildZCodeApiUrlFromEnv(runtime.env, "/api/v1/oauth/cli/init");
  const envelope = await readApiJson<OAuthFlowEnvelope>(runtime.apiClient, initUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pollToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ provider }),
  });
  if (runtime.oauthFlowStartGeneration !== startGeneration) {
    throw new Error("OAuth flow 已被新的登录请求替换");
  }
  runtime.oauthFlowStartProvider = null;
  const data = envelope.data;
  if (
    envelope.code !== 0 ||
    !isUnknownRecord(data) ||
    !readTrimmedString(data.flow_id) ||
    !readTrimmedString(data.authorize_url) ||
    !Number.isFinite(data.expires_at) ||
    !Number.isFinite(data.poll_interval_sec)
  ) {
    throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 初始化响应无效");
  }

  const flowId = readTrimmedString(data.flow_id)!;
  const authorizeUrlString = readTrimmedString(data.authorize_url)!;
  const expiresAt = (data.expires_at as number) * 1_000;
  const pollIntervalMs = (data.poll_interval_sec as number) * 1_000;
  let authorizeUrl: URL;
  try {
    authorizeUrl = new URL(authorizeUrlString);
  } catch {
    throw new Error("OAuth flow 初始化响应无效");
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    // BigModel CLI callback 的失败页会截断原有 Desktop deep link 回调体验。
    // flow 仍由 Host 轮询，但浏览器回调恢复到官网中转页，再透传到 zcode://oauth/callback。
    authorizeUrl.searchParams.set("redirect", buildDesktopOAuthRedirectUriFromEnv(runtime.env));
  } else if (provider === ZAI_PROVIDER_ID) {
    // Z.AI 后端 init 仍可能返回 provider-specific callback，导致回跳行为与 BigModel 不一致。
    // Desktop 统一改写为官网中转页，再由官网透传到 zcode://oauth/callback。
    authorizeUrl.searchParams.set("redirect_uri", buildDesktopOAuthRedirectUriFromEnv(runtime.env));
  }
  const state = authorizeUrl.searchParams.get("state")?.trim();
  const remainingLifetimeMs = expiresAt - runtime.now();
  if (
    authorizeUrl.protocol !== "https:" ||
    !state ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(pollIntervalMs) ||
    remainingLifetimeMs <= 0 ||
    pollIntervalMs < 1_000 ||
    pollIntervalMs >= remainingLifetimeMs
  ) {
    throw new Error("OAuth flow 初始化响应无效");
  }

  const timeoutMs = Math.min(OAUTH_TIMEOUT_MS, remainingLifetimeMs);
  const timeout = setTimeout(() => {
    const pending = runtime.pendingState;
    // polling flow 超时必须立即收口，不能等待下一次 UI 轮询；同时校验 flowId，避免旧定时器清掉新 flow。
    if (pending?.state === state && pending.polling?.flowId === flowId) {
      clearPendingState(runtime);
    }
  }, timeoutMs);
  runtime.pendingState = {
    state,
    provider: adapter.providerId,
    timeout,
    phase: "awaiting-attribution-or-code",
    polling: {
      expiresAt,
      flowId,
      nextPollAt: runtime.now(),
      pollIntervalMs,
      pollToken,
      pollUrl: buildZCodeApiUrlFromEnv(
        runtime.env,
        `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
      ),
    },
  };

  serviceLog.info("OAuth polling flow started", {
    expiresInMs: timeoutMs,
    pollIntervalMs,
    provider,
  });
  return { provider, authorizeUrl: authorizeUrl.toString(), state };
}

export async function pollPendingOAuth(
  runtime: OAuthServiceRuntime,
): Promise<OAuthCallbackResult | null> {
  const apiClient = runtime.apiClient;
  if (!apiClient) {
    return null;
  }
  const pending = runtime.pendingState;
  const polling = pending?.polling;
  if (!pending || !polling) {
    return null;
  }
  if (runtime.now() >= polling.expiresAt) {
    clearPendingState(runtime);
    throw new Error("OAuth flow 已过期");
  }
  if (runtime.now() < polling.nextPollAt) {
    return null;
  }
  polling.nextPollAt = runtime.now() + polling.pollIntervalMs;

  let envelope: OAuthFlowEnvelope;
  try {
    envelope = await readApiJson<OAuthFlowEnvelope>(apiClient, polling.pollUrl, {
      headers: { Authorization: `Bearer ${polling.pollToken}` },
    });
  } catch (error) {
    if (runtime.pendingState !== pending) return null;
    if (
      error instanceof ApiError &&
      error.status &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    ) {
      try {
        return await runPendingSessionCompletion(runtime, pending, async () => {
          throw error;
        });
      } catch (terminalError) {
        if (runtime.pendingState === pending) clearPendingState(runtime);
        throw terminalError;
      }
    }
    // 轮询是 deep link 丢失时的可靠路径，单次断网或 5xx 不能立即取消 flow。
    // 保留服务端下发的查询间隔，下一轮继续尝试；高频状态只记 debug，避免生产日志膨胀。
    serviceLog.debug("OAuth polling request will retry", {
      error: error instanceof Error ? error.message : String(error),
      provider: pending.provider,
    });
    return null;
  }
  if (runtime.pendingState !== pending) {
    return null;
  }
  if (
    envelope.code === 0 &&
    isUnknownRecord(envelope.data) &&
    readTrimmedString(envelope.data.status) === "pending"
  ) {
    return null;
  }
  try {
    const result = await runPendingSessionCompletion(runtime, pending, async () => {
      const pollData = envelope.data;
      if (envelope.code !== 0 || !isUnknownRecord(pollData)) {
        throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 查询响应无效");
      }
      const status = readTrimmedString(pollData.status);
      if (status === "failed") {
        throw new Error("OAuth flow 授权失败");
      }
      if (status !== "ready") {
        throw new Error("OAuth flow 查询响应无效");
      }

      const ready = pollData;
      const user = isUnknownRecord(ready.user) ? ready.user : null;
      const zai = isUnknownRecord(ready.zai) ? ready.zai : null;
      const bigmodel = isUnknownRecord(ready.bigmodel) ? ready.bigmodel : null;
      const providerAccessToken =
        pending.provider === ZAI_PROVIDER_ID
          ? readTrimmedString(zai?.access_token)
          : readTrimmedString(bigmodel?.access_token) || readTrimmedString(bigmodel?.accessToken);
      const zcodeJwtToken = readTrimmedString(ready.token);
      const userId = readTrimmedString(user?.user_id);
      if (!zcodeJwtToken || !providerAccessToken || !userId) {
        throw new Error("OAuth flow 查询响应无效");
      }
      const username = readTrimmedString(user?.name) || readTrimmedString(user?.email) || userId;
      const avatarUrl = readTrimmedString(user?.avatar);
      const profile: OAuthUserProfile = {
        id: userId,
        username,
        displayName: username,
        ...(avatarUrl ? { avatarUrl } : {}),
        rawProfile: user,
      };
      const adapter = getAdapter(runtime, pending.provider);
      const refreshToken =
        pending.provider === BIGMODEL_PROVIDER_ID
          ? readTrimmedString(bigmodel?.refresh_token) || readTrimmedString(bigmodel?.refreshToken)
          : undefined;
      const tokenSet = adapter.normalizePolledTokenSet
        ? await adapter.normalizePolledTokenSet({
            accessToken: providerAccessToken,
            zcodeJwtToken,
            ...(refreshToken ? { refreshToken } : {}),
          })
        : {
            accessToken: providerAccessToken,
            zcodeJwtToken,
            ...(refreshToken ? { refreshToken } : {}),
          };
      return { tokenSet, profile };
    });
    if (result?.kind === "session") {
      serviceLog.info("OAuth polling flow completed", { provider: pending.provider });
    }
    return result;
  } catch (error) {
    if (runtime.pendingState === pending) clearPendingState(runtime);
    throw error;
  }
}

export async function startOAuthInternal(
  runtime: OAuthServiceRuntime,
  provider: OAuthProviderId,
): Promise<OAuthStartResponse> {
  const adapter = getEnabledAdapter(runtime, provider);

  // 同窗口快速连续点击不同 provider 时，旧 state 如果不先取消，
  // 两条并发流程会共享同一回调通道，导致后回调抢占前回调并触发 state 错配。
  await runSessionMutation(runtime, async () => {
    runtime.oauthFlowStartGeneration += 1;
    runtime.oauthFlowStartProvider = null;
    clearPendingState(runtime);
  });

  const state = randomBytes(32).toString("hex");
  const timeout = setTimeout(() => {
    if (runtime.pendingState?.state === state) {
      runtime.pendingState = null;
    }
  }, OAUTH_TIMEOUT_MS);

  runtime.pendingState = {
    state,
    provider: adapter.providerId,
    timeout,
    phase: "awaiting-attribution-or-code",
  };

  const authorizeUrl = adapter.buildAuthorizeUrl({
    providerId: adapter.providerId,
    state,
    redirectUri: adapter.redirectUri,
    now: runtime.now,
  });

  return {
    provider: adapter.providerId,
    authorizeUrl,
    state,
  };
}

export async function cancelPending(
  runtime: OAuthServiceRuntime,
  provider?: OAuthProviderId,
): Promise<void> {
  if (!runtime.pendingState) {
    if (provider && runtime.oauthFlowStartProvider && runtime.oauthFlowStartProvider !== provider)
      return;
    runtime.oauthFlowStartGeneration += 1;
    runtime.oauthFlowStartProvider = null;
    return;
  }
  if (provider && runtime.pendingState.provider !== provider) return;
  runtime.oauthFlowStartGeneration += 1;
  runtime.oauthFlowStartProvider = null;
  clearPendingState(runtime);
}
