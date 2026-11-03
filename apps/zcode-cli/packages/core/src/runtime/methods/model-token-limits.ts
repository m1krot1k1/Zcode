import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";

const DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS = 32_000;
// 根因：deepseek-v4.1-flash-1017 声明 maxOutputTokens=384k，而 root-run 预算只有 500k，
// 单个 in-flight 请求就占 77%，第二个子 Agent 的 admission 直接被拒。
// 修复依据：admission 预留只需要覆盖单次请求合理的输出上限，真实花费仍按 provider usage 结算。
const DEFAULT_ROOT_RUN_RESERVATION_MAX_OUTPUT_TOKENS = 64_000;

export function resolveRootRunReservationMaxOutputTokens(input: {
  requestedMaxOutputTokens: number | undefined;
}): number {
  return Math.min(
    positiveFlooredTokens(input.requestedMaxOutputTokens) ??
      DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS,
    DEFAULT_ROOT_RUN_RESERVATION_MAX_OUTPUT_TOKENS,
  );
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
