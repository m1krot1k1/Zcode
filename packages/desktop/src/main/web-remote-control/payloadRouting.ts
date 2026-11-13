import type {
  WebRemoteControlAppPayload,
  WebRemoteControlPlatformRequestPayload,
  WebRemoteControlPlatformResponsePayload,
} from "@zcode/shared";

import type { WebRemoteControlManagerServices } from "./services.js";
import type { WebRemoteControlManagerDependencies, WindowControlRuntime } from "./types.js";

export interface PayloadRoutingServices {
  routePayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void;
}

export function createPayloadRoutingServices(config: {
  dependencies: WebRemoteControlManagerDependencies;
  services: WebRemoteControlManagerServices;
}): PayloadRoutingServices {
  const { dependencies, services } = config;

  async function respondToPlatformRequest(
    runtime: WindowControlRuntime,
    request: WebRemoteControlPlatformRequestPayload,
  ): Promise<void> {
    let response: WebRemoteControlPlatformResponsePayload;

    try {
      const result = await dependencies.platformHandlers[request.method](request.args as never);
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: true,
        result,
      } as WebRemoteControlPlatformResponsePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] platform request failed window=${runtime.windowId} session=${runtime.deviceSid} method=${request.method} error=${message}`,
      );
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: false,
        error: message,
      };
    }

    services.sendAppPayload(runtime, response);
  }

  function logMobileDiagnostic(
    runtime: WindowControlRuntime,
    payload: Extract<WebRemoteControlAppPayload, { zcode_type: "mobile-diagnostic" }>,
  ): void {
    dependencies.logger.info("[web-remote-control] mobile diagnostic", {
      window: runtime.windowId,
      session: runtime.deviceSid,
      event: payload.event,
      state: payload.state,
      previousState: payload.previousState,
      pairStatus: payload.pairStatus,
      closeCode: payload.closeCode,
      closeReason: payload.closeReason,
      wasClean: payload.wasClean,
      wasPaired: payload.wasPaired,
      failureReason: payload.failureReason,
      failureMessage: payload.failureMessage,
      visibilityState: payload.visibilityState,
      online: payload.online,
      hiddenDurationMs: payload.hiddenDurationMs,
      timestamp: payload.timestamp,
    });
  }

  function routePayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void {
    switch (payload.zcode_type) {
      case "bootstrap-request":
        services.sendAppPayload(runtime, {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: services.buildBootstrapResult(runtime),
        });
        break;
      case "workspace-list-request":
        services.sendAppPayload(runtime, {
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: services.buildWorkspaceListResult(runtime),
        });
        break;
      case "platform-request":
        void respondToPlatformRequest(runtime, payload);
        break;
      case "mobile-view-state-update":
        services.applyMobileViewStateUpdate(runtime, payload.viewState, payload.deviceInfo);
        break;
      case "mobile-task-view-update":
        services.applyMobileTaskViewUpdate(runtime, payload);
        break;
      case "workspace-bridge-open":
        void services.respondToWorkspaceBridgeOpen(runtime, payload);
        break;
      case "workspace-reconnect-request":
        void services.respondToWorkspaceReconnectRequest(runtime, payload);
        break;
      case "rpc-frame":
      case "rpc-frame-ack":
        services.routeRpcTransportPayload(runtime, payload);
        break;
      case "telemetry-report":
        // 手机已在创建边界构造事件；Main 只转发，不维护会话事实或干预 replayable 链路。
        dependencies.reportRendererTelemetryEvent?.(payload.event);
        break;
      case "mobile-diagnostic":
        logMobileDiagnostic(runtime, payload);
        break;
      default:
        break;
    }
  }

  return { routePayload };
}
