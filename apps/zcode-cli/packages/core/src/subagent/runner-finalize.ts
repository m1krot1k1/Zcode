// Subagent runner: терминальная финализация background-задач.

import {
  SessionEventType,
  traceContextToLogContext,
  type AgentCompletedOutput,
  type SubagentRunRequest,
} from "@zcode/contracts";
import { formatLocalAgentTaskNotification } from "./completion-notification.js";
import { selectExecutionErrorMessage } from "../errors/error-payload.js";
import {
  isTerminalRuntimeTask,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";
import {
  type ExploreSubagentPortOptions,
  type SubagentLifecycle,
  type CompletedAgentRun,
  BACKGROUND_AGENT_STOPPED_STATE,
} from "./runner-types.js";
import { evaluateAndPersistPrismAcceptance } from "./runner-admission.js";
import {
  writeCompletedAgentArtifacts,
  writeFailedAgentArtifacts,
  writeStoppedAgentArtifacts,
} from "./runner-artifacts.js";
import {
  emitSubagentExecutionTerminal,
  enqueueBackgroundNotification,
  emitBackgroundTaskCompletedEvent,
  emitRuntimeTaskBackgroundCompletedEvent,
  emitRuntimeTaskSubagentStoppedEvent,
  traceContextFromRuntimeTask,
  emitSubagentEvent,
} from "./runner-notifications.js";
import { withoutRuntimeMessageState } from "./runner-task-runtime.js";

export async function finalizeBackgroundCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  completed: CompletedAgentRun,
): Promise<void> {
  const current = registry.get(lifecycle.agentId);
  if (!current || isTerminalRuntimeTask(current)) return;
  registry.beginSubagentTaskFinalization(lifecycle.agentId);

  const acceptedOutput: AgentCompletedOutput = {
    ...completed.output,
    acceptance: await evaluateAndPersistPrismAcceptance(
      options,
      registry,
      lifecycle.agentId,
      completed.evidenceEvents,
      lifecycle.runTraceContext,
    ),
  };

  await writeCompletedAgentArtifacts(lifecycle, request, acceptedOutput);
  const notification = formatLocalAgentTaskNotification({
    agentId: acceptedOutput.agentId,
    agentType: acceptedOutput.agentType,
    description: acceptedOutput.description,
    outputFile: lifecycle.outputFile,
    parentToolCallId: String(request.parentToolCallId),
    acceptanceStatus: acceptedOutput.acceptance?.status ?? "unknown",
    result: acceptedOutput.content.map((block) => block.text).join("\n\n"),
    status: "completed",
    totalDurationMs: acceptedOutput.totalDurationMs,
    totalTokens: acceptedOutput.totalTokens,
    totalToolUseCount: acceptedOutput.totalToolUseCount,
    usage: acceptedOutput.usage,
  });
  const completedAt = new Date();
  const task = registry.update(lifecycle.agentId, (current) => ({
    ...withoutRuntimeMessageState(current),
    status: "completed",
    completedAt,
    output: acceptedOutput,
    usage: {
      durationMs: acceptedOutput.totalDurationMs,
      modelUsage: acceptedOutput.usage,
      toolUseCount: acceptedOutput.totalToolUseCount,
      totalTokens: acceptedOutput.totalTokens,
    },
  }));
  if (task) {
    await emitSubagentExecutionTerminal(options, registry, task, lifecycle.runTraceContext);
  }
  enqueueBackgroundNotification(
    options,
    registry,
    lifecycle.agentId,
    notification,
    lifecycle.runTraceContext,
  );
  if (task) {
    await emitBackgroundTaskCompletedEvent(options, request, lifecycle.runTraceContext, task);
  }

  await emitSubagentEvent(
    options,
    SessionEventType.SubagentStopped,
    request,
    lifecycle.runTraceContext,
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      background: true,
      childSessionId: lifecycle.childSessionId,
      parentToolCallId: request.parentToolCallId,
      status: "completed",
      outputFile: lifecycle.outputFile,
      totalDurationMs: completed.output.totalDurationMs,
      totalToolUseCount: completed.output.totalToolUseCount,
      totalTokens: completed.output.totalTokens,
    },
  );

  options.logger?.info("Subagent background task completed", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    durationMs: completed.output.totalDurationMs,
    event: "subagent.background.completed",
    module: "core.subagent",
    status: "completed",
    totalToolUseCount: completed.output.totalToolUseCount,
    totalTokens: completed.output.totalTokens,
  });
}

