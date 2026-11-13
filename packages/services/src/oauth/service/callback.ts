import type { OAuthCallbackResult, OAuthUserProfile } from "@zcode/shared";
import { hasOAuthAuthorizationCode, parseOAuthLoginAttribution } from "../callbackAttribution.js";
import {
  clearPendingState,
  getAdapter,
  runSessionMutation,
  runWithAdapterError,
} from "./runtime.js";
import { runPendingSessionCompletion } from "./sessionPersistence.js";
import type { OAuthServiceRuntime } from "./types.js";

export async function handleCallback(
  runtime: OAuthServiceRuntime,
  url: string,
): Promise<OAuthCallbackResult | null> {
  const pending = runtime.pendingState;
  if (!pending) {
    const callbackState = new URL(url).searchParams.get("state")?.trim();
    const completed = runtime.recentlyCompletedPollingState;
    if (
      callbackState &&
      completed?.state === callbackState &&
      completed.generation === runtime.oauthFlowStartGeneration &&
      runtime.now() < completed.expiresAt
    ) {
      const attribution = parseOAuthLoginAttribution(new URL(url).searchParams);
      await runSessionMutation(runtime, async () => {
        // 修复原因：轮询先成功时仍需保存浏览器归因，不能把登录去重当作丢弃整条回调。
        if (
          !runtime.pendingState &&
          runtime.recentlyCompletedPollingState === completed &&
          completed.generation === runtime.oauthFlowStartGeneration &&
          attribution
        ) {
          await runtime.repo.saveLoginAttribution(attribution);
        }
      });
      return { kind: "duplicate", provider: completed.provider };
    }
    throw new Error("OAuth state 不匹配或已过期");
  }

  const parsedUrl = new URL(url);
  const state = parsedUrl.searchParams.get("state");
  if (!state || state !== pending.state) {
    throw new Error("OAuth state 不匹配或已过期");
  }
  if (pending.polling && runtime.now() >= pending.polling.expiresAt) {
    clearPendingState(runtime);
    throw new Error("OAuth flow 已过期");
  }

  const attribution = parseOAuthLoginAttribution(parsedUrl.searchParams);
  if (attribution && !hasOAuthAuthorizationCode(parsedUrl.searchParams)) {
    if (pending.phase === "awaiting-code-after-attribution") {
      throw new Error("OAuth 归因回调已处理");
    }

    // 修复原因：纯归因回调是最终授权码前的中转步骤，不能清掉仍需继续登录的 state；
    // 但若不显式推进 phase，同一 state 可重复写入归因并隐式复用 pending 生命周期。
    pending.phase = "awaiting-code-after-attribution";
    try {
      await runtime.repo.saveLoginAttribution(attribution);
    } catch (error) {
      if (runtime.pendingState === pending) {
        pending.phase = "awaiting-attribution-or-code";
      }
      throw error;
    }
    return {
      kind: "attribution",
      provider: pending.provider,
      attribution,
    };
  }

  const adapter = getAdapter(runtime, pending.provider);
  const fallbackProfile: OAuthUserProfile = {
    id: "unknown",
    username: "user",
    displayName: "User",
  };

  return runPendingSessionCompletion(
    runtime,
    pending,
    async () => {
      const callback = adapter.parseCallbackParams(url);
      const context = {
        providerId: adapter.providerId,
        state: callback.state,
        redirectUri: adapter.redirectUri,
        now: runtime.now,
      };
      const tokenSet = await runWithAdapterError(adapter, () =>
        adapter.exchangeToken(callback, context),
      );
      let profile = fallbackProfile;
      if (adapter.fetchUserInfo) {
        try {
          profile = await runWithAdapterError(adapter, () =>
            adapter.fetchUserInfo!(tokenSet, context),
          );
        } catch {
          // 获取用户信息失败不阻塞登录
        }
      }
      return { tokenSet, profile };
    },
    attribution ? () => runtime.repo.saveLoginAttribution(attribution) : undefined,
  );
}
