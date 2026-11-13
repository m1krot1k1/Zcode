import { randomUUID } from "node:crypto";
import type { WebRemoteControlDeviceTransportState } from "#src/main/web-remote-relay/index.js";
import { buildWebRemoteControlPairResultTelemetry } from "@zcode/shared";

import { createFailure, resolveRuntimeWorkspaceDimensions } from "./helpers.js";
import type { WebRemoteControlManagerServices } from "./services.js";
import type { WindowControlRuntime } from "./types.js";

export interface TransportStateServices {
  mapTransportState(
    runtime: WindowControlRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void;
}

export function createTransportStateServices(config: {
  services: WebRemoteControlManagerServices;
}): TransportStateServices {
  const { services } = config;

  function mapTransportState(
    runtime: WindowControlRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void {
    const previousTransportState = runtime.transportState;
    runtime.transportState = state;
    // 瞬时查看不能沿用连接弹窗的断线宽限；恢复必须由新 epoch 下的可见页面重新声明。
    if (state !== "paired") {
      runtime.mobileTaskViewEpoch = undefined;
      runtime.mobileTaskViewSeq = undefined;
      services.clearMobileTaskView(runtime);
    } else if (previousTransportState !== "paired") {
      runtime.mobileTaskViewEpoch = randomUUID();
      runtime.mobileTaskViewSeq = -1;
    }
    if (state !== "paired") {
      runtime.hasObservedSendReadyForPairing = false;
    }
    if (state === "waiting_terminal" || state === "paired") {
      runtime.error = undefined;
      runtime.failure = undefined;
    }
    if (state === "connecting" || state === "authenticating") {
      if (runtime.mobileConnected) {
        // Bugfix: 已配对会话的 relay 短抖会先经历 connecting/authenticating。
        // 旧逻辑把 dialog 立刻切成“启动中”，用户会误以为远控重新启动；这里在宽限期内保持 active。
        runtime.status = "active";
        services.scheduleMobileDisconnectGrace(runtime);
        services.emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "starting";
      services.emitRuntimeStatus(runtime);
      return;
    }
    if (state === "waiting_terminal") {
      if (runtime.mobileConnected) {
        // Bugfix: 已配对会话恢复时 relay 可能短暂回 waiting。
        // 旧逻辑会把 dialog 从 active 拉回“等待手机匹配”；这里先防抖，超时仍未 paired 再降级。
        runtime.status = "active";
        services.scheduleMobileDisconnectGrace(runtime);
        services.emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      services.emitRuntimeStatus(runtime);
      return;
    }
    if (state === "paired") {
      if (previousTransportState !== "paired") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        services.reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "success",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
          }),
        );
      }
      runtime.hasEverPaired = true;
      services.clearMobileDisconnectGraceTimer(runtime);
      runtime.status = "active";
      runtime.mobileConnected = true;
      services.emitRuntimeStatus(runtime);
      // Bugfix: 普通断线重连重新 paired 时 transport 不一定触发 onSendReady。
      // 这里在状态恢复为可发送后主动 flush，避免重连窗口内缓冲的响应/RPC 帧超时丢弃。
      services.flushPendingOutboundPayloads(runtime);
      services.sendPendingBridgeInvalidation(runtime);
      if (previousTransportState !== "paired") services.requestMobileTaskView(runtime);
      return;
    }
    if (state === "kicked") {
      if (previousTransportState !== "kicked") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        services.reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      services.preserveWindowRuntimeFailure(
        runtime.windowId,
        runtime,
        "external-relay-kicked",
        createFailure("session-conflict", "Web remote control connection was kicked by relay."),
      );
      return;
    }
    if (state === "error") {
      if (previousTransportState !== "error") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        services.reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      runtime.status = "error";
      services.emitRuntimeStatus(runtime);
    }
  }

  return { mapTransportState };
}
