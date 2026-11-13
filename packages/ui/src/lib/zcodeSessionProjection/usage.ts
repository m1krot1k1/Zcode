import {
  type ZCodeStreamEvent,
  type ZCodeUsage,
  type ZCodeSessionStateSnapshot,
  zcodeContextUsageBreakdownSchema,
} from "@zcode/shared";
import {
  asRecord,
  nonNegativeIntegerValue,
  numberValue,
  positiveIntegerValue,
  stringValue,
} from "./primitives.js";

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
  runtimeUsage:
    | ZCodeSessionStateSnapshot["runtime"]["contextUsage"]
    | undefined,
): ContextUsageUpdate | null {
  if (!runtimeUsage || runtimeUsage.size <= 0 || runtimeUsage.used <= 0) {
    return null;
  }
  // Bugfix: session resume 时 protocol projection 可能还没重放主轮次 usage。
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
  const explicitUsed = numberValue(
    payload.contextUsed ?? projection.contextUsed,
  );
  const useModelUsageForContext = shouldUseModelUsageForContext(payload);
  const modelUsageUsed = useModelUsageForContext
    ? contextUsageTokensFromPayload(usage)
    : undefined;
  const used =
    modelUsageUsed ??
    // 修复原因：主轮次模型返回 usage 时必须以真实网络 token 统计为准；
    // context window 是 input + output 共享窗口，不能再只用 inputTokens 渲染 meter。
    // projection.contextUsed 是 runtime 估算/恢复事实源，只在缺少 usage 时兜底。
    explicitUsed;
  if (size === undefined || size <= 0) {
    return null;
  }
  // Bugfix: ZCode Protocol session.updated 承载的是 projection 事实源；
  // 旧 task UI 只认识 usage_update，必须在迁移桥里把 contextUsed/contextWindow 显式转出来。
  // used=0 只表示初始化或异常兜底，不能渲染成可用的 context meter。
  if (used === undefined || used <= 0) {
    return null;
  }
  return {
    used,
    size,
    cost: null,
    ...(useModelUsageForContext
      ? optionalContextCacheUsageFromPayload(payload, usage)
      : {}),
    ...(useModelUsageForContext
      ? optionalContextUsageBreakdownFromPayload(payload)
      : {}),
  };
}

function optionalContextUsageBreakdownFromPayload(
  payload: Record<string, unknown>,
): Pick<ContextUsageUpdate, "breakdown"> {
  const parsed = zcodeContextUsageBreakdownSchema.safeParse(
    payload.contextUsageBreakdown,
  );
  return parsed.success && parsed.data.length > 0
    ? { breakdown: parsed.data }
    : {};
}

function contextUsageTokensFromPayload(
  usage: Record<string, unknown>,
): number | undefined {
  const inputTokens = positiveIntegerValue(usage.inputTokens ?? usage.input);
  if (inputTokens !== undefined) {
    // 修复原因：AI SDK v6 已把 Anthropic cache read/write 并入 inputTokens。
    // projection 兼容层只加 output，避免 replayable 恢复时把 cache read 重复计入 context meter。
    return (
      inputTokens +
      (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0)
    );
  }

  const totalTokens = positiveIntegerValue(usage.totalTokens ?? usage.total);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  const cacheTokens =
    (nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ??
      0) +
    (nonNegativeIntegerValue(
      usage.cachedWriteTokens ?? usage.cacheWriteTokens,
    ) ?? 0);
  return cacheTokens > 0
    ? cacheTokens +
        (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0)
    : undefined;
}

function optionalContextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): Pick<ContextUsageUpdate, "cache"> {
  const cache = contextCacheUsageFromPayload(payload, usage);
  return cache ? { cache } : {};
}

function shouldUseModelUsageForContext(
  payload: Record<string, unknown>,
): boolean {
  const querySource = stringValue(payload.querySource);
  // 修复原因：只有主会话模型请求的 inputTokens 才代表当前可见上下文。
  // 标题、压缩、prompt enhance 等 sidecar 请求即使带 contextWindow，也不能覆盖输入栏 context meter。
  return querySource === undefined || querySource === "main_turn";
}

function contextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): ContextUsageUpdate["cache"] {
  const aggregate = asRecord(payload.cacheHit);
  if (Object.keys(aggregate).length > 0) {
    const inputTokens = nonNegativeIntegerValue(aggregate.inputTokens) ?? 0;
    const cacheReadTokens =
      nonNegativeIntegerValue(aggregate.cacheReadTokens) ?? 0;
    const cacheWriteTokens =
      nonNegativeIntegerValue(aggregate.cacheWriteTokens) ?? 0;
    const latestHitRate = numberValue(aggregate.latestHitRate);
    const hitRate = numberValue(aggregate.hitRate);
    const hitRateRequestCount = nonNegativeIntegerValue(
      aggregate.hitRateRequestCount,
    );
    const totalInputTokens = nonNegativeIntegerValue(
      aggregate.totalInputTokens,
    );
    const totalCacheReadTokens = nonNegativeIntegerValue(
      aggregate.totalCacheReadTokens,
    );
    const totalCacheWriteTokens = nonNegativeIntegerValue(
      aggregate.totalCacheWriteTokens,
    );
    return {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(latestHitRate !== undefined
        ? { latestHitRate: Math.max(0, latestHitRate) }
        : {}),
      ...(hitRateRequestCount !== undefined ? { hitRateRequestCount } : {}),
      ...(totalInputTokens !== undefined ? { totalInputTokens } : {}),
      ...(totalCacheReadTokens !== undefined ? { totalCacheReadTokens } : {}),
      ...(totalCacheWriteTokens !== undefined ? { totalCacheWriteTokens } : {}),
      hitRate: hitRate !== undefined ? Math.max(0, hitRate) : null,
    };
  }

  const hasCacheRead =
    "cachedReadTokens" in usage || "cacheReadTokens" in usage;
  const hasCacheWrite =
    "cachedWriteTokens" in usage || "cacheWriteTokens" in usage;
  const hasHitRate = "cacheHitRate" in usage || "hitRate" in usage;
  if (!hasCacheRead && !hasCacheWrite && !hasHitRate) {
    return undefined;
  }
  const inputTokens =
    nonNegativeIntegerValue(usage.inputTokens ?? usage.input) ?? 0;
  const cacheReadTokens =
    nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ??
    0;
  const cacheWriteTokens =
    nonNegativeIntegerValue(
      usage.cachedWriteTokens ?? usage.cacheWriteTokens,
    ) ?? 0;
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
    // 修复原因：context usage 的缓存命中率是 agent/app 协议字段；
    // projection 兼容层只做一次归一化，避免 UI 组件各自重复推导。
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
  const cachedInputTokens = numberValue(
    usage.cachedReadTokens ?? usage.cacheReadTokens,
  );
  const cachedWriteInputTokens = numberValue(
    usage.cachedWriteTokens ?? usage.cacheWriteTokens,
  );
  const inputSideTokens =
    inputTokens > 0
      ? inputTokens
      : (cachedInputTokens ?? 0) + (cachedWriteInputTokens ?? 0);
  const totalTokens =
    numberValue(usage.totalTokens ?? usage.total) ??
    inputSideTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens,
  };
}
