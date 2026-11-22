import {
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelEvent,
  type ModelRequest,
  type ModelResult,
  type ModelStatusSink,
} from "@zcode/contracts";

/** 配额耗尽且所有候选 Provider 都失败时的稳定字符串码；不新增 enum 值。 */
export const PROVIDER_QUOTA_FALLBACK_EXHAUSTED_CODE = "PROVIDER_QUOTA_FALLBACK_EXHAUSTED";

const MAX_PROVIDER_ATTEMPTS = 3;
const QUOTA_RETRY_AFTER_THRESHOLD_MS = 600_000;

export interface ProviderFallbackEvent {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface ProviderFallbackAttempt {
  readonly providerId: string;
  readonly modelId: string;
  readonly model: Model;
}

export interface ProviderModelClassFacts {
  readonly providerId: string;
  readonly modelId: string;
  readonly hidden?: boolean;
  readonly contextWindow?: number;
  readonly supportsToolCall?: boolean;
  readonly supportsJsonSchemaOutput?: boolean;
  readonly inputFormat?: Partial<
    Record<
      "supportsText" | "supportsImage" | "supportsVideo" | "supportsAudio" | "supportsPdf",
      boolean
    >
  >;
  readonly reasoningLevels?: readonly string[];
}

export interface ProviderFallbackModelInput {
  readonly primary: ProviderFallbackAttempt;
  readonly fallbacks: readonly ProviderFallbackAttempt[];
  /** 总尝试数（含首次）；上限固定为 3，默认 3。 */
  readonly maxAttempts?: number;
  readonly onFallback?: (event: ProviderFallbackEvent) => void;
}

const INPUT_FORMAT_KEYS = [
  "supportsText",
  "supportsImage",
  "supportsVideo",
  "supportsAudio",
  "supportsPdf",
] as const;

/**
 * 判断错误是否属于「配额已经耗尽，重试无意义」。只读结构字段，兼容旧 adapter 错误。
 * 429 只有 Retry-After 超过 10 分钟才算耗尽；普通 429 仍走原有退避重试。
 */
export function isProviderQuotaExhaustedFailure(error: unknown): boolean {
  return findQuotaFailure(error) !== undefined;
}

export function resolveProviderQuotaReason(error: unknown): string {
  return findQuotaFailure(error)?.reason ?? "quota_exhausted";
}

/** 从当前 Provider 的同类模型中挑出按 Registry 顺序的候选，排除显式关闭切换的场景。 */
export function selectProviderFallbackCandidates(input: {
  readonly source: ProviderModelClassFacts;
  readonly providers: readonly ProviderModelClassFacts[];
  readonly reasoningLevel?: string;
  readonly allowFallback?: boolean;
  readonly maxAttempts?: number;
}): ProviderModelClassFacts[] {
  if (input.allowFallback === false) return [];
  const maxAttempts = Math.min(Math.max(input.maxAttempts ?? MAX_PROVIDER_ATTEMPTS, 1), 3);
  const remaining = Math.max(maxAttempts - 1, 0);
  if (remaining === 0) return [];
  const ordered = [...input.providers];
  const currentIndex = ordered.findIndex(
    (provider) => provider.providerId === input.source.providerId,
  );
  // 从当前 Provider 之后开始，按 Registry 顺序环形取，确保「下一个」语义。
  const rotated =
    currentIndex >= 0
      ? [...ordered.slice(currentIndex + 1), ...ordered.slice(0, currentIndex)]
      : ordered;
  return rotated
    .filter(
      (candidate) =>
        candidate.providerId !== input.source.providerId &&
        candidate.hidden !== true &&
        isSameModelClass(input.source, candidate, input.reasoningLevel),
    )
    .slice(0, remaining);
}

/**
 * 在 Model 发送边界包一层配额切换：配额错误不重试同一 Provider，直接换下一个；
 * 非配额错误保持原样，由 adapter 的普通重试策略处理。
 */
export function createProviderQuotaFallbackModel(input: ProviderFallbackModelInput): Model {
  const maxAttempts = Math.min(Math.max(input.maxAttempts ?? MAX_PROVIDER_ATTEMPTS, 1), 3);
  const attempts = [input.primary, ...input.fallbacks].slice(0, maxAttempts);
  if (attempts.length <= 1) return input.primary.model;
  return new ProviderQuotaFallbackModel(attempts, input.onFallback);
}

class ProviderQuotaFallbackModel implements Model {
  get requestCapabilities(): Model["requestCapabilities"] {
    return this.#attempts[0]!.model.requestCapabilities;
  }
  get providerId(): Model["providerId"] {
    return this.#attempts[0]!.model.providerId;
  }
  get modelId(): Model["modelId"] {
    return this.#attempts[0]!.model.modelId;
  }
  get displayName(): string | undefined {
    return this.#attempts[0]!.model.displayName;
  }
  get properties(): Model["properties"] {
    return this.#attempts[0]!.model.properties;
  }
  get optionSpecs(): Model["optionSpecs"] {
    return this.#attempts[0]!.model.optionSpecs;
  }
  get options(): Model["options"] {
    return this.#attempts[0]!.model.options;
  }

