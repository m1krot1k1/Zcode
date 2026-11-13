import type { WebRemoteControlFailure } from "@zcode/shared";

import type { WebRemoteControlManagerServices } from "./services.js";
import type {
  WebRemoteControlManagerDependencies,
  WebRemoteControlManagerState,
  WindowControlRuntime,
} from "./types.js";

export interface LifecycleServices {
  preserveWindowRuntimeFailure(
    windowId: number,
    runtime: WindowControlRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void;
  stopWindowRuntime(windowId: number, reason: string): Promise<void>;
  requireAuthentication(windowId: number): void;
}

export function createLifecycleServices(config: {
  state: WebRemoteControlManagerState;
  dependencies: WebRemoteControlManagerDependencies;
  services: WebRemoteControlManagerServices;
}): LifecycleServices {
  const { state, dependencies, services } = config;

  function preserveWindowRuntimeFailure(
    windowId: number,
    runtime: WindowControlRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void {
    if (runtime.status === "error" && runtime.failure?.reason === failure.reason) {
      return;
    }

    services.sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: failure.reason,
      error: failure.message ?? failure.reason,
    });
    services.cancelBridgeOpen(runtime);
    services.disposeRuntimeBridgeResources(runtime);
    services.clearPendingOutboundPayloadTimer(runtime);
    services.clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    runtime.status = "error";
    runtime.mobileConnected = false;
    runtime.error = failure.message;
    runtime.failure = failure;
    state.runtimes.set(windowId, runtime);
    dependencies.logger.warn(
      `[web-remote-control] runtime closed window=${windowId} session=${runtime.deviceSid} reason=${reason} failure=${failure.reason} message=${failure.message ?? "<none>"}`,
    );
    services.emitRuntimeStatus(runtime);
  }

  async function stopWindowRuntime(windowId: number, reason: string): Promise<void> {
    state.windowLifecycles.get(windowId)?.controller.abort();
    state.windowLifecycles.delete(windowId);
    const runtime = state.runtimes.get(windowId);
    if (!runtime) {
      return;
    }

    services.sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: "desktop-disconnected",
      error: "Desktop disconnected this Web remote control session.",
    });
    state.runtimes.delete(windowId);
    state.pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    services.cancelBridgeOpen(runtime);
    services.disposeRuntimeBridgeResources(runtime);
    services.clearPendingOutboundPayloadTimer(runtime);
    services.clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    dependencies.disposeWorkspaceHostAttachmentsForWindow(windowId, reason);

    dependencies.logger.info(
      `[web-remote-control] stopped window=${windowId} session=${runtime.deviceSid} reason=${reason}`,
    );
    services.emitIdleStatus(windowId);
  }

  function requireAuthentication(windowId: number): void {
    void stopWindowRuntime(windowId, "auth-required");
    state.authRequiredWindows.add(windowId);
    state.startupRestoreClaimed = false;
    dependencies.onStatusChanged?.(windowId, { status: "auth-required" });
  }

  return {
    preserveWindowRuntimeFailure,
    stopWindowRuntime,
    requireAuthentication,
  };
}
