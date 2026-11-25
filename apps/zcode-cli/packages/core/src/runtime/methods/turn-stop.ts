import { HookEventName, TurnMachineImpl, createMessageId, createPartId } from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import { emptyTokenUsageInfo, toTokenUsageInfo } from "../helpers/index.js";
import { calculateRuntimeModelCost } from "../helpers/model-cost.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import {
  appendTurnRequestEntries,
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
} from "./turn-output-token-continuation.js";
import {
  createRuntimeAssistantEntry,
  systemReminderAttachmentEntry,
} from "../../agent/message-history.js";
import { runAgentAutoRepairGate } from "../auto-repair-loop/index.js";
import { runUncensoredTakeoverGate } from "./uncensored-takeover-gate.js";

interface AssistantPersistenceAnchor {
  latestAssistantMessageId: AgentRuntimeInternal["latestAssistantMessageId"];
  latestAssistantTurnId: AgentRuntimeInternal["latestAssistantTurnId"];
  latestConversationMessageId: AgentRuntimeInternal["latestConversationMessageId"];
}

export function captureAssistantPersistenceAnchor(
  runtime: AgentRuntimeInternal,
): AssistantPersistenceAnchor {
  return {
    latestAssistantMessageId: runtime.latestAssistantMessageId,
    latestAssistantTurnId: runtime.latestAssistantTurnId,
    latestConversationMessageId: runtime.latestConversationMessageId,
  };
}

export async function persistCompletedAssistantStep(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    includeEmptyAssistant: boolean;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<boolean> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed assistant persistence requires the loop Model");
  }
  let committed = commitAssistantToTurnRequest(runtime, state, options.result, undefined);
  if (!committed && options.includeEmptyAssistant) {
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      createRuntimeAssistantEntry(
        "",
        undefined,
        undefined,
        model,
        toTokenUsageInfo(options.result.usage),
      ),
    ]);
    committed = true;
  }
  if (!committed) {
    if (runtime.sessionStore) {
      await runtime.sessionStore.removeMessage({
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
      });
    }
    if (runtime.latestConversationMessageId === options.assistantMessageId) {
      runtime.latestConversationMessageId =
        options.assistantPersistenceAnchor.latestConversationMessageId;
    }
    if (runtime.latestAssistantMessageId === options.assistantMessageId) {
      runtime.latestAssistantMessageId =
        options.assistantPersistenceAnchor.latestAssistantMessageId;
      runtime.latestAssistantTurnId = options.assistantPersistenceAnchor.latestAssistantTurnId;
    }
    return false;
  }
  const persistedTokens = toTokenUsageInfo(options.result.usage);
  const cost = calculateRuntimeModelCost(model.modelId, persistedTokens);
  const stepDiagnostics = state.lastStepDiagnostics
    ? {
        ...state.lastStepDiagnostics,
        stateTransitions: [...(state.turnMachine.state.stateTransitions ?? [])],
      }
    : undefined;
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "step-finish",
      reason: options.result.finishReason,
      ...(stepDiagnostics?.rawFinishReason ? { rawReason: stepDiagnostics.rawFinishReason } : {}),
      ...(cost !== undefined ? { cost } : {}),
      tokens: persistedTokens,
      ...(stepDiagnostics ? { stepDiagnostics } : {}),
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    options.assistantMessageId,
    state.currentUserMessageId,
    options.assistantCreatedAt,
    {
      completed: Date.now(),
      finish: options.result.finishReason,
      finishReason: options.result.finishReason,
      ...(stepDiagnostics?.rawFinishReason
        ? { rawFinishReason: stepDiagnostics.rawFinishReason }
        : {}),
      ...(stepDiagnostics ? { stepDiagnostics } : {}),
      tokens: persistedTokens,
    },
    options.modelTraceContext,
    model,
  );
  return committed;
}

export async function persistOutputTokenLimitErrorCarrier(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    error: { data: Record<string, unknown>; name: string };
    finishReason: string;
    model: Model;
    modelTraceContext: TraceContext;
  },
): Promise<void> {
  const messageId = createMessageId();
  const createdAt = Date.now();
  const tokens = emptyTokenUsageInfo();
  const cost = calculateRuntimeModelCost(options.model.modelId, tokens);

  // partial 与终态 error 共用 durable assistant 时，Compact 无法同时重放
  // provider partial 并排除 transcript-only error。两者拆成独立消息后沿用既有过滤边界即可。
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    undefined,
    options.modelTraceContext,
    options.model,
  );
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: messageId,
      type: "step-finish",
      reason: options.finishReason,
      ...(cost !== undefined ? { cost } : {}),
      tokens,
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    {
      completed: Date.now(),
      error: options.error,
      finish: options.finishReason,
      tokens,
    },
    options.modelTraceContext,
    options.model,
  );
}

/**
 * Single exit for a turn whose visible answer is already persisted. Drains pending guides to
 * the authoritative queue, closes steering and fixes the fork boundary on that assistant
 * message, so the final visible text and the stable boundary cannot diverge.
 */
