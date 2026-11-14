import type { RemoteTarget, SourceServerArtifactPolicy, WorkspacePurpose } from "@zcode/shared";

export interface WindowRemoteAssetDirs {
  bundledReleaseDir?: string;
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
}

export interface WindowRemoteConnectionCloseEvent {
  exitCode: number | null;
  signal: string | null;
  error?: string;
  recoverable?: boolean;
  recoveryAttempt?: number;
  recoveryLimit?: number;
  recoveryBudgetExhausted?: boolean;
  reasonCode?: string;
  retryable?: boolean;
}

export interface WindowRemoteConnectionHandle<TServices, TCapabilities = never> {
  services: TServices;
  reusedConnectionTarget?: RemoteTarget;
  capabilities?: TCapabilities;
  dispose(): void | Promise<void>;
  onDidClose?(listener: (event: WindowRemoteConnectionCloseEvent) => void): {
    dispose(): void;
  };
  /** 同一 Source transport 自动重连完成；services/capabilities getter 已切到新连接。 */
  onDidReconnect?(listener: () => void): { dispose(): void };
}

export interface WindowRemoteConnectionConnectRequest {
  membershipIntent?: "add" | "retain";
  existingSourceServerId?: string;
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  signal: AbortSignal;
  confirmSourceServerInstall?: boolean;
}

export type WindowRemoteConnectionState =
  | "connecting"
  | "online"
  | "closing"
  | "failed"
  | "disconnected";

export interface WindowRemoteLogicalSessionSnapshot {
  sourceServerId?: string;
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
}

export class WindowRemoteConnectCancelledError extends Error {
  public readonly code = "remote-connection-canceled";
  constructor() {
    super("远程连接已取消");
    this.name = "WindowRemoteConnectCancelledError";
  }
}

export class WindowRemoteConnectionUnavailableError extends Error {
  constructor(remoteSessionId: string) {
    super(`远程连接当前不可用，remoteSessionId=${remoteSessionId}`);
    this.name = "WindowRemoteConnectionUnavailableError";
  }
}

export interface ConnectionEntry<TServices, TCapabilities> {
  key: string;
  sourceServerId?: string;
  target: RemoteTarget;
  state: WindowRemoteConnectionState;
  abortController: AbortController;
  sessions: Set<string>;
  ready: Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  handle?: WindowRemoteConnectionHandle<TServices, TCapabilities>;
  closeSubscription?: { dispose(): void };
  reconnectSubscription?: { dispose(): void };
  reconnectFlight?: Promise<void>;
  replacementRetryTimer?: ReturnType<typeof setTimeout>;
  recoveryReplacements?: Array<{
    previous: LogicalSession<TServices, TCapabilities>;
    current: LogicalSession<TServices, TCapabilities>;
  }>;
  closePhase: "none" | "recovering" | "terminal";
  lastRecoveryAttemptNotified?: number;
  recoveryReady?: Promise<void>;
  recoveryFailure?: Error;
  resolveRecovery?: () => void;
  rejectRecovery?: (error: Error) => void;
  disposePromise?: Promise<void>;
  disposed: boolean;
  transitionEpoch: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleReason: string;
  workspaceKeys: Set<string>;
  runningTaskCountByWorkspaceKey: Map<string, number>;
  workspaceRuntimeByKey: Map<string, WorkspaceRuntimeState>;
}

export class WindowRemoteConnectionTransitionStaleError extends Error {
  public constructor() {
    super("远程连接状态已在异步操作期间换代");
    this.name = "WindowRemoteConnectionTransitionStaleError";
  }
}

export interface RemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface WorkspaceRuntimeState {
  context: RemoteWorkspaceContext;
  generation: number;
  pendingReleaseGeneration?: number;
  releaseInFlight?: Promise<void>;
}

export interface LogicalSession<TServices, TCapabilities> {
  sourceServerId?: string;
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  legacyWorkspaceIdentity?: string;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
  entry: ConnectionEntry<TServices, TCapabilities>;
  workspaceKey?: string;
  workspaceGeneration?: number;
  workspaceReady: Promise<void>;
  workspaceReadyState: "pending" | "ready" | "failed";
  cancelled: boolean;
  rejectCancellation: (error: WindowRemoteConnectCancelledError) => void;
  cancellation: Promise<never>;
}

/** 建立/复用 connection entry 的入参；connect 与 connectSource 共用同一形状。 */
export interface WindowRemoteEntryParams {
  key: string;
  membershipIntent?: "add" | "retain";
  existingSourceServerId?: string;
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  confirmSourceServerInstall?: boolean;
}

export interface WindowRemoteConnectionRegistryOptions<TServices, TCapabilities> {
  connect: (
    request: WindowRemoteConnectionConnectRequest,
  ) => Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  createId: () => string;
  onConnectionChanged?: () => void;
  onSessionClosed?: (event: WindowRemoteConnectionCloseEvent & { remoteSessionId: string }) => void;
  onSessionReconnected?: (event: {
    previous: WindowRemoteLogicalSessionSnapshot;
    current: WindowRemoteLogicalSessionSnapshot;
    services: TServices;
    isCurrent: () => boolean;
    commit: () => boolean;
  }) => void | Promise<void>;
  onSessionReconnectError?: (error: unknown) => void;
  releaseWorkspace?: (services: TServices, context: RemoteWorkspaceContext) => Promise<void>;
  onWorkspaceReleaseError?: (context: RemoteWorkspaceContext, error: unknown) => void;
  resolveSourceServerId?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  ) => string | undefined;
  shouldKeepConnectionAlive?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  ) => boolean;
  prepareWorkspaceIdentity?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
    input: {
      sourceServerId: string;
      workspacePath: string;
      stableWorkspaceIdentity: string;
      legacyRouteHint?: string;
      signal?: AbortSignal;
    },
  ) => Promise<void>;
  wslIdleTtlMs?: number;
  logicalReplacementRetryDelaysMs?: readonly number[];
}

/** 可变生命周期标记；只由 registry.dispose 推进。 */
export interface RegistryRuntime {
  disposed: boolean;
  disposePromise: Promise<void> | null;
}

/**
 * Registry 的唯一状态所有者。所有模块通过显式传入的 context 读写同一组 map，
 * 避免各处闭包各自持有副本。
 */
export interface RegistryContext<TServices, TCapabilities> {
  options: WindowRemoteConnectionRegistryOptions<TServices, TCapabilities>;
  entriesByKey: Map<string, ConnectionEntry<TServices, TCapabilities>>;
  entriesBySourceServerId: Map<string, ConnectionEntry<TServices, TCapabilities>>;
  sessionsById: Map<string, LogicalSession<TServices, TCapabilities>>;
  pendingSessionsByRequestId: Map<string, LogicalSession<TServices, TCapabilities>>;
  runtime: RegistryRuntime;
  wslIdleTtlMs: number;
  logicalReplacementRetryDelaysMs: readonly number[];
}
