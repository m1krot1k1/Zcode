// Subagent runner: явный запуск субагента в фоне.

import {
  SessionEventType,
  traceContextToLogContext,
  type AgentBackgroundedOutput,
  type SubagentStartOptions,
  type SubagentStartRequest,
} from "@zcode/contracts";
import type { ExploreRunnerContext } from "./runner-types.js";
import {
  createRuntimeTaskSnapshot,
  declarePrismTaskContractForAdmission,
  deriveChildTaskLevel,
  registerSubagentTaskWithCapacityWait,
  resolveAgentProfileForRequest,
  resolveAllowedTools,
  throwOnSubagentAdmissionFailure,
} from "./runner-admission.js";
import { writeAgentMetadataFile } from "./runner-artifacts.js";
import {
  createSubagentSessionReadyGate,
  guardSubagentPromiseWithAbort,
  runBackgroundAgent,
} from "./runner-execution.js";
import { finalizeBackgroundStopped } from "./runner-finalize.js";
import { emitSubagentEvent, taskCorrelationPayload } from "./runner-notifications.js";
import {
  createAgentBackgroundedOutput,
  createSubagentLifecycle,
  createSubagentTaskAbortController,
  createSubagentTaskDeadline,
} from "./runner-task-runtime.js";

export async function startExploreSubagentInBackground(
  ctx: ExploreRunnerContext,
  rawRequest: SubagentStartRequest,
  startOptions?: SubagentStartOptions,
): Promise<AgentBackgroundedOutput> {
  const { profile, request } = resolveAgentProfileForRequest(ctx.getProfiles(), rawRequest);
  if (startOptions?.signal?.aborted) {
    throw startOptions.signal.reason ?? new Error("Subagent start aborted before admission");
  }
  const lifecycle = createSubagentLifecycle(ctx.options, request, profile, ctx.registry);
  const startedAt = new Date(lifecycle.startedAt);
  const output = createAgentBackgroundedOutput(request, lifecycle);
  const taskAbort = createSubagentTaskAbortController(startOptions?.signal);
  const admission = await registerSubagentTaskWithCapacityWait(
    ctx.registry,
    createRuntimeTaskSnapshot({
      isBackgrounded: true,
      lifecycle,
      request,
      startedAt,
      status: "running",
      // 同一父级链推导 level，避免后台子代理丢失递归保护上下文。
      level: deriveChildTaskLevel(request, undefined, ctx.registry),
      parentToolNames: ctx.options.parentToolNames,
      ...(ctx.registry.getSubagentTaskByChildSession(request.sessionId)?.taskId
        ? { parentTaskId: ctx.registry.getSubagentTaskByChildSession(request.sessionId)!.taskId }
        : {}),
    }),
    taskAbort,
  );
  if (!admission.accepted) {
    taskAbort.dispose();
    taskAbort.settle(ctx.registry.get(lifecycle.agentId));
    throwOnSubagentAdmissionFailure(admission, request);
  }
  // Bug 原因: explicit background start раньше не получал per-task deadline, поэтому
  // переданная в фон задача могла выполняться бесконечно и не иметь terminal-факта.
  // 修复依据: тот же per-role timer, что и у foreground run; он живёт до фактического
  // settlement и очищается на каждом выходе, а финализацию по-прежнему захватывает
  // beginSubagentTaskFinalization (старт не становится вторым владельцем terminal).
  const taskDeadline = createSubagentTaskDeadline({
    lifecycle,
    options: ctx.options,
    registry: ctx.registry,
    request,
    taskAbort,
  });
  try {
    await writeAgentMetadataFile(lifecycle, request, "running");
    if (taskAbort.signal.aborted) {
      throw taskAbort.signal.reason ?? new Error("Subagent startup aborted");
    }
    await declarePrismTaskContractForAdmission(
      ctx.options,
      request,
      ctx.registry,
      admission.task,
      lifecycle.runTraceContext,
    );
    if (taskAbort.signal.aborted) {
      throw taskAbort.signal.reason ?? new Error("Subagent startup aborted");
    }
  } catch (error) {
    taskDeadline.clear();
    if (taskAbort.signal.aborted) {
      await finalizeBackgroundStopped(ctx.options, request, lifecycle, ctx.registry, false);
    } else {
      // setup 失败时移除 registry 记录，避免 fake running background task。
      ctx.registry.remove(lifecycle.agentId);
    }
    taskAbort.dispose();
    ctx.registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
    taskAbort.settle(ctx.registry.get(lifecycle.agentId));
    throw error;
  }

  const readyGate = createSubagentSessionReadyGate();
  const executionPromise = runBackgroundAgent(
    ctx.options,
    request,
    lifecycle,
    ctx.registry,
    {
      signal: taskAbort.signal,
      ...(startOptions?.model ? { model: startOptions.model } : {}),
      ...(startOptions?.modelOverride ? { modelOverride: startOptions.modelOverride } : {}),
    },
    {
      onSessionReady: async (info) => {
        await emitSubagentEvent(
          ctx.options,
          SessionEventType.SubagentSpawned,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            background: true,
            childSessionId: lifecycle.childSessionId,
            description: request.description,
            prompt: request.prompt,
            parentToolCallId: request.parentToolCallId,
            status: "running",
            ...taskCorrelationPayload(ctx.registry, lifecycle.agentId),
            allowedTools: [...resolveAllowedTools(profile, ctx.options)],
            outputFile: lifecycle.outputFile,
            model: profile.modelSelection
              ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
              : undefined,
            ...(info?.reasoningLevel ? { reasoningLevel: info.reasoningLevel } : {}),
          },
        );
        readyGate.resolve();
      },
      onSessionStartFailed: readyGate.reject,
    },
    () => {
      // Background задача фактически settlement'нулась: timer больше не нужен.
      taskDeadline.clear();
      taskAbort.dispose();
      ctx.registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
      taskAbort.settle(ctx.registry.get(lifecycle.agentId));
    },
  );
  try {
    await guardSubagentPromiseWithAbort(
      readyGate.promise,
      request,
      lifecycle,
      taskAbort.signal,
    );
  } catch (error) {
    // Readiness не наступила: задача ещё не передана владельцу, timer снимаем здесь.
    taskDeadline.clear();
    const wasAborted = taskAbort.signal.aborted;
    taskAbort.abort(error);
    if (!wasAborted) {
      await executionPromise;
      ctx.registry.remove(lifecycle.agentId);
    }
    throw error;
  }
  // Explicit background start belongs to its task owner after readiness, not to the caller turn.
  taskAbort.detachParent();

  ctx.options.logger?.info("Explore subagent background task started", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    event: "subagent.background.started",
    module: "core.subagent",
    parentToolCallId: request.parentToolCallId,
    status: "started",
  });
  return output;
}
