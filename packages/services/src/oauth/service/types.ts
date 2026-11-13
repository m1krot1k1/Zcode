import type { Emitter } from "@zcode/rpc";
import type {
  ApiClient,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthSessionState,
} from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import type { OAuthProviderAdapter } from "../providers/index.js";
import type { OAuthCredentialRepo } from "../repo/oauthCredentialRepo.js";

/** OAuth 超时时间（5 分钟） */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const COMPLETED_POLLING_STATE_GRACE_MS = 30 * 1000;
export const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

export interface PendingState {
  state: string;
  provider: OAuthProviderId;
  timeout: NodeJS.Timeout;
  phase: "awaiting-attribution-or-code" | "awaiting-code-after-attribution";
  completionPromise?: Promise<OAuthCallbackResult | null>;
  polling?: {
    expiresAt: number;
    flowId: string;
    nextPollAt: number;
    pollIntervalMs: number;
    pollToken: string;
    pollUrl: string;
  };
}

export interface OAuthFlowEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

export interface OAuthServiceDependencies {
  adapters?: OAuthProviderAdapter[];
  apiClient?: ApiClient;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
}

export interface RecentlyCompletedPollingState {
  generation: number;
  expiresAt: number;
  provider: OAuthProviderId;
  state: string;
}

/**
 * OAuth 会话的唯一可变状态所有者。
 *
 * 拆分后的流程模块只通过该运行时对象读写 pending flow、generation 和串行队列，
 * 避免同一个 OAuth 会话事实出现多条写入路径。
 */
export interface OAuthServiceRuntime {
  readonly credentialService: ICredentialService;
  readonly repo: OAuthCredentialRepo;
  readonly adapters: Map<OAuthProviderId, OAuthProviderAdapter>;
  readonly now: () => number;
  readonly onProviderLogout?: (
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ) => Promise<void>;
  readonly apiClient?: ApiClient;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionChanges: Emitter<OAuthSessionState>;
  pendingState: PendingState | null;
  oauthFlowStartGeneration: number;
  oauthFlowStartProvider: OAuthProviderId | null;
  oauthSessionGeneration: number;
  sessionMutationQueue: Promise<unknown>;
  recentlyCompletedPollingState: RecentlyCompletedPollingState | null;
}
