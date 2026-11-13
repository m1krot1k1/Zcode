import type { WebRemoteControlPayloadSendResult } from "@zcode/client";
import type { WebRemoteControlAppPayload } from "@zcode/shared";
import { WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS } from "@zcode/shared";

import {
  WEB_REMOTE_CONTROL_PENDING_OUTBOUND_PAYLOAD_LIMIT,
  type WebRemoteControlManagerDependencies,
  type WindowControlRuntime,
} from "./types.js";

export interface OutboundServices {
  clearPendingOutboundPayloadTimer(runtime: WindowControlRuntime): void;
  sendPayloadToTransport(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult;
  sendPendingBridgeInvalidation(runtime: WindowControlRuntime): void;
  bufferOutboundPayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void;
  flushPendingOutboundPayloads(runtime: WindowControlRuntime): void;
  sendAppPayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void;
}

export function createOutboundServices(
  logger: WebRemoteControlManagerDependencies["logger"],
): OutboundServices {
  function clearPendingOutboundPayloadTimer(runtime: WindowControlRuntime): void {
    if (!runtime.pendingOutboundPayloadTimer) {
      return;
    }
    clearTimeout(runtime.pendingOutboundPayloadTimer);
    runtime.pendingOutboundPayloadTimer = undefined;
  }

  function schedulePendingOutboundPayloadTimeout(runtime: WindowControlRuntime): void {
    if (runtime.pendingOutboundPayloadTimer || runtime.pendingOutboundPayloads.length === 0) {
      return;
    }
    runtime.pendingOutboundPayloadTimer = setTimeout(() => {
      runtime.pendingOutboundPayloadTimer = undefined;
      const droppedCount = runtime.pendingOutboundPayloads.splice(0).length;
      logger.warn("[web-remote-control] dropped buffered outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
    }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
  }

  function sendPayloadToTransport(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult {
    if (runtime.transport.sendPayloadResult) {
      return runtime.transport.sendPayloadResult(payload);
    }
    return runtime.transport.sendPayload(payload)
      ? { kind: "sent", bytes: 0 }
      : { kind: "unavailable" };
  }

  function sendPendingBridgeInvalidation(runtime: WindowControlRuntime): void {
    const payload = runtime.pendingBridgeInvalidation;
    if (!payload) return;
    const result = sendPayloadToTransport(runtime, payload);
    if (result.kind === "oversize") {
      logger.error("[web-remote-control] bridge invalidation is oversized", {
        bridgeSessionId: payload.bridgeSessionId,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
    }
    // unavailable 时保持 latch；sent 后也保留，直到手机用新 bridge identity 发起 open。
  }

  function bufferOutboundPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (
      runtime.pendingOutboundPayloads.length >= WEB_REMOTE_CONTROL_PENDING_OUTBOUND_PAYLOAD_LIMIT
    ) {
      const droppedCount = runtime.pendingOutboundPayloads.length + 1;
      runtime.pendingOutboundPayloads.length = 0;
      clearPendingOutboundPayloadTimer(runtime);
      logger.warn("[web-remote-control] dropped overflowing outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
      return;
    }
    runtime.pendingOutboundPayloads.push(payload);
    schedulePendingOutboundPayloadTimeout(runtime);
  }

  function flushPendingOutboundPayloads(runtime: WindowControlRuntime): void {
    while (runtime.pendingOutboundPayloads.length > 0) {
      const payload = runtime.pendingOutboundPayloads[0];
      if (!payload) {
        break;
      }
      const result = sendPayloadToTransport(runtime, payload);
      if (result.kind === "unavailable") {
        schedulePendingOutboundPayloadTimeout(runtime);
        return;
      }
      if (result.kind === "oversize") {
        // Bugfix：永久 oversize 不能伪装成临时不可发送后反复进入 50 项 buffer。
        logger.warn("[web-remote-control] dropped oversize app payload", {
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        });
      }
      runtime.pendingOutboundPayloads.shift();
    }
    clearPendingOutboundPayloadTimer(runtime);
  }

  function sendAppPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length > 0) {
      bufferOutboundPayload(runtime, payload);
      flushPendingOutboundPayloads(runtime);
      return;
    }
    const result = sendPayloadToTransport(runtime, payload);
    if (result.kind === "sent") {
      return;
    }
    if (result.kind === "oversize") {
      logger.warn("[web-remote-control] rejected oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      return;
    }
    // Bugfix: relay suspect 窗口内 sendPayload 会返回 false。
    // desktop 发出的响应/RPC 帧不能静默丢弃，先短暂缓冲，等 paired 恢复后再 flush。
    bufferOutboundPayload(runtime, payload);
  }

  return {
    clearPendingOutboundPayloadTimer,
    sendPayloadToTransport,
    sendPendingBridgeInvalidation,
    bufferOutboundPayload,
    flushPendingOutboundPayloads,
    sendAppPayload,
  };
}
