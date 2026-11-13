import type { Logger, SessionId } from "@zcode/contracts";
import { createSessionEvent, SessionEventType } from "@zcode/contracts";
import {
  networkCaptureControlSchema,
  zcodeOpenCodeAgentRunEventSchema,
  zcodeProtocolMethods,
  type ZCodeProtocolError,
  type ZCodeProtocolMessage,
  type ZCodeProtocolRequest,
  type ZCodeProtocolRequestId,
  type ZCodeProtocolResponse,
} from "@zcode/shared";
import {
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  ProtocolRequestError,
  type PendingClientRequest,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";
import { abortPluginOperations, type PluginOperationRegistries } from "./server-plugin-ops.js";

/** 与 CLI 侧 createNodeNetworkCapture 的公开面一致；server 只切换 captureId。 */
export interface ProtocolNetworkCapture {
  setCaptureId(captureId: string | null): void;
}

/**
 * handleMessage 需要的最小 server 能力：反向请求的落定、request 处理入口。
 * 用回调而不是回指 server 实例，避免 lifecycle ↔ server 的双向依赖。
 */
export interface ProtocolMessageHooks {
  resolveClientRequest(id: ZCodeProtocolRequestId, result: unknown): void;
  rejectClientRequest(id: ZCodeProtocolRequestId, error: Error): void;
  handleRequest(
    request: ZCodeProtocolRequest,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse>;
}

export interface ProtocolMessageHost extends ProtocolMessageHooks {
  readonly context: ZCodeProtocolAgentServerContext;
  readonly logger?: Logger;
  readonly networkCapture: ProtocolNetworkCapture;
  assertServing(): void;
}

/**
 * 单条入站消息的多路复用：response/error/request/notification 各有独立语义，
 * 只有 request 会产生应答；notification 只做 side effect。
 */
export async function handleProtocolMessage(
  host: ProtocolMessageHost,
  message: ZCodeProtocolMessage,
): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined> {
  host.assertServing();
  if (isResponse(message)) {
    host.resolveClientRequest(message.id, message.result);
    return undefined;
  }
  if (isErrorResponse(message)) {
    host.rejectClientRequest(
      message.id,
      new ProtocolRequestError(message.error.code, message.error.message, message.error.data),
    );
    return undefined;
  }
  if (isRequest(message)) {
    return await host.handleRequest(message);
  }
  if (isNotification(message)) {
    if (message.method === zcodeProtocolMethods.processNetworkCapture) {
      const control = networkCaptureControlSchema.safeParse(message.params);
      if (control.success) host.networkCapture.setCaptureId(control.data.captureId);
      return undefined;
    }
    if (message.method === zcodeProtocolMethods.interactionOpenCodeAgentRunEvent) {
      const parsed = zcodeOpenCodeAgentRunEventSchema.safeParse(message.params);
      if (!parsed.success) {
        host.logger?.warn("Rejected malformed OpenCode delegated run event", {
          event: "zcode_protocol.opencode_run_event.invalid",
        });
        return undefined;
      }
      const event = parsed.data;
      const store = host.context.deps.sessionStore;
      const sessionID = event.zcodeSessionId as SessionId;
      // SqliteSessionStore 的方法通过 this.db 访问数据库；直接解构后调用会丢失 store 接收者，导致 CLI 进程崩溃。
      const run = await store?.getOpenCodeAgentRun?.({ sessionID, runID: event.runId });
      if (
        !run ||
        run.commandID !== event.commandId ||
        run.runID !== event.runId ||
        run.sessionID !== sessionID ||
        !store?.getOpenCodeAgentRun ||
        !store?.applyOpenCodeAgentRunHostEvent
      ) {
        host.logger?.warn("Ignored OpenCode delegated run event without matching outbox owner", {
          commandId: event.commandId,
          runId: event.runId,
          sessionId: event.zcodeSessionId,
          sequence: event.sequence,
        });
        return undefined;
      }
      if (event.sequence !== run.hostEventSequence + 1) {
        host.logger?.warn("Rejected out-of-order OpenCode delegated run event", {
          commandId: event.commandId,
          expectedSequence: run.hostEventSequence + 1,
          receivedSequence: event.sequence,
          runId: event.runId,
          sessionId: event.zcodeSessionId,
        });
        return undefined;
      }
      if (event.event.type !== "started" && run.openCodeSessionID !== event.opencodeSessionId) {
        host.logger?.warn("Rejected OpenCode delegated event with mismatched ACP session", {
          commandId: event.commandId,
          runId: event.runId,
          sessionId: event.zcodeSessionId,
        });
        return undefined;
      }
      const eventType = event.event.type;
      const status =
        eventType === "completed"
          ? "completed"
          : eventType === "cancelled"
            ? "cancelled"
            : eventType === "failed"
              ? "failed"
              : eventType === "interrupted"
                ? "interrupted"
                : "running";
      const applied = await store.applyOpenCodeAgentRunHostEvent({
        sessionID,
        runID: event.runId,
        expectedStatus: run.status,
        expectedEventSequence: run.eventSequence,
        eventSequence: run.eventSequence + 1,
        expectedHostEventSequence: run.hostEventSequence,
        hostEventSequence: event.sequence,
        hostEvent: event.event,
        status,
        ...(status === "running" ? { openCodeSessionID: event.opencodeSessionId } : {}),
        ...(eventType === "completed"
          ? {
              stopReason: event.event.stopReason,
              resultText: event.event.finalText,
            }
          : {}),
        ...("diagnosticCode" in event.event && event.event.diagnosticCode
          ? { diagnosticCode: event.event.diagnosticCode }
          : {}),
      });
      if (!applied) {
        host.logger?.warn("OpenCode delegated run event lost its compare-and-set", {
          commandId: event.commandId,
          runId: event.runId,
          sequence: event.sequence,
          outboxStatus: run.status,
        });
        return undefined;
      }
      const updatedRun = await store.getOpenCodeAgentRun({ sessionID, runID: event.runId });
      const record = host.context.sessions.get(String(sessionID));
      if (updatedRun && record) {
        const projected = createSessionEvent(
          SessionEventType.OpenCodeAgentRunUpdated,
          sessionID,
          {
            runId: updatedRun.runID,
            commandId: updatedRun.commandID,
            ...(updatedRun.requestedModelID ? { modelId: updatedRun.requestedModelID } : {}),
            promptText: updatedRun.promptText,
            outputText: updatedRun.outputText,
            tools: updatedRun.toolActivity,
            status:
              updatedRun.status === "pending" || updatedRun.status === "dispatching"
                ? "starting"
                : updatedRun.status,
            startedAt: updatedRun.time.created,
            ...(updatedRun.time.terminal !== undefined
              ? { endedAt: updatedRun.time.terminal }
              : {}),
            ...(updatedRun.diagnosticCode
              ? { diagnosticCode: updatedRun.diagnosticCode }
              : {}),
          },
          { traceId: record.traceContext.traceId },
        );
        const persisted = await record.eventStore.append(projected);
        host.context.v4Gateway?.ingest(String(sessionID), persisted);
        if (
          event.event.type === "permissionRequested" ||
          event.event.type === "permissionResolved"
        ) {
          // Permission details are live-only: project them to current subscribers without
          // appending them to EventStore or the OpenCode run journal.
          const permissionEvent = createSessionEvent(
            SessionEventType.OpenCodeAgentPermissionUpdated,
            sessionID,
            {
              commandId: event.commandId,
              runId: event.runId,
              opencodeSessionId: event.opencodeSessionId,
              requestId: event.event.requestId,
              state: event.event.type === "permissionRequested" ? "requested" : "resolved",
              ...(event.event.type === "permissionRequested"
                ? {
                    request: {
                      title: event.event.title,
                      ...(event.event.inputSummary
                        ? { inputSummary: event.event.inputSummary }
                        : {}),
                      options: event.event.options,
                    },
                  }
                : { cancelled: event.event.cancelled }),
            },
            { traceId: record.traceContext.traceId },
          );
          host.context.v4Gateway?.ingest(String(sessionID), permissionEvent);
        }
      }
      return undefined;
    }
    host.logger?.debug("ZCode Protocol notification ignored", {
      event: "zcode_protocol.notification.ignored",
      method: message.method,
      module: "bootstrap.zcode_protocol",
    });
  }
  return undefined;
}

export interface ProtocolDisconnectHost {
  readonly context: ZCodeProtocolAgentServerContext;
  readonly logger?: Logger;
  readonly networkCapture: ProtocolNetworkCapture;
  readonly pendingClientRequests: Map<string, PendingClientRequest<unknown>>;
  readonly operations: PluginOperationRegistries;
  cleanupClientRequest(pending: PendingClientRequest<unknown>): void;
}

/** 协议 owner 消失即前台执行的终止边界；见下方 Bash/工具循环的孤儿进程说明。 */
export function disconnectProtocolClient(host: ProtocolDisconnectHost, error: Error): void {
  host.networkCapture.setCaptureId(null);
  // 连接关闭后反向请求已不可能收到响应，必须先结束 pending，
  // 否则正在物化 Session 的 handler 会阻塞 connection 的关闭流程。
  const pendingRequests = new Set(host.pendingClientRequests.values());
  for (const pending of pendingRequests) {
    host.cleanupClientRequest(pending);
    pending.reject(error);
  }
  // Bug 原因：Server Core 被 SIGKILL 后，Agent 的 stdin 虽然收到 EOF，但连接关闭
  // 只拒绝了反向请求，没有打断已经进入 Bash/工具循环的前台执行。transport 会继续
  // 等待该请求自然结束，旧 Agent 因而成为 PPID 1 的孤儿并在新 Core generation 之外
  // 继续写文件。协议 owner 消失就是本进程全部前台执行的终止边界，必须同步取消。
  for (const record of host.context.sessions.values()) {
    try {
      record.app.runtime.stopActiveForegroundExecution?.({
        reason: "ZCode Protocol owner disconnected",
      });
    } catch (cause) {
      host.logger?.warn("Failed to stop foreground execution after protocol disconnect", {
        errorType: cause instanceof Error ? cause.name : typeof cause,
        sessionId: record.app.sessionId,
      });
    }
    record.activeAbortController?.abort(error);
  }
  abortPluginOperations(host.operations, error);
}

/** 同一 60s 节拍：subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。 */
export function pruneProtocolSessionEventStores(
  context: ZCodeProtocolAgentServerContext,
  nowMs: number = Date.now(),
): number {
  let evicted = 0;
  for (const record of context.sessions.values()) {
    evicted += record.eventStore.pruneTransientEvents?.(nowMs) ?? 0;
  }
  return evicted;
}

/** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */
export function pruneProtocolDetachedChildPublishers(
  context: ZCodeProtocolAgentServerContext,
  nowMs: number = Date.now(),
): number {
  return context.v4Gateway?.pruneDetachedChildPublishers(nowMs) ?? 0;
}

/**
 * 内存诊断计数器，随 60s 资源采样写本地日志。
 * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
 */
export function collectProtocolMemoryDiagnostics(
  context: ZCodeProtocolAgentServerContext,
): Record<string, number> {
  let eventRows = 0;
  let eventEvicted = 0;
  let eventTransientRetained = 0;
  for (const record of context.sessions.values()) {
    const stats = record.eventStore.getStats?.();
    eventRows += stats?.events ?? 0;
    eventEvicted += stats?.evictedEvents ?? 0;
    eventTransientRetained += stats?.retainedTransient ?? 0;
  }
  const counters: Record<string, number> = {
    sessions: context.sessions.size,
    eventRows,
    eventEvicted,
    eventTransientRetained,
  };
  const v4 = context.v4Gateway?.collectMemoryDiagnostics();
  if (v4) {
    for (const [key, value] of Object.entries(v4)) {
      counters[`v4.${key}`] = value;
    }
  }
  return counters;
}

/** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */
export function disposeProtocolProjections(context: ZCodeProtocolAgentServerContext): void {
  context.v4Gateway?.dispose();
  context.sessions.clear();
}
