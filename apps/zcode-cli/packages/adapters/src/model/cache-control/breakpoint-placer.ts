import type {
  CacheBreakpointPlan,
  CacheBreakpointTarget,
  CacheControlCapability,
  CacheableMessageSummary,
  CliModelCacheControlContract,
  NormalizedCacheUsage,
  PlanCacheBreakpointsInput,
} from "./contract.js";
import {
  DEFAULT_CACHE_QUANTIZATION_STRIDE,
  resolveProviderCacheCapability,
} from "./provider-matrix.js";

const EPHEMERAL_WIRE_CACHE_CONTROL = { type: "ephemeral" } as const;

export function planCacheBreakpoints(input: PlanCacheBreakpointsInput): CacheBreakpointPlan {
  const { capability, messages, toolCount } = input;
  if (!capability.supportsExplicitBreakpoints || capability.maxBreakpoints <= 0) {
    return { breakpoints: [], capability };
  }

  let remainingBudget = capability.maxBreakpoints;
  const breakpoints: CacheBreakpointTarget[] = [];

  if (capability.supportsToolSchemaBreakpoint && toolCount > 0 && remainingBudget > 0) {
    breakpoints.push({ index: toolCount - 1, kind: "tools" });
    remainingBudget -= 1;
  }

  if (remainingBudget > 0) {
    const systemBreakpointIndex = selectStableSystemBreakpointIndex(messages);
    if (systemBreakpointIndex !== undefined) {
      breakpoints.push({ index: systemBreakpointIndex, kind: "system" });
      remainingBudget -= 1;
    }
  }

  if (remainingBudget > 0) {
    const stride = Math.max(
      2,
      Math.floor(input.quantizationStride ?? capability.quantizationStrideMessages ?? DEFAULT_CACHE_QUANTIZATION_STRIDE),
    );
    const historyAnchors = selectQuantizedHistoryAnchors(messages, stride, remainingBudget);
    for (const index of historyAnchors) {
      breakpoints.push({ index, kind: "history-anchor" });
    }
  }

  return { breakpoints, capability };
}

function selectStableSystemBreakpointIndex(
  messages: readonly CacheableMessageSummary[],
): number | undefined {
  let leadingCount = 0;
  while (messages[leadingCount]?.role === "system") {
    leadingCount += 1;
  }
  if (leadingCount === 0) {
    return undefined;
  }

  // При наличии нескольких ведущих system-секций предпочитаем первую непустую секцию с явным cacheControl
  // (статическое тело системного промпта без динамических напоминаний), иначе последнюю непустую ведущую system-секцию.
  for (let i = 0; i < leadingCount; i += 1) {
    const entry = messages[i];
    if (entry?.hasNonEmptyContent && entry.cacheControl !== undefined) {
      return i;
    }
  }

  for (let i = leadingCount - 1; i >= 0; i -= 1) {
    if (messages[i]?.hasNonEmptyContent) {
      return i;
    }
  }
  return undefined;
}

/**
 * Квантованная лестница исторических якорей (Rolling Quantized Prefix Staircase):
 * точки сдвигаются только каждые `stride` подходящих сообщений `user | tool`, а предыдущая ступень
 * удерживается во втором слоте, благодаря чему префикс остаётся побайтово неизменным между квантами.
 */
function selectQuantizedHistoryAnchors(
  messages: readonly CacheableMessageSummary[],
  stride: number,
  maxAnchors: number,
): number[] {
  const candidates: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if ((msg?.role === "user" || msg?.role === "tool") && msg.hasNonEmptyContent) {
      candidates.push(i);
    }
  }

  if (candidates.length === 0 || maxAnchors <= 0) {
    return [];
  }

  if (candidates.length < stride) {
    return [candidates[0]!];
  }

  const latestQuantumPos = Math.floor(candidates.length / stride) * stride - 1;
  if (maxAnchors === 1) {
    return [candidates[latestQuantumPos]!];
  }

  const previousQuantumPos = latestQuantumPos >= stride ? latestQuantumPos - stride : 0;
  if (previousQuantumPos === latestQuantumPos) {
    return [candidates[latestQuantumPos]!];
  }
  return [candidates[previousQuantumPos]!, candidates[latestQuantumPos]!];
}

export function applyCacheControlToOpenAiCompatibleWireBody(
  body: Record<string, unknown>,
  input: {
    readonly capability: CacheControlCapability;
    readonly quantizationStride?: number;
  },
): Record<string, unknown> {
  const { capability } = input;
  if (!capability.supportsExplicitBreakpoints || capability.maxBreakpoints <= 0) {
    return body;
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : undefined;
  const rawTools = Array.isArray(body.tools) ? body.tools : undefined;
  if (!rawMessages && !rawTools) {
    return body;
  }

  const summaries: CacheableMessageSummary[] = (rawMessages ?? []).map((item) => {
    const record = asRecord(item);
    const role = normalizeWireRole(record?.role);
    return {
      hasNonEmptyContent: hasNonEmptyWireContent(record?.content),
      role,
    };
  });

  const plan = planCacheBreakpoints({
    capability,
    messages: summaries,
    quantizationStride: input.quantizationStride,
    toolCount: rawTools?.length ?? 0,
  });

  const messageTargetIndices = new Set(
    plan.breakpoints
      .filter((bp) => bp.kind === "system" || bp.kind === "history-anchor")
      .map((bp) => bp.index),
  );
  const toolTargetIndices = new Set(
    plan.breakpoints.filter((bp) => bp.kind === "tools").map((bp) => bp.index),
  );

  const nextMessages = rawMessages?.map((item, index) => {
    const record = asRecord(item);
    if (!record) return item;
    const cleaned = stripWireMessageCacheControl(record);
    if (!messageTargetIndices.has(index)) {
      return cleaned;
    }
    return injectWireMessageCacheControl(cleaned);
  });

  const nextTools = rawTools?.map((toolItem, index) => {
    const record = asRecord(toolItem);
    if (!record) return toolItem;
    const { cache_control: _removed, ...rest } = record;
    if (!toolTargetIndices.has(index)) {
      return rest;
    }
    return {
      ...rest,
      cache_control: { ...EPHEMERAL_WIRE_CACHE_CONTROL },
    };
  });

  return {
    ...body,
    ...(nextMessages ? { messages: nextMessages } : {}),
    ...(nextTools ? { tools: nextTools } : {}),
    ...(capability.isOpenRouter && body.provider === undefined
      ? {
          provider: {
            allow_fallbacks: true,
            require_parameters: false,
          },
        }
      : {}),
  };
}

function normalizeWireRole(value: unknown): CacheableMessageSummary["role"] {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }
  return "user";
}

function hasNonEmptyWireContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.length > 0;
  }
  if (Array.isArray(content)) {
    return content.some((part) => {
      const record = asRecord(part);
      if (!record) return false;
      if (typeof record.text === "string") return record.text.length > 0;
      return typeof record.type === "string";
    });
  }
  return false;
}

function stripWireMessageCacheControl(message: Record<string, unknown>): Record<string, unknown> {
  const { cache_control: _topRemoved, ...rest } = message;
  if (!Array.isArray(rest.content)) {
    return rest;
  }
  return {
    ...rest,
    content: rest.content.map((part) => {
      const record = asRecord(part);
      if (!record || !("cache_control" in record)) return part;
      const { cache_control: _partRemoved, ...partRest } = record;
      return partRest;
    }),
  };
}

function injectWireMessageCacheControl(message: Record<string, unknown>): Record<string, unknown> {
  const content = message.content;
  if (typeof content === "string" && content.length > 0) {
    return {
      ...message,
      content: [
        {
          type: "text",
          text: content,
          cache_control: { ...EPHEMERAL_WIRE_CACHE_CONTROL },
        },
      ],
    };
  }

  if (Array.isArray(content) && content.length > 0) {
    const nextParts = [...content];
    for (let i = nextParts.length - 1; i >= 0; i -= 1) {
      const partRecord = asRecord(nextParts[i]);
      if (!partRecord) continue;
      nextParts[i] = {
        ...partRecord,
        cache_control: { ...EPHEMERAL_WIRE_CACHE_CONTROL },
      };
      return {
        ...message,
        content: nextParts,
      };
    }
  }

  return message;
}

export function normalizeProviderCacheUsage(input: {
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  readonly rawUsage?: Record<string, unknown>;
}): NormalizedCacheUsage {
  const raw = input.rawUsage;
  const promptDetails = asRecord(raw?.prompt_tokens_details);

  const cacheReadTokens =
    finiteNonNegativeNumber(input.inputTokenDetails?.cacheReadTokens) ??
    finiteNonNegativeNumber(promptDetails?.cached_tokens) ??
    finiteNonNegativeNumber(raw?.cache_read_input_tokens) ??
    finiteNonNegativeNumber(raw?.cached_tokens) ??
    finiteNonNegativeNumber(raw?.cachedContentTokenCount);

  const cacheWriteTokens =
    finiteNonNegativeNumber(input.inputTokenDetails?.cacheWriteTokens) ??
    finiteNonNegativeNumber(promptDetails?.cache_write_tokens) ??
    finiteNonNegativeNumber(raw?.cache_creation_input_tokens) ??
    finiteNonNegativeNumber(raw?.cache_write_tokens);

  return {
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createCliModelCacheControl(): CliModelCacheControlContract {
  return {
    applyToOpenAiCompatibleWireBody: applyCacheControlToOpenAiCompatibleWireBody,
    normalizeCacheUsage: normalizeProviderCacheUsage,
    planBreakpoints: planCacheBreakpoints,
    resolveCapability: resolveProviderCacheCapability,
  };
}

export const defaultCliModelCacheControl = createCliModelCacheControl();

type ProviderFetch = typeof globalThis.fetch;

export function createOpenAiCompatibleCacheControlFetch(input: {
  readonly baseURL: string;
  readonly capture?: { body?: Record<string, unknown> };
  readonly defaultModelId?: string;
  readonly fetch: ProviderFetch;
  readonly providerId: string;
}): ProviderFetch {
  return async (request, init) => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : request instanceof Request
          ? await request.clone().text()
          : undefined;
    if (!bodyText) {
      return input.fetch(request, init);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return input.fetch(request, init);
    }

    const record = asRecord(parsed);
    if (!record) {
      return input.fetch(request, init);
    }

    const modelId = typeof record.model === "string" ? record.model : input.defaultModelId;
    const capability = resolveProviderCacheCapability({
      baseURL: input.baseURL,
      modelId,
      providerId: input.providerId,
      providerKind: "openai-compatible",
    });

    if (!capability.supportsExplicitBreakpoints) {
      return input.fetch(request, init);
    }

    const patched = applyCacheControlToOpenAiCompatibleWireBody(record, { capability });
    if (input.capture) {
      input.capture.body = patched;
    }
    const serialized = JSON.stringify(patched);
    if (request instanceof Request) {
      return input.fetch(new Request(request, { ...init, body: serialized }));
    }
    return input.fetch(request, { ...init, body: serialized });
  };
}
