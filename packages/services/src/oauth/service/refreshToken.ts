import type { OAuthProviderId } from "@zcode/shared";
import {
  getEnabledAdapter,
  resolveProvider,
  runSessionMutation,
  runWithAdapterError,
} from "./runtime.js";
import type { OAuthServiceRuntime } from "./types.js";

export async function refreshToken(
  runtime: OAuthServiceRuntime,
  provider?: OAuthProviderId,
): Promise<void> {
  const generation = runtime.oauthSessionGeneration;
  const targetProvider = await resolveProvider(runtime, provider);
  if (!targetProvider) {
    throw new Error("当前没有可用的登录 provider");
  }

  const adapter = getEnabledAdapter(runtime, targetProvider);
  if (!adapter.refreshToken) {
    throw new Error(
      `${adapter.meta.displayName} OAuth 暂未提供 refresh token 交换接口，请重新登录`,
    );
  }

  const activeProvider = await runtime.repo.getActiveProvider();
  if (targetProvider !== activeProvider) {
    throw new Error("只能刷新当前 App 登录 provider，请重新登录");
  }

  const tokenSet = await runtime.repo.loadActiveTokenSet();
  if (!tokenSet?.refreshToken) {
    throw new Error("当前账号缺少 refresh_token，请重新登录");
  }

  const refreshed = await runWithAdapterError(adapter, () =>
    adapter.refreshToken!(tokenSet, {
      providerId: targetProvider,
      state: "",
      redirectUri: adapter.redirectUri,
      now: runtime.now,
    }),
  );

  await runSessionMutation(runtime, async () => {
    // 刷新写回若绕过会话队列，会插入 401 的核对/清理窗口，或在退出后复活凭据。
    if (
      runtime.oauthSessionGeneration !== generation ||
      (await runtime.repo.getActiveProvider()) !== targetProvider ||
      (await runtime.credentialService.load(`oauth:${targetProvider}:access_token`)) !==
        tokenSet.accessToken
    )
      return;
    await runtime.repo.saveActiveTokenSet(refreshed);
  });
}
