import type {
  ToolSearchExecutionContext,
} from "@zcode/contracts";
import { isOffPeakUserTakeover, refreshOffPeakTurnAfterTakeover } from "../off-peak/turn.js";

import { beginLocalTurnPreparation } from "@zcode/contracts";
import { SessionEventType, createChildTraceContext, createMessageId, createPartId, getModelUsageTotalTokens, traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import type { MessageId, ModelNetworkStatusEvent, ModelToolContract } from "../deps.js";
import {
  createRuntimeAssistantEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { createModelContextExceededFinishError, projectExecutionErrorPayload, finalizeSuspiciousEmptyModelResult, isContextExceededFinishReason, isSuspiciousEmptyModelResult, readRawFinishReason, throwIfTurnAborted, isModelContextExceededError, isTurnCancellationError, buildTurnFileChangeSummary } from "../helpers/index.js";
import type {
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  RuntimeModelStreamSnapshot,
  RuntimeModelTextResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import {
  captureAssistantPersistenceAnchor,
  finishModelStepWithoutToolCalls,
} from "./turn-stop.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import { persistCancelledStreamSnapshot } from "./cancelled-stream-persistence.js";
import {
  beginStartPlanBusyAdmissionRetryAttempt,
  createStartPlanBusyAutoRetryExhaustedError,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  getStartPlanBusyAdmissionRetryDelayMs,
  isStartPlanBusyStreamRecoveryFailure,
} from "./streaming-recovery.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordModelHistoryRound } from "./turn-loop-state.js";
import {
  querySourceForTask,
  recordMainTurnCacheHitUsage,
  recordMainTurnModelUsage,
} from "./turn-model-step-usage.js";
import { estimateCurrentModelInputTokens } from "./compact.js";
import { resolveReasoningAwareMaxOutputTokens } from "./model-token-limits.js";
import { resolvePromptDepthRuntimeTuning } from "../../context/cognitive-protocols.js";
import {
  applyExecutionSelectionFallback,
  matchExecutionSelectionFallback,
} from "./turn-execution-fallback.js";
import {
  classifyOutputTokenContinuation,
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
  completeOutputTokenRecovery,
  hasAssistantReasoningContent,
  recordTruncatedToolCallRecovery,
} from "./turn-output-token-continuation.js";
import { synthesizeTruncatedToolCallSettlements } from "../../tool/self-repair/index.js";
import { recoverModelStepAfterContextExceeded } from "./turn-model-step-compact-recovery.js";
import { handleOutputTokenLimitOutcome } from "./turn-model-step-output-limit.js";
import {
  buildAutomationCreateLimitFallback,
  buildStepDiagnostics,
  logModelRequestCompleted,
  logModelResponseDiagnostics,
  type ModelStepResult,
} from "./turn-model-step-diagnostics.js";

export async function runModelBackedTurnStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
    toolSearch?: ToolSearchExecutionContext;
  },
): Promise<ModelStepResult> {
  const assistantMessageId = createMessageId();
  const stepTelemetry = this.agentTelemetry.step({
    stepId: assistantMessageId,
    stepIndex: state.modelStepCount,
  });
  return stepTelemetry.run(async () => {
    try {
      const result = await runModelBackedTurnStepImpl.call(
        this,
        state,
        options,
        assistantMessageId,
      );
      stepTelemetry.finishCompleted(
        result === "output_continuation"
          ? "model_completed"
          : result === "continue"
            ? "tool_requested"
            : "turn_completed",
      );
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, state.turnAbortSignal)) {
        stepTelemetry.finishCancelled("abort_signal");
      } else {
        stepTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function runModelBackedTurnStepImpl(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
    toolSearch?: ToolSearchExecutionContext;
  },
  assistantMessageId: MessageId,
): Promise<ModelStepResult> {
  const model = state.model;
  const modelStepIndex = state.modelStepCount;
  const modelStartedAt = Date.now();
  const assistantCreatedAt = modelStartedAt;
  const assistantPersistenceAnchor = captureAssistantPersistenceAnchor(this);
  const querySource = querySourceForTask(this.config.taskType);
  const executionModelSelection = { providerId: model.providerId, modelId: model.modelId };
  // 请求预算由 Agent 执行链显式决定。普通 Turn 选择打满模型声明的上限，
  // ModelFactory 不再把该请求参数伪装成长期 ModelSelection/Active Model 状态。
  const executionMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
  const executionContextWindow = model.properties.contextWindow;
  const modelTraceContext = createChildTraceContext(state.turnTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
      querySource,
    },
  });

  this.logModelRequestSteeringContext({
    activeTurn: state.activeTurn,
    drained: options.drainedSteerForNextRequest,
    messages: options.messages,
    modelStepCount: state.modelStepCount,
    traceContext: modelTraceContext,
  });
  const finishPersistence = beginLocalTurnPreparation(modelTraceContext, "persistence");
  await this.persistAssistantMessage(
    assistantMessageId,
    state.currentUserMessageId,
    assistantCreatedAt,
    undefined,
    modelTraceContext,
    model,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "step-start",
    },
    modelTraceContext,
  );

  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      // 自动续写提示只属于本次请求，不应写入持久化的 ModelRequest 轨迹。
      messages: options.recordedMessages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: options.tools.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  state.events.push(modelRequestEvent);
  finishPersistence();
  const streamingToolCoordinator = createStreamingToolCoordinator(this, state, {
    assistantMessageId,
    model,
    toolSearch: options.toolSearch,
    traceContext: modelTraceContext,
  });
  const networkEventStartIndex = state.events.length;
  let latestStreamSnapshot: RuntimeModelStreamSnapshot = { reasoning: [], text: "" };
  const streamRecoveryRequest = state.pendingStreamRecoveryRequest;
  state.pendingStreamRecoveryRequest = undefined;
  let latestModelRequestId: string | undefined;
  let latestFailedModelRequestId: string | undefined;
  const recordModelNetworkStatus = (event: ModelNetworkStatusEvent): void => {
    if (event.type === "model_request_started") {
      latestModelRequestId = event.requestId;
      return;
    }
    if (event.type === "model_stream_stalled" || event.type === "model_request_failed") {
      latestFailedModelRequestId = event.requestId;
    }
  };

  let result: RuntimeModelTextResult;
  // Инкремент 4.4: явный профиль глубины повышает бюджет рассуждения и минимальный выходной
  // бюджет. Пока профиль не задан, рантайм сохраняет поведение 4.1 — новый параметр не меняет
  // рассуждения существующих сессий молча (условие обратной совместимости).
  const depthTuning =
    this.config.promptDepth === undefined
      ? undefined
      : resolvePromptDepthRuntimeTuning(this.config.promptDepth);
  const outputBudget = resolveReasoningAwareMaxOutputTokens({
    modelHardMaxOutputTokens: executionMaxOutputTokens,
    configuredMaxOutputTokens: depthTuning?.minMaxOutputTokens,
    contextWindow: executionContextWindow,
    estimatedInputTokens: estimateCurrentModelInputTokens(
      options.messages,
      options.sourceEntries,
    ),
    reasoningEffort: depthTuning?.reasoningEffort ?? model.options?.reasoningLevel,
    minToolPayloadReserveTokens: this.config.reasoningReserveOutputTokens,
  });
  try {
    result = await this.runModelTextRequest({
      abortSignal: state.turnAbortSignal,
      assistantMessageId,
      events: state.events,
      maxOutputTokens: outputBudget.effectiveMaxOutputTokens,
      latestRealUserMessageIndex: options.latestRealUserMessageIndex,
      messages: options.messages,
      sourceEntries: options.sourceEntries,
      model,
      onStreamSnapshot: (snapshot) => {
        latestStreamSnapshot = snapshot;
      },
      onModelNetworkStatus: recordModelNetworkStatus,
      onStreamReasoningDelta: (text) => streamingToolCoordinator.recordReasoningDelta(text),
      onStreamTextDelta: (text) => streamingToolCoordinator.recordTextDelta(text),
      onStreamToolCall: (toolCall) => streamingToolCoordinator.accept(toolCall),
      streamRecovery: streamRecoveryRequest,
      tools: options.tools,
      toolSearchEnabled: options.toolSearch?.mode === "native",
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(state.turnAbortSignal);
  } catch (error) {
    let finalError = error;
    await recordMainTurnModelUsage(this, state, {
      assistantMessageId,
      error: finalError,
      model,
      modelTraceContext,
      networkEventStartIndex,
      startedAt: modelStartedAt,
      status: state.turnAbortSignal.aborted ? "cancelled" : "error",
    });
    const failedRequestId = latestFailedModelRequestId ?? latestModelRequestId;
    // 执行 Selection 的声明式退回必须先于同模型 stream recovery：明确归因到加速 provider/network
    // 边界的请求失败都要退回会话模型（spec §2.2）。若 recovery 在前，流中断后会先在加速模型上
    // 重试到预算耗尽，降级形同虚设。
    const selectionFallbackMatch = matchExecutionSelectionFallback({
      error: finalError,
      executionProviderId: String(executionModelSelection.providerId),
      selectionFallback: state.selectionFallback,
      turnAborted: state.turnAbortSignal.aborted,
    });
    const toolCallCountBeforeSelectionFallback = state.toolCallCount;
    const selectionFallbackResult = selectionFallbackMatch
      ? await applyExecutionSelectionFallback(this, state, {
          assistantCreatedAt,
          assistantMessageId,
          error: finalError,
          executionModel: model,
          match: selectionFallbackMatch,
          modelTraceContext,
          streamingToolCoordinator,
        })
      : undefined;
    if (selectionFallbackResult?.applied) {
      // Bug 根因：fallback settlement 已提交工具结果并建立新 anchor，却继承了此前 length 链的计数，
      // 使退回模型第一次截断就可能提前耗尽。只按工具计数增量重置，纯文本 tail discard 不绕过上限。
      if (state.toolCallCount > toolCallCountBeforeSelectionFallback) {
        completeOutputTokenRecovery(state.turnRequestState);
      }
      return "continue";
    }
    const toolCallCountBeforeStreamRecovery = state.toolCallCount;
    // Bug 根因：退回目标解析失败后若继续进入通用恢复，会重新请求同一个已失败的 execution provider。
    // 命中声明就已消费本轮恢复决策；无处可退必须保留原错误并直接失败。
    if (
      !selectionFallbackMatch &&
      (await streamingToolCoordinator.recoverFromModelFailure(
        error,
        assistantCreatedAt,
        failedRequestId ? { failedRequestId } : undefined,
      ))
    ) {
      if (state.toolCallCount > toolCallCountBeforeStreamRecovery) {
        completeOutputTokenRecovery(state.turnRequestState);
      }
      return "continue";
    }
    if (
      !state.turnAbortSignal.aborted &&
      isOffPeakUserTakeover(error) &&
      refreshOffPeakTurnAfterTakeover(this, state)
    ) {
      await streamingToolCoordinator.abandon("model_failed");
      await this.persistAssistantMessage(
        assistantMessageId,
        state.userMessageId,
        assistantCreatedAt,
        {
          completed: Date.now(),
          finish: "off_peak_request_replaced",
        },
        modelTraceContext,
        model,
      );
      state.modelResponse = "";
      state.modelStepCount += 1;
      recordModelHistoryRound(state);
      state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      return "continue";
    }
    const admissionRetryDelayMs = getStartPlanBusyAdmissionRetryDelayMs({
      error: finalError,
      providerId: executionModelSelection.providerId,
      state,
      turnNumber: this.turnNumber,
    });
    if (
      !selectionFallbackMatch &&
      !state.turnAbortSignal.aborted &&
      admissionRetryDelayMs !== undefined
    ) {
      // 第二轮及以后 Start Plan 可能在首 token 前被 admission 并发限制拒绝；
      // 这时没有文本或 tool anchor，旧 stream recovery 不会启动，必须关闭空 assistant 后短重试。
      const recoveryAttempt = beginStartPlanBusyAdmissionRetryAttempt(state);
      this.logger?.warn("Main turn retrying after Start Plan admission busy", {
        ...traceContextToLogContext(modelTraceContext),
        event: "model.main_turn.retry_start_plan_admission_busy",
        module: "core.runtime",
        retryDelayMs: admissionRetryDelayMs,
        retryNumber: recoveryAttempt.retryNumber,
        maxRetries: recoveryAttempt.maxRetries,
        status: "waiting",
      });
      await emitStreamRecoveryStarted(
        this,
        state,
        {
          assistantMessageId,
          ...(failedRequestId ? { failedRequestId } : {}),
          traceContext: modelTraceContext,
        },
        finalError,
        recoveryAttempt,
      );
      await this.persistAssistantMessage(
        assistantMessageId,
        state.userMessageId,
        assistantCreatedAt,
        {
          completed: Date.now(),
          finish: "start_plan_admission_retry_discarded",
        },
        modelTraceContext,
        model,
      );
      state.modelResponse = "";
      state.modelStepCount += 1;
      recordModelHistoryRound(state);
      state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      await emitStreamRecoveryRetryEvents(
        this,
        state,
        {
          assistantMessageId,
          ...(failedRequestId ? { failedRequestId } : {}),
          traceContext: modelTraceContext,
        },
        {
          ...recoveryAttempt,
          discardedReasoningBytes: 0,
          discardedTextBytes: 0,
          reason: "no_tool_committed",
          toolCallIds: [],
        },
      );
      await streamingToolCoordinator.abandon("model_failed");
      await new Promise((resolve) => setTimeout(resolve, admissionRetryDelayMs));
      throwIfTurnAborted(state.turnAbortSignal);
      return "continue";
    }
    if (
      !selectionFallbackMatch &&
      state.streamRecoveryRetryCount > 0 &&
      !state.turnAbortSignal.aborted &&
      isStartPlanBusyStreamRecoveryFailure(finalError)
    ) {
      // Start Plan 运行中断流会先走 core stream recovery；恢复次数耗尽后，
      // 继续抛原 provider 文案会和首轮繁忙失败无法区分，UI 也就不能展示“自动重试达到最大次数”。
      finalError = createStartPlanBusyAutoRetryExhaustedError(finalError);
    }
    // 无 fallback target 时工具已在上方 settlement；再次 abandon 会发布与终态矛盾的 ledger 事件。
    if (!selectionFallbackResult?.settledAcceptedTools) {
      await streamingToolCoordinator.abandon(
        state.turnAbortSignal.aborted ? "cancelled" : "model_failed",
      );
    }
    if (
      state.turnAbortSignal.aborted &&
      isTurnCancellationError(finalError, state.turnAbortSignal)
    ) {
      await persistCancelledStreamSnapshot(this, {
        assistantCreatedAt,
        assistantMessageId,
        snapshot: latestStreamSnapshot,
        traceContext: modelTraceContext,
      });
      const reasoning = latestStreamSnapshot.reasoning.filter(hasAssistantReasoningContent);
      if (latestStreamSnapshot.text.length > 0 || reasoning.length > 0) {
        // 取消时 durable snapshot 已经持久化，但成功路径的 live history commit
        // 和 historyRoundCount 不会执行，导致当前进程与 cold resume 的 provider history 不一致。
        commitTurnRequestEntries(this, state.turnRequestState, [
          createRuntimeAssistantEntry(
            latestStreamSnapshot.text,
            undefined,
            reasoning,
            state.model
              ? { providerId: state.model.providerId, modelId: state.model.modelId }
              : undefined,
          ),
        ]);
        recordModelHistoryRound(state);
      }
    }
    const finalErrorRecord =
      finalError && typeof finalError === "object"
        ? (finalError as Record<string, unknown>)
        : undefined;
    const persistedErrorCode =
      typeof finalErrorRecord?.code === "string" ? finalErrorRecord.code : undefined;
    const persistedErrorProjection = projectExecutionErrorPayload(finalError);
    const persistedTurnResult = isTurnCancellationError(finalError, state.turnAbortSignal)
      ? "cancelled"
      : undefined;
    await this.persistAssistantMessage(
      assistantMessageId,
      state.userMessageId,
      assistantCreatedAt,
      {
        completed: Date.now(),
        error: {
          name: finalError instanceof Error ? finalError.name : "UnknownError",
          data: {
            message: finalError instanceof Error ? finalError.message : String(finalError),
            ...(persistedErrorCode ? { code: persistedErrorCode } : {}),
            // live TurnError 有结构化归因，但 transcript 过去未持久化，冷恢复后会丢成 runtime。
            ...(persistedErrorProjection.attribution
              ? { attribution: persistedErrorProjection.attribution }
              : {}),
            // 用户 Stop 的模型中止过去只持久化通用 error name/message，
            // cold hydration 无法区分正常取消和真实 provider 失败，最终错误地生成 TurnError。
            ...(persistedTurnResult ? { turnResult: persistedTurnResult } : {}),
          },
        },
      },
      modelTraceContext,
      model,
    );
    if (
      isModelContextExceededError(finalError) &&
      (await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        finalError,
        modelStepIndex,
        options.requestEntries,
      ))
    ) {
      return "continue";
    }
    throw finalError;
  }

  state.modelResponse = result.text;
  state.modelStepCount += 1;
  state.tokenCount += getModelUsageTotalTokens(result.usage);

  if (result.usage.cacheReadTokens && result.usage.cacheReadTokens > 0) {
    this.messageHistory.setCacheHit(result.usage.cacheReadTokens);
  }

  let toolCalls = this.extractToolCallsFromResult(result);
  const providerToolCallCount = toolCalls.length;
  const localTerminalResponse = state.automationCreateLimitReached === true;
  if (state.automationCreateLimitReached && toolCalls.length > 0) {
    // 即使 provider 在 tools=[] 后仍幻觉出工具调用，也不能重新进入执行器；
    // 上限命中后的当前用户 turn 已经是纯文本终止边界。
    this.logger?.warn("Ignored tool calls after automation create limit was reached", {
      event: "automation.create_limit.tool_calls_ignored",
      module: "core.runtime",
      status: "completed",
      toolCallCount: toolCalls.length,
    });
    toolCalls = [];
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  } else if (state.automationCreateLimitReached && state.modelResponse.trim().length === 0) {
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  }
  const usage = result.usage ?? {};
  const responseLength = state.modelResponse.length;
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  // Automation create-limit 已经接管当前响应的终止语义；若在清空
  // provider tool calls 后仍重新解释 length/context reason，纯文本终态会再续跑 3 次。
  const outputTokenContinuation = localTerminalResponse
    ? "none"
    : classifyOutputTokenContinuation({
        continuationCount: state.turnRequestState.outputTokenContinuationCount,
        finishReason: result.finishReason,
        rawFinishReason,
        toolCallCount: providerToolCallCount,
      });
  logModelResponseDiagnostics({
    logger: this.logger,
    modelTraceContext,
    result,
    rawFinishReason,
    responseLength,
    toolCallCount: toolCalls.length,
    usage,
  });
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    toolCalls.length === 0 &&
    isContextExceededFinishReason(result.finishReason, rawFinishReason)
  ) {
    // 超窗 provider 可能返回空内容和 zero usage；必须先识别 overflow，
    // 否则会被 suspicious empty 包成普通 ModelError，后续 reactive compact 无法触发。
    const contextError = createModelContextExceededFinishError({
      finishReason: result.finishReason,
      rawFinishReason,
    });
    if (
      await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        contextError,
        modelStepIndex,
        options.requestEntries,
      )
    ) {
      return "continue";
    }
    throw contextError;
  }
  const emptyMainTurnResult =
    querySource === "main_turn" &&
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    responseLength === 0 &&
    toolCalls.length === 0;
  if (
    emptyMainTurnResult ||
    (!localTerminalResponse &&
      outputTokenContinuation === "none" &&
      isSuspiciousEmptyModelResult(result.finishReason, responseLength, toolCalls.length, usage))
  ) {
    // 根因：空 stop + 非零 usage 会绕过 adapter 的 zero-usage retry/anomaly 判据，随后被写成成功空 TurnComplete。
    // 修复依据：普通主 turn 必须给用户可见正文或工具调用；内部查询仍由各自调用方处理空结果。
    this.logger?.warn("Model returned an empty final result", {
      ...traceContextToLogContext(modelTraceContext),
      event: "model.response.suspicious_empty",
      finishReason: result.finishReason,
      module: "core.runtime",
      rawFinishReason,
      responseLength,
      status: "failed",
      toolCallCount: toolCalls.length,
      usageTotalTokens: usage.totalTokens,
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason: result.finishReason,
      model: executionModelSelection,
      providerMetadata: result.providerMetadata,
      rawFinishReason,
    });
  }
  // AI SDK 可能把非标准 output-limit 归一化为 other；Runtime 已确认恢复语义后，
  // live 事件与持久化必须统一使用 length，同时由上方 diagnostics 保留 provider 原始事实。
  if (outputTokenContinuation !== "none") result.finishReason = "length";
  const cacheHitRatio =
    (usage.inputTokens ?? 0) > 0
      ? Math.min(1, Math.max(0, (usage.cacheReadTokens ?? 0) / usage.inputTokens!))
      : undefined;
  state.lastStepDiagnostics = buildStepDiagnostics({
    finishReason: result.finishReason,
    rawFinishReason,
    outputBudget,
    cacheHitRatio,
    stateTransitions: state.turnMachine.state.stateTransitions ?? [],
  });
  for (const reasoning of result.reasoning ?? []) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        metadata: reasoning.providerOptions,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }
  if (state.modelResponse.length > 0) {
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "text",
        text: state.modelResponse,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }

  const cacheHit =
    querySource === "main_turn" ? recordMainTurnCacheHitUsage(this, result.usage) : undefined;
  // subagent 的文件 checkpoint 已经持久化，但旧 gate 只允许 main_turn 把
  // 汇总写入 ModelComplete，导致 child 详情无法从权威事件恢复摘要和撤销入口。
  const supportsTurnFileChanges = querySource === "main_turn" || querySource === "subagent";
  const fileChanges =
    supportsTurnFileChanges && toolCalls.length === 0
      ? buildTurnFileChangeSummary(this.currentTurnFileChanges)
      : undefined;
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: state.modelResponse,
      ...(latestModelRequestId ? { requestId: latestModelRequestId } : {}),
      // 桌面 continuous 实时事件只携带当前 model_complete payload。
      // 如果主轮次只发 usage 不发 contextWindow，旧 task stream 无法生成 usage_update，
      // 长程任务中输入栏会拿不到 context meter 的 size 而隐藏。
      ...(querySource === "main_turn" && executionContextWindow !== undefined
        ? { contextWindow: executionContextWindow }
        : {}),
      querySource,
      stopReason: result.finishReason,
      usage: result.usage,
      ...(cacheHit ? { cacheHit } : {}),
      ...(fileChanges ? { fileChanges } : {}),
      ...(querySource === "main_turn" && result.contextUsageBreakdown
        ? { contextUsageBreakdown: result.contextUsageBreakdown }
        : {}),
      toolCallCount: toolCalls.length,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  state.events.push(modelCompleteEvent);
  this.lastAssistantCompletedAtMs = Date.now();
  await recordMainTurnModelUsage(this, state, {
    assistantMessageId,
    model,
    modelTraceContext,
    networkEventStartIndex,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
  });
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.receiveModelResponse(state.modelResponse),
  );
  throwIfTurnAborted(state.turnAbortSignal);

  logModelRequestCompleted({
    logger: this.logger,
    modelTraceContext,
    agentType: this.config.agentType ?? "root",
    durationMs: Date.now() - modelStartedAt,
    sessionId: this.sessionId,
    totalTokens: state.tokenCount,
    toolCallCount: toolCalls.length,
  });

  const executableToolCalls = toolCalls
    .filter((toolCall) => !toolCall.providerExecuted)
    .map((toolCall) => streamingToolCoordinator.admit(toolCall));
  const streamedToolResults = await streamingToolCoordinator.drain(executableToolCalls);
  if (outputTokenContinuation === "recover_truncated_tool_calls") {
    const truncatedSettlements = synthesizeTruncatedToolCallSettlements({
      toolCalls: executableToolCalls,
      existingStreamedIds: new Set(streamedToolResults.map((entry) => entry.toolCallId)),
      resolveEntry: (name) => this.registry.get(name),
      maxOutputTokens: outputBudget.effectiveMaxOutputTokens,
      reasoningTokens: usage.reasoningTokens,
      outputTokens: usage.outputTokens,
    });
    if (truncatedSettlements.length > 0) {
      state.turnRequestState.entries = options.requestEntries;
      recordTruncatedToolCallRecovery(state.turnRequestState);
      state.reactiveCompactAttemptedInCurrentModelStep = false;
      state.turnMachine = new TurnMachineImpl(
        state.turnMachine.enterTruncatedToolRecovery("finish_reason_length"),
      );
      const firstTruncatedPreview = truncatedSettlements.find(
        (entry) => entry.result.failureDiagnostics?.rawTruncatedInputPreview,
      )?.result.failureDiagnostics?.rawTruncatedInputPreview;
      if (firstTruncatedPreview && state.lastStepDiagnostics) {
        state.lastStepDiagnostics = {
          ...state.lastStepDiagnostics,
          rawTruncatedInputPreview: firstTruncatedPreview,
        };
      }
      const truncatedIds = new Set(truncatedSettlements.map((entry) => entry.toolCallId));
      const sanitizedToolCalls = executableToolCalls.map((tc) =>
        truncatedIds.has(tc.id as never) &&
        (typeof tc.input !== "object" || tc.input === null || Array.isArray(tc.input))
          ? { ...tc, input: {} }
          : tc,
      );
      state.toolCallCount += sanitizedToolCalls.length;
      if (commitAssistantToTurnRequest(this, state, result, sanitizedToolCalls)) {
        recordModelHistoryRound(state);
      }
      return await executeToolCallsForModelStep.call(this, state, {
        toolSearch: options.toolSearch,
        assistantCreatedAt,
        assistantMessageId,
        modelTraceContext,
        result,
        toolCalls: sanitizedToolCalls,
        streamedToolResults: [
          ...streamedToolResults.filter((entry) => !truncatedIds.has(entry.toolCallId)),
          ...truncatedSettlements,
        ],
      });
    }
  }
  if (
    outputTokenContinuation !== "none" &&
    outputTokenContinuation !== "recover_truncated_tool_calls"
  ) {
    return await handleOutputTokenLimitOutcome(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      model,
      modelTraceContext,
      outputTokenContinuation,
      requestEntries: options.requestEntries,
      result,
    });
  }
  completeOutputTokenRecovery(state.turnRequestState);
  if (executableToolCalls.length === 0) {
    return await finishModelStepWithoutToolCalls.call(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      modelTraceContext,
      querySource,
      result,
    });
  }

  state.toolCallCount += executableToolCalls.length;
  // 合并修复：工具调用 assistant 必须同时进入 canonical history 与本轮 request history。
  // 只写 canonical history 会让紧随其后的工具结果失去对应 assistant tool-call。
  if (commitAssistantToTurnRequest(this, state, result, executableToolCalls)) {
    recordModelHistoryRound(state);
  }
  const toolStepResult = await executeToolCallsForModelStep.call(this, state, {
    toolSearch: options.toolSearch,
    assistantCreatedAt,
    assistantMessageId,
    modelTraceContext,
    result,
    toolCalls: executableToolCalls,
    streamedToolResults,
  });
  return toolStepResult;
}