export async function finalizeBackgroundFailure(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  error: unknown,
): Promise<void> {
  const current = registry.get(lifecycle.agentId);
  if (!current || isTerminalRuntimeTask(current)) return;
  registry.beginSubagentTaskFinalization(lifecycle.agentId);

  // background runner 收到的通常是 Turn failure wrapper，直接读 message
  // 会把 provider 的 429 原文替换成通用的 “Turn execution failed”；这里只选择
  // wrapper 下的根因 message，不压缩空白或截断 provider 原文。
  const errorMessage = error instanceof Error ? selectExecutionErrorMessage(error) : String(error);
  const completedAt = new Date();
  const totalDurationMs = Date.now() - lifecycle.startedAt;
  await writeFailedAgentArtifacts(lifecycle, request, errorMessage);
  const notification = formatLocalAgentTaskNotification({
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    error: errorMessage,
    outputFile: lifecycle.outputFile,
    parentToolCallId: String(request.parentToolCallId),
    status: "failed",
    totalDurationMs,
  });
  const task = registry.update(lifecycle.agentId, (current) => ({
    ...withoutRuntimeMessageState(current),
    status: "failed",
    completedAt,
    error: errorMessage,
    usage: {
      durationMs: totalDurationMs,
    },
  }));
  if (task) {
    await emitSubagentExecutionTerminal(options, registry, task, lifecycle.runTraceContext);
  }
  enqueueBackgroundNotification(
    options,
    registry,
    lifecycle.agentId,
    notification,
    lifecycle.runTraceContext,
  );
  if (task) {
    await emitBackgroundTaskCompletedEvent(options, request, lifecycle.runTraceContext, task);
  }

  await emitSubagentEvent(
    options,
    SessionEventType.SubagentStopped,
    request,
    lifecycle.runTraceContext,
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      background: true,
      childSessionId: lifecycle.childSessionId,
      parentToolCallId: request.parentToolCallId,
      status: "failed",
      outputFile: lifecycle.outputFile,
      totalDurationMs,
      error: errorMessage,
    },
  );

  options.logger?.warn("Subagent background task failed", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    errorMessage,
    event: "subagent.background.failed",
    module: "core.subagent",
    status: "failed",
  });
}

export async function finalizeBackgroundStopped(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  wasSpawned = true,
): Promise<RuntimeTaskSnapshot | undefined> {
  const current = registry.get(lifecycle.agentId);
  if (!current || isTerminalRuntimeTask(current)) return current;
  if (!registry.beginSubagentTaskFinalization(lifecycle.agentId)) return current;
  const completedAt = new Date();
  const totalDurationMs = Math.max(0, completedAt.getTime() - current.startedAt.getTime());
  const stopped: RuntimeTaskSnapshot = {
    ...withoutRuntimeMessageState(current),
    status: BACKGROUND_AGENT_STOPPED_STATE.registryStatus,
    completedAt,
    error: BACKGROUND_AGENT_STOPPED_STATE.message,
    usage: { durationMs: totalDurationMs },
  };
  const traceContext = traceContextFromRuntimeTask(stopped);
  const committed = registry.update(lifecycle.agentId, (latest) =>
    isTerminalRuntimeTask(latest) ? latest : { ...stopped, notified: latest.notified },
  );
  if (!committed || committed.status !== BACKGROUND_AGENT_STOPPED_STATE.registryStatus) {
    return committed;
  }
  // terminal state is published only after runBackgroundAgent/runAgentToCompletion has settled.
  // Artifact and notification failures must not roll the stopped runtime back to running.
  try {
    await writeStoppedAgentArtifacts(committed);
  } catch (error) {
    options.logger?.warn("Stopped subagent artifact write failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.background.stopped_artifact_failed",
    });
  }
  // 修复依据：terminal catalog 只能在 output artifact 写完后持久化，避免恢复到尚未完成的文件。
  if (wasSpawned || committed.prismTaskContract) {
    await emitSubagentExecutionTerminal(options, registry, committed, traceContext, wasSpawned);
  }
  if (!wasSpawned) return committed;

  const notification = formatLocalAgentTaskNotification({
    agentId: committed.agentId,
    agentType: committed.agentType,
    description: committed.description,
    outputFile: committed.outputFile ?? "",
    parentToolCallId: String(committed.parentToolCallId ?? committed.taskId),
    status: BACKGROUND_AGENT_STOPPED_STATE.notificationStatus,
    totalDurationMs,
  });
  const enqueued = enqueueBackgroundNotification(
    options,
    registry,
    committed.taskId,
    notification,
    traceContext,
  );
  if (!enqueued) {
    options.logger?.warn("Skipped stopped subagent notification during owner teardown", {
      ...traceContextToLogContext(traceContext),
      agentId: committed.agentId,
      event: "subagent.background.stopped_notification_skipped",
    });
  }

  try {
    await emitRuntimeTaskBackgroundCompletedEvent(options, committed, traceContext);
    await emitRuntimeTaskSubagentStoppedEvent(options, committed, traceContext, totalDurationMs);
  } catch (error) {
    options.logger?.warn("Stopped subagent event emit failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.background.stopped_event_failed",
    });
  }
  options.logger?.info("Subagent background task stopped", {
    ...traceContextToLogContext(traceContext),
    agentId: committed.agentId,
    event: "subagent.background.stopped",
    module: "core.subagent",
    status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
  });
  return committed;
}

