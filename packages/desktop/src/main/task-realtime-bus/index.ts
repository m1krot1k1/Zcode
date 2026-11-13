/*
 * 当前生产状态（2026-11-12，见 docs/specs/2026-11-11-owner-lease-mirror-decision.md）：
 * 只有跨 Host session route（SessionRouteAnnounce / SessionMessageSendRequested / SessionMessageDeliver）
 * 有 Host 生产者。lease、stream mirror、owner-command 是 wire 兼容的 inert 状态，Host 不再创建
 * taskRealtimeBridge，也不再注入 realtime port；不要在未补消费者和 stale-run/去重验证前重新接线。
 *
 * 模块拆分（2026-11-13）：本文件只负责 Host 注册表、消息路由和状态装配；
 * 租约、stream mirror、owner-command、session message 与事件去重分别在
 * 同目录的 leases / stream-batches / stream-delivery / owner-commands /
 * session-messages / dedup 模块中，全部读写同一个 TaskRealtimeBusState。
 */
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  type TaskRealtimeEvent,
  type TaskRealtimeHostDeliveryKind,
  type TaskRunLeaseAcquireRequest,
  type TaskStreamMirrorPublishOp,
  formatZodError,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
} from "@zcode/shared";
import { logger as defaultLogger } from "../logger.js";
import { rememberEventId } from "./dedup.js";
import { deliverRealtimeEvent, deliverSnapshotInvalidation } from "./delivery.js";
import { acquireLease, releaseLease, releaseLeasesForHost } from "./leases.js";
import {
  failPendingOwnerCommandsForHost,
  handleOwnerCommandRequest,
  handleOwnerCommandResult,
} from "./owner-commands.js";
import {
  failPendingSessionMessagesForHost,
  handleSessionMessageDeliverResult,
  handleSessionMessageSendRequested,
  unregisterSessionRoutesForHost,
} from "./session-messages.js";
import { TaskRealtimeBusState } from "./state.js";
import {
  flushMatchingStreamBatchBeforeInvalidation,
  handleStreamOpPublish,
} from "./stream-batches.js";
import { replayVisibleRunsToHost } from "./stream-delivery.js";
import type {
  HostExitListener,
  HostMessageListener,
  RegisteredRealtimeHost,
  TaskRealtimeBusOptions,
} from "./types.js";

export class TaskRealtimeBus {
  private readonly state: TaskRealtimeBusState;

  constructor(options: TaskRealtimeBusOptions = {}) {
    this.state = new TaskRealtimeBusState(
      options.logger ?? defaultLogger,
      options.seenEventLimit ?? 1000,
    );
  }

  registerHost(params: {
    hostId: string;
    windowId: number;
    child: ElectronUtilityProcess;
    workspaceKeys: Iterable<string>;
    deliveryKind?: TaskRealtimeHostDeliveryKind;
  }): void {
    const existing = this.state.hosts.get(params.hostId);
    if (existing) {
      this.unregisterHost(params.hostId);
    }

    const onMessage: HostMessageListener = (message) => {
      this.handleHostMessage(params.hostId, message);
    };
    const onExit: HostExitListener = () => {
      this.unregisterHost(params.hostId);
    };

    params.child.on("message", onMessage);
    params.child.once("exit", onExit);

    const workspaceKeys = new Set(params.workspaceKeys);
    const deliveryKind = params.deliveryKind ?? "desktop_window";
    this.state.hosts.set(params.hostId, {
      hostId: params.hostId,
      windowId: params.windowId,
      child: params.child,
      workspaceKeys,
      deliveryKind,
      onMessage,
      onExit,
    });

    this.state.logger.info("[task-realtime] registered host", {
      hostId: params.hostId,
      windowId: params.windowId,
      workspaceKeyCount: workspaceKeys.size,
      deliveryKind,
    });

    replayVisibleRunsToHost(this.state, params.hostId, workspaceKeys);
  }

  unregisterHost(hostId: string): void {
    const registered = this.state.hosts.get(hostId);
    if (!registered) {
      return;
    }

    registered.child.off?.("message", registered.onMessage);
    registered.child.off?.("exit", registered.onExit);
    this.state.hosts.delete(hostId);
    failPendingOwnerCommandsForHost(this.state, hostId, "Owner command host exited.");
    unregisterSessionRoutesForHost(this.state, hostId);
    failPendingSessionMessagesForHost(this.state, hostId, "Session message host exited.");
    const releasedLeases = releaseLeasesForHost(this.state, hostId);
    for (const lease of releasedLeases) {
      deliverSnapshotInvalidation(this.state, lease, hostId, "stream_mirror_owner_lost");
    }

    this.state.logger.info("[task-realtime] unregistered host", {
      hostId,
      windowId: registered.windowId,
    });
  }

