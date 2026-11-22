import type { WebRemoteControlPayloadSendResult } from "@zcode/client";
import type {
  TelemetryEventPayload,
  WebRemoteControlAppPayload,
  WebRemoteControlContext,
  WebRemoteControlFailure,
  WebRemoteControlMobileDeviceInfo,
  WebRemoteControlMobileTaskViewUpdatePayload,
  WebRemoteControlMobileViewState,
  WebRemoteControlRpcTransportPayload,
  WebRemoteControlStartResult,
  WebRemoteControlStatus,
  WebRemoteControlWindowBootstrapResult,
  WebRemoteControlWorkspaceBridgeOpenPayload,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import type { WebRemoteControlDeviceTransportState } from "#src/main/web-remote-relay/index.js";

import type { WindowControlRuntime } from "./types.js";

/**
 * Набор внутренних операций manager-а, которые модули вызывают друг у друга.
 * Заполняется один раз при создании manager-а и дальше только читается, поэтому
 * циклические зависимости между модулями не требуют специального порядка инициализации.
 */
export interface WebRemoteControlManagerServices {
  sendAppPayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void;
  flushPendingOutboundPayloads(runtime: WindowControlRuntime): void;
  sendPendingBridgeInvalidation(runtime: WindowControlRuntime): void;
  clearPendingOutboundPayloadTimer(runtime: WindowControlRuntime): void;
  sendPayloadToTransport(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult;

  reportRemoteUsageEvent(windowId: number, event: TelemetryEventPayload): void;

  buildRuntimeStatus(runtime: WindowControlRuntime): WebRemoteControlStatus;
  emitRuntimeStatus(runtime: WindowControlRuntime): void;
  emitIdleStatus(windowId: number): void;
  clearMobileTaskView(runtime: WindowControlRuntime): void;
  requestMobileTaskView(runtime: WindowControlRuntime): void;
  scheduleMobileDisconnectGrace(runtime: WindowControlRuntime): void;
  clearMobileDisconnectGraceTimer(runtime: WindowControlRuntime): void;

  getRuntimeStatusTarget(runtime: WindowControlRuntime): WebRemoteControlWorkspaceTarget;
  getAvailableWorkspaces(runtime: WindowControlRuntime): WebRemoteControlWorkspaceTarget[];
  buildBootstrapResult(runtime: WindowControlRuntime): WebRemoteControlWindowBootstrapResult;
  buildWorkspaceListResult(runtime: WindowControlRuntime): WebRemoteControlWorkspaceListResult;
  pushWorkspaceListUpdated(runtime: WindowControlRuntime): void;
  applyMobileViewStateUpdate(
    runtime: WindowControlRuntime,
    viewState: WebRemoteControlMobileViewState,
    deviceInfo?: WebRemoteControlMobileDeviceInfo,
  ): void;
  applyMobileTaskViewUpdate(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlMobileTaskViewUpdatePayload,
  ): void;

  disposeRuntimeBridgeResources(runtime: WindowControlRuntime): void;
  cancelBridgeOpen(runtime: WindowControlRuntime): void;
  respondToWorkspaceBridgeOpen(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void>;
  respondToWorkspaceReconnectRequest(
    runtime: WindowControlRuntime,
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void>;
  routeRpcTransportPayload(
    runtime: WindowControlRuntime,
    frame: WebRemoteControlRpcTransportPayload,
  ): void;
  routeRawTransportCandidate(runtime: WindowControlRuntime, payload: unknown): boolean;

  preserveWindowRuntimeFailure(
    windowId: number,
    runtime: WindowControlRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void;
  stopWindowRuntime(windowId: number, reason: string): Promise<void>;
  requireAuthentication(windowId: number): void;

  clearStartAuthorizationsForWindow(windowId: number): void;

  routePayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void;
  mapTransportState(
    runtime: WindowControlRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void;
  start(windowId: number, context: WebRemoteControlContext): Promise<WebRemoteControlStartResult>;
}

export function createEmptyServices(): WebRemoteControlManagerServices {
  return {} as WebRemoteControlManagerServices;
}

export function applyServices(
  target: WebRemoteControlManagerServices,
  partial: Partial<WebRemoteControlManagerServices>,
): void {
  Object.assign(target, partial);
}
