// Subagent runner: SendMessage и resume терминальных агентов.

import {
  SessionEventType,
  createChildTraceContext,
  type SubagentRunRequest,
  type SubagentSendMessageOptions,
  type SubagentSendMessageRequest,
  type SubagentSendMessageResult,
} from "@zcode/contracts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentProfile } from "./profile.js";
import {
  isTerminalRuntimeTask,
  runtimeTaskOutputFile,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";
import type { ExploreSubagentPortOptions, SubagentLifecycle } from "./runner-types.js";
import { createRuntimeTaskSnapshot, deriveChildTaskLevel } from "./runner-admission.js";
import { writeAgentMetadataFile } from "./runner-artifacts.js";
import {
  guardSubagentPromiseWithAbort,
  runBackgroundAgent,
  createSubagentSessionReadyGate,
} from "./runner-execution.js";
import { finalizeBackgroundStopped } from "./runner-finalize.js";
import { emitSubagentEvent, taskCorrelationPayload } from "./runner-notifications.js";
import { createSubagentTaskAbortController, registerSubagentTask } from "./runner-task-runtime.js";

export function restorePreviousTerminalTaskAfterResumeFailure(
  registry: RuntimeTaskRegistry,
  previousTask: RuntimeTaskSnapshot,
  failedAttemptId: string | undefined,
  previousTaskWasArchived: boolean,
): boolean {
  const current = registry.get(previousTask.taskId);
  if (!current || current.attemptId !== failedAttemptId) return false;
  // 修复依据：setup 等待文件 IO 时，SendMessage 可已排入 pendingMessages；回滚只恢复 terminal 状态，保留已接受消息。
  registry.register({ ...previousTask, pendingMessages: current.pendingMessages });
  if (previousTaskWasArchived && previousTask.attemptId) {
    registry.markTerminalTaskArchived?.(previousTask.taskId, previousTask.attemptId);
  }
  return true;
}

export function createSubagentLifecycleFromTask(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
  task: RuntimeTaskSnapshot,
): SubagentLifecycle | undefined {
  if (!task.childSessionId) return undefined;
  const agentId = task.agentId;
  const childSessionId = task.childSessionId;
  const startedAt = Date.now();
  const agentOutputDir = task.outputFile
    ? dirname(task.outputFile)
    : dirname(
        runtimeTaskOutputFile(
          options.outputRootDir ?? join(tmpdir(), "zcode-agents"),
          task.rootSessionId ?? request.sessionId,
          task.taskId,
        ),
      );
  const metadataFile = join(agentOutputDir, "metadata.json");
  const outputFile = join(agentOutputDir, "output.txt");
  const taskOutputFile = join(agentOutputDir, "task.output");
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
      resumed: true,
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
      resumed: true,
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

export async function sendMessageToLocalAgent(
  options: ExploreSubagentPortOptions,
  getProfiles: () => readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  request: SubagentSendMessageRequest,
  sendOptions?: SubagentSendMessageOptions,
): Promise<SubagentSendMessageResult> {
  if (sendOptions?.signal?.aborted) {
    return createSendMessageFailure(request, `SendMessage was aborted for ${request.to}.`);
  }

  let task = registry.get(request.to);
  if (!task) {
    const archivedTask = await options.resolveTerminalTaskCatalog?.(request.to);
    task = registry.get(request.to) ?? archivedTask;
  }
  if (!task || task.type !== "local_agent") {
    return createSendMessageFailure(
      request,
      `No active local_agent task found for target ${request.to}.`,
    );
  }

  if (registry.isSubagentTaskFinalizing(task.taskId)) {
    await registry.waitForTerminal(task.taskId, {
      signal: sendOptions?.signal,
    });
    task = registry.get(task.taskId) ?? (await options.resolveTerminalTaskCatalog?.(task.taskId));
    if (!task || task.type !== "local_agent") {
      return createSendMessageFailure(
        request,
        `No active local_agent task found for target ${request.to}.`,
      );
    }
  }

  const message = createRuntimeTaskPendingMessage(request);
  if (!isTerminalRuntimeTask(task)) {
    return deliverMessageToRunningAgent(registry, task, message);
  }

  return resumeTerminalAgentInBackground(
    options,
    getProfiles(),
    registry,
    task,
    request,
    message,
    sendOptions,
  );
}

async function deliverMessageToRunningAgent(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  message: RuntimeTaskPendingMessage,
): Promise<SubagentSendMessageResult> {
  if (task.messageSink) {
    try {
      const delivery = await task.messageSink.send(message);
      return createSendMessageSuccess(task, message, delivery);
    } catch {
      registry.queueMessage(task.taskId, message);
      return createSendMessageSuccess(task, message, "queued");
    }
  }

  registry.queueMessage(task.taskId, message);
  return createSendMessageSuccess(task, message, "queued");
}

async function resumeTerminalAgentInBackground(
  options: ExploreSubagentPortOptions,
  profiles: readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  request: SubagentSendMessageRequest,
  message: RuntimeTaskPendingMessage,
  sendOptions?: SubagentSendMessageOptions,
): Promise<SubagentSendMessageResult> {
  const profile = profiles.find((candidate) => candidate.name === task.agentType);
  if (!profile) {
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: profile ${task.agentType} is unavailable.`,
    );
  }

  const resumeRequest: SubagentRunRequest = {
    sessionId: request.sessionId,
    turnId: request.turnId,
    parentToolCallId: request.parentToolCallId,
    agentType: task.agentType,
    description: request.summary || task.description,
    prompt: request.message,
    workingDirectory: request.workingDirectory,
    workspaceRoot: request.workspaceRoot,
    trace: request.trace,
  };
  const lifecycle = createSubagentLifecycleFromTask(options, resumeRequest, profile, task);
  if (!lifecycle) {
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: missing child session id.`,
    );
  }
  const startedAt = new Date(lifecycle.startedAt);
  const previousTask = task;
  const taskAbort = createSubagentTaskAbortController(sendOptions?.signal);
  const latestTaskBeforeAdmission = registry.get(task.taskId);
  const previousTaskWasArchived = latestTaskBeforeAdmission
    ? Boolean(task.attemptId && registry.isTerminalTaskArchived?.(task.taskId, task.attemptId))
    : true;
  if (latestTaskBeforeAdmission && latestTaskBeforeAdmission.attemptId !== task.attemptId) {
    taskAbort.dispose();
    taskAbort.settle(latestTaskBeforeAdmission);
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: task attempt changed; retry SendMessage.`,
    );
  }
  const admission = registerSubagentTask(
    registry,
    createRuntimeTaskSnapshot({
      isBackgrounded: true,
      lifecycle,
      request: resumeRequest,
      pendingMessages: task.pendingMessages,
      startedAt,
      status: "running",
      // Resume保留 level；旧 snapshot 中的 spawnGrant 是弃用字段，运行时不再恢复。
      level: task.level ?? deriveChildTaskLevel(resumeRequest, undefined, registry),
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    }),
    taskAbort,
  );
  if (!admission.accepted) {
    taskAbort.dispose();
    taskAbort.settle(registry.get(lifecycle.agentId));
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: ${admission.reason}.`,
    );
  }
  try {
    await writeAgentMetadataFile(lifecycle, resumeRequest, "running", {
      resumedAt: new Date().toISOString(),
      resumedFromMessageId: message.id,
    });
    if (taskAbort.signal.aborted) {
      throw taskAbort.signal.reason ?? new Error(`SendMessage resume aborted for ${task.agentId}.`);
    }
  } catch (error) {
    if (taskAbort.signal.aborted) {
      await finalizeBackgroundStopped(options, resumeRequest, lifecycle, registry, false);
    } else {
      // 修复原因：setup 尚未启动 runtime；非取消失败恢复原 terminal snapshot，避免假 running。
      restorePreviousTerminalTaskAfterResumeFailure(
        registry,
        previousTask,
        admission.task.attemptId,
        previousTaskWasArchived,
      );
    }
    taskAbort.dispose();
    registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
    taskAbort.settle(registry.get(lifecycle.agentId));
    throw error;
  }

  const readyGate = createSubagentSessionReadyGate();
  const executionPromise = runBackgroundAgent(
    options,
    resumeRequest,
    lifecycle,
    registry,
    {
      signal: taskAbort.signal,
      model: sendOptions?.model,
      modelOverride: sendOptions?.modelOverride,
    },
    {
      resumeFromStore: true,
      onSessionReady: async () => {
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentSpawned,
          resumeRequest,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: resumeRequest.agentType,
            background: true,
            childSessionId: lifecycle.childSessionId,
            description: resumeRequest.description,
            outputFile: lifecycle.outputFile,
            parentToolCallId: resumeRequest.parentToolCallId,
            prompt: resumeRequest.prompt,
            resumed: true,
            status: "running",
            ...taskCorrelationPayload(registry, lifecycle.agentId),
          },
        );
        readyGate.resolve();
      },
      onSessionStartFailed: readyGate.reject,
    },
    () => {
      taskAbort.dispose();
      registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
      taskAbort.settle(registry.get(lifecycle.agentId));
    },
  );
  try {
    await guardSubagentPromiseWithAbort(
      readyGate.promise,
      resumeRequest,
      lifecycle,
      taskAbort.signal,
    );
    if (taskAbort.signal.aborted) {
      throw taskAbort.signal.reason ?? new Error(`SendMessage resume aborted for ${task.agentId}.`);
    }
  } catch (error) {
    const wasAborted = taskAbort.signal.aborted;
    taskAbort.abort(error);
    if (!wasAborted) {
      await executionPromise;
      registry.register(previousTask);
    }
    throw error;
  }
  // После подтверждения resume runtime становится самостоятельной фоновой задачей.
  taskAbort.detachParent();
  // terminal 状态属于旧 snapshot，但 resume 输出路径属于新 lifecycle；
  // 旧 snapshot 的可选 outputFile 不能用于本次 provider-visible 结果。
  return createSendMessageSuccess(
    { ...task, outputFile: lifecycle.outputFile },
    message,
    "resumed_background",
  );
}

