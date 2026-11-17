import { CoreErrorType, createCoreError, TurnMachineImpl } from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import { projectExecutionErrorPayload } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordModelHistoryRound } from "./turn-loop-state.js";
import {
  persistCompletedAssistantStep,
  persistOutputTokenLimitErrorCarrier,
} from "./turn-stop.js";
import {
  appendOutputTokenContinuation,
  completeOutputTokenRecovery,
  OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
} from "./turn-output-token-continuation.js";
import type { ModelStepResult } from "./turn-model-step-diagnostics.js";

/** Anchor берётся из параметров владельца персиста, чтобы не дублировать приватный тип. */
type AssistantPersistenceAnchor = Parameters<
  typeof persistCompletedAssistantStep
>[2]["assistantPersistenceAnchor"];

/**
 * Завершение шага, когда провайдер упёрся в лимит выходных токенов.
 *
 * Вынесено из `turn-model-step.ts` без изменения порядка операций: сначала коммитится
 * assistant-шаг, затем либо продолжение (output continuation), либо терминальная ошибка
 * `model_output_limit_exceeded`. Ветка `recover_truncated_tool_calls` обрабатывается
 * вызывающим кодом до этого вызова.
 */
export async function handleOutputTokenLimitOutcome(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  input: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    model: Model;
    modelTraceContext: TraceContext;
    outputTokenContinuation: string;
    requestEntries: RegularTurnLoopState["turnRequestState"]["entries"];
    result: RuntimeModelTextResult;
  },
): Promise<ModelStepResult> {
  // 首次命中 output-limit 时，当前 request 可能带有一次性的 project-memory attachment；
  // query-local 状态必须从实际请求数组推进，不能退回请求前的数组。
  state.turnRequestState.entries = input.requestEntries;
  const assistantCommitted = await persistCompletedAssistantStep(runtime, state, {
    assistantPersistenceAnchor: input.assistantPersistenceAnchor,
    assistantCreatedAt: input.assistantCreatedAt,
    assistantMessageId: input.assistantMessageId,
    includeEmptyAssistant: false,
    modelTraceContext: input.modelTraceContext,
    result: input.result,
  });
  if (assistantCommitted) recordModelHistoryRound(state);
  if (input.outputTokenContinuation === "continue") {
    appendOutputTokenContinuation(state.turnRequestState);
    state.reactiveCompactAttemptedInCurrentModelStep = false;
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "output_continuation";
  }

  const exhaustedError = createCoreError(
    CoreErrorType.ModelError,
    OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
    {
      context: {
        providerCode: "model_output_limit_exceeded",
        reason: "model_output_limit_exceeded",
        source: "provider",
      },
      recoverable: true,
    },
  );
  const exhaustedErrorProjection = projectExecutionErrorPayload(
    exhaustedError,
    OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
  );
  completeOutputTokenRecovery(state.turnRequestState);
  await persistOutputTokenLimitErrorCarrier(runtime, state, {
    error: {
      name: exhaustedErrorProjection.code ?? exhaustedError.type,
      data: {
        ...(exhaustedErrorProjection.code ? { code: exhaustedErrorProjection.code } : {}),
        message: exhaustedErrorProjection.message,
        // 既有 cold hydration 用 retryable 恢复 UI recoverable；这里复用该字段，
        // 不为单一错误扩展 transcript/hydration schema。
        retryable: exhaustedError.recoverable,
        ...(exhaustedErrorProjection.attribution
          ? { attribution: exhaustedErrorProjection.attribution }
          : {}),
      },
    },
    finishReason: input.result.finishReason,
    model: input.model,
    modelTraceContext: input.modelTraceContext,
  });
  if (state.activeTurn) state.activeTurn.steerable = false;
  // 上游 query loop 会把 max_output_tokens API-error assistant 交给外层；这里复用
  // 既有 ModelError -> TurnError 收口表达同一实时错误，同时只结束当前 Turn command。
  throw exhaustedError;
}
