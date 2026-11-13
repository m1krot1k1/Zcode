import type { OAuthProviderId } from "@zcode/shared";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { serviceLog } from "./logging.js";
import { cancelPending } from "./pendingFlow.js";
import { notifyProviderLogout, notifyProvidersLogout, runSessionMutation } from "./runtime.js";
import type { OAuthServiceRuntime } from "./types.js";

/** Host 本地 401 提交入口，不扩展 IOAuthService 的跨端契约。 */
export function logoutIfCurrentCredentialRequest(
  runtime: OAuthServiceRuntime,
  input: string | URL,
  headers: Headers,
): Promise<boolean> {
  return logoutActiveSession(runtime, () =>
    isCurrentOAuthCredentialRequest({
      input,
      headers,
      credentialService: runtime.credentialService,
      env: runtime.env,
    }),
  );
}

export async function logoutActiveSession(
  runtime: OAuthServiceRuntime,
  isCurrent?: () => Promise<boolean>,
): Promise<boolean> {
  const result = await runSessionMutation(runtime, async () => {
    // 异步分类的 true 不是清理授权；凭据复核与清理必须和登录写入共用队列。
    if (isCurrent && !(await isCurrent())) return null;
    const activeProvider = await runtime.repo.getActiveProvider();
    // 合并边界：清理前保留原账号身份，不能退回仅按平台清理或在退出后再猜身份。
    const accountIdentity = activeProvider
      ? ((await runtime.repo.loadUserProfile(activeProvider))?.id ?? null)
      : null;
    runtime.oauthSessionGeneration += 1;
    await runtime.repo.clearActiveSession();
    // 登出已生效：后续 provider/设置清理即使失败，也必须先撤销已认证的远控连接。
    runtime.sessionChanges.fire("signed-out");
    return { activeProvider, accountIdentity };
  });
  if (!result) return false;
  if (result.activeProvider) {
    await cancelPending(runtime, result.activeProvider);
    try {
      await notifyProviderLogout(runtime, result.activeProvider, result.accountIdentity);
    } catch (error) {
      if (!isCurrent) throw error;
      // 凭据已经清理，派生配置失败不能吞掉原有过期提示；手动退出仍保留原错误语义。
      serviceLog.warn("Unauthorized session provider cleanup failed", { error });
    }
  }
  return true;
}

export async function logout(
  runtime: OAuthServiceRuntime,
  provider?: OAuthProviderId,
): Promise<void> {
  if (!provider) {
    await logoutActiveSession(runtime);
    return;
  }

  const loggedOutIdentity = await runSessionMutation(runtime, async () => {
    const activeProvider = await runtime.repo.getActiveProvider();
    if (provider !== activeProvider) {
      return undefined;
    }
    const accountIdentity = (await runtime.repo.loadUserProfile(provider))?.id ?? null;
    runtime.oauthSessionGeneration += 1;
    // ZAI/BigModel provider 的 Unlink 已收敛为 App logout。
    // 只有当前 active provider 才代表登录事实，避免旧 unlink 路径误删非当前 provider token。
    await runtime.repo.clearActiveSession();
    runtime.sessionChanges.fire("signed-out");
    return accountIdentity;
  });
  if (loggedOutIdentity !== undefined) {
    await notifyProviderLogout(runtime, provider, loggedOutIdentity);
  }
  await cancelPending(runtime, provider);
}

export async function logoutAll(runtime: OAuthServiceRuntime): Promise<void> {
  const providers = [...runtime.adapters.keys()];
  const accountIdentities = await runSessionMutation(runtime, async () => {
    const identities = new Map<OAuthProviderId, string | null>();
    for (const provider of providers) {
      identities.set(provider, (await runtime.repo.loadUserProfile(provider))?.id ?? null);
    }
    runtime.oauthSessionGeneration += 1;
    await runtime.repo.clearAll(providers);
    runtime.sessionChanges.fire("signed-out");
    return identities;
  });
  await cancelPending(runtime);
  await notifyProvidersLogout(runtime, providers, accountIdentities);
}
