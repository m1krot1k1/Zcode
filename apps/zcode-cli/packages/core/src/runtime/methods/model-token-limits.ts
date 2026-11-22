import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";

const DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS = 32_000;
const DEFAULT_REASONING_AWARE_MAX_OUTPUT_TOKENS = 32_768;
export const MIN_TOOL_PAYLOAD_RESERVE_TOKENS = 16_384;

export type ReasoningEffortLevel =
  | "disabled"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max"
  | string
  | undefined;

export interface ReasoningAwareOutputBudgetInput {
  modelHardMaxOutputTokens: number | undefined;
  configuredMaxOutputTokens: number | undefined;
  contextWindow: number | undefined;
  estimatedInputTokens: number;
  reasoningEffort: ReasoningEffortLevel;
  explicitThinkingBudgetTokens?: number;
  minToolPayloadReserveTokens?: number;
}

export interface ResolvedOutputBudget {
  effectiveMaxOutputTokens: number;
  thinkingBudgetTokens: number;
  minToolPayloadReserveTokens: number;
}

export function resolveThinkingBudgetTokens(
  reasoningEffort: ReasoningEffortLevel,
  explicitThinkingBudgetTokens?: number,
): number {
  const explicit = positiveFlooredTokens(explicitThinkingBudgetTokens);
  if (explicit !== undefined) {
    return explicit;
  }
  switch (reasoningEffort?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "disabled":
    case "none":
    case "off":
      return 0;
    case "minimal":
      return 2_048;
    case "low":
      return 4_096;
    case "medium":
      return 8_192;
    case "high":
      return 16_384;
    case "max":
    case "xhigh":
      return 31_999;
    default:
      return 8_192;
  }
}

/**
 * Рассчитывает `maxOutputTokens` с учётом активного `thinking` / `reasoningEffort` (F-01),
 * гарантируя резерв `>= 16 384` токенов под генерацию JSON-аргументов инструментов
 * в пределах реального аппаратного потолка модели и свободного остатка `contextWindow`.
 */
export function resolveReasoningAwareMaxOutputTokens(
  input: ReasoningAwareOutputBudgetInput,
): ResolvedOutputBudget {
  const reserve =
    positiveFlooredTokens(input.minToolPayloadReserveTokens) ?? MIN_TOOL_PAYLOAD_RESERVE_TOKENS;
  const thinkingBudgetTokens = resolveThinkingBudgetTokens(
    input.reasoningEffort,
    input.explicitThinkingBudgetTokens,
  );
  const hardMax = positiveFlooredTokens(input.modelHardMaxOutputTokens);
  const configured = positiveFlooredTokens(input.configuredMaxOutputTokens);

  let desired: number;
  if (thinkingBudgetTokens > 0) {
    const baseTarget = configured ?? hardMax ?? DEFAULT_REASONING_AWARE_MAX_OUTPUT_TOKENS;
    desired = Math.max(baseTarget, thinkingBudgetTokens + reserve);
  } else {
    desired = configured ?? hardMax ?? DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS;
  }

  const cappedByModel = hardMax !== undefined ? Math.min(desired, hardMax) : desired;
  const effectiveMaxOutputTokens = resolveModelStepMaxOutputTokens({
    baselineMaxOutputTokens: cappedByModel,
    contextWindow: input.contextWindow,
    estimatedCurrentUsage: input.estimatedInputTokens,
    modelContextBudgetStrategy: "preflight-v1",
  });

  const effectiveReserve = Math.min(reserve, effectiveMaxOutputTokens);
  return {
    effectiveMaxOutputTokens,
    thinkingBudgetTokens: Math.min(
      thinkingBudgetTokens,
      Math.max(0, effectiveMaxOutputTokens - effectiveReserve),
    ),
    minToolPayloadReserveTokens: effectiveReserve,
  };
}

export function resolveNormalRequestMaxOutputTokens(input: {
  modelMaxOutputTokens: number | undefined;
}): number {
  // 32K 是模型未声明输出预算时的默认值，不是对模型级配置的全局上限。
  // 已解析到模型值时必须原样使用，否则 64K 模型的请求预算会被错误裁剪为 32K。
  return (
    positiveFlooredTokens(input.modelMaxOutputTokens) ?? DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS
  );
}

export function resolveModelStepMaxOutputTokens(input: {
  baselineMaxOutputTokens: number;
  contextWindow: number | undefined;
  estimatedCurrentUsage: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1" | undefined;
}): number {
  // legacy 仅为入参兼容；所有请求（含工具续轮）都按剩余窗口计算 preflight cap。
  if (
    input.contextWindow === undefined ||
    !Number.isFinite(input.contextWindow) ||
    input.contextWindow <= 0 ||
    !Number.isFinite(input.estimatedCurrentUsage) ||
    input.estimatedCurrentUsage < 0
  ) {
    return input.baselineMaxOutputTokens;
  }

  const estimatedAvailable = Math.floor(input.contextWindow - input.estimatedCurrentUsage - 1_000);
  if (estimatedAvailable <= 0) {
    // 本地估算不是 provider 权威拒绝；无正数可发送时保留 baseline 走既有错误恢复。
    return input.baselineMaxOutputTokens;
  }
  const candidate = Math.min(input.baselineMaxOutputTokens, estimatedAvailable);
  return candidate;
}

export function modelRequestTokenLimitLogContext(input: {
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  modelContextBudgetStrategy: "legacy" | "preflight-v1" | undefined;
  traceContext: TraceContext;
}) {
  return {
    ...traceContextToLogContext(input.traceContext),
    contextWindow: input.contextWindow,
    event: "model.request.token_limits",
    inputBudgetTokens: inputBudgetTokens(input.contextWindow, input.maxOutputTokens),
    maxOutputTokens: input.maxOutputTokens,
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    module: "core.runtime",
  };
}

function inputBudgetTokens(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): number | undefined {
  if (
    contextWindow === undefined ||
    maxOutputTokens === undefined ||
    !Number.isFinite(contextWindow) ||
    !Number.isFinite(maxOutputTokens)
  ) {
    return undefined;
  }

  return Math.max(0, Math.floor(contextWindow) - Math.floor(maxOutputTokens));
}

function positiveFlooredTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
