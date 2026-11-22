import { Emitter } from "@zcode/rpc";
import type { OAuthProviderId, OAuthSessionState } from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import { createOAuthProviderAdapters, type OAuthProviderAdapter } from "../providers/index.js";
import { OAuthCredentialRepo } from "../repo/oauthCredentialRepo.js";
import { createOAuthRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthServiceDependencies, OAuthServiceRuntime } from "./types.js";

export function createOAuthServiceRuntime(
  credentialService: ICredentialService,
  dependencies: OAuthServiceDependencies = {},
): OAuthServiceRuntime {
  const adapters =
    dependencies.adapters ??
    createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      apiClient: dependencies.apiClient,
    });
  const sessionChanges = new Emitter<OAuthSessionState>();
  let runtime: OAuthServiceRuntime;
  const repo = new OAuthCredentialRepo(credentialService, {
    providerIds: adapters.map((adapter) => adapter.providerId),
    onCorruptOAuthSessionCleared: async (providers) => {
      sessionChanges.fire("signed-out");
      // 本地 OAuth 凭据解密失败后等价于强制 logout。
      // repo 只能清 OAuth 命名空间，派生的 Start/Coding Plan provider key 必须回到 service 层清理。
      await notifyProvidersLogout(runtime, providers);
    },
  });
  runtime = {
    credentialService,
    repo,
    adapters: new Map<OAuthProviderId, OAuthProviderAdapter>(
      adapters.map((adapter) => [adapter.providerId, adapter]),
    ),
    now: dependencies.now ?? Date.now,
    onProviderLogout: dependencies.onProviderLogout,
    apiClient: dependencies.apiClient,
    env: dependencies.env ?? process.env,
    sessionChanges,
    pendingState: null,
    oauthFlowStartGeneration: 0,
    oauthFlowStartProvider: null,
    oauthSessionGeneration: 0,
    sessionMutationQueue: Promise.resolve(),
    recentlyCompletedPollingState: null,
  };
  return runtime;
}

export function runSessionMutation<T>(
  runtime: OAuthServiceRuntime,
  run: () => Promise<T>,
): Promise<T> {
  // 后台 profile 迁移、logout、provider 切换都会改 OAuth 凭据；
  // 必须串行化，避免旧迁移在退出或切换清理之后重新写回 user_info。
  const next = runtime.sessionMutationQueue.catch(() => undefined).then(run);
  runtime.sessionMutationQueue = next.catch(() => undefined);
  return next;
}

export function clearPendingState(runtime: OAuthServiceRuntime): void {
  if (!runtime.pendingState) {
    return;
  }

  clearTimeout(runtime.pendingState.timeout);
  runtime.pendingState = null;
}

export function getAdapter(
  runtime: OAuthServiceRuntime,
  provider: OAuthProviderId,
): OAuthProviderAdapter {
  const adapter = runtime.adapters.get(provider);
  if (!adapter) {
    throw new Error(`不支持的 OAuth provider: ${provider}`);
  }

  return adapter;
}

export function getEnabledAdapter(
  runtime: OAuthServiceRuntime,
  provider: OAuthProviderId,
): OAuthProviderAdapter {
  const adapter = getAdapter(runtime, provider);
  if (!adapter.meta.enabled) {
    throw new Error(`OAuth provider 未启用: ${provider}`);
  }

  return adapter;
}

export async function resolveProvider(
  runtime: OAuthServiceRuntime,
  provider?: OAuthProviderId,
): Promise<OAuthProviderId | null> {
  if (provider) {
    return provider;
  }

  return runtime.repo.getActiveProvider();
}

export async function runWithAdapterError<T>(
  adapter: OAuthProviderAdapter,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw adapter.normalizeError(error);
  }
}

export async function notifyProviderLogout(
  runtime: OAuthServiceRuntime,
  provider: OAuthProviderId,
  accountIdentity?: string | null,
): Promise<void> {
  if (!runtime.onProviderLogout) {
    return;
  }

  await runtime.onProviderLogout(provider, accountIdentity);
}

export async function notifyProvidersLogout(
  runtime: OAuthServiceRuntime,
  providers: readonly OAuthProviderId[],
  accountIdentities: ReadonlyMap<OAuthProviderId, string | null> = new Map(),
): Promise<void> {
  await Promise.all(
    providers.map((provider) =>
      notifyProviderLogout(runtime, provider, accountIdentities.get(provider)),
    ),
  );
}
