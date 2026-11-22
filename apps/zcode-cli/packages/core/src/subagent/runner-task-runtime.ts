// Subagent runner: lifecycle задачи, abort/deadline и terminal settlement.

import {
  AgentErrorCode,
  CoreErrorType,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  createSessionId,
  traceContextToLogContext,
  type AgentBackgroundedOutput,
  type SubagentRunRequest,
} from "@zcode/contracts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentProfile } from "./profile.js";
import { formatLocalAgentTaskNotification } from "./completion-notification.js";
import {
  isTerminalRuntimeTask,
  runtimeTaskOutputFile,
  type RuntimeTaskAdmissionResult,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";
import type { ExploreSubagentPortOptions, SubagentLifecycle } from "./runner-types.js";
import { writeFailedAgentArtifacts } from "./runner-artifacts.js";
import {
  emitSubagentEvent,
  emitSubagentExecutionTerminal,
  enqueueBackgroundNotification,
  emitBackgroundTaskCompletedEvent,
} from "./runner-notifications.js";

export interface SubagentTaskAbortHandle {
  abort(reason?: unknown): void;
  detachParent(): void;
  dispose(): void;
  settle(snapshot?: RuntimeTaskSnapshot): void;
  settled: Promise<void | RuntimeTaskSnapshot>;
  signal: AbortSignal;
}

export function createSubagentTaskAbortController(parentSignal?: AbortSignal): SubagentTaskAbortHandle {
  const controller = new AbortController();
  let resolveSettled!: (snapshot?: RuntimeTaskSnapshot) => void;
  let isSettled = false;
  const settled = new Promise<void | RuntimeTaskSnapshot>((resolve) => {
    resolveSettled = resolve;
  });
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason ?? new Error("Subagent task aborted"));
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const detachParent = (): void => {
    parentSignal?.removeEventListener("abort", onParentAbort);
  };
  const dispose = (): void => {
    detachParent();
  };

  return {
    abort: (reason?: unknown) => controller.abort(reason),
    detachParent,
    dispose,
    settle: (snapshot) => {
      if (isSettled) return;
      isSettled = true;
      resolveSettled(snapshot);
    },
    settled,
    signal: controller.signal,
  };
}

const SUBAGENT_TASK_DEADLINE_ERROR_MESSAGE = "Subagent task deadline exceeded";
// Partial report ограничен, чтобы deadline-артефакт и abort reason не раздувались
// историей длинного assistant message.
const SUBAGENT_DEADLINE_PARTIAL_REPORT_MAX_CHARS = 4_000;

interface SubagentTaskDeadlineHandle {
  clear(): void;
}

/**
 * Hard per-task deadline. Timer принадлежит задаче, а не вызывающему turn: foreground run,
 * auto-background и explicit background start очищают его только вместе с settlement.
 */
export function createSubagentTaskDeadline(input: {
  lifecycle: SubagentLifecycle;
  options: ExploreSubagentPortOptions;
  registry: RuntimeTaskRegistry;
  request: SubagentRunRequest;
  taskAbort: SubagentTaskAbortHandle;
}): SubagentTaskDeadlineHandle {
  let timeoutMs: number | undefined;
  try {
    timeoutMs = input.options.getTaskTimeoutMs?.(input.request.agentType);
  } catch (error) {
    input.options.logger?.warn("Subagent task deadline resolution failed", {
      ...traceContextToLogContext(input.lifecycle.runTraceContext),
      agentId: input.lifecycle.agentId,
      agentType: input.request.agentType,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.task.deadline_resolution_failed",
      module: "core.subagent",
    });
    return { clear: () => {} };
  }
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { clear: () => {} };
  }
  // Stalled setup тоже входит в deadline: отсчёт идёт от фактического старта задачи.
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - input.lifecycle.startedAt));
  const timer = setTimeout(() => {
    void failSubagentTaskOnDeadline({ ...input, timeoutMs }).catch((error: unknown) => {
      input.options.logger?.warn("Subagent task deadline finalization failed", {
        ...traceContextToLogContext(input.lifecycle.runTraceContext),
        agentId: input.lifecycle.agentId,
        agentType: input.request.agentType,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent.task.deadline_finalization_failed",
        module: "core.subagent",
      });
    });
  }, remainingMs);
  return { clear: () => clearTimeout(timer) };
}

/**
 * Причина: при hard deadline parent Task получал только константную ошибку, хотя
 * assistant text child-сессии уже закоммичен в event store. Читаем bounded-снимок
 * через единственный публичный reader и возвращаем partial report, не меняя
 * канонический registry status/error. Любая ошибка чтения — only canonical message.
 */
