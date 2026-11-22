import type { Event } from "@zcode/rpc";
import type {
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthSessionState,
  OAuthStartResponse,
  UserInfo,
} from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import type { IOAuthService } from "../oauth.js";
import { createOAuthProviderAdapters } from "../providers/index.js";
import { createOAuthRuntimeConfig } from "../runtimeConfig.js";
import { handleCallback } from "./callback.js";
import { logout, logoutAll, logoutIfCurrentCredentialRequest } from "./logout.js";
import {
  cancelPending,
  pollPendingOAuth,
  startOAuthInternal,
  startOAuthWithPolling,
} from "./pendingFlow.js";
import { refreshToken } from "./refreshToken.js";
import { restoreCachedSession, restoreCachedSessionState } from "./restoreCachedSession.js";
import { restoreSession } from "./restoreSession.js";
import { createOAuthServiceRuntime } from "./runtime.js";
import type { OAuthServiceDependencies, OAuthServiceRuntime } from "./types.js";

/**
 * OAuth 认证服务实现
 *
 * 在 host process 中运行，管理 OAuth 流程的完整生命周期。
 * 具体流程按职责位于 ./ 下的模块，共享同一份 runtime 状态。
 */
export class OAuthService implements IOAuthService {
  private readonly runtime: OAuthServiceRuntime;
  readonly onDidChangeSession: Event<OAuthSessionState>;

  constructor(credentialService: ICredentialService, dependencies: OAuthServiceDependencies = {}) {
    this.runtime = createOAuthServiceRuntime(credentialService, dependencies);
    this.onDidChangeSession = this.runtime.sessionChanges.event;
  }

  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [...this.runtime.adapters.values()]
      .map((adapter) => adapter.meta)
      .filter((meta) => meta.enabled)
      .sort((a, b) => a.order - b.order);
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.runtime.repo.getActiveProvider();
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    return restoreCachedSession(this.runtime);
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    return restoreCachedSessionState(this.runtime);
  }

  async restoreSession(): Promise<UserInfo | null> {
    return restoreSession(this.runtime);
  }

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    return startOAuthInternal(this.runtime, provider);
  }

  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    return startOAuthWithPolling(this.runtime, provider);
  }

  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    return pollPendingOAuth(this.runtime);
  }

  async handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    return handleCallback(this.runtime, url);
  }

  async refreshToken(provider?: OAuthProviderId): Promise<void> {
    return refreshToken(this.runtime, provider);
  }

  /** Host 本地 401 提交入口，不扩展 IOAuthService 的跨端契约。 */
  logoutIfCurrentCredentialRequest(input: string | URL, headers: Headers): Promise<boolean> {
    return logoutIfCurrentCredentialRequest(this.runtime, input, headers);
  }

  async logout(provider?: OAuthProviderId): Promise<void> {
    return logout(this.runtime, provider);
  }

  async logoutAll(): Promise<void> {
    return logoutAll(this.runtime);
  }

  async cancelPending(provider?: OAuthProviderId): Promise<void> {
    return cancelPending(this.runtime, provider);
  }
}

/**
 * 工厂函数：创建 OAuthService 实例
 */
export function createOAuthService(
  credentialService: ICredentialService,
  dependencies: Omit<OAuthServiceDependencies, "adapters"> = {},
): OAuthService {
  return new OAuthService(credentialService, {
    ...dependencies,
    adapters: createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      apiClient: dependencies.apiClient,
    }),
  });
}