  updateHostWorkspaceKeys(hostId: string, workspaceKeys: Iterable<string>): void {
    const registered = this.state.hosts.get(hostId);
    if (!registered) {
      this.state.logger.warn("[task-realtime] workspace update for unknown host", { hostId });
      return;
    }

    const previous = registered.workspaceKeys;
    const next = new Set(workspaceKeys);
    registered.workspaceKeys = next;
    this.state.logger.info("[task-realtime] updated host workspace scopes", {
      hostId,
      workspaceKeyCount: registered.workspaceKeys.size,
    });
    replayVisibleRunsToHost(
      this.state,
      hostId,
      [...next].filter((workspaceKey) => !previous.has(workspaceKey)),
    );
  }

  getHostDeliveryKindForTest(hostId: string): TaskRealtimeHostDeliveryKind | undefined {
    return this.state.hosts.get(hostId)?.deliveryKind;
  }

  private handleHostMessage(hostId: string, message: unknown): void {
    const parsed = hostResponseMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.state.logger.warn(
        "[task-realtime] invalid host response message:",
        formatZodError(parsed.error),
      );
      return;
    }

    const origin = this.state.hosts.get(hostId);
    if (!origin) {
      this.state.logger.warn("[task-realtime] publish from unknown host", { hostId });
      return;
    }

    switch (parsed.data.type) {
      case HostResponseTypes.TaskRealtimePublish:
        this.handleRealtimePublish(origin, parsed.data.event as TaskRealtimeEvent);
        break;
      case HostResponseTypes.TaskRunLeaseAcquire:
        this.handleLeaseAcquire(origin, parsed.data.request);
        break;
      case HostResponseTypes.TaskRunLeaseRelease:
        releaseLease(this.state, origin.hostId, parsed.data.target);
        break;
      case HostResponseTypes.TaskStreamOpPublish:
        handleStreamOpPublish(
          this.state,
          origin,
          parsed.data.target,
          parsed.data.op as TaskStreamMirrorPublishOp,
        );
        break;
      case HostResponseTypes.TaskOwnerCommandRequest:
        handleOwnerCommandRequest(this.state, origin, parsed.data.command);
        break;
      case HostResponseTypes.TaskOwnerCommandResult:
        handleOwnerCommandResult(this.state, origin, parsed.data.result);
        break;
      case HostResponseTypes.SessionMessageSendRequested:
        handleSessionMessageSendRequested(this.state, origin, parsed.data.request);
        break;
      case HostResponseTypes.SessionRouteAnnounce:
        this.rememberSessionRoute(origin, parsed.data.route);
        break;
      case HostResponseTypes.SessionMessageDeliverResult:
        handleSessionMessageDeliverResult(this.state, origin, parsed.data.result);
        break;
      default:
        break;
    }
  }

  private rememberSessionRoute(
    origin: RegisteredRealtimeHost,
    route: {
      sessionId: string;
    },
  ): void {
    this.state.sessionRoutes.set(route.sessionId, origin.hostId);
  }

  private handleRealtimePublish(origin: RegisteredRealtimeHost, event: TaskRealtimeEvent): void {
    if (!rememberEventId(this.state, event.eventId)) {
      return;
    }
    flushMatchingStreamBatchBeforeInvalidation(this.state, event);
    deliverRealtimeEvent(this.state, { ...event, originHostId: origin.hostId }, () => true);
  }

  private handleLeaseAcquire(
    origin: RegisteredRealtimeHost,
    request: TaskRunLeaseAcquireRequest,
  ): void {
    origin.child.postMessage({
      type: HostMessageTypes.TaskRunLeaseResult,
      result: acquireLease(this.state, origin.hostId, request),
    });
  }

  /** 内存诊断计数器；只读 size。 */
  collectMemoryDiagnostics(): Record<string, number> {
    return {
      streamBatches: this.state.streamBatches.size,
      leases: this.state.leases.size,
      sessionRoutes: this.state.sessionRoutes.size,
    };
  }
}
