import type { WebRemoteControlAppPayload, WebRemoteControlStatus } from "@zcode/shared";

import {
  MOBILE_DISCONNECT_STATUS_GRACE_MS,
  type WebRemoteControlManagerDependencies,
  type WebRemoteControlManagerState,
  type WindowControlRuntime,
} from "./types.js";
import type { WebRemoteControlManagerServices } from "./services.js";

export interface StatusServices {
  buildRuntimeStatus(runtime: WindowControlRuntime): WebRemoteControlStatus;
  emitRuntimeStatus(runtime: WindowControlRuntime): void;
  emitIdleStatus(windowId: number): void;
  clearMobileTaskView(runtime: WindowControlRuntime): void;
  requestMobileTaskView(runtime: WindowControlRuntime): void;
  scheduleMobileDisconnectGrace(runtime: WindowControlRuntime): void;
  clearMobileDisconnectGraceTimer(runtime: WindowControlRuntime): void;
}

export function createStatusServices(config: {
  state: WebRemoteControlManagerState;
  dependencies: WebRemoteControlManagerDependencies;
  services: WebRemoteControlManagerServices;
}): StatusServices {
  const { state, dependencies, services } = config;

  function buildRuntimeStatus(runtime: WindowControlRuntime): WebRemoteControlStatus {
    const target = services.getRuntimeStatusTarget(runtime);
    return {
      status: runtime.status,
      sessionId: runtime.deviceSid,
      windowControlSessionId: runtime.deviceSid,
      mobileConnected: runtime.mobileConnected,
      mobileViewState: runtime.mobileViewState,
      mobileTaskView: runtime.mobileTaskView ?? null,
      mobileDeviceInfo: runtime.mobileDeviceInfo,
      qrUrl: runtime.qrUrl,
      connectUrl: runtime.connectUrl,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: runtime.currentBridge?.initialTaskId ?? runtime.initialTaskId,
      error: runtime.error,
      failure: runtime.failure,
    };
  }

  function emitRuntimeStatus(runtime: WindowControlRuntime): void {
    dependencies.onStatusChanged?.(runtime.windowId, buildRuntimeStatus(runtime));
  }

  function clearMobileTaskView(runtime: WindowControlRuntime): void {
    if (!runtime.mobileTaskView) return;
    runtime.mobileTaskView = undefined;
    emitRuntimeStatus(runtime);
  }

  function requestMobileTaskView(runtime: WindowControlRuntime): void {
    if (runtime.transportState !== "paired" || !runtime.mobileTaskViewEpoch) return;
    const payload: WebRemoteControlAppPayload = {
      zcode_type: "mobile-task-view-request",
      epoch: runtime.mobileTaskViewEpoch,
    };
    services.sendAppPayload(runtime, payload);
  }

  function emitIdleStatus(windowId: number): void {
    dependencies.onStatusChanged?.(windowId, { status: "idle" });
  }

  function clearMobileDisconnectGraceTimer(runtime: WindowControlRuntime): void {
    if (!runtime.mobileDisconnectGraceTimer) {
      return;
    }
    clearTimeout(runtime.mobileDisconnectGraceTimer);
    runtime.mobileDisconnectGraceTimer = undefined;
  }

  function scheduleMobileDisconnectGrace(runtime: WindowControlRuntime): void {
    if (runtime.mobileDisconnectGraceTimer) {
      return;
    }
    runtime.mobileDisconnectGraceTimer = setTimeout(() => {
      runtime.mobileDisconnectGraceTimer = undefined;
      if (state.runtimes.get(runtime.windowId) !== runtime || runtime.status === "error") {
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
    }, MOBILE_DISCONNECT_STATUS_GRACE_MS);
  }

  return {
    buildRuntimeStatus,
    emitRuntimeStatus,
    emitIdleStatus,
    clearMobileTaskView,
    requestMobileTaskView,
    scheduleMobileDisconnectGrace,
    clearMobileDisconnectGraceTimer,
  };
}