async function readSubagentDeadlinePartialReport(
  lifecycle: Pick<SubagentLifecycle, "agentId" | "childSessionId" | "runTraceContext">,
  options: ExploreSubagentPortOptions,
): Promise<string | undefined> {
  if (!options.getChildEventsAfter) return undefined;
  try {
    const events = await options.getChildEventsAfter(lifecycle.childSessionId, 0);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== SessionEventType.AssistantMessage) continue;
      const payload = event.payload as { content?: unknown } | undefined;
      const content = typeof payload?.content === "string" ? payload.content.trim() : "";
      if (!content) continue;
      return content.length > SUBAGENT_DEADLINE_PARTIAL_REPORT_MAX_CHARS
        ? `${content.slice(0, SUBAGENT_DEADLINE_PARTIAL_REPORT_MAX_CHARS)}\n[truncated]`
        : content;
    }
    return undefined;
  } catch (error) {
    options.logger?.warn("Subagent deadline partial report read failed", {
      ...traceContextToLogContext(lifecycle.runTraceContext),
      agentId: lifecycle.agentId,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.task.deadline_partial_report_failed",
      module: "core.subagent",
    });
    return undefined;
  }
}

function formatSubagentDeadlineFailureMessage(partialReport: string | undefined): string {
  if (!partialReport) return SUBAGENT_TASK_DEADLINE_ERROR_MESSAGE;
  return `${SUBAGENT_TASK_DEADLINE_ERROR_MESSAGE}\n\nPartial report:\n${partialReport}`;
}

async function failSubagentTaskOnDeadline(input: {
  lifecycle: SubagentLifecycle;
  options: ExploreSubagentPortOptions;
  registry: RuntimeTaskRegistry;
  request: SubagentRunRequest;
  taskAbort: SubagentTaskAbortHandle;
  timeoutMs: number;
}): Promise<void> {
  const { lifecycle, options, registry, request, taskAbort, timeoutMs } = input;
  const createDeadlineError = (message: string) =>
    createCoreError(CoreErrorType.ToolTimeout, message, {
      context: {
        code: AgentErrorCode.CHILD_RUNTIME_FAILED,
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        parentToolCallId: request.parentToolCallId,
        timeoutMs,
      },
      recoverable: true,
      retryable: true,
    });
  const error = createDeadlineError(SUBAGENT_TASK_DEADLINE_ERROR_MESSAGE);
  options.logger?.warn("Subagent task deadline exceeded", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    event: "subagent.task.deadline_exceeded",
    module: "core.subagent",
    parentToolCallId: request.parentToolCallId,
    status: "failed",
    timeoutMs,
  });
  const current = registry.get(lifecycle.agentId);
  if (!current || isTerminalRuntimeTask(current)) {
    // Deadline сработал после терминального перехода: aborted child уже не нужен,
    // но повторно писать terminal status нельзя.
    taskAbort.abort(error);
    return;
  }
  if (!registry.beginSubagentTaskFinalization(lifecycle.agentId)) {
    // Другой финализатор уже владеет переходом; abort всё равно должен дойти до child.
    taskAbort.abort(error);
    return;
  }
  // Partial читается до terminal transition: registry остаётся на канонической строке,
  // а расширенное сообщение уходит только в abort reason, artifacts и stopped payload.
  const partialReport = await readSubagentDeadlinePartialReport(lifecycle, options);
  const failureMessage = formatSubagentDeadlineFailureMessage(partialReport);
  const abortError =
    failureMessage === SUBAGENT_TASK_DEADLINE_ERROR_MESSAGE
      ? error
      : createDeadlineError(failureMessage);
  // Сначала фиксируем terminal failed, затем abort: даже child, игнорирующий signal,
  // не оставляет задачу в running. Порядок не даёт abort-пути записать статус killed.
  const completedAt = new Date();
  const totalDurationMs = Math.max(0, completedAt.getTime() - current.startedAt.getTime());
  const terminalTask = registry.update(lifecycle.agentId, (task) =>
    isTerminalRuntimeTask(task)
      ? task
      : {
          ...withoutRuntimeMessageState(task),
          status: "failed",
          completedAt,
          error: SUBAGENT_TASK_DEADLINE_ERROR_MESSAGE,
          usage: { durationMs: totalDurationMs },
        },
  );
  taskAbort.abort(abortError);
  const ownsDeadlineTerminal =
    terminalTask?.status === "failed" &&
    terminalTask.error === SUBAGENT_TASK_DEADLINE_ERROR_MESSAGE;
  if (!ownsDeadlineTerminal) {
    releaseTaskAbortHandle(registry, lifecycle.agentId, taskAbort);
    return;
  }
  try {
    await writeFailedAgentArtifacts(lifecycle, request, failureMessage);
  } catch (artifactError) {
    options.logger?.warn("Subagent deadline artifact write failed", {
      ...traceContextToLogContext(lifecycle.runTraceContext),
      agentId: lifecycle.agentId,
      errorMessage: artifactError instanceof Error ? artifactError.message : String(artifactError),
      event: "subagent.task.deadline_artifact_failed",
      module: "core.subagent",
    });
  }
  try {
    await emitSubagentExecutionTerminal(
      options,
      registry,
      terminalTask,
      lifecycle.runTraceContext,
    );
    if (terminalTask.isBackgrounded) {
      enqueueBackgroundNotification(
        options,
        registry,
        lifecycle.agentId,
        formatLocalAgentTaskNotification({
          agentId: terminalTask.agentId,
          agentType: request.agentType,
          description: request.description,
          error: failureMessage,
          outputFile: lifecycle.outputFile,
          parentToolCallId: String(request.parentToolCallId),
          status: "failed",
          totalDurationMs,
        }),
        lifecycle.runTraceContext,
      );
      await emitBackgroundTaskCompletedEvent(
        options,
        request,
        lifecycle.runTraceContext,
        terminalTask,
      );
    }
    await emitSubagentEvent(
      options,
      SessionEventType.SubagentStopped,
      request,
      lifecycle.runTraceContext,
      {
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        ...(terminalTask.isBackgrounded ? { background: true } : {}),
        childSessionId: lifecycle.childSessionId,
        parentToolCallId: request.parentToolCallId,
        status: "failed",
        ...(terminalTask.isBackgrounded ? { outputFile: lifecycle.outputFile } : {}),
        totalDurationMs,
        error: failureMessage,
      },
    );
  } catch (eventError) {
    options.logger?.warn("Subagent deadline event emit failed", {
      ...traceContextToLogContext(lifecycle.runTraceContext),
      agentId: lifecycle.agentId,
      errorMessage: eventError instanceof Error ? eventError.message : String(eventError),
      event: "subagent.task.deadline_event_failed",
      module: "core.subagent",
    });
  } finally {
    releaseTaskAbortHandle(registry, lifecycle.agentId, taskAbort);
  }
}

