// Subagent runner: foreground run субагента.

import { holdSwarmCrashBoundary } from "../runtime/helpers/turn-errors.js";
import {
  AgentErrorCode,
  CoreErrorType,
  SessionEventType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type AgentCompletedOutput,
  type AgentOutput,
  type SwarmNodeAttemptLifecycleFact,
  type SubagentRunOptions,
  type SubagentRunRequest,
} from "@zcode/contracts";
import {
  ErrorPayloadRole,
  selectExecutionErrorMessage,
  withErrorPayloadRole,
} from "../errors/error-payload.js";
import { isTerminalRuntimeTask } from "../runtime-task/registry.js";
import type { ExploreRunnerContext } from "./runner-types.js";
import {
  createAutoBackgroundTimer,
  createRuntimeTaskSnapshot,
  declarePrismTaskContractForAdmission,
  deriveChildTaskLevel,
  evaluateAndPersistPrismAcceptance,
  registerSubagentTaskWithCapacityWait,
  resolveAgentProfileForRequest,
  resolveAllowedTools,
  throwOnSubagentAdmissionFailure,
  type AutoBackgroundTimer,
} from "./runner-admission.js";
import {
  writeAgentMetadataFile,
  writeCompletedAgentArtifacts,
  writeFailedAgentArtifacts,
} from "./runner-artifacts.js";
import {
  DEFAULT_SUBAGENT_INACTIVITY_TIMEOUT_MS,
  createSubagentActivityWatchdog,
  createSubagentSessionReadyGate,
  guardSubagentPromiseWithAbort,
  runAgentToCompletion,
} from "./runner-execution.js";
import {
  finalizeBackgroundCompletion,
  finalizeBackgroundFailure,
  finalizeBackgroundStopped,
} from "./runner-finalize.js";
import {
  emitSubagentEvent,
  emitSubagentExecutionTerminal,
  taskCorrelationPayload,
} from "./runner-notifications.js";
import {
  createAgentBackgroundedOutput,
  createSubagentLifecycle,
  createSubagentTaskAbortController,
  createSubagentTaskDeadline,
  withoutRuntimeMessageState,
} from "./runner-task-runtime.js";

