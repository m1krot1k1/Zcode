import type { RendererTelemetryEventPayload } from "@zcode/shared";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import type { MessagePortProtocol } from "@zcode/rpc";
import type {
  AcknowledgedWebRemoteControlRelayProtocolAdapter,
  WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import type {
  HostPreparedProjectWorkspace,
  HostProjectWorkspaceNavigationInput,
  RemoteUsageRemoteKind,
  TelemetryEventPayload,
  WebRemoteControlAppPayload,
  WebRemoteControlContext,
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlFailure,
  WebRemoteControlMobileDeviceInfo,
  WebRemoteControlMobileViewState,
  WebRemoteControlPlatformMethod,
  WebRemoteControlPlatformMethodArgsMap,
  WebRemoteControlPlatformMethodResultMap,
  WebRemoteControlStatus,
  WebRemoteControlWorkspaceTarget,
  ZCodeEndpointUrls,
} from "@zcode/shared";
import type {
  WebRemoteControlDeviceStorage,
  WebRemoteControlDeviceTransportOptions,
  WebRemoteControlDeviceTransportState,
  WebRemoteControlLogin,
} from "#src/main/web-remote-relay/index.js";

import type { WebRemoteControlFeatureGate } from "../webRemoteControlFeatureGate.js";

export interface WebRemoteControlHostAttachmentHandle {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteUsageRemoteKind;
}

export interface WorkspaceBridgeRuntime {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  hostEntryId: string;
  attachmentId: string;
  kind: "local" | "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  hostProtocol?: MessagePortProtocol;
  relayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  disposeBridge?: () => void;
  readyAnnounced: boolean;
  degraded: boolean;
}

export interface WebRemoteControlDeviceTransportLike {
  start(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  sendPayloadResult?(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult;
  measurePayloadBytes?(payload: WebRemoteControlAppPayload): number;
  dispose(): void;
}

export interface WebRemoteControlStartupRestoreContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartAuthorization {
  token: string;
  expiresAt: number;
  windowId: number;
  workspaceKey: string;
  remoteSessionId?: string;
}

export interface WindowControlLifecycle {
  controller: AbortController;
  identity?: { userId: string; endpointOrigin: string };
}

export interface WindowControlRuntime {
  windowId: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlContext["theme"];
  status: WebRemoteControlStatus["status"];
  error?: string;
  failure?: WebRemoteControlFailure;
  deviceSid: string;
  deviceMid: string;
  connectUrl: string;
  qrUrl: string;
  transport: WebRemoteControlDeviceTransportLike;
  mobileConnected: boolean;
  hasEverPaired: boolean;
  hasObservedSendReadyForPairing: boolean;
  transportState?: WebRemoteControlDeviceTransportState;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileTaskView?: NonNullable<WebRemoteControlStatus["mobileTaskView"]>;
  mobileTaskViewEpoch?: string;
  mobileTaskViewSeq?: number;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  currentBridge?: WorkspaceBridgeRuntime;
  bridgeOpen?: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
    intentKey: string;
    hostRequestId: string;
    preparingProject: boolean;
    promise: Promise<WebRemoteControlExternalWorkspaceBridge>;
  };
  pendingBridgeInvalidation?: Extract<
    WebRemoteControlAppPayload,
    { zcode_type: "bridge-degraded" }
  >;
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  mobileDisconnectGraceTimer?: ReturnType<typeof setTimeout>;
}

export interface WebRemoteControlManagerDependencies {
  getEndpointUrls?: () => Promise<ZCodeEndpointUrls> | ZCodeEndpointUrls;
  relayWsUrl: string;
  mobileRemoteControlUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  getLogin(): Promise<WebRemoteControlLogin | undefined>;
  deviceStorage: WebRemoteControlDeviceStorage;
  startupRestoreStorageProvider: {
    load(): Promise<WebRemoteControlStartupRestoreContext | undefined>;
    save(context: WebRemoteControlStartupRestoreContext): Promise<void>;
    clear(): Promise<void>;
  };
  featureGate: WebRemoteControlFeatureGate;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  platformHandlers: {
    [K in WebRemoteControlPlatformMethod]: (
      args: WebRemoteControlPlatformMethodArgsMap[K],
    ) => Promise<WebRemoteControlPlatformMethodResultMap[K]>;
  };
  reconnectWorkspace: (windowId: number, workspaceKey: string) => Promise<void>;
  prepareProjectWorkspace?: (
    windowId: number,
    project: HostProjectWorkspaceNavigationInput,
    requestId: string,
  ) => Promise<HostPreparedProjectWorkspace>;
  cancelProjectPreparation?: (windowId: number, requestId: string) => void;
  reportRemoteUsageEvent?: (windowId: number, event: TelemetryEventPayload) => void;
  reportRendererTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  onStatusChanged?: (windowId: number, status: WebRemoteControlStatus) => void;
  attachWorkspaceHost: (
    windowId: number,
    context: WebRemoteControlContext & { kind: "local" | "remote" },
  ) => Promise<WebRemoteControlHostAttachmentHandle>;
  releaseWorkspaceHostAttachment: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  createDeviceTransport?: (
    options: WebRemoteControlDeviceTransportOptions,
  ) => WebRemoteControlDeviceTransportLike;
}

/** Мутируемое состояние manager-а, общее для всех модулей web-remote-control. */
export interface WebRemoteControlManagerState {
  runtimes: Map<number, WindowControlRuntime>;
  windowLifecycles: Map<number, WindowControlLifecycle>;
  authRequiredWindows: Set<number>;
  registrationQueue: Promise<unknown>;
  startAuthorizations: Map<string, WebRemoteControlStartAuthorization>;
  availableWorkspacesByWindowId: Map<number, WebRemoteControlWorkspaceTarget[]>;
  pushedWorkspaceListSignaturesByWindowId: Map<number, string>;
  startupRestoreClaimed: boolean;
  lifecycleRevision: number;
  authNotificationRevision: number;
}

export function createManagerState(): WebRemoteControlManagerState {
  return {
    runtimes: new Map(),
    windowLifecycles: new Map(),
    authRequiredWindows: new Set(),
    registrationQueue: Promise.resolve(),
    startAuthorizations: new Map(),
    availableWorkspacesByWindowId: new Map(),
    pushedWorkspaceListSignaturesByWindowId: new Map(),
    startupRestoreClaimed: false,
    lifecycleRevision: 0,
    authNotificationRevision: 0,
  };
}

export const WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS = 30_000;

// Bugfix: 外部 relay 首次鉴权会受边缘层冷启动和网络抖动影响，实测可能略超 15s。
// 这里等待到 30s，避免在 device 已经快进入 waiting_terminal 时过早销毁可用连接。
export const EXTERNAL_RELAY_QR_READY_TIMEOUT_MS = 30_000;
export const MOBILE_DISCONNECT_STATUS_GRACE_MS = 3_000;
export const WEB_REMOTE_CONTROL_PENDING_OUTBOUND_PAYLOAD_LIMIT = 50;