  readonly #attempts: readonly ProviderFallbackAttempt[];
  readonly #onFallback?: (event: ProviderFallbackEvent) => void;

  constructor(
    attempts: readonly ProviderFallbackAttempt[],
    onFallback?: (event: ProviderFallbackEvent) => void,
  ) {
    this.#attempts = attempts;
    this.#onFallback = onFallback;
  }

  bind(options?: Parameters<Model["bind"]>[0]): Model {
    return new ProviderQuotaFallbackModel(
      this.#attempts.map((attempt) => ({
        ...attempt,
        model: attempt.model.bind(options),
      })),
      this.#onFallback,
    );
  }

  async generateText(request: ModelRequest): Promise<ModelResult> {
    const failures: ProviderAttemptFailure[] = [];
    for (let index = 0; index < this.#attempts.length; index += 1) {
      const attempt = this.#attempts[index]!;
      const fallback = this.#fallbackEventFor(index, failures);
      if (fallback) this.#onFallback?.(fallback);
      try {
        return await withFallbackStatus(fallback, () => attempt.model.generateText(request));
      } catch (error) {
        if (!isProviderQuotaExhaustedFailure(error)) throw error;
        failures.push(toFailure(attempt, error));
        if (index === this.#attempts.length - 1) throw createExhaustedError(failures);
      }
    }
    throw createExhaustedError(failures);
  }

  async *streamText(request: ModelRequest): AsyncIterable<ModelEvent> {
    const failures: ProviderAttemptFailure[] = [];
    for (let index = 0; index < this.#attempts.length; index += 1) {
      const attempt = this.#attempts[index]!;
      const fallback = this.#fallbackEventFor(index, failures);
      let emitted = false;
      try {
        const stream = withFallbackStatus(fallback, () => attempt.model.streamText(request));
        for await (const event of stream) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        // 已输出内容后不能换 Provider，否则会把两段回答拼在一起。
        if (emitted || !isProviderQuotaExhaustedFailure(error)) throw error;
        failures.push(toFailure(attempt, error));
        if (index === this.#attempts.length - 1) throw createExhaustedError(failures);
      }
    }
    throw createExhaustedError(failures);
  }

  #fallbackEventFor(
    index: number,
    failures: readonly ProviderAttemptFailure[],
  ): ProviderFallbackEvent | undefined {
    if (index === 0 || failures.length === 0) return undefined;
    const previous = failures[failures.length - 1]!;
    return {
      from: previous.providerId,
      to: this.#attempts[index]!.providerId,
      reason: previous.reason,
    };
  }
}

interface ProviderAttemptFailure {
  readonly providerId: string;
  readonly modelId: string;
  readonly reason: string;
}

function toFailure(attempt: ProviderFallbackAttempt, error: unknown): ProviderAttemptFailure {
  return {
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    reason: resolveProviderQuotaReason(error),
  };
}

