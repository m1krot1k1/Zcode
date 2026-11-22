import type { UserInfo } from "@zcode/shared";
import { withProviderProfileSchema } from "../oauthProfileSchema.js";
import { logout } from "./logout.js";
import { log } from "./logging.js";
import { runWithAdapterError } from "./runtime.js";
import { toUserInfo } from "./support.js";
import type { OAuthServiceRuntime } from "./types.js";

export async function restoreSession(runtime: OAuthServiceRuntime): Promise<UserInfo | null> {
  const activeProvider = await runtime.repo.getActiveProvider();
  if (!activeProvider) {
    log("restoreSession skipped: no active provider");
    return null;
  }

  log("restoreSession started:", activeProvider);

  const adapter = runtime.adapters.get(activeProvider);
  if (!adapter || !adapter.meta.enabled) {
    log("restoreSession aborted: provider unavailable, clearing active provider:", activeProvider);
    await runtime.repo.setActiveProvider(null);
    return null;
  }

  let tokenSet = await runtime.repo.loadActiveTokenSet();
  if (!tokenSet && adapter.loadLegacyTokenSet) {
    log("restoreSession fallback: trying provider legacy token set:", activeProvider);
    tokenSet = await adapter.loadLegacyTokenSet((key) => runtime.credentialService.load(key));

    // 多 provider 改造后，旧版 BigModel 仍可能只保留 legacy token key。
    // 这里在 provider 兼容读取成功后回填命名空间 key，避免每次启动都重复走 legacy 分支。
    if (tokenSet) {
      log("restoreSession fallback hit: migrating legacy token set:", activeProvider);
      await runtime.repo.saveActiveTokenSet(tokenSet);
      await runtime.repo.saveTokenSet(activeProvider, tokenSet);
    }
  }

  if (!tokenSet || !adapter.fetchUserInfo) {
    log(
      "restoreSession failed: missing token or user-info capability, logging out:",
      activeProvider,
    );
    await logout(runtime);
    return null;
  }

  try {
    log("restoreSession validating token with provider userinfo endpoint:", activeProvider);
    const profile = await runWithAdapterError(adapter, () =>
      adapter.fetchUserInfo!(tokenSet, {
        providerId: activeProvider,
        state: "",
        redirectUri: adapter.redirectUri,
        now: runtime.now,
      }),
    );

    await runtime.repo.saveActiveUserProfile(withProviderProfileSchema(activeProvider, profile));
    await runtime.repo.setActiveProvider(activeProvider);
    log("restoreSession validated:", activeProvider, profile.id);
    return toUserInfo(profile);
  } catch (error) {
    const normalized = adapter.normalizeError(error);

    // 启动恢复只看本地凭据会把“过期 token”误判成已登录。
    // 当远端明确返回未授权（401/403）时，立即按退出流程清理本地登录态。
    if (isUnauthorizedError(normalized)) {
      log("restoreSession unauthorized, logging out:", activeProvider, normalized.message);
      await logout(runtime);
      return null;
    }

    log("restoreSession validation error:", activeProvider, normalized.message);

    throw normalized;
  }
}

function isUnauthorizedError(error: Error): boolean {
  const lowerMessage = error.message.toLowerCase();
  return (
    /\b401\b|\b403\b/.test(lowerMessage) ||
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("forbidden")
  );
}
