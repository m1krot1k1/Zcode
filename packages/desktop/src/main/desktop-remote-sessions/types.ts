import type {
  BrowserWindow,
  MessagePortMain,
  UtilityProcess as ElectronUtilityProcess,
} from "electron";
import type {
  BindRemoteWorkspaceSessionContextResult,
  HostPreparedProjectWorkspace,
  ProviderProvisioningTrigger,
  RemoteTarget,
  WebRemoteControlFailure,
  WindowHostRemoteWorkspaceDescriptor,
  WorkspacePurpose,
} from "@zcode/shared";
import type {
  RemoteDisconnectReason,
  RemoteGaugeTransition,
} from "../desktopRemoteUsageArmsTelemetry.js";
import type { RemoteAssetDirs } from "../desktopRuntimeEnv.js";
import type { ProviderProvisioningEnvironmentCoordinator } from "../providerProvisioningEnvironmentCoordinator.js";

export interface RemoteWorkspaceSessionContext {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface RemoteWorkspaceConnectContext {
  workspacePath?: string;
  workspaceIdentity?: string;
  confirmSourceServerInstall?: boolean;
}

export interface PendingConnect {
  requestId: string;
  webContentsId: number;
  win: BrowserWindow;
  remoteUsageTelemetryEligible: boolean;
  resolve: (sessionId: string) => void;
  onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
  reject: (error: Error) => void;
}

export interface PendingWorkspaceBind {
  resolve: (previousWorkspaceIdentity?: string) => void;
  reject: (error: Error & { code?: string; retryable?: boolean }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface WorkspaceContextBindFlight {
  contextKey: string;
  promise: Promise<BindRemoteWorkspaceSessionContextResult>;
}

export interface RemoteAttachmentRoute {
  /** 手机创建的目录 scope 不自动建立桌面 tab；桌面显式 join 后才提升。 */
  mobileOnly?: boolean;
  providerProvisioningReady?: Promise<void>;
  webContentsId: number;
  // Main 只保留端口转发所需的 request/session 关联和脱敏 descriptor；连接/任务事实归 Host。
  descriptor: WindowHostRemoteWorkspaceDescriptor;
  rendererAttachmentId?: string;
  pendingRendererAttachment?: {
    attachmentId: string;
    previousAttachmentId?: string;
    reason: string;
    ready: () => Promise<void>;
    timeout: NodeJS.Timeout;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  attachmentState: "attachable" | "closed";
  connectedAtMonotonicMs: number;
  connectFinalized: boolean;
  remoteUsageTelemetryEligible: boolean;
  providerProvisioningDispose?: () => void;
}

export interface PendingProviderProvisioningExecution {
  readonly child: ElectronUtilityProcess;
  readonly trigger: ProviderProvisioningTrigger;
  readonly startedAtMonotonicMs: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface PendingProjectNavigation {
  child: ElectronUtilityProcess;
  win: BrowserWindow;
  requestId: string;
  resolve(value: HostPreparedProjectWorkspace): void;
  reject(error: Error): void;
}

export interface RemoteSessionManagerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface RemoteSessionManagerOptions {
  logger: RemoteSessionManagerLogger;
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  resolveRemoteAssetDirs: () => RemoteAssetDirs;
  resolveWslTarget?: (
    target: Extract<RemoteTarget, { kind: "wsl" }>,
  ) => Promise<Extract<RemoteTarget, { kind: "wsl" }>>;
  createMessageChannel?: () => {
    port1: MessagePortMain;
    port2: MessagePortMain;
  };
  rendererAttachmentReadyTimeoutMs?: number;
  workspaceBindReadyTimeoutMs?: number;
  reportRemoteConnectionStateChanged?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    transition: Exclude<RemoteGaugeTransition, "none">;
  }) => void;
  reportRemoteDisconnect?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    disconnectReason: RemoteDisconnectReason;
    durationMs: number;
  }) => void;
  monotonicNowMs?: () => number;
  webRemoteControlManagerRef: {
    current: {
      failRemoteSession(sessionId: string, reason: string, failure: WebRemoteControlFailure): void;
      replaceRemoteSession?(event: {
        previousSessionId: string;
        sessionId: string;
        workspacePath: string;
        workspaceIdentity: string;
      }): Promise<void>;
    } | null;
  };
  providerProvisioningCoordinator?: ProviderProvisioningEnvironmentCoordinator;
}

export interface RemoteSessionsState {
  pendingByRequestKey: Map<string, PendingConnect>;
  pendingProjectNavigations: Map<string, PendingProjectNavigation>;
  pendingWorkspaceBindsByRequestKey: Map<string, PendingWorkspaceBind>;
  workspaceContextBindFlightsBySessionId: Map<string, WorkspaceContextBindFlight>;
  routesBySessionId: Map<string, RemoteAttachmentRoute>;
  listenedHosts: WeakSet<ElectronUtilityProcess>;
  pendingProviderProvisioningExecutions: Map<string, PendingProviderProvisioningExecution>;
  appShutdownStarted: boolean;
}

export interface RemoteSessionsContext {
  options: RemoteSessionManagerOptions;
  state: RemoteSessionsState;
  providerProvisioningCoordinator: ProviderProvisioningEnvironmentCoordinator;
  monotonicNowMs: () => number;
  workspaceBindReadyTimeoutMs: number;
}