function createExhaustedError(failures: readonly ProviderAttemptFailure[]): Error {
  const summary = failures
    .map((failure) => `${failure.providerId}/${failure.modelId} (${failure.reason})`)
    .join(", ");
  return Object.assign(
    new Error(
      `All configured providers have exhausted their quota: ${summary}. Check your balance or choose another model.`,
    ),
    {
      name: "ProviderQuotaFallbackExhaustedError",
      code: PROVIDER_QUOTA_FALLBACK_EXHAUSTED_CODE,
      context: {
        attempts: failures,
        providerQuotaExhausted: true,
        reason: "provider_quota_fallback_exhausted",
      },
    },
  );
}

function withFallbackStatus<T>(fallback: ProviderFallbackEvent | undefined, run: () => T): T {
  if (!fallback) return run();
  const context = getCurrentModelInvocationContext();
  const sink = context?.statusSink;
  if (!context || !sink) {
    return run();
  }
  const wrapped: ModelStatusSink = {
    publish: (event) => sink.publish({ ...event, providerFallback: fallback }),
    ...(sink.publishFailure
      ? {
          publishFailure: (event, error) =>
            sink.publishFailure!({ ...event, providerFallback: fallback }, error),
        }
      : {}),
  };
  return runWithModelInvocationContext({ ...context, statusSink: wrapped }, run);
}

function isSameModelClass(
  source: ProviderModelClassFacts,
  candidate: ProviderModelClassFacts,
  reasoningLevel: string | undefined,
): boolean {
  if (reasoningLevel !== undefined && !candidate.reasoningLevels?.includes(reasoningLevel)) {
    return false;
  }
  if (candidate.modelId === source.modelId) return true;
  if (
    source.contextWindow !== undefined &&
    (candidate.contextWindow ?? 0) < source.contextWindow
  ) {
    return false;
  }
  if (source.supportsToolCall === true && candidate.supportsToolCall !== true) return false;
  if (
    source.supportsJsonSchemaOutput === true &&
    candidate.supportsJsonSchemaOutput !== true
  ) {
    return false;
  }
  for (const key of INPUT_FORMAT_KEYS) {
    if (source.inputFormat?.[key] === true && candidate.inputFormat?.[key] !== true) {
      return false;
    }
  }
  return true;
}

function findQuotaFailure(
  error: unknown,
): { statusCode?: number; reason: string } | undefined {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const context = isRecord(record.context) ? record.context : undefined;
    if (context?.providerQuotaExhausted === true) {
      return {
        statusCode: numberValue(context.statusCode),
        reason: stringValue(context.providerQuotaReason) ?? "quota_exhausted",
      };
    }
    const statusCode = numberValue(context?.statusCode) ?? numberValue(record.statusCode);
    const retryAfterMs = numberValue(context?.retryAfterMs) ?? numberValue(record.retryAfterMs);
    const providerCode = stringValue(context?.providerCode) ?? stringValue(record.code);
    const message = typeof record.message === "string" ? record.message : "";
    if (
      statusCode === 402 ||
      providerCode === "insufficient_balance" ||
      providerCode === "FreeUsageLimitError" ||
      /FreeUsageLimitError|free-model usage limit/i.test(message)
    ) {
      return { statusCode, reason: quotaReason(statusCode, providerCode, message) };
    }
    if (
      statusCode === 429 &&
      retryAfterMs !== undefined &&
      retryAfterMs > QUOTA_RETRY_AFTER_THRESHOLD_MS
    ) {
      return { statusCode, reason: "retry_after_exceeded" };
    }
    current = record.cause;
  }
  return undefined;
}

function quotaReason(
  statusCode: number | undefined,
  providerCode: string | undefined,
  message: string,
): string {
  if (providerCode === "insufficient_balance" || statusCode === 402) return "insufficient_balance";
  if (providerCode === "FreeUsageLimitError" || /free-model usage limit/i.test(message)) {
    return "free_usage_limit";
  }
  return "quota_exhausted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
