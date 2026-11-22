import type { TelemetryEventPayload } from "@zcode/shared";

import type { WebRemoteControlManagerDependencies } from "./types.js";

export interface TelemetryServices {
  reportRemoteUsageEvent(windowId: number, event: TelemetryEventPayload): void;
}

export function createTelemetryServices(
  dependencies: WebRemoteControlManagerDependencies,
): TelemetryServices {
  function reportRemoteUsageEvent(windowId: number, event: TelemetryEventPayload): void {
    try {
      dependencies.reportRemoteUsageEvent?.(windowId, event);
    } catch (error) {
      // 埋点是旁路能力，任何异常都不能改变远控配对和 bridge 的业务结果。
      dependencies.logger.warn("[web-remote-control] remote usage telemetry failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  return { reportRemoteUsageEvent };
}
