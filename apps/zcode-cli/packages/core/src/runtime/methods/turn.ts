import { beginLocalTurnPreparation, type LocalTtftDetail } from "@zcode/contracts";
import { ensureGroupTaskPermissionScope } from "./input-intent-persistence.js";
import { prepareOffPeakTurn } from "../off-peak/runtime.js";
import {
  SessionEventType,
  TurnMachineImpl,
  type QueryId,
  type SessionEvent,
  type TurnState,
  createChildTraceContext,
  createMessageId,
  createQueryId,
  createTurnId,
  runWithContextAsync,
  traceContextToLogContext,
} from "../deps.js";
import type { ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import { disposeProjectMemoryRecallPrefetch } from "../helpers/project-memory-recall.js";
import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";
import {
  acceptSubmissionModelSelection,
  captureHighspeedFallbackSelection,
  applySubmissionExecutionState,
} from "./turn-model.js";
import { shouldRunRootSwarmPlanner } from "../helpers/swarm-planner-gate.js";
import { executeSwarmRun } from "./turn-swarm-execute.js";
import {
  createTurnAbortScope,
  isTurnCancellationError,
  parseCompactCommand,
  parseRewindCommand,
  summarizeTurnAttachmentsForEvent,
  throwIfTurnAborted,
} from "../helpers/index.js";
import { type TurnCommandContext, type TurnCommandState } from "./turn-command-context.js";
import {
  createTurnLoopState,
  initializeTurnContext,
  persistTurnUserInput,
  prepareTurnForLoop,
  prepareTurnInputEntries,
  runUserPromptStage,
} from "./turn-command-input.js";
import { resolveTurnExecutionModel } from "./turn-command-model.js";
import { finalizeFailedTurn, finalizeSuccessfulTurn } from "./turn-command-outcome.js";

const TARGET_RUN_HEARTBEAT_MS = 15_000;

export async function executeTurn(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  if (options?.modelExecution) {
    options = {
      ...options,
      modelExecution: captureHighspeedFallbackSelection(this, options.modelExecution),
    };
  }
  return await enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandAccepted: () => {
      // 原始 executeTurn 与协议 admission 共用接纳语义；Loop 开始后不再倒写旧选择。
      void acceptSubmissionModelSelection(
        this,
        options?.intent,
        options?.traceContext ?? this.rootTraceContext,
        options?.modelExecution,
      ).catch((error) => {
        this.logger?.warn("Accepted model selection projection failed", { error: String(error) });
      });
    },
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options,
      priority: "next",
      reject,
      resolve,
      traceContext: options?.traceContext ?? this.rootTraceContext,
    }),
  });
}