export async function runExploreSubagent(
  ctx: ExploreRunnerContext,
  rawRequest: SubagentRunRequest,
  runOptions?: SubagentRunOptions,
): Promise<AgentOutput> {
  const { profile, request } = resolveAgentProfileForRequest(
    runOptions?.internalAgentProfilesSnapshot ?? ctx.getProfiles(),
    rawRequest,
  );
  if (runOptions?.signal?.aborted) {
    throw runOptions.signal.reason ?? new Error("Subagent run aborted before admission");
  }
  const lifecycle = createSubagentLifecycle(ctx.options, request, profile, ctx.registry);
  const startedAt = new Date(lifecycle.startedAt);
  const taskAbort = createSubagentTaskAbortController(runOptions?.signal);
  const swarmNodeID = runOptions?.internalSwarmNodeID;
  const persistSwarmFact = async (
    phase: SwarmNodeAttemptLifecycleFact["phase"],
    detail: { resultText?: string; diagnosticCode?: string } = {},
  ): Promise<void> => {
    if (!swarmNodeID || !runOptions?.persistSwarmNodeAttempt) return;
    await runOptions.persistSwarmNodeAttempt({
      phase,
      nodeID: swarmNodeID,
      attemptID: lifecycle.agentId,
      attemptNo: 1,
      childSessionID: lifecycle.childSessionId,
      ...detail,
    } as SwarmNodeAttemptLifecycleFact);
  };
  if (swarmNodeID && runOptions?.persistSwarmNodeAttempt) {
    try {
      await persistSwarmFact("reserved");
      // 原因：预约写入后马上启动 child，外部进程看不到稳定的 dispatching。
      // 修复依据：crash E2E 用 ZCODE_E2E_SWARM_CRASH_BOUNDARY 把窗口留到可 SIGKILL。
      await holdSwarmCrashBoundary();
    } catch (error) {
      taskAbort.dispose();
      taskAbort.settle(undefined);
      throw error;
    }
  }
  // Уровень берётся из snapshot родителя, чтобы background/resume не сбрасывали
  // рекурсивную защиту; он не ограничивает общее число задач.
  const admission = await registerSubagentTaskWithCapacityWait(
    ctx.registry,
    createRuntimeTaskSnapshot({
      isBackgrounded: false,
      lifecycle,
      request,
      startedAt,
      status: "running",
      // level только защищает от циклической рекурсии и не задаёт лимит дерева.
      level: deriveChildTaskLevel(request, runOptions?.level, ctx.registry),
      // Эффективная поверхность родителя: профиль не может объявить запись,
      // которой нет у фактического tool surface родителя.
      parentToolNames: ctx.options.parentToolNames,
      // Ребро поддерева для агрегата токенов/времени; root-turn не имеет parent task.
      ...(ctx.registry.getSubagentTaskByChildSession(request.sessionId)?.taskId
        ? { parentTaskId: ctx.registry.getSubagentTaskByChildSession(request.sessionId)!.taskId }
        : {}),
    }),
    taskAbort,
  );
  if (!admission.accepted) {
    try {
      await persistSwarmFact("failed", { diagnosticCode: "child_admission_rejected" });
    } finally {
      taskAbort.dispose();
      taskAbort.settle(ctx.registry.get(lifecycle.agentId));
    }
    throwOnSubagentAdmissionFailure(admission, request);
  }
  // Hard deadline ставится после admission: taskAbort уже существует, а registry
  // владеет терминальным состоянием. Timer очищается на каждом выходе из run.
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
    try {
      if (taskAbort.signal.aborted) {
        await persistSwarmFact("cancelled", { diagnosticCode: "child_startup_cancelled" });
        await finalizeBackgroundStopped(ctx.options, request, lifecycle, ctx.registry, false);
      } else {
        await persistSwarmFact("failed", { diagnosticCode: "child_startup_failed" });
        // 修复原因：元数据阶段尚未启动 child runtime；非取消失败需要撤销 admission，
        // 避免把一个不存在的后台任务留在 registry 或占用 root quota。
        ctx.registry.remove(lifecycle.agentId);
      }
    } finally {
      taskDeadline.clear();
      taskAbort.dispose();
      ctx.registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
      taskAbort.settle(ctx.registry.get(lifecycle.agentId));
    }
    throw error;
  }

  const hasForegroundModelOverride = runOptions?.modelOverride?.background === "deny";
  if (hasForegroundModelOverride) {
    ctx.borrowedForegroundAgentIds.add(lifecycle.agentId);
  }
  // Watchdog бездействия: по умолчанию выравнивается с idle timeout модели.
  // Раньше дефолт был 0 (watchdog выключен), из-за чего субагент с неработающим
  // Bash (spawn EAGAIN) или зависшим провайдером висел часами, не публикуя событий.
  // Явный 0 в конфиге по-прежнему означает «без watchdog»; отключение — осознанное решение.
  const activityWatchdog = createSubagentActivityWatchdog({
    abort: taskAbort.abort,
    lifecycle,
    logger: ctx.options.logger,
    request,
    signal: taskAbort.signal,
    timeoutMs: ctx.options.inactivityTimeoutMs ?? DEFAULT_SUBAGENT_INACTIVITY_TIMEOUT_MS,
  });
  const readyGate = createSubagentSessionReadyGate();
  let sessionReady = false;
  // Владелец terminal-перехода выставляется ровно один раз; success/failure ветки одного
  // run используют его совместно, а конкурирующий deadline/Stop не перезаписывает terminal.
  let ownsTaskFinalization = false;
  // child persistence/resume 可能在 onSessionReady 前永久挂起；watchdog 和
  // abort guard 必须覆盖完整 setup，而不能把 Ready 当成取消能力的安装边界。
  activityWatchdog.start();
  const completionPromise = runAgentToCompletion(
    ctx.options,
    request,
    lifecycle,
    ctx.registry,
    {
      signal: taskAbort.signal,
      ...(runOptions?.model ? { model: runOptions.model } : {}),
      ...(runOptions?.modelOverride ? { modelOverride: runOptions.modelOverride } : {}),
      ...(runOptions?.internalSwarmRootRunId
        ? {
            internalSwarmRootRunId: runOptions.internalSwarmRootRunId,
            internalSwarmRootTurnId: runOptions.internalSwarmRootTurnId,
          }
        : {}),
      ...(runOptions?.internalAgentProfilesSnapshot
        ? { internalAgentProfilesSnapshot: runOptions.internalAgentProfilesSnapshot }
        : {}),
      // DAG-маркер нужен runAgentToCompletion, чтобы не парсить presentation у узлов.
      ...(runOptions?.internalSwarmNodeID === undefined
        ? {}
        : { internalSwarmNodeID: runOptions.internalSwarmNodeID }),
    },
    {
      reportActivity: activityWatchdog.reportActivity,
    },
    {
      onSessionReady: async (info) => {
        await persistSwarmFact("running");
        await emitSubagentEvent(
          ctx.options,
          SessionEventType.SubagentSpawned,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            description: request.description,
            prompt: request.prompt,
            parentToolCallId: request.parentToolCallId,
            status: "running",
            ...taskCorrelationPayload(ctx.registry, lifecycle.agentId),
            allowedTools: [...resolveAllowedTools(profile, ctx.options)],
            model: profile.modelSelection
              ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
              : undefined,
            ...(info?.reasoningLevel ? { reasoningLevel: info.reasoningLevel } : {}),
          },
        );
        // Причина гонки: registry admission предшествует созданию читаемой child-сессии.
        // Публикуем readiness только после записи SubagentSpawned, чтобы UI не получил sessionNotFound.
        ctx.registry.update(lifecycle.agentId, (task) => ({
          ...task,
          childSessionReady: true,
        }));
        sessionReady = true;
        readyGate.resolve();
      },
    },
  );
  void completionPromise.catch((error: unknown) => readyGate.reject(error));
  try {
    await guardSubagentPromiseWithAbort(
      readyGate.promise,
      request,
      lifecycle,
      taskAbort.signal,
    );
    if (taskAbort.signal.aborted) {
      throw taskAbort.signal.reason ?? new Error("Subagent start aborted before readiness");
    }
  } catch (error) {
    activityWatchdog.stop();
    if (taskAbort.signal.aborted) {
      ctx.borrowedForegroundAgentIds.delete(lifecycle.agentId);
      void completionPromise
        .then(
          () => finalizeBackgroundStopped(ctx.options, request, lifecycle, ctx.registry, sessionReady),
          () => finalizeBackgroundStopped(ctx.options, request, lifecycle, ctx.registry, sessionReady),
        )
        .catch((settleError: unknown) => {
          ctx.options.logger?.warn("Cancelled subagent startup settlement failed", {
            errorMessage:
              settleError instanceof Error ? settleError.message : String(settleError),
            event: "subagent.startup.cancel_settlement_failed",
          });
        })
        .finally(() => {
          taskDeadline.clear();
          taskAbort.dispose();
          ctx.registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
          taskAbort.settle(ctx.registry.get(lifecycle.agentId));
        });
      throw error;
    }
    // A non-abort readiness rejection means setup/runtime failed on its own. Do not convert
    // that failure into cancellation; wait for settlement, then remove the unready admission.
    await completionPromise.catch(() => undefined);
    taskDeadline.clear();
    taskAbort.dispose();
    ctx.borrowedForegroundAgentIds.delete(lifecycle.agentId);
    ctx.registry.remove(lifecycle.agentId);
    ctx.registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
    taskAbort.settle(ctx.registry.get(lifecycle.agentId));
    throw error;
  }

  ctx.options.logger?.info("Explore subagent spawned", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    event: "subagent.spawned",
    module: "core.subagent",
    parentToolCallId: request.parentToolCallId,
    status: "started",
  });
  const guardedCompletionPromise = guardSubagentPromiseWithAbort(
    completionPromise,
    request,
    lifecycle,
    taskAbort.signal,
  );

  let autoBackgroundTimer: AutoBackgroundTimer | undefined;
  let runningInBackground = false;
  try {
    autoBackgroundTimer =
      !hasForegroundModelOverride && ctx.autoBackgroundMs !== undefined
        ? createAutoBackgroundTimer(
            ctx.registry,
            lifecycle.agentId,
            ctx.autoBackgroundMs,
            taskAbort.signal,
          )
        : undefined;
    const backgroundRequestPromise = !hasForegroundModelOverride
      ? ctx.registry
          .waitForBackgroundRequest(lifecycle.agentId, {
            signal: taskAbort.signal,
          })
          .then((task) => ({
            kind: task ? ("backgrounded" as const) : ("ignored" as const),
          }))
      : undefined;
    const winner = await Promise.race([
      guardedCompletionPromise.then((completed) => ({
        completed,
        kind: "completed" as const,
      })),
      ...(backgroundRequestPromise ? [backgroundRequestPromise] : []),
      ...(autoBackgroundTimer ? [autoBackgroundTimer.promise] : []),
    ]);

    if (winner.kind === "backgrounded") {
      runningInBackground = true;
      taskAbort.detachParent();
      activityWatchdog.stop();
      void completionPromise
        .then((completed) => {
          // Child фактически завершился: снимаем deadline до захвата финализации,
          // иначе поздний timer мог бы конкурировать за terminal-переход.
          taskDeadline.clear();
          return finalizeBackgroundCompletion(ctx.options, request, lifecycle, ctx.registry, completed);
        })
        .catch(async (error) => {
          taskDeadline.clear();
          if (taskAbort.signal.aborted) {
            await finalizeBackgroundStopped(ctx.options, request, lifecycle, ctx.registry, true);
          } else {
            await finalizeBackgroundFailure(ctx.options, request, lifecycle, ctx.registry, error);
          }
        })
        .catch((finalizationError: unknown) => {
          ctx.options.logger?.warn("Subagent background finalization failed", {
            errorMessage:
              finalizationError instanceof Error
                ? finalizationError.message
                : String(finalizationError),
            event: "subagent.background.finalization_failed",
            agentId: lifecycle.agentId,
          });
        })
        .finally(() => {
          // Задача продолжает жить после передачи в background, поэтому deadline
          // снимается только вместе с её фактическим settlement.
          taskDeadline.clear();
          taskAbort.dispose();
          ctx.registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
          taskAbort.settle(ctx.registry.get(lifecycle.agentId));
        });
      return createAgentBackgroundedOutput(request, lifecycle);
    }

    const completed =
      winner.kind === "completed" ? winner.completed : await guardedCompletionPromise;
    // Bug 原因: timer deadline жил до внешнего finally, поэтому поздний callback мог
    // захватить финализацию и записать failed уже после успешного completion.
    // 修复依据: completion — единственный владелец результата, снимаем timer до финализации.
    taskDeadline.clear();
    const acceptedOutput = {
      ...completed.output,
      acceptance: await evaluateAndPersistPrismAcceptance(
        ctx.options,
        ctx.registry,
        lifecycle.agentId,
        completed.evidenceEvents,
        lifecycle.runTraceContext,
      ),
    } satisfies AgentCompletedOutput;
    // Bug 原因: при гонке deadline успевал первым захватить finalization, а success path
    // всё равно перезаписывал terminal failed на completed. 修复依据: terminal пишет только
    // владелец финализации; проигравший путь не публикует второй terminal и не перезаписывает artifacts.
    ownsTaskFinalization = ctx.registry.beginSubagentTaskFinalization(lifecycle.agentId);
    if (!ownsTaskFinalization) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Subagent task was already finalized",
        {
          context: {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            parentToolCallId: request.parentToolCallId,
          },
          recoverable: true,
        },
      );
    }
    await persistSwarmFact("completed", {
      resultText: completed.output.content.map((block) => block.text).join("\n\n"),
    });
    autoBackgroundTimer?.cancel();
    activityWatchdog.stop();
    taskAbort.dispose();
    ctx.borrowedForegroundAgentIds.delete(lifecycle.agentId);

    // 终态提交后 UI/SendMessage 可立即观察到它；同 id 的重启必须等本次产物和事件落定。
    await writeCompletedAgentArtifacts(lifecycle, request, acceptedOutput);
    const terminalTask = ctx.registry.update(lifecycle.agentId, (task) => ({
      ...withoutRuntimeMessageState(task),
      status: "completed",
      completedAt: new Date(),
      output: acceptedOutput,
      usage: {
        durationMs: acceptedOutput.totalDurationMs,
        modelUsage: acceptedOutput.usage,
        toolUseCount: acceptedOutput.totalToolUseCount,
        totalTokens: acceptedOutput.totalTokens,
      },
    }));
    if (terminalTask) {
      await emitSubagentExecutionTerminal(
        ctx.options,
        ctx.registry,
        terminalTask,
        lifecycle.runTraceContext,
      );
    }

    try {
      await emitSubagentEvent(
        ctx.options,
        SessionEventType.SubagentStopped,
        request,
        lifecycle.runTraceContext,
        {
          agentId: lifecycle.agentId,
          agentType: request.agentType,
          childSessionId: lifecycle.childSessionId,
          parentToolCallId: request.parentToolCallId,
          status: "completed",
          totalDurationMs: completed.output.totalDurationMs,
          totalToolUseCount: completed.output.totalToolUseCount,
          totalTokens: completed.output.totalTokens,
          subtreeTotalDurationMs: completed.output.subtreeTotalDurationMs,
          subtreeToolUseCount: completed.output.subtreeToolUseCount,
          subtreeTotalTokens: completed.output.subtreeTotalTokens,
        },
      );
    } catch (eventError) {
      // Delivery is best-effort after the successful runtime result is committed.
      ctx.options.logger?.warn("Explore subagent completion event emit failed", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        errorMessage: eventError instanceof Error ? eventError.message : String(eventError),
        event: "subagent.completion_event_failed",
        module: "core.subagent",
        status: "completed",
      });
    }

    ctx.options.logger?.info("Explore subagent completed", {
      ...traceContextToLogContext(lifecycle.runTraceContext),
      agentId: lifecycle.agentId,
      durationMs: completed.output.totalDurationMs,
      event: "subagent.completed",
      module: "core.subagent",
      status: "completed",
      totalToolUseCount: completed.output.totalToolUseCount,
      totalTokens: completed.output.totalTokens,
    });

    // 修复原因：之前只把 Host acceptance 写入 registry/产物，却向父 Agent 返回未经评估的 worker 输出。
    return acceptedOutput;
  } catch (error) {
    activityWatchdog.stop();
    // Bug 原因: deadline/Stop finalizer мог уже записать terminal snapshot, пока этот путь
    // ждал promise; повторная запись давала второй terminal и расходилась с artifacts.
    // 修复依据: terminal snapshot — источник истины, поздний путь только пробрасывает ошибку.
    const currentTerminalTask = ctx.registry.get(lifecycle.agentId);
    if (currentTerminalTask && isTerminalRuntimeTask(currentTerminalTask)) {
      throw error;
    }
    if (taskAbort.signal.aborted) {
      await persistSwarmFact("cancelled", { diagnosticCode: "child_cancelled" });
      // guardSubagentPromiseWithAbort быстрее завершает вызывающий tool, чем child runtime;
      // не публикуем stopped до его настоящего settlement.
      runningInBackground = true;
      ctx.borrowedForegroundAgentIds.delete(lifecycle.agentId);
      void completionPromise
        .then(
          () => finalizeBackgroundStopped(ctx.options, request, lifecycle, ctx.registry, true),
          () => finalizeBackgroundStopped(ctx.options, request, lifecycle, ctx.registry, true),
        )
        .catch((settleError: unknown) => {
          ctx.options.logger?.warn("Cancelled subagent settlement failed", {
            errorMessage:
              settleError instanceof Error ? settleError.message : String(settleError),
            event: "subagent.cancel.settlement_failed",
          });
        })
        .finally(() => {
          taskDeadline.clear();
          taskAbort.dispose();
          ctx.registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
          taskAbort.settle(ctx.registry.get(lifecycle.agentId));
        });
      throw error;
    }
    // Задача уже завершилась ошибкой: timer не должен участвовать в финализации.
    taskDeadline.clear();
    await persistSwarmFact("failed", { diagnosticCode: "child_execution_failed" });
    taskAbort.dispose();
    ctx.borrowedForegroundAgentIds.delete(lifecycle.agentId);
    const totalDurationMs = Date.now() - lifecycle.startedAt;
    // 根因：前台子代理收到 Turn failure wrapper，因此 message 可能只有通用文案；依据：
    // 后台 settlement 已从 cause 链选择原始错误，任务注册表应保留同一诊断原因。
    const errorMessage = selectExecutionErrorMessage(error);
    // Bug 原因: параллельный deadline/Stop finalizer мог уже записать terminal сразу после
    // проверки выше. 修复依据: если финализацией владеет этот же run (например, persist
    // после completion), продолжаем его failure-ветку; чужой владелец не перезаписывается.
    if (!ownsTaskFinalization) {
      ownsTaskFinalization = ctx.registry.beginSubagentTaskFinalization(lifecycle.agentId);
    }
    if (!ownsTaskFinalization) {
      throw error;
    }
    await writeFailedAgentArtifacts(lifecycle, request, errorMessage);
    const terminalTask = ctx.registry.update(lifecycle.agentId, (task) => ({
      ...withoutRuntimeMessageState(task),
      status: "failed",
      completedAt: new Date(),
      error: errorMessage,
      usage: {
        durationMs: totalDurationMs,
      },
    }));
    if (terminalTask) {
      await emitSubagentExecutionTerminal(
        ctx.options,
        ctx.registry,
        terminalTask,
        lifecycle.runTraceContext,
      );
    }
    await emitSubagentEvent(
      ctx.options,
      SessionEventType.SubagentStopped,
      request,
      lifecycle.runTraceContext,
      {
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        childSessionId: lifecycle.childSessionId,
        parentToolCallId: request.parentToolCallId,
        status: "failed",
        totalDurationMs,
        error: errorMessage,
      },
    );

    if (isCoreError(error)) {
      throw error;
    }

    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Explore subagent failed", {
      cause: error instanceof Error ? error : undefined,
      // 这层只描述父 Agent toolcall 的生命周期失败；真实 provider/model
      // 错误在 cause 链里，应作为 UI hover 与父模型 tool result 的主摘要。
      context: withErrorPayloadRole(
        {
          code: AgentErrorCode.CHILD_RUNTIME_FAILED,
          agentId: lifecycle.agentId,
          agentType: request.agentType,
          parentToolCallId: request.parentToolCallId,
        },
        ErrorPayloadRole.Wrapper,
      ),
      recoverable: true,
    });
  } finally {
    activityWatchdog.stop();
    autoBackgroundTimer?.cancel();
    if (!runningInBackground) {
      taskDeadline.clear();
      taskAbort.dispose();
      ctx.registry.releaseSubagentCancellationHandle(lifecycle.agentId, taskAbort);
      taskAbort.settle(ctx.registry.get(lifecycle.agentId));
    }
  }
}
