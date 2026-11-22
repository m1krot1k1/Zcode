/**
 * zcodeTaskServiceAdapterRuntimePayloads.ts: Telemetry, context usage и примитивы разбора payload.
 */
import type { NetworkObservation } from "@zcode/rpc";
import type {
  ZCodeSessionEvent,
  ZCodeSessionStateSnapshot,
  ZCodeStreamEvent,
  ZCodeTimelineStatus,
  ZCodeTimelineTrigger,
  ZCodeTurnSteerCommandKind,
  ZCodeTurnSteerSource,
  ZCodeUsage,
} from "@zcode/shared";
import { logger } from "./zcodeTaskServiceAdapterCore.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "./zcodeTaskServiceAdapterElicitationMapping.js";
import { emitNetworkTelemetryObservation } from "@zcode/rpc";
import { zcodeContextUsageBreakdownSchema } from "@zcode/shared";

export function recordAgentModelNetworkTelemetry(event: ZCodeSessionEvent): void {
  const observation = agentModelNetworkObservationFromEvent(event);
  if (!observation) {
    return;
  }
  try {
    emitNetworkTelemetryObservation(observation);
  } catch (error) {
    // 修复原因：agent 模型网络遥测属于旁路指标，sink 异常不能影响主会话消息流。
    logger.warn(undefined, "上报 agent 模型网络遥测失败", error);
  }
}

export function agentModelNetworkObservationFromEvent(
  event: ZCodeSessionEvent,
): NetworkObservation | null {
  const payload = asRecord(event.payload);
  const type = stringValue(payload.type);
  if (type !== "model_request_completed" && type !== "model_request_failed") {
    return null;
  }
  // 修复原因：retryable failed 只是同一次逻辑请求的中间 attempt，最终 completed/failed 会带总 attempt。
  // 如果这里也计数，会把成功率、失败率和重试率同时放大。
  if (type === "model_request_failed" && booleanValue(payload.retryable) === true) {
    return null;
  }

  const durationMs = Math.max(0, Math.round(numberValue(payload.durationMs) ?? 0));
  const statusCode = nonNegativeIntegerValue(payload.statusCode);
  const ok = type === "model_request_completed";
  return {
    transport: "http",
    interface: buildAgentModelNetworkInterface(payload),
    durationMs,
    ok,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(ok ? {} : { errorKind: classifyAgentModelNetworkError(payload, statusCode) }),
    attempt: positiveIntegerValue(payload.attempt) ?? 1,
  };
}

export function buildAgentModelNetworkInterface(payload: Record<string, unknown>): string {
  const providerKind = safeNetworkDimension(stringValue(payload.providerKind)) ?? "unknown";
  const transport = safeNetworkDimension(stringValue(payload.transport)) ?? "unknown";
  const base = normalizeAgentModelBaseUrl(stringValue(payload.baseURL));
  return `zcode_agent.model.${providerKind}.${transport}.${base}`;
}

export function normalizeAgentModelBaseUrl(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    const safePath = pathname.length > 80 ? `${pathname.slice(0, 80)}...` : pathname;
    return `${parsed.host}${safePath}`;
  } catch {
    return safeNetworkDimension(value, 120) ?? "unknown";
  }
}

