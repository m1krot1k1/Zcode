import { randomUUID } from "node:crypto";
import type { WebRemoteControlPayloadSendResult } from "@zcode/client";
import { createAcknowledgedWebRemoteControlRelayProtocol } from "@zcode/client";
import { MessagePortProtocol } from "@zcode/rpc";
import type {
  HostProjectWorkspaceNavigationInput,
  WebRemoteControlAppPayload,
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlRpcTransportPayload,
  WebRemoteControlWorkspaceBridgeOpenPayload,
  WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import {
  buildWebRemoteControlBridgeResultTelemetry,
  classifyRemoteUsageError,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
  resolveWebRemoteControlWorkspaceKey,
} from "@zcode/shared";

import {
  isBridgeableRemoteTarget,
  mapWorkspaceBridgeFailureReason,
  resolveRemoteKind,
  toExternalBridge,
  wrapElectronPort,
} from "./helpers.js";
import type { WebRemoteControlManagerServices } from "./services.js";
import type {
  WebRemoteControlHostAttachmentHandle,
  WebRemoteControlManagerDependencies,
  WebRemoteControlManagerState,
  WindowControlRuntime,
  WorkspaceBridgeRuntime,
} from "./types.js";

export interface BridgeServices {
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
}

export function createBridgeServices(config: {
  state: WebRemoteControlManagerState;
  dependencies: WebRemoteControlManagerDependencies;
  services: WebRemoteControlManagerServices;
}): BridgeServices {
  const { state, dependencies, services } = config;

  function disposeRuntimeBridgeResources(runtime: WindowControlRuntime): void {
    services.clearMobileTaskView(runtime);
    const bridge = runtime.currentBridge;
    if (!bridge) {
      return;
    }

    bridge.disposeBridge?.();
    bridge.disposeBridge = undefined;
    bridge.relayProtocol?.dispose();
    bridge.relayProtocol = undefined;
    try {
      bridge.hostProtocol?.disconnect();
    } catch {
      // MessagePortProtocol 已经关闭时 dispose 失败不影响主流程。
    }
    if (bridge.attachmentId) {
      dependencies.releaseWorkspaceHostAttachment(bridge.attachmentId);
    }

    runtime.currentBridge = undefined;
  }

  function isCurrentBridgeRuntime(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
  ): boolean {
    return state.runtimes.get(runtime.windowId) === runtime && runtime.currentBridge === bridge;
  }

  function degradeBridgeAfterRawFault(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
    reasonCode: string,
  ): void {
    if (!isCurrentBridgeRuntime(runtime, bridge) || bridge.degraded) return;
    bridge.degraded = true;
    dependencies.logger.warn("[web-remote-control] raw relay bridge degraded", {
      windowId: runtime.windowId,
      session: runtime.deviceSid,
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      recoveryId: bridge.recoveryId,
      reasonCode,
    });
    runtime.pendingBridgeInvalidation = {
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: bridge.bridgeGeneration }),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      // Bugfix：checksum/oversize/future ACK 等 fault 不能伪装成 frame gap；
      // app control 只传通用恢复原因，typed reasonCode 留在上面的安全日志。
      reason: "rpc-transport-fault",
    };
    // Bug 原因：degraded 后 raw 两端都已禁止继续转发，保留旧 attachment 只会泄漏
    // scoped subscription。物理 Host/Agent 不受影响，只释放手机短生命周期 attachment。
    disposeRuntimeBridgeResources(runtime);
    services.sendPendingBridgeInvalidation(runtime);
  }

  function cancelBridgeOpen(runtime: WindowControlRuntime): void {
    const pending = runtime.bridgeOpen;
    runtime.bridgeOpen = undefined;
    if (pending?.preparingProject)
      dependencies.cancelProjectPreparation?.(runtime.windowId, pending.hostRequestId);
  }

  function createWorkspaceBridge(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    const intentKey = JSON.stringify([
      request.workspaceKey,
      request.taskId ?? null,
      request.project?.projectId,
      request.project?.hostId,
      request.project?.draftId,
      request.taskHostId,
      request.fileTreeTaskId,
    ]);
    const previous = runtime.bridgeOpen;
    if (
      previous?.bridgeSessionId === request.bridgeSessionId &&
      previous.bridgeGeneration === request.bridgeGeneration
    ) {
      if (previous.intentKey !== intentKey)
        return Promise.reject(new Error("Workspace bridge identity cannot change intent."));
      if (
        runtime.currentBridge?.degraded ||
        (runtime.pendingBridgeInvalidation?.bridgeSessionId === request.bridgeSessionId &&
          runtime.pendingBridgeInvalidation.bridgeGeneration === request.bridgeGeneration)
      )
        return Promise.reject(new Error("Degraded workspace bridge requires a new identity."));
      return previous.promise;
    }
    cancelBridgeOpen(runtime);
    // 同一 transport identity 的重试复用整次 admission；新导航立即使旧异步结果失效。
    const pending: NonNullable<WindowControlRuntime["bridgeOpen"]> = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      intentKey,
      hostRequestId: randomUUID(),
      preparingProject: Boolean(request.project || request.taskHostId),
      promise: undefined as never,
    };
    runtime.bridgeOpen = pending;
    pending.promise = buildWorkspaceBridge(runtime, request, pending);
    return pending.promise;
  }

  async function buildWorkspaceBridge(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
    pending: NonNullable<WindowControlRuntime["bridgeOpen"]>,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    let target: WebRemoteControlWorkspaceTarget | undefined;
    const intent: HostProjectWorkspaceNavigationInput | undefined =
      request.project ??
      ((request.fileTreeTaskId || request.taskId) && request.taskHostId
        ? {
            hostId: request.taskHostId,
            task: {
              taskId: (request.fileTreeTaskId ?? request.taskId)!,
              workspaceKey: request.workspaceKey,
            },
          }
        : undefined);
    if (intent) {
      if ((request.project && request.taskId) || !dependencies.prepareProjectWorkspace)
        throw new Error("Project navigation is unavailable.");
      try {
        const prepared = await dependencies.prepareProjectWorkspace(
          runtime.windowId,
          intent,
          pending.hostRequestId,
        );
        target = {
          workspacePath: prepared.workspacePath,
          workspaceIdentity: prepared.workspaceIdentity,
          remoteSessionId: prepared.remote?.remoteSessionId,
          kind: prepared.remote ? "remote" : "local",
          label: prepared.workspacePath,
          ...(prepared.remote ? { connectionState: "connected" as const } : {}),
        };
      } finally {
        pending.preparingProject = false;
      }
    } else {
      target = services
        .getAvailableWorkspaces(runtime)
        .find(
          (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === request.workspaceKey,
        );
    }
    if (state.runtimes.get(runtime.windowId) !== runtime || runtime.bridgeOpen !== pending)
      throw new Error("Workspace bridge request was superseded.");
    if (!target) {
      throw new Error("目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge。");
    }
    if (!isBridgeableRemoteTarget(target)) {
      throw new Error("目标远程工作区尚未连接，无法创建 bridge，请先重连。");
    }
    const targetWorkspaceKey = resolveWebRemoteControlWorkspaceKey(target);

    const invalidation = runtime.pendingBridgeInvalidation;
    if (
      invalidation?.bridgeSessionId === request.bridgeSessionId &&
      invalidation.bridgeGeneration === request.bridgeGeneration
    ) {
      throw new Error("Degraded workspace bridge must be rebuilt with a new transport identity.");
    }
    // 收到新 identity 的 open 已证明手机消费了 invalidation；后续失败由显式 bridge-error
    // 和 Web 侧有界 retry 收口，不再重复旧 generation 的 degraded 通知。
    runtime.pendingBridgeInvalidation = undefined;

    disposeRuntimeBridgeResources(runtime);
    runtime.status = "connecting";
    runtime.error = undefined;
    runtime.failure = undefined;
    services.emitRuntimeStatus(runtime);

    const bridgeRuntime: WorkspaceBridgeRuntime = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      hostEntryId: "",
      attachmentId: "",
      kind: target.kind,
      workspaceKey: targetWorkspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: request.taskId,
      readyAnnounced: false,
      degraded: false,
    };
    runtime.currentBridge = bridgeRuntime;

    dependencies.logger.info(
      `[web-remote-control] attaching workspace bridge window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId} workspace=${target.workspacePath}`,
    );

    let acquired: WebRemoteControlHostAttachmentHandle | undefined;
    try {
      acquired = await dependencies.attachWorkspaceHost(runtime.windowId, {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        initialTaskId: request.taskId,
        kind: target.kind,
      });
      if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || runtime.bridgeOpen !== pending) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
        acquired = undefined;
        throw new Error("Workspace bridge request was superseded.");
      }
      const hostProtocol = new MessagePortProtocol(wrapElectronPort(acquired.port));
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridgeRuntime.bridgeSessionId,
        bridgeGeneration: bridgeRuntime.bridgeGeneration,
        recoveryId: bridgeRuntime.recoveryId,
        measureFrameBytes: (frame) =>
          runtime.transport.measurePayloadBytes?.(frame) ??
          measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
        sendFrame: (payload) => {
          if (!bridgeRuntime.readyAnnounced || bridgeRuntime.degraded) return false;
          const result: WebRemoteControlPayloadSendResult = services.sendPayloadToTransport(
            runtime,
            payload,
          );
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });

      // Bugfix：raw adapter 是唯一 replay owner；main 不再把 rpc-frame 放进普通 50 项 buffer。
      const disposeHostToRelay = hostProtocol.onMessage((buffer) => {
        relayProtocol.protocol.send(buffer);
      });
      const disposeRelayToHost = relayProtocol.protocol.onMessage((buffer) => {
        hostProtocol.send(buffer);
      });
      const disposeDegraded = relayProtocol.onDegraded((fault) => {
        degradeBridgeAfterRawFault(runtime, bridgeRuntime, fault.reasonCode);
      });
      const disposeSaturated = relayProtocol.onSaturated(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("saturated");
      });
      const disposeDrained = relayProtocol.onDrained(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("drained");
      });

      bridgeRuntime.hostEntryId = acquired.entryId;
      bridgeRuntime.attachmentId = acquired.attachmentId;
      bridgeRuntime.hostProtocol = hostProtocol;
      bridgeRuntime.relayProtocol = relayProtocol;
      bridgeRuntime.disposeBridge = () => {
        disposeHostToRelay.dispose();
        disposeRelayToHost.dispose();
        disposeDegraded.dispose();
        disposeSaturated.dispose();
        disposeDrained.dispose();
      };
      runtime.status = "active";
      runtime.error = undefined;
      runtime.failure = undefined;
      services.emitRuntimeStatus(runtime);

      dependencies.logger.info(
        `[web-remote-control] workspace bridge active window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId}`,
      );
      services.reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "success",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
        }),
      );

      return toExternalBridge(bridgeRuntime);
    } catch (error) {
      services.reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "failure",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
          errorCategory: classifyRemoteUsageError(error),
        }),
      );
      if (acquired) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
      }
      if (isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        disposeRuntimeBridgeResources(runtime);
        runtime.status = runtime.mobileConnected ? "active" : "running";
        services.emitRuntimeStatus(runtime);
      }
      throw error;
    }
  }

  async function respondToWorkspaceBridgeOpen(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void> {
    try {
      const bridge = await createWorkspaceBridge(runtime, request);
      services.sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        bridge,
      });
      const currentBridge = runtime.currentBridge;
      if (
        currentBridge?.bridgeSessionId === request.bridgeSessionId &&
        currentBridge.bridgeGeneration === request.bridgeGeneration
      ) {
        // bridge-ready 必须先进入 ordinary app transport，才允许 queued raw frames 开闸。
        currentBridge.readyAnnounced = true;
        currentBridge.relayProtocol?.flushPendingFrames();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] workspace bridge failed window=${runtime.windowId} session=${runtime.deviceSid} workspaceKey=${request.workspaceKey} error=${message}`,
      );
      services.sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: mapWorkspaceBridgeFailureReason(error),
        error: message,
      });
    }
  }

  async function respondToWorkspaceReconnectRequest(
    runtime: WindowControlRuntime,
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void> {
    try {
      await dependencies.reconnectWorkspace(runtime.windowId, request.workspaceKey);
      services.sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: true,
      });
    } catch (error) {
      services.sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function routeRpcTransportPayload(
    runtime: WindowControlRuntime,
    frame: WebRemoteControlRpcTransportPayload,
  ): void {
    routeRawTransportCandidate(runtime, frame);
  }

  function routeRawTransportCandidate(runtime: WindowControlRuntime, payload: unknown): boolean {
    const bridge = runtime.currentBridge;
    if (!bridge || bridge.degraded) return false;
    return bridge.relayProtocol?.acceptPayload(payload) ?? false;
  }

  return {
    disposeRuntimeBridgeResources,
    cancelBridgeOpen,
    respondToWorkspaceBridgeOpen,
    respondToWorkspaceReconnectRequest,
    routeRpcTransportPayload,
    routeRawTransportCandidate,
  };
}