function releaseTaskAbortHandle(
  registry: RuntimeTaskRegistry,
  taskId: string,
  taskAbort: SubagentTaskAbortHandle,
): void {
  taskAbort.dispose();
  registry.releaseSubagentCancellationHandle(taskId, taskAbort);
  taskAbort.settle(registry.get(taskId));
}

export function registerSubagentTask(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  cancellation: SubagentTaskAbortHandle,
): RuntimeTaskAdmissionResult {
  return registry.registerSubagentTask(task, cancellation);
}

export function createSubagentLifecycle(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
  registry: RuntimeTaskRegistry,
): SubagentLifecycle {
  const agentId = options.createAgentId?.() ?? `agent_${crypto.randomUUID()}`;
  const childSessionId = createSessionId(`subagent_${agentId}`);
  const startedAt = Date.now();
  const outputRootDir = options.outputRootDir ?? join(tmpdir(), "zcode-agents");
  const outputFile = runtimeTaskOutputFile(
    outputRootDir,
    registry.getRootSessionIdForSession(request.sessionId),
    agentId,
  );
  const agentOutputDir = dirname(outputFile);
  const metadataFile = join(agentOutputDir, "metadata.json");
  const taskOutputFile = join(agentOutputDir, "task.output");
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
    },
  });
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
    },
  });

  return {
    agentId,
    childSessionId,
    metadataFile,
    outputFile,
    taskOutputFile,
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

export function withoutRuntimeMessageState(task: RuntimeTaskSnapshot): RuntimeTaskSnapshot {
  const { messageSink: _messageSink, pendingMessages: _pendingMessages, ...snapshot } = task;
  return snapshot;
}

export function createAgentBackgroundedOutput(
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
): AgentBackgroundedOutput {
  return {
    status: "async_launched",
    isAsync: true,
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    childSessionId: lifecycle.childSessionId,
    backgroundTaskId: lifecycle.agentId,
    outputFile: lifecycle.outputFile,
    canReadOutputFile: request.callerCanReadOutputFile === true,
  };
}

