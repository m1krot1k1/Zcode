import {
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlAppPayload,
  type WebRemoteControlWindowBootstrapResult,
} from "@zcode/shared";
import {
  readKnownDevices,
  type WebRemoteControlTerminalTransportDiagnostic,
} from "#src/web-remote-control/index.js";
import type { WebRemoteControlConnectingDevice } from "#src/web-remote-control/views.js";

import { webRemoteControlStorage } from "./runtime.js";

export interface RelayBootstrapWorkspaceOptions {
  preferredWorkspaceKey?: string;
  preferredTaskId?: string;
}

export function resolveRelayBootstrapWorkspace(
  bootstrapResult: WebRemoteControlWindowBootstrapResult,
  options?: RelayBootstrapWorkspaceOptions,
): ReturnType<typeof resolveWebRemoteControlInitialWorkspaceSelection> {
  const preferredWorkspace = options?.preferredWorkspaceKey
    ? bootstrapResult.workspaces.find(
        (workspace) =>
          resolveWebRemoteControlWorkspaceKey(workspace) ===
          options.preferredWorkspaceKey,
      )
    : undefined;
  if (!preferredWorkspace) {
    return resolveWebRemoteControlInitialWorkspaceSelection(bootstrapResult);
  }
  return {
    workspaceKey: resolveWebRemoteControlWorkspaceKey(preferredWorkspace),
    taskId: options?.preferredTaskId,
    canBridge:
      preferredWorkspace.kind !== "remote" ||
      Boolean(
        preferredWorkspace.workspaceIdentity &&
        preferredWorkspace.remoteSessionId,
      ),
  };
}

export interface RelayConnectingDeviceParams {
  deviceName?: string;
  deviceMid?: string;
}

export function resolveRelayConnectingDevice(
  relayParams: RelayConnectingDeviceParams,
): WebRemoteControlConnectingDevice {
  return {
    name: relayParams.deviceName,
    platform: relayParams.deviceMid
      ? readKnownDevices(webRemoteControlStorage).get(relayParams.deviceMid)
          ?.platform
      : undefined,
  };
}

export function buildRelayDeviceNavigation(input: {
  deviceName?: string;
  devicePlatform?: string;
  signal: AbortSignal;
  chooseOtherDevice: () => void;
}) {
  return {
    deviceName: input.deviceName,
    devicePlatform: input.devicePlatform,
    chooseOtherDevice: () => {
      if (!input.signal.aborted) void input.chooseOtherDevice();
    },
  };
}

export type RelayMobileDiagnosticPayload = WebRemoteControlAppPayload & {
  zcode_type: "mobile-diagnostic";
};

export function sendRelayMobileDiagnostic(
  diagnostic: WebRemoteControlTerminalTransportDiagnostic,
  send: ((payload: RelayMobileDiagnosticPayload) => void) | undefined,
): void {
  if (diagnostic.type === "socket-extensions") return;
  send?.({
    zcode_type: "mobile-diagnostic",
    event: diagnostic.type,
    timestamp: diagnostic.timestamp,
    state: diagnostic.state,
    previousState:
      "previousState" in diagnostic ? diagnostic.previousState : undefined,
    pairStatus: "pairStatus" in diagnostic ? diagnostic.pairStatus : undefined,
    closeCode: "code" in diagnostic ? diagnostic.code : undefined,
    closeReason: "reason" in diagnostic ? diagnostic.reason : undefined,
    wasClean: "wasClean" in diagnostic ? diagnostic.wasClean : undefined,
    wasPaired: "wasPaired" in diagnostic ? diagnostic.wasPaired : undefined,
    visibilityState: diagnostic.visibilityState,
    online: diagnostic.online,
    hiddenDurationMs: diagnostic.hiddenDurationMs,
  });
}
