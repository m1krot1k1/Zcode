import type {
  Logger,
  ModelUsage,
  PersistedFinishReasonKind,
  PersistedStepDiagnostics,
  TraceContext,
} from "@zcode/contracts";

import { objectKeys, readRawFinishReason } from "../helpers/index.js";
import { traceContextToLogContext } from "../deps.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { ResolvedOutputBudget } from "./model-token-limits.js";

/**
 * Диагностика шага модели, вынесенная из `turn-model-step.ts`.
 *
 * Функции чистые по отношению к рантайму: они получают значения и пишут только лог/объект
 * диагностики, поэтому не меняют порядок событий и не создают второй путь записи.
 */

/** Результат одного шага модели: продолжить цикл, продолжить с output-continuation или выйти. */
export type ModelStepResult = "continue" | "output_continuation" | "break";

/** Текст-подстановка, когда провайдер вернул tool calls при уже достигнутом лимите автоматизаций. */
export function buildAutomationCreateLimitFallback(input: string): string {
  if (/\p{Script=Han}/u.test(input)) {
    return "定时任务已达到 20 个上限，本次未创建。请前往“自动化”手动删除一个已有任务后重试。";
  }
  return "The limit of 20 scheduled tasks has been reached, so no task was created. Manually delete an existing task on the Automations page, then try again.";
}

/** Приводит finish reason провайдера к持久化-разрешённому набору; всё неизвестное — `unknown`. */
export function normalizePersistedFinishReason(
  reason: string | undefined,
): PersistedFinishReasonKind {
  switch (reason) {
    case "stop":
    case "length":
    case "tool-calls":
    case "content-filter":
    case "error":
    case "other":
      return reason;
    default:
      return "unknown";
  }
}

export function logModelResponseDiagnostics(input: {
  logger: Logger | undefined;
  modelTraceContext: TraceContext;
  result: RuntimeModelTextResult;
  rawFinishReason: string | undefined;
  responseLength: number;
  toolCallCount: number;
  usage: ModelUsage;
}): void {
  const { usage, result } = input;
  input.logger?.info("Model response diagnostics", {
    ...traceContextToLogContext(input.modelTraceContext),
    event: "model.response.diagnostics",
    finishReason: result.finishReason,
    module: "core.runtime",
    providerMetadataKeys: objectKeys(result.providerMetadata),
    rawFinishReason: input.rawFinishReason,
    responseEmpty: input.responseLength === 0,
    responseLength: input.responseLength,
    status: "completed",
    toolCallCount: input.toolCallCount,
    usageCacheReadTokens: usage.cacheReadTokens,
    usageCacheWriteTokens: usage.cacheWriteTokens,
    usageInputTokens: usage.inputTokens,
    usageOutputTokens: usage.outputTokens,
    usageReasoningTokens: usage.reasoningTokens,
    usageTotalTokens: usage.totalTokens,
  });
}

export function logModelRequestCompleted(input: {
  logger: Logger | undefined;
  modelTraceContext: TraceContext;
  agentType: string;
  durationMs: number;
  sessionId: string;
  totalTokens: number;
  toolCallCount: number;
}): void {
  input.logger?.info("Model request completed", {
    ...traceContextToLogContext(input.modelTraceContext),
    // 原因: по одному trace нельзя разложить /start по переходам.
    // agentType + sessionId делают каждый hop отдельной записью, пригодной для агрегации.
    agentType: input.agentType,
    durationMs: input.durationMs,
    event: "model.request.completed",
    module: "core.runtime",
    sessionId: input.sessionId,
    status: "completed",
    totalTokens: input.totalTokens,
    toolCallCount: input.toolCallCount,
  });
}

/**
 * Собирает персистентную диагностику шага.
 *
 * `rawFinishReason` обрезается до 128 символов: провайдер иногда отдаёт длинный хвост,
 * и без обрезки он раздувает transcript.
 */
export function buildStepDiagnostics(input: {
  finishReason: string;
  rawFinishReason: string | undefined;
  outputBudget: ResolvedOutputBudget;
  cacheHitRatio: number | undefined;
  stateTransitions: readonly unknown[];
}): PersistedStepDiagnostics {
  return {
    finishReason: normalizePersistedFinishReason(input.finishReason),
    ...(input.rawFinishReason ? { rawFinishReason: input.rawFinishReason.slice(0, 128) } : {}),
    ...(input.outputBudget.effectiveMaxOutputTokens > 0
      ? { effectiveMaxOutputTokens: input.outputBudget.effectiveMaxOutputTokens }
      : {}),
    ...(input.outputBudget.thinkingBudgetTokens > 0
      ? { thinkingBudgetTokens: input.outputBudget.thinkingBudgetTokens }
      : {}),
    ...(input.cacheHitRatio !== undefined ? { cacheHitRatio: input.cacheHitRatio } : {}),
    stateTransitions: [...input.stateTransitions] as PersistedStepDiagnostics["stateTransitions"],
  };
}

/** Переиспользуется тестами и старым кодом; оставлен как явный реэкспорт источника истины. */
export { readRawFinishReason };