function createRuntimeTaskPendingMessage(
  request: SubagentSendMessageRequest,
): RuntimeTaskPendingMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    isMeta: true,
    message: request.message,
    origin: {
      kind: "coordinator",
      toolCallId: String(request.parentToolCallId),
    },
    queuedAt: new Date(),
    summary: request.summary,
    traceContext: request.trace,
  };
}

function createSendMessageSuccess(
  task: Pick<RuntimeTaskSnapshot, "agentId" | "outputFile" | "status" | "taskId">,
  message: RuntimeTaskPendingMessage,
  delivery: NonNullable<SubagentSendMessageResult["delivery"]>,
): SubagentSendMessageResult {
  const providerMessage =
    delivery === "queued"
      ? `Message queued for delivery to ${task.agentId} at its next tool round.`
      : delivery === "resumed_background"
        ? `Agent "${task.agentId}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.outputFile}`
        : `Message ${message.id} was sent to its active turn for local agent ${task.agentId}.`;
  return {
    status: "success",
    messageId: message.id,
    delivery,
    agentId: task.agentId,
    taskId: task.taskId,
    outputFile: task.outputFile,
    message: providerMessage,
  };
}

function createSendMessageFailure(
  request: SubagentSendMessageRequest,
  error: string,
): SubagentSendMessageResult {
  return {
    status: "failed",
    messageId: `msg_${crypto.randomUUID()}`,
    agentId: request.to,
    error,
    message: error,
  };
}

