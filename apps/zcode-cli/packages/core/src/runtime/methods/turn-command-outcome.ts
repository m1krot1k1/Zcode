import { CoreErrorType, SessionEventType, createModelUsageSummaryFromEvents } from "../deps.js";
import { traceContextToLogContext } from "../deps.js";
import {
  appendTurnOutcomeEvent,
  createTurnFailureError,
  isTurnCancellationError,
  readAbortReasonText,
} from "../helpers/index.js";
import { captureEvidenceGatedLesson } from "../../subagent/persistent-memory.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import { maybeStartDeferredSessionTitleGeneration } from "./session-title.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import {
  MODEL_CREATION_FAILED_MESSAGE,
  MODEL_CREATION_TURN_PHASE,
  TURN_EXECUTION_FAILED_MESSAGE,
  type TurnCommandContext,
} from "./turn-command-context.js";
import type { TurnResult } from "../types.js";

/** Успешное завершение: usage, стабильная граница fork, TurnComplete и Memory. */
export async function finalizeSuccessfulTurn(ctx: TurnCommandContext): Promise<TurnResult> {
  const { runtime, options, events, turnTraceContext, turnStartedAtMs, turnId } = ctx;
  const { state } = ctx;
  const loopState = state.loopState!;
  const turnMachine = state.turnMachine;

  const turnUsage = createModelUsageSummaryFromEvents(events);
  // goal usage/active-run 先结算，再固定 exact goal/verifier boundary；只有两者都
  // 已持久化，TurnComplete 才能让 projection/UI 开放最终 assistant fork。
  await runtime.accountTargetTurnCompletion({
    inputID: ctx.targetRunInputID,
    startedAtMs: turnStartedAtMs,
    startedTarget: state.startedTarget,
    traceContext: turnTraceContext,
    usage: turnUsage,
  });
  if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
    await persistStableForkCompletionBoundary(runtime, {
      boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
      startMessageId: loopState.stableProductStartMessageId,
      historyRoundCount: loopState.historyRoundCount,
      traceContext: turnTraceContext,
    });
  }
  if (loopState.stableBoundaryAssistantMessageId) {
    await appendBrowserTurnScreenshot(
      runtime,
      loopState,
      loopState.stableBoundaryAssistantMessageId,
    );
  }
  const completeEvent = runtime.createEvent(
    SessionEventType.TurnComplete,
    {
      response: loopState.modelResponse,
      tokenCount: loopState.tokenCount,
      usage: turnUsage,
      toolCallCount: loopState.toolCallCount,
      historyRoundCount: loopState.historyRoundCount,
      duration: Date.now() - turnMachine.state.startedAt.getTime(),
      // turn loop 是 maxTurns 的唯一执行者；它把受限终态写进 turnMachine.resultType，
      // 这里原样发布，避免把 error_max_turns 覆盖成普通 success。
      resultType: turnMachine.state.resultType,
      ...(loopState.backgroundSubagentResultConsumed
        ? { backgroundSubagentResultConsumed: true }
        : {}),
      ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
      cacheStats: runtime.messageHistory.getCacheStats(),
      inputId: options?.inputId,
    },
    turnTraceContext,
  );
  await runtime.appendEvent(completeEvent, turnTraceContext);
  events.push(completeEvent);
  // 受限 maxTurns 不是普通 completed：usage-факт и терминальный лог должны нести
  // не-успешный статус, иначе success-метрики смешивают ограниченный turn с успехом
  // （docs/specs/max-turns-limit.md「Типы терминального статуса」）。
  const limitedAtMaxTurns = turnMachine.state.resultType === "error_max_turns";
  await recordTurnUsageFact(runtime, {
    completedAt: Date.now(),
    events,
    ...(limitedAtMaxTurns
      ? {
          // UsageStatus не содержит "failed"; "error" — фактически поддерживаемый
          // ограниченный статус. errorType берётся из name обычного Error.
          error: Object.assign(new Error("Turn reached the configured max turns limit."), {
            name: "error_max_turns",
          }),
        }
      : {}),
    startedAt: turnStartedAtMs,
    status: limitedAtMaxTurns ? "error" : "completed",
    traceContext: turnTraceContext,
    turnId,
    userMessageId: state.userMessageId,
  });
  if (state.shouldRetryTitleGenerationAfterTurn && state.userMessageId) {
    // 需要请求前刷新 provider runtime headers 的模型
    // 若在主 turn 前生成标题，会先占用鉴权刷新窗口，导致真正的用户消息失败。
    maybeStartDeferredSessionTitleGeneration.call(
      runtime,
      ctx.displayInput,
      state.userMessageId,
      turnTraceContext,
      options?.offPeakExecutionId,
    );
  }
  runtime.turnNumber++;

  const projection = await runtime.rebuildProjection();
  // 受限 turn 不能以 "Turn completed"/status completed 进日志：这条日志是成功收口的
  // 生产可用事件，混用会让监控把 error_max_turns 计成成功
  // （docs/specs/max-turns-limit.md「Типы терминального статуса」）。
  if (limitedAtMaxTurns) {
    runtime.logger?.info("Turn completed with max turns limit", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
      event: "turn.max_turns.completed",
      module: "core.runtime",
      resultType: turnMachine.state.resultType,
      status: "failed",
      toolCallCount: loopState.toolCallCount,
    });
  } else {
    runtime.logger?.info("Turn completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
      event: "turn.completed",
      module: "core.runtime",
      status: "completed",
      toolCallCount: loopState.toolCallCount,
    });
  }
  // 单轮执行策略只抑制本次成功 Turn 的后台提取，不修改 Session Memory 配置。
  if (options?.modelExecution?.memoryExtraction !== "skip" && !runtime.shuttingDown) {
    scheduleProjectMemoryExtraction(runtime, {
      model: loopState.model,
      traceContext: turnTraceContext,
    });
    // 原因：只记录本回合已发生的「同一工具先失败后成功」，写失败不能打断已完成的回合。
    await captureEvidenceGatedLesson({
      events,
      fileSystemPort: runtime.fileSystemPort,
      memory: runtime.config.memory,
      remoteWorkspace: runtime.isRemoteWorkspace(),
      sessionId: runtime.sessionId,
      turnId,
      workspaceRoot: runtime.workspaceRoot,
    });
  }

  const result: TurnResult = {
    response: loopState.modelResponse,
    turnId,
    traceId: ctx.traceId,
    usage: turnUsage,
    events,
    projection,
  };
  return result;
}