async function completeTurnWithFinalAssistant(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  assistantMessageId: MessageId,
): Promise<"break"> {
  if (state.activeTurn) {
    // FIFO barrier / reservation 阻止本轮安全 inline 时，仍保留既有权威 queue 兜底；
    // 正常可消费的 text-only guide 已作为 user-role continuation drain。
    await runtime.fallbackPendingGuidesToQueue({
      activeTurn: state.activeTurn,
      events: state.events,
      reasonCode: "guide.noToolBoundary",
      traceContext: state.turnTraceContext,
    });
    state.activeTurn.steerable = false;
  }
  state.stableProductStartMessageId = state.currentUserMessageId;
  state.stableBoundaryAssistantMessageId = assistantMessageId;
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.complete(state.modelResponse, "success"),
  );
  return "break";
}

export async function finishModelStepWithoutToolCalls(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    /** Route identity computed once in turn-model-step; the takeover gate accepts main_turn only. */
    querySource: string;
    result: RuntimeModelTextResult;
  },
): Promise<"continue" | "break"> {
  if (!state.model) {
    throw new Error("Model-backed turn stop requires the loop Model");
  }
  const assistantCommitted = await persistCompletedAssistantStep(this, state, {
    ...options,
    includeEmptyAssistant: true,
  });
  if (assistantCommitted) recordModelHistoryRound(state);
  if (state.automationCreateLimitReached) {
    // 上限命中后只允许这一轮纯文本说明。跳过 guide 和 Stop hook，避免它们再次
    // 触发模型请求，把已经关闭工具的 turn 延长成新的恢复循环。
    return await completeTurnWithFinalAssistant(this, state, options.assistantMessageId);
  }
  // Uncensored takeover: a provider refusal of one attributed task item is handed to a
  // fallback model. Remaining items continue the same turn; a plain-chat or repeated refusal
  // finishes with the fallback outcome as the turn's final visible answer.
  const takeover = await runUncensoredTakeoverGate.call(this, state, {
    querySource: options.querySource,
    result: options.result,
  });
  if (takeover.action === "continue") return "continue";
  if (takeover.action === "finish") {
    // TUI 和旧 web 投影把 TurnComplete.response / TurnResult.response 当作可见回复的权威兜底。
    // 合成的最终文本已持久化并流式发送；response 必须指向它而不是主模型拒答，否则客户端会在
    // 备用模型答案之后再次追加拒答。
    state.modelResponse = takeover.finalText;
    return await completeTurnWithFinalAssistant(this, state, takeover.assistantMessageId);
  }
  // Этап 4.5b: `enableAutoRepairLoop` — единственная точка, где решение «ход
  // завершён» ещё можно отменить. Проверки идут после персиста assistant, но до
  // завершения автомата, поэтому блокирующий сигнал продолжает тот же turn.
  // При выключенном флаге гейт выходит сразу и ничего не запускает.
  const repairGate = await runAgentAutoRepairGate({
    enabled: this.config.enableAutoRepairLoop === true,
    executionPort: this.executionPort,
    workingDirectory: this.config.workingDirectory,
    maxIterations: this.config.autoRepairLoopLimits?.maxIterations,
    runsSoFar: state.autoRepairGateRuns ?? 0,
    logger: this.logger
      ? {
          info: (message, payload) => this.logger?.info(message, payload),
          warn: (message, payload) => this.logger?.warn(message, payload),
        }
      : undefined,
  });
  state.autoRepairGateRuns = repairGate.runsUsed;
  if (repairGate.kind === "repair") {
    commitTurnRequestEntries(this, state.turnRequestState, [
      systemReminderAttachmentEntry("diagnostics", repairGate.report),
    ]);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  if (await drainInlineGuideForNextRequest(this, state)) {
    // 正常 text-only 是可续跑边界：assistant 已持久化，guide 以 user role 进入历史，
    // 保持同一 active turn 继续下一次 provider request，不改投 future queue。
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  const stopHookResult = await this.runStopHooks(
    state.modelResponse,
    state.toolCallCount,
    state.turnTraceContext,
    state.turnAbortSignal,
    state.stopHookContinuationCount > 0,
  );
  if (this.shouldContinueAfterStopHooks(stopHookResult, state.stopHookContinuationCount)) {
    state.stopHookContinuationCount += 1;
    const hookEntry = this.injectHookAdditionalContextIntoMessageHistory(
      HookEventName.Stop,
      stopHookResult.additionalContexts,
    );
    appendTurnRequestEntries(state.turnRequestState, hookEntry ? [hookEntry] : []);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  // assistant completed 只代表 model step 收口；Stop hook 仍可能继续同一 product turn。
  // 只有最终 break 才把它交给 turn.ts 在 goal accounting 后持久化最终 boundary。
  return await completeTurnWithFinalAssistant(this, state, options.assistantMessageId);
}
