// Subagent runner: parent events и порядок background-уведомлений.

import {
  SessionEventType,
  createSessionEvent,
  createTraceId,
  traceContextToLogContext,
  type SubagentRunRequest,
  type SubagentExecutionTerminalPayload,
  type TraceContext,
} from "@zcode/contracts";
import {
  isTerminalRuntimeTask,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";
import { type ExploreSubagentPortOptions, BACKGROUND_AGENT_STOPPED_STATE } from "./runner-types.js";

export async function emitBackgroundTaskCompletedEvent(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  task: RuntimeTaskSnapshot,
): Promise<void> {
  if (!isTerminalRuntimeTask(task)) return;
  await emitSubagentEvent(
    options,
    SessionEventType.BackgroundTaskCompleted,
    request,
    traceContext,
    {
      taskId: task.taskId,
      toolCallId: String(request.parentToolCallId),
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      cancellable: false,
      description: task.description,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      terminalId: task.taskId,
    },
  );
}

export async function emitRuntimeTaskBackgroundCompletedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.BackgroundTaskCompleted,
    task.parentSessionId,
    {
      taskId: task.taskId,
      toolCallId: String(task.parentToolCallId ?? task.taskId),
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      cancellable: false,
      description: task.description,
      status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      terminalId: task.taskId,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

export async function emitRuntimeTaskSubagentStoppedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
  totalDurationMs: number,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.SubagentStopped,
    task.parentSessionId,
    {
      agentId: task.agentId,
      agentType: task.agentType,
      background: true,
      childSessionId: task.childSessionId,
      parentToolCallId: task.parentToolCallId,
      status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
      outputFile: task.outputFile,
      totalDurationMs,
      error: task.error,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

export async function emitSubagentExecutionTerminal(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
  childStarted = true,
): Promise<void> {
  if (task.status === "running") return;
  if (!task.parentSessionId || !task.childSessionId || !task.rootRunId || !task.attemptId) {
    options.logger?.warn("Skipped subagent terminal event with incomplete lineage", {
      event: "subagent.execution_terminal.lineage_missing",
      module: "core.subagent",
      taskId: task.taskId,
    });
    return;
  }

  const parentTask = registry.getSubagentTaskByChildSession(task.parentSessionId);
  const branchGeneration = task.branchGeneration ?? 0;
  const terminalId = [task.rootRunId, task.taskId, String(branchGeneration), task.attemptId].join(
    "/",
  );
  const observedAt = task.completedAt ?? new Date();
  const payload: SubagentExecutionTerminalPayload = {
    // completed task 的 Host acceptance 已写入 output；terminal 不得再固定报告 unknown。
    acceptanceStatus:
      task.status === "completed" && task.output?.status === "completed"
        ? (task.output.acceptance?.status ?? "unknown")
        : "unknown",
    branchGeneration,
    attemptId: task.attemptId,
    childStarted,
    childSessionId: task.childSessionId,
    observedAt,
    parentTaskId: parentTask?.taskId,
    provenance: "runtime_lifecycle",
    rootRunId: task.rootRunId,
    schema: "zcode.prism.subagent-terminal.v3",
    taskId: task.taskId,
    terminalId,
    // 原因：Registry 的 killed 表示启动流程已被中止；child 从未启动时对外应报告 cancelled。
    terminalStatus: !childStarted && task.status === "killed" ? "cancelled" : task.status,
  };
  const event = createSessionEvent(
    SessionEventType.SubagentExecutionTerminal,
    task.parentSessionId,
    payload,
    { turnId: task.turnId, traceId: traceContext.traceId },
  );

  try {
    await options.emitParentEvent(event, traceContext);
  } catch {
    // Receipt persistence is best-effort; never change a settled task or log untrusted error text.
    options.logger?.warn("Subagent terminal lifecycle event append failed", {
      event: "subagent.execution_terminal.append_failed",
      module: "core.subagent",
      taskId: task.taskId,
    });
  }
  try {
    const archived = await options.persistTerminalTaskCatalog?.(task);
    if (archived) {
      // 原因：compact snapshot 的数量随任务累计；只有 root-session catalog 已持久化后才允许逐出。
      registry.markTerminalTaskArchived?.(task.taskId, task.attemptId);
    }
  } catch {
    options.logger?.warn("Subagent terminal catalog persistence failed", {
      event: "subagent.terminal_catalog.persist_failed",
      module: "core.subagent",
      taskId: task.taskId,
    });
  }
}

export function enqueueBackgroundNotification(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  taskId: string,
  message: string,
  traceContext: TraceContext,
): boolean {
  if (!options.enqueueParentTaskNotification) {
    options.logger?.warn("Skipped subagent background notification without parent queue", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.skipped",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  const task = registry.get(taskId);
  if (!task || task.notified) {
    options.logger?.debug("Skipped duplicate subagent background notification", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.duplicate",
      module: "core.subagent",
      reason: task ? "already_notified" : "task_missing",
      taskId,
    });
    return false;
  }

  try {
    options.enqueueParentTaskNotification({
      originMeta: {
        backgroundSource: "subagent",
        title: task.description.trim() || taskId,
        workId: taskId,
      },
      taskId,
      text: message,
      traceContext,
    });
  } catch (error) {
    options.logger?.warn("Failed to enqueue subagent background notification", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.background.notification.failed",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  registry.update(taskId, (current) =>
    current.notified
      ? current
      : {
          ...current,
          notified: true,
        },
  );
  options.logger?.info?.("Subagent background notification enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "subagent.background.notification.enqueued",
    module: "core.subagent",
    taskId,
  });
  return true;
}

export function traceContextFromRuntimeTask(task: RuntimeTaskSnapshot): TraceContext {
  return (
    task.traceContext ?? {
      traceId: createTraceId(),
      spanId: `span_${task.taskId}`,
      sessionId: task.parentSessionId,
      turnId: task.turnId,
    }
  );
}

/** Additive run correlation для SubagentSpawned: старые подписчики просто не читают поля. */
export function taskCorrelationPayload(
  registry: RuntimeTaskRegistry,
  taskId: string,
): { runId?: string; attemptId?: string } {
  const task = registry.get(taskId);
  return {
    ...(task?.rootRunId ? { runId: task.rootRunId } : {}),
    ...(task?.attemptId ? { attemptId: task.attemptId } : {}),
  };
}

export async function emitSubagentEvent(
  options: ExploreSubagentPortOptions,
  type: SessionEventType,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const eventPayload = request.orchestrationRunId
    ? {
        ...payload,
        orchestrationRunId: request.orchestrationRunId,
        // The internal legacy correlation key is not a model-issued tool call.
        parentToolCallId: undefined,
      }
    : payload;
  const event = createSessionEvent(type, request.sessionId, eventPayload, {
    turnId: request.turnId,
    traceId: traceContext.traceId,
  });
  await options.emitParentEvent(event, traceContext);
}