/** Терминальная ветка ошибки: снимает target accounting и пишет TurnError + usage. */
export async function finalizeFailedTurn(ctx: TurnCommandContext, error: unknown): Promise<never> {
  const { runtime, options, events, turnTraceContext, turnStartedAtMs, turnId } = ctx;
  const { state } = ctx;
  state.turnFailureHandled = true;
  const { creationFailure, creationFallbackUnavailable } = state.model;
  // CR-01：创建失败轮进入主链只为保留已接纳输入。落库中的普通失败不能覆盖模型创建错误，
  // 只记 warn。用户取消仍收口为 cancelled；宿主 fault 只经 abort signal 传入，
  // createTurnFailureError 会先于创建错误识别它。
  const reportedCreationFailure =
    creationFailure && !isTurnCancellationError(error, ctx.turnAbortSignal)
      ? creationFailure
      : undefined;
  if (reportedCreationFailure && error !== reportedCreationFailure.error) {
    runtime.logger?.warn("Accepted input persistence failed after model creation failed", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "turn.model_creation.input_persistence_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  const fallbackMessage = reportedCreationFailure
    ? MODEL_CREATION_FAILED_MESSAGE
    : TURN_EXECUTION_FAILED_MESSAGE;
  const coreError = createTurnFailureError(
    reportedCreationFailure ? reportedCreationFailure.error : error,
    ctx.turnAbortSignal,
    fallbackMessage,
  );
  const preserveQueueAutoDrainOnCancel =
    coreError.type === CoreErrorType.TurnCancelled &&
    runtime.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
  const finishedTarget = await runtime.finishTargetTurnAccounting({
    endedAtMs: Date.now(),
    inputID: ctx.targetRunInputID,
    startedTarget: state.startedTarget,
    status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
    traceContext: turnTraceContext,
  });
  if (finishedTarget?.targetID === state.startedTarget?.targetID) {
    state.startedTarget = finishedTarget;
  }
  if (coreError.type === CoreErrorType.TurnCancelled) {
    await runtime.pauseActiveTargetForCancellation(turnTraceContext);
    if (state.activeTurn) {
      await runtime.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events,
        reasonCode: "guide.turnInterrupted",
        traceContext: turnTraceContext,
      });
    }
  }
  // 普通 TurnError 只结束当前 turn，不撤销已经 accepted 的 future input。
  // V4 TurnError 投影将队列切成 error-paused，runtime 同步关闭行内 drain，
  // 保留排队输入，等待用户显式继续。
  if (state.activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
    const pendingInputs = (await runtime.rebuildProjection()).pendingSteerInputs;
    if (pendingInputs.length > 0) {
      runtime.queueAutoDrain = false;
      runtime.queueExternalDrainActive = false;
    }
  } else if (
    state.activeTurn &&
    coreError.type === CoreErrorType.TurnCancelled &&
    !preserveQueueAutoDrainOnCancel &&
    state.activeTurn.pendingInputs.length > 0
  ) {
    // runtime 授权位与投影同步：投影在 TurnComplete(cancelled)+queue>0 时把
    // queue.autoDrain 置 false（held），runtime 的 drain 门也必须同步翻转，
    // 否则 held 期间新起的 turn 会把后续入队项 drain 掉，与投影语义分叉。
    runtime.queueAutoDrain = false;
    runtime.queueExternalDrainActive = false;
  }

  // background wake 可能在 loopState 初始化前取消；此时仍要保留已 dequeue 的结果事实。
  const backgroundSubagentResultConsumed =
    options?.backgroundSubagentResultConsumed === true ||
    state.loopState?.backgroundSubagentResultConsumed === true;
  const workflowResultConsumed =
    options?.workflowResultConsumed === true || state.loopState?.workflowResultConsumed === true;
  await appendTurnOutcomeEvent(runtime, {
    coreError,
    events,
    durationMs: Date.now() - state.turnMachine.state.startedAt.getTime(),
    turnPhase: reportedCreationFailure ? MODEL_CREATION_TURN_PHASE : state.turnMachine.state.phase,
    inputId: options?.inputId,
    highspeedCardId: options?.intent?.highspeed?.cardId,
    highspeedFallbackUnavailable:
      creationFallbackUnavailable || state.loopState?.highspeedFallbackUnavailable === true,
    traceContext: turnTraceContext,
    fallbackMessage,
    logEvent: "turn.failed",
    logLabel: "Turn",
    preserveQueueAutoDrainOnCancel,
    abortReason: readAbortReasonText(ctx.turnAbortSignal.reason),
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    historyRoundCount: state.loopState?.historyRoundCount,
  });
  await recordTurnUsageFact(runtime, {
    completedAt: Date.now(),
    error: coreError,
    events,
    startedAt: turnStartedAtMs,
    status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
    traceContext: turnTraceContext,
    turnId,
    userMessageId: state.userMessageId,
  });
  throw coreError;
}