export function safeNetworkDimension(
  value: string | undefined,
  maxLength = 48,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const safe = trimmed.replace(/[?#[\]{}|\\^`"'<>\s]+/gu, "_");
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}...` : safe;
}

export function classifyAgentModelNetworkError(
  payload: Record<string, unknown>,
  statusCode: number | undefined,
): string {
  const reason = stringValue(payload.reason);
  switch (reason) {
    case "timeout":
    case "stream_idle_timeout":
      return "timeout";
    case "network_error":
    case "stale_connection":
      return "connection_reset";
    case "proxy_error":
      return "proxy_error";
    case "tls_error":
      return "tls_error";
    default:
      if (statusCode !== undefined && statusCode >= 500) {
        return "server_error";
      }
      if (statusCode !== undefined && statusCode >= 400) {
        return "client_error";
      }
      return "other";
  }
}

export type ContextUsageUpdate = Pick<
  Extract<ZCodeStreamEvent, { type: "usage_update" }>,
  "used" | "size" | "cost" | "cache" | "breakdown"
>;

export function contextUsageFromProjection(
  projection: ZCodeSessionStateSnapshot["projection"],
): ContextUsageUpdate | null {
  if (projection.contextWindow <= 0 || projection.contextUsed <= 0) {
    return null;
  }
  return {
    used: projection.contextUsed,
    size: projection.contextWindow,
    cost: null,
  };
}

export function contextUsageFromRuntime(
  runtimeUsage: ZCodeSessionStateSnapshot["runtime"]["contextUsage"] | undefined,
): ContextUsageUpdate | null {
  if (!runtimeUsage || runtimeUsage.size <= 0 || runtimeUsage.used <= 0) {
    return null;
  }
  // session resume 时 protocol projection 可能还没重放主轮次 usage。
  // runtime.contextUsage 来自持久化 assistant token 记录，应优先用于恢复旧 task UI。
  return {
    used: runtimeUsage.used,
    size: runtimeUsage.size,
    cost: runtimeUsage.cost ?? null,
    ...(runtimeUsage.cache ? { cache: runtimeUsage.cache } : {}),
    ...(runtimeUsage.breakdown ? { breakdown: runtimeUsage.breakdown } : {}),
  };
}

export function contextUsageFromPayload(
  payload: Record<string, unknown>,
): ContextUsageUpdate | null {
  const projection = asRecord(payload.projection);
  const usage = asRecord(payload.usage);
  const size = numberValue(payload.contextWindow ?? projection.contextWindow);
  const explicitUsed = numberValue(payload.contextUsed ?? projection.contextUsed);
  const useModelUsageForContext = shouldUseModelUsageForContext(payload);
  const modelUsageUsed = useModelUsageForContext ? contextUsageTokensFromPayload(usage) : undefined;
  const used =
    modelUsageUsed ??
    // 主轮次模型返回 usage 时必须以真实网络 token 统计为准；
    // context window 是 input + output 共享窗口，不能再只用 inputTokens 渲染 meter。
    // projection.contextUsed 是 runtime 估算/恢复事实源，只在缺少 usage 时兜底。
    explicitUsed;
  if (size === undefined || size <= 0) {
    return null;
  }
  // ZCode Protocol 的 session.updated 里 contextUsed/contextWindow 是 projection 事实源；
  // 旧 task stream 只认识 usage_update，adapter 不转换就会让右下角 context meter 永远拿不到数据。
  // used=0 只表示初始化或异常兜底，不能渲染成可用的 context meter。
  if (used === undefined || used <= 0) {
    return null;
  }
  return {
    used,
    size,
    cost: null,
    ...(useModelUsageForContext ? optionalContextCacheUsageFromPayload(payload, usage) : {}),
    ...(useModelUsageForContext ? optionalContextUsageBreakdownFromPayload(payload) : {}),
  };
}

export function optionalContextUsageBreakdownFromPayload(
  payload: Record<string, unknown>,
): Pick<ContextUsageUpdate, "breakdown"> {
  const parsed = zcodeContextUsageBreakdownSchema.safeParse(payload.contextUsageBreakdown);
  return parsed.success && parsed.data.length > 0 ? { breakdown: parsed.data } : {};
}

export function contextUsageTokensFromPayload(usage: Record<string, unknown>): number | undefined {
  const inputTokens = positiveIntegerValue(usage.inputTokens ?? usage.input);
  if (inputTokens !== undefined) {
    // AI SDK v6 已把 Anthropic cache read/write 并入 inputTokens。
    // adapter 只需要加 output；再加 cacheReadTokens 会把输入栏 context meter 算大。
    return inputTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0);
  }

  const totalTokens = positiveIntegerValue(usage.totalTokens ?? usage.total);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  const cacheTokens =
    (nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0) +
    (nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0);
  return cacheTokens > 0
    ? cacheTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0)
    : undefined;
}

export function optionalContextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): Pick<ContextUsageUpdate, "cache"> {
  const cache = contextCacheUsageFromPayload(payload, usage);
  return cache ? { cache } : {};
}

export function shouldUseModelUsageForContext(payload: Record<string, unknown>): boolean {
  const querySource = stringValue(payload.querySource);
  // 只有主会话模型请求的 inputTokens 才代表当前可见上下文。
  // 标题、压缩、prompt enhance 等 sidecar 请求即使带 contextWindow，也不能覆盖输入栏 context meter。
  return querySource === undefined || querySource === "main_turn";
}

export function contextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): ContextUsageUpdate["cache"] {
  const aggregate = asRecord(payload.cacheHit);
  if (Object.keys(aggregate).length > 0) {
    const inputTokens = nonNegativeIntegerValue(aggregate.inputTokens) ?? 0;
    const cacheReadTokens = nonNegativeIntegerValue(aggregate.cacheReadTokens) ?? 0;
    const cacheWriteTokens = nonNegativeIntegerValue(aggregate.cacheWriteTokens) ?? 0;
    const latestHitRate = numberValue(aggregate.latestHitRate);
    const hitRate = numberValue(aggregate.hitRate);
    const hitRateRequestCount = nonNegativeIntegerValue(aggregate.hitRateRequestCount);
    const totalInputTokens = nonNegativeIntegerValue(aggregate.totalInputTokens);
    const totalCacheReadTokens = nonNegativeIntegerValue(aggregate.totalCacheReadTokens);
    const totalCacheWriteTokens = nonNegativeIntegerValue(aggregate.totalCacheWriteTokens);
    return {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(latestHitRate !== undefined ? { latestHitRate: Math.max(0, latestHitRate) } : {}),
      ...(hitRateRequestCount !== undefined ? { hitRateRequestCount } : {}),
      ...(totalInputTokens !== undefined ? { totalInputTokens } : {}),
      ...(totalCacheReadTokens !== undefined ? { totalCacheReadTokens } : {}),
      ...(totalCacheWriteTokens !== undefined ? { totalCacheWriteTokens } : {}),
      hitRate: hitRate !== undefined ? Math.max(0, hitRate) : null,
    };
  }

  const hasCacheRead = "cachedReadTokens" in usage || "cacheReadTokens" in usage;
  const hasCacheWrite = "cachedWriteTokens" in usage || "cacheWriteTokens" in usage;
  const hasHitRate = "cacheHitRate" in usage || "hitRate" in usage;
  if (!hasCacheRead && !hasCacheWrite && !hasHitRate) {
    return undefined;
  }
  const inputTokens = nonNegativeIntegerValue(usage.inputTokens ?? usage.input) ?? 0;
  const cacheReadTokens =
    nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0;
  const cacheWriteTokens =
    nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0;
  const explicitHitRate = numberValue(usage.cacheHitRate ?? usage.hitRate);
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    latestHitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
    // UI 展示的是 agent/app 协议返回的命中率；provider 没直接给时，
    // 在 adapter 侧按 provider usage 归一化一次，避免各 UI 入口重复理解 token 字段。
    hitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
  };
}

export function usageFromPayload(value: unknown): ZCodeUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) {
    return undefined;
  }
  const inputTokens = numberValue(usage.inputTokens ?? usage.input) ?? 0;
  const outputTokens = numberValue(usage.outputTokens ?? usage.output) ?? 0;
  const reasoningTokens = numberValue(usage.reasoningTokens ?? usage.reasoning);
  const cachedInputTokens = numberValue(usage.cachedReadTokens ?? usage.cacheReadTokens);
  const cachedWriteInputTokens = numberValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens);
  const inputSideTokens =
    inputTokens > 0 ? inputTokens : (cachedInputTokens ?? 0) + (cachedWriteInputTokens ?? 0);
  const totalTokens =
    numberValue(usage.totalTokens ?? usage.total) ?? inputSideTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens,
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === ASK_USER_QUESTION_TOOL_NAME;
}

export function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === EXIT_PLAN_MODE_TOOL_NAME;
}

export function isUserInputBackedPermissionToolName(value: string | undefined): boolean {
  return isAskUserQuestionToolName(value) || isExitPlanModeToolName(value);
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function timelineStatusValue(value: unknown): ZCodeTimelineStatus | undefined {
  return value === "started" ||
    value === "retrying" ||
    value === "skipped" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : undefined;
}

export function timelineTriggerValue(value: unknown): ZCodeTimelineTrigger | undefined {
  return value === "manual" ||
    value === "auto" ||
    value === "reactive" ||
    value === "partial" ||
    value === "session_memory"
    ? value
    : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function turnSteerSourceValue(value: unknown): ZCodeTurnSteerSource | undefined {
  return value === "plan_approval_feedback" || value === "workflow_refine_feedback"
    ? value
    : undefined;
}

export function turnSteerCommandKindValue(value: unknown): ZCodeTurnSteerCommandKind | undefined {
  return value === "sendGoalCommand" || value === "sendText" || value === "compact"
    ? value
    : undefined;
}