export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // 普通 Turn 过去在异步初始化完成后才读取 Session Selection/输出样式，
  // 初始化期间发生的切模会越过 admission 边界，错误影响已经开始的 Turn。
  // 这里在任何 await 之前冻结本轮事实；后续配置变化只作用于下一轮。
  const offPeakTurn = prepareOffPeakTurn(this, options);
  options = offPeakTurn.options;
  const admittedModelSelection =
    options?.intent?.modelSelection ??
    (options && "executionSelection" in options
      ? options.executionSelection
      : this.getSessionModelSelection());
  // 加速轮期间新输入可以更新 Session 续跑选择；卡过期必须回到本轮启动时的普通模型。
  const highspeedFallbackSelection = options?.modelExecution?.selectionFallback
    ? structuredClone(
        "highspeedFallbackSelection" in options.modelExecution
          ? options.modelExecution.highspeedFallbackSelection
          : this.getSessionModelSelection(),
      )
    : undefined;
  const admittedOutputStyle = this.config.outputStyle;
  const compactInstructions = parseCompactCommand(input);
  const rewindCommand = parseRewindCommand(input);
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  const turnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  const targetRunInputID = options?.inputId ?? String(turnId);
  const events: SessionEvent[] = [];
  const initialTurnMachine = TurnMachineImpl.create(
    this.sessionId,
    this.turnNumber,
    input,
    traceId,
    turnId,
  );
  this.currentTurnFileChanges = new Map();
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;
  const ownsRootRunBudget = !options?.internalSwarmRootRunId;
  const rootRunId = options?.internalSwarmRootRunId ?? `${this.sessionId}:${turnId}`;
  if (ownsRootRunBudget) {
    this.runtimeTaskRegistry.beginRootRunBudget({
      rootRunId,
      rootSessionId: this.sessionId,
      turnId,
      startedAt: turnStartedAtMs,
      maxParallel: this.config.subagentMaxParallel,
      onExhausted: () => turnAbortScope.abort(new Error("Root run time budget exhausted")),
    });
  }
  let targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
  // 线上“已工作 N 秒”但没有终态的根因候选是：内层 Turn try/catch 之前的 await
  // 拒绝直接穿出。记录当前阶段并区分是否已被内层处理，便于生产日志还原卡点。
  let turnPhase = "queued";
  let finishPreparation: () => void = () => {};
  const preparationStages: Record<string, LocalTtftDetail["stage"]> = {
    context_initialization: "context",
    session_start_hooks: "hooks",
    user_prompt_hooks: "hooks",
    session_persistence: "persistence",
    turn_started_event: "persistence",
    target_accounting: "persistence",
  };
  const startTurnPhase = (phase: string): number => {
    const stage = preparationStages[phase];
    finishPreparation =
      stage && stage !== "attempt" && stage !== "retry_wait" && stage !== "user_confirmation"
        ? beginLocalTurnPreparation(turnTraceContext, stage)
        : () => {};
    turnPhase = phase;
    const startedAt = Date.now();
    this.logger?.info("Turn phase started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.phase.started",
      module: "core.runtime",
      phase,
      status: "started",
    });
    return startedAt;
  };
  const completeTurnPhase = (phase: string, startedAt: number): void => {
    finishPreparation();
    this.logger?.info("Turn phase completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - startedAt,
      event: "turn.phase.completed",
      module: "core.runtime",
      phase,
      status: "completed",
    });
  };
  const turnTelemetry = this.agentTelemetry.turn({
    inputSource: options?.inputSource,
    traceContext: turnTraceContext,
    turnNumber: this.turnNumber,
  });

  const state: TurnCommandState = {
    turnMachine: initialTurnMachine,
    activeTurn: undefined,
    startedTarget: null,
    userMessageId: undefined,
    loopState: undefined,
    shouldRetryTitleGenerationAfterTurn: false,
    turnFailureHandled: false,
    model: {
      admittedModel: undefined,
      submissionModel: undefined,
      effectiveExecutionSelection: admittedModelSelection,
      effectiveRequestDependencies: options?.modelExecution?.requestDependencies,
      creationFallback: undefined,
      creationFailure: undefined,
      creationFallbackUnavailable: false,
    },
  };
  const ctx: TurnCommandContext = {
    runtime: this,
    input,
    attachments,
    options,
    compactInstructions,
    rewindCommand,
    turnId,
    queryId,
    displayInput,
    turnTraceContext,
    traceId,
    turnStartedAtMs,
    targetRunInputID,
    turnAbortSignal,
    events,
    admittedModelSelection,
    highspeedFallbackSelection,
    admittedOutputStyle,
    ownsRootRunBudget,
    rootRunId,
    startTurnPhase,
    completeTurnPhase,
    state,
  };

  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      const executionStartedAt = performance.timeOrigin + performance.now();
      beginLocalTurnPreparation(turnTraceContext, "execution")();
      throwIfTurnAborted(turnAbortSignal);

      await resolveTurnExecutionModel(ctx);
      await initializeTurnContext(ctx);

      if (compactInstructions !== null) {
        const compactModel = await applySubmissionExecutionState(
          this,
          options?.intent,
          turnTraceContext,
          options?.modelExecution,
          state.model.admittedModel,
          input,
        );
        return this.executeManualCompact(
          input,
          compactInstructions,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
          compactModel,
        );
      }
      if (rewindCommand !== null) {
        return this.executeRewindCommand(
          input,
          rewindCommand,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
        );
      }
      // 创建失败轮不会进入 model step，guide 无法被消费；不可 steer 时调用方会改走队列。
      state.activeTurn = this.beginActiveTurn(
        turnId,
        turnTraceContext,
        "regular",
        state.model.creationFailure === undefined,
        options?.inputId === undefined ? {} : { inputId: options.inputId },
      );
      this.logger?.info("Turn started", {
        ...traceContextToLogContext(turnTraceContext),
        event: "turn.started",
        inputLength: input.length,
        module: "core.runtime",
        status: "started",
      });

      state.turnMachine = new TurnMachineImpl(state.turnMachine.start());
      let phaseStartedAt = startTurnPhase("session_persistence");
      await this.ensureSessionPersisted(displayInput, turnTraceContext);
      await ensureGroupTaskPermissionScope(this.sessionStore, this.sessionId, options?.intent);
      // execution-scoped 临时 Provider（例如闲时任务）拥有本轮自己的模型，不改写
      // Session Selection；普通 Submission 才在真正开跑时应用其原子选择。
      // 创建失败轮不再应用：重复建模会在主 try 之外再次抛错；也不改写选择、mode、plan，
      // 不占用目标轮次。
      state.model.submissionModel = state.model.creationFailure
        ? undefined
        : await applySubmissionExecutionState(
            this,
            options?.intent,
            turnTraceContext,
            options?.modelExecution,
            state.model.admittedModel,
            input,
          );
      state.startedTarget = state.model.creationFailure
        ? null
        : await this.readSessionTargetForContext(turnTraceContext);
      completeTurnPhase("target_read", phaseStartedAt);
      if (state.startedTarget?.status !== "active") {
        state.startedTarget = null;
      }
      state.userMessageId =
        options?.skipInputRecord === true
          ? (options.recordedInputMessageId ?? createMessageId())
          : createMessageId();
      // 附件展示元信息随 TurnStarted 下发（v4 投影 → userInput row.attachments）。
      // workspace checkpoint 挂在 user messageId 上；先生成 id 再发 TurnStarted，
      // v4 投影才能用 turn rowId 找回该轮文件 checkpoint，避免摘要有计数但展开查空。
      const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
      const turnStartedEvent = this.createEvent(
        SessionEventType.TurnStarted,
        {
          executionStartedAt,
          turnNumber: this.turnNumber,
          input: displayInput,
          messageId: state.userMessageId,
          inputId: options?.inputId,
          ...(options?.automationId
            ? { automationId: options.automationId }
            : options?.offPeakTaskId
              ? {
                  offPeakTaskId: options.offPeakTaskId,
                  ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
                }
              : {}),
          foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
          queryId,
          inputSource: options?.inputSource,
          inputVisibility: options?.inputVisibility,
          originMeta: options?.originMeta,
          ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
          ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
          targetId: options?.targetId,
          ...(options?.intent ? { intent: options.intent } : {}),
          ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
        },
        turnTraceContext,
      );
      phaseStartedAt = startTurnPhase("turn_started_event");
      await this.appendEvent(turnStartedEvent, turnTraceContext);
      completeTurnPhase("turn_started_event", phaseStartedAt);
      events.push(turnStartedEvent);
      phaseStartedAt = startTurnPhase("target_accounting");
      state.startedTarget = await this.startTargetTurnAccounting({
        inputID: targetRunInputID,
        startedAtMs: turnStartedAtMs,
        startedTarget: state.startedTarget,
        traceContext: turnTraceContext,
      });
      completeTurnPhase("target_accounting", phaseStartedAt);
      if (state.startedTarget && this.sessionStore?.heartbeatTargetRun) {
        targetRunHeartbeat = setInterval(() => {
          void this.trackResidencyBlockingWork(
            this.heartbeatTargetTurnAccounting({
              inputID: targetRunInputID,
              seenAtMs: Date.now(),
              startedTarget: state.startedTarget,
              traceContext: turnTraceContext,
            }),
          );
        }, TARGET_RUN_HEARTBEAT_MS);
        if (typeof targetRunHeartbeat === "object" && "unref" in targetRunHeartbeat) {
          targetRunHeartbeat.unref();
        }
      }

      try {
        const earlyResult = await runUserPromptStage(ctx);
        if (earlyResult) return earlyResult;
        const resolvedAttachments = await prepareTurnInputEntries(ctx);
        await persistTurnUserInput(ctx, resolvedAttachments);
        const loopModel = await prepareTurnForLoop(ctx);
        state.loopState = createTurnLoopState(ctx, loopModel);
        const loopState = state.loopState;

        openGoalStateChangeReminderDeferral(state.activeTurn);
        phaseStartedAt = startTurnPhase("regular_turn_loop");
        try {
          // 原因：internalSwarmRootRunId 只用于共享 root-run 预算；后代不应再次规划。
          // 修复依据：root planner 只在显式 swarm 且拥有 root-run budget 时开启；
          // auto 不再开启 planner，复杂任务走 Root → Start → Orchestrator。
          // 原因：子代理可能继承 root 的 orchestration intent；修复依据：只有创建 root-run budget
          // 且显式 swarm 的 turn 拥有 planner，后代仅能显式调用 Task/Agent 继续委派。
          if (
            shouldRunRootSwarmPlanner({
              ownsRootRunBudget,
              orchestrationMode: options?.intent?.orchestrationMode,
              internalSwarmRootRunId: options?.internalSwarmRootRunId,
            })
          ) {
            const swarmHandled = await executeSwarmRun.call(this, loopState, input, {
              rootRunId,
              rootTurnId: options?.internalSwarmRootTurnId ?? turnId,
              showPlanningStatus: options?.intent?.orchestrationMode === "swarm",
            });
            if (swarmHandled) {
              // После фактической child-работы root только собирает отчёт. Его собственные
              // инструменты здесь маскировали бы сбой делегирования незаметной inline-работой.
              loopState.toolDisallowlist = [
                ...new Set([
                  ...(loopState.toolDisallowlist ?? []),
                  ...this.getTools(loopState.model).map((tool) => tool.name),
                  "Agent",
                  "Task",
                ]),
              ];
            }
          }
          await runRegularTurnLoop.call(this, loopState);
          completeTurnPhase("regular_turn_loop", phaseStartedAt);
        } finally {
          finishOutputTokenRecovery(loopState.turnRequestState);
          await closeGoalStateChangeReminderDeferral.call(this, state.activeTurn, turnTraceContext);
        }
        state.turnMachine = loopState.turnMachine;
        return await finalizeSuccessfulTurn(ctx);
      } catch (error) {
        return await finalizeFailedTurn(ctx, error);
      }
    }).then(
      (result) => {
        turnTelemetry.finishCompleted("assistant_message");
        return result;
      },
      (error: unknown) => {
        if (!state.turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: turnPhase,
            status: "failed",
          });
        }
        if (isTurnCancellationError(error, turnAbortSignal)) {
          turnTelemetry.finishCancelled("abort_signal");
        } else {
          turnTelemetry.finishFailed("unhandled", "unknown", error);
        }
        throw error;
      },
    );

  return turnTelemetry.run(execute).finally(async () => {
    disposeProjectMemoryRecallPrefetch(this);
    if (targetRunHeartbeat) {
      clearInterval(targetRunHeartbeat);
    }
    this.releaseTurnStart(turnId);
    clearBrowserTurnState(this.sessionId, turnId);
    this.finishActiveTurn(state.activeTurn);
    // 根因：预算到期后 root signal 与 child runtime 是异步收口，root 可能先于后代返回；
    // 修复依据：registry 作为唯一 cascade owner 暴露 settlement promise，root 等待同一把手柄收口。
    if (ownsRootRunBudget) {
      await this.runtimeTaskRegistry.waitForRootRunCancellation(rootRunId);
      this.runtimeTaskRegistry.finishRootRunTurn(rootRunId);
    }
    offPeakTurn.release(
      turnAbortSignal.aborted
        ? "stopped"
        : events.some((event) => event.type === SessionEventType.TurnError)
          ? "failed"
          : "succeeded",
    );
    turnAbortScope.dispose();
    try {
      await this.browserControlPort?.turnEnded?.({
        sessionId: this.sessionId,
        turnId: String(turnId),
        traceContext: turnTraceContext,
      });
    } catch (error) {
      // 生命周期清理失败不能覆盖已经完成/失败的主 turn；backend 会在 session close 再兜底释放。
      this.logger?.warn("Browser turn cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.turn_cleanup.failed",
        turnId: String(turnId),
      });
    }
  });
}
