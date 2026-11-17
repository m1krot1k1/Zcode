import type { ModelCacheControl } from "@zcode/contracts";

/**
 * cli-model-cache-control 对外契约：
 * 为支持显式前缀缓存断点的模型家族（Anthropic 原生、OpenRouter 上的 Anthropic / Gemini / Qwen / DeepSeek / GLM）
 * 计算最多 4 个稳定的 cache_control 断点，避免每步漂移导致缓存前缀失效，并统一解析 provider 缓存命中指标。
 */
export type CliModelCacheControlId = string & { readonly __brand: "CliModelCacheControlId" };

export type CacheControlProviderFamily =
  | "anthropic-native"
  | "openrouter-anthropic"
  | "openrouter-gemini"
  | "openrouter-qwen"
  | "openrouter-deepseek"
  | "openrouter-glm"
  | "automatic-prefix"
  | "unsupported";

export interface CacheControlCapability {
  readonly family: CacheControlProviderFamily;
  readonly isOpenRouter: boolean;
  readonly maxBreakpoints: number;
  readonly quantizationStrideMessages: number;
  readonly supportsExplicitBreakpoints: boolean;
  readonly supportsToolSchemaBreakpoint: boolean;
}

export interface ResolveCacheCapabilityInput {
  readonly baseURL?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly providerKind?: string;
}

export interface CacheableMessageSummary {
  readonly cacheControl?: ModelCacheControl;
  readonly hasNonEmptyContent: boolean;
  readonly role: "system" | "user" | "assistant" | "tool";
}

export interface CacheBreakpointTarget {
  readonly index: number;
  readonly kind: "system" | "tools" | "history-anchor";
}

export interface CacheBreakpointPlan {
  readonly breakpoints: readonly CacheBreakpointTarget[];
  readonly capability: CacheControlCapability;
}

export interface PlanCacheBreakpointsInput {
  readonly capability: CacheControlCapability;
  readonly messages: readonly CacheableMessageSummary[];
  readonly quantizationStride?: number;
  readonly toolCount: number;
}

export interface NormalizedCacheUsage {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface CliModelCacheControlContract {
  /**
   * 判定目标 provider + model 是否支持显式 `cache_control: { type: "ephemeral" }` 断点。
   * 纯函数、幂等、无副作用。
   */
  resolveCapability(input: ResolveCacheCapabilityInput): CacheControlCapability;

  /**
   * 在严格不超过 `capability.maxBreakpoints`（默认 4）的前提下，规划稳定的系统提示词、工具表与量化历史断点。
   * 纯函数、幂等、无副作用。
   */
  planBreakpoints(input: PlanCacheBreakpointsInput): CacheBreakpointPlan;

  /**
   * 将规划好的 `cache_control` 断点与 OpenRouter 粘性缓存路由参数无损注入 OpenAI-compatible 请求 JSON 体。
   * 返回新对象，不原地污染调用方快照。
   */
  applyToOpenAiCompatibleWireBody(
    body: Record<string, unknown>,
    input: {
      readonly capability: CacheControlCapability;
      readonly quantizationStride?: number;
    },
  ): Record<string, unknown>;

  /**
   * 统一从 AI SDK `inputTokenDetails` 与原始 `usage`（OpenRouter `prompt_tokens_details.cached_tokens`、
   * Anthropic `cache_read_input_tokens` 等）提取缓存读写 token 指标。
   */
  normalizeCacheUsage(input: {
    readonly inputTokenDetails?: {
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    };
    readonly rawUsage?: Record<string, unknown>;
  }): NormalizedCacheUsage;
}
