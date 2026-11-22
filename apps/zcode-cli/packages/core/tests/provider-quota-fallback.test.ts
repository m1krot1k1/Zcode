import { describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelEvent,
  type ModelNetworkStatusEvent,
  type ModelRequest,
  type ModelStatusSink,
  type ModelTextResult,
} from "@zcode/contracts";
import { modelSelectionSchema } from "@zcode/shared/model-selection";
import {
  PROVIDER_QUOTA_FALLBACK_EXHAUSTED_CODE,
  createProviderQuotaFallbackModel,
  isProviderQuotaExhaustedFailure,
  resolveProviderQuotaReason,
  selectProviderFallbackCandidates,
  type ProviderFallbackAttempt,
  type ProviderFallbackEvent,
  type ProviderModelClassFacts,
} from "../src/runtime/methods/provider-quota-fallback.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const MODEL_ID = "shared-model";
const QUOTA_RETRY_AFTER_MS = 15_995_000; // Retry-After: 15995（秒）——远超 10 分钟阈值，重试无意义
const REQUEST = {
  messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
} as unknown as ModelRequest;

function ok(text: string): ModelTextResult {
  return {
    text,
    finishReason: "stop",
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  };
}

/** 模拟 adapter 在 429 且 Retry-After 超阈值后抛出的错误（fail-fast，不进入普通重试）。 */
function quotaError(providerId: string, retryAfterMs = QUOTA_RETRY_AFTER_MS): Error {
  return Object.assign(new Error(`[${providerId}] 429 quota exceeded`), {
    statusCode: 429,
    retryAfterMs,
    context: { statusCode: 429, retryAfterMs },
  });
}

function attempt(
  providerId: string,
  generateText: (request: ModelRequest) => Promise<ModelTextResult>,
): ProviderFallbackAttempt {
  return {
    providerId,
    modelId: MODEL_ID,
    model: createTestRuntimeModel({ providerId, modelId: MODEL_ID, generateText }),
  };
}

function facts(providerId: string, override: Partial<ProviderModelClassFacts> = {}) {
  return {
    providerId,
    modelId: MODEL_ID,
    contextWindow: 200_000,
    supportsToolCall: true,
    ...override,
  } satisfies ProviderModelClassFacts;
}

function startedEvent(providerId: string): ModelNetworkStatusEvent {
  return {
    type: "model_request_started",
    timestamp: new Date().toISOString(),
    traceId: "trace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    providerId,
    modelId: MODEL_ID,
    querySource: "main_turn",
    requestId: "request-1",
    attempt: 1,
  } as unknown as ModelNetworkStatusEvent;
}

describe("provider quota fallback", () => {
  it("立即切到下一个 Provider，并在首个请求上打 providerFallback 状态事件", async () => {
    const calls: string[] = [];
    const primary = attempt("alpha", async () => {
      calls.push("alpha");
      throw quotaError("alpha");
    });
    const secondary = attempt("beta", async () => {
      calls.push("beta");
      // adapter 在切换后的首个请求上会把 providerFallback 透传给 statusSink
      const sink = getCurrentModelInvocationContext()?.statusSink;
      sink?.publish({
        ...startedEvent("beta"),
        providerFallback: { from: "alpha", to: "beta", reason: "retry_after_exceeded" },
      } as unknown as ModelNetworkStatusEvent);
      return ok("beta answer");
    });
    const fallbacks: ProviderFallbackEvent[] = [];
    const model = createProviderQuotaFallbackModel({
      primary,
      fallbacks: [secondary],
      onFallback: (event) => fallbacks.push(event),
    });

    const published: ModelNetworkStatusEvent[] = [];
    const statusSink: ModelStatusSink = { publish: (event) => void published.push(event) };
    const result = await runWithModelInvocationContext({ statusSink }, () =>
      model.generateText(REQUEST),
    );

    expect(result.text).toBe("beta answer");
    // 首个 Provider 只尝试一次：15995 秒的重试等待不接受，直接换 Provider
    expect(calls).toEqual(["alpha", "beta"]);
    expect(fallbacks).toEqual([
      { from: "alpha", to: "beta", reason: "retry_after_exceeded" },
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "model_request_started",
      providerId: "beta",
      providerFallback: { from: "alpha", to: "beta", reason: "retry_after_exceeded" },
    });
  });

  it("流式请求在未输出任何内容前切换 Provider", async () => {
    const primary = attempt("alpha", async () => {
      throw quotaError("alpha");
    });
    const secondary = attempt("beta", async () => ok("beta stream"));
    const model = createProviderQuotaFallbackModel({ primary, fallbacks: [secondary] });

    const chunks: string[] = [];
    for await (const event of model.streamText(REQUEST)) {
      if (event.type === "text_delta") chunks.push(event.text);
    }

    expect(chunks.join("")).toBe("beta stream");
  });

  it("全部 Provider 配额耗尽时只抛一个稳定错误，尝试次数等于 Provider 数", async () => {
    const calls: string[] = [];
    const attempts = ["alpha", "beta", "gamma"].map((providerId) =>
      attempt(providerId, async () => {
        calls.push(providerId);
        throw quotaError(providerId);
      }),
    );
    const fallbacks: ProviderFallbackEvent[] = [];
    const model = createProviderQuotaFallbackModel({
      primary: attempts[0]!,
      fallbacks: attempts.slice(1),
      onFallback: (event) => fallbacks.push(event),
    });

    const error = await model.generateText(REQUEST).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "ProviderQuotaFallbackExhaustedError",
      code: PROVIDER_QUOTA_FALLBACK_EXHAUSTED_CODE,
      context: {
        providerQuotaExhausted: true,
        attempts: [
          { providerId: "alpha", modelId: MODEL_ID, reason: "retry_after_exceeded" },
          { providerId: "beta", modelId: MODEL_ID, reason: "retry_after_exceeded" },
          { providerId: "gamma", modelId: MODEL_ID, reason: "retry_after_exceeded" },
        ],
      },
    });
    // 3 个 Provider 各一次 = 3 次，而不是 adapter 的普通重试预算（11 次）
    expect(calls).toEqual(["alpha", "beta", "gamma"]);
    expect(calls).toHaveLength(attempts.length);
    expect(fallbacks.map((event) => `${event.from}->${event.to}`)).toEqual([
      "alpha->beta",
      "beta->gamma",
    ]);
  });

  it("已经输出内容后不切换 Provider，避免把两段回答拼在一起", async () => {
    const primary = attempt("alpha", async () => ok("unused"));
    const partial: Model = {
      ...primary.model,
      async *streamText(): AsyncIterable<ModelEvent> {
        yield { id: "seg", type: "text_start" };
        yield { id: "seg", type: "text_delta", text: "partial" };
        throw quotaError("alpha");
      },
    };
    const secondaryGenerate = vi.fn(async () => ok("beta answer"));
    const secondary = attempt("beta", secondaryGenerate);
    const model = createProviderQuotaFallbackModel({
      primary: { ...primary, model: partial },
      fallbacks: [secondary],
    });

    const chunks: string[] = [];
    await expect(async () => {
      for await (const event of model.streamText(REQUEST)) {
        if (event.type === "text_delta") chunks.push(event.text);
      }
    }).rejects.toMatchObject({ statusCode: 429 });

    expect(chunks).toEqual(["partial"]);
    expect(secondaryGenerate).not.toHaveBeenCalled();
  });

  it("非配额错误（500）不触发切换，错误原样交给普通重试策略", async () => {
    const serverError = Object.assign(new Error("Internal Server Error"), {
      statusCode: 500,
      context: { statusCode: 500 },
    });
    const primary = attempt("alpha", async () => {
      throw serverError;
    });
    const secondaryGenerate = vi.fn(async () => ok("beta answer"));
    const model = createProviderQuotaFallbackModel({
      primary,
      fallbacks: [attempt("beta", secondaryGenerate)],
    });

    await expect(model.generateText(REQUEST)).rejects.toBe(serverError);
    expect(secondaryGenerate).not.toHaveBeenCalled();
    // 非配额错误保持可重试：classifier 不把它标记为配额耗尽，adapter 的 11 次重试预算不受影响
    expect(isProviderQuotaExhaustedFailure(serverError)).toBe(false);
    // 普通 429（Retry-After 未超过 10 分钟）同样走原有退避重试，不算配额耗尽
    expect(isProviderQuotaExhaustedFailure(quotaError("alpha", 5_000))).toBe(false);
    expect(isProviderQuotaExhaustedFailure(quotaError("alpha", 600_000))).toBe(false);
  });

  it("providerFallback: disabled 时不生成候选，模型原样透传，错误保持原状", async () => {
    const selection = modelSelectionSchema.parse({
      providerId: "alpha",
      modelId: MODEL_ID,
      options: { providerFallback: "disabled" },
    });
    expect(selection.options?.providerFallback).toBe("disabled");
    // 协议只接受显式 disabled，其他取值（含拼写错误）必须拒绝
    expect(
      modelSelectionSchema.safeParse({
        providerId: "alpha",
        modelId: MODEL_ID,
        options: { providerFallback: "enabled" },
      }).success,
    ).toBe(false);

    const providers = [facts("alpha"), facts("beta"), facts("gamma")];
    expect(
      selectProviderFallbackCandidates({
        source: providers[0]!,
        providers,
        allowFallback: false,
      }),
    ).toEqual([]);

    // bootstrap 在 disabled 时把 primary 直接返回；等价于 wrapper 只有一个 attempt
    const original = quotaError("alpha");
    const primaryModel = createTestRuntimeModel({
      providerId: "alpha",
      modelId: MODEL_ID,
      generateText: async () => {
        throw original;
      },
    });
    const model = createProviderQuotaFallbackModel({
      primary: { providerId: "alpha", modelId: MODEL_ID, model: primaryModel },
      fallbacks: [],
    });

    expect(model).toBe(primaryModel);
    await expect(model.generateText(REQUEST)).rejects.toBe(original);
    expect((original as { code?: string }).code).not.toBe(
      PROVIDER_QUOTA_FALLBACK_EXHAUSTED_CODE,
    );
  });
});

describe("quota failure classification", () => {
  it("区分 429 超阈值、402 与免费额度耗尽", () => {
    expect(resolveProviderQuotaReason(quotaError("alpha"))).toBe("retry_after_exceeded");
    expect(
      resolveProviderQuotaReason(
        Object.assign(new Error("payment required"), { statusCode: 402 }),
      ),
    ).toBe("insufficient_balance");
    expect(
      resolveProviderQuotaReason(
        Object.assign(new Error("rejected"), { code: "insufficient_balance" }),
      ),
    ).toBe("insufficient_balance");
    expect(
      resolveProviderQuotaReason(
        Object.assign(new Error("FreeUsageLimitError: free-model usage limit reached"), {
          statusCode: 429,
        }),
      ),
    ).toBe("free_usage_limit");
  });

  it("识别 adapter 已标记的 providerQuotaExhausted，并沿 cause 链查找", () => {
    const marked = Object.assign(new Error("quota"), {
      context: { providerQuotaExhausted: true, providerQuotaReason: "insufficient_balance" },
    });
    expect(isProviderQuotaExhaustedFailure(marked)).toBe(true);
    expect(resolveProviderQuotaReason(marked)).toBe("insufficient_balance");

    const wrapped = Object.assign(new Error("request failed"), {
      cause: quotaError("alpha"),
    });
    expect(isProviderQuotaExhaustedFailure(wrapped)).toBe(true);
    expect(resolveProviderQuotaReason(wrapped)).toBe("retry_after_exceeded");
    expect(isProviderQuotaExhaustedFailure(new Error("boom"))).toBe(false);
  });

  it("按 Registry 顺序环形选择下一个 Provider，上限 3 次且跳过隐藏模型", () => {
    const providers = [
      facts("alpha"),
      facts("beta"),
      facts("gamma", { hidden: true }),
      facts("delta"),
      facts("epsilon"),
    ];
    expect(
      selectProviderFallbackCandidates({ source: providers[0]!, providers }).map(
        (candidate) => candidate.providerId,
      ),
    ).toEqual(["beta", "delta"]);
    // 环形的「下一个」语义：gamma 之后是 delta，再绕回 alpha
    expect(
      selectProviderFallbackCandidates({
        source: facts("gamma"),
        providers: [facts("alpha"), facts("beta"), facts("gamma"), facts("delta")],
      }).map((candidate) => candidate.providerId),
    ).toEqual(["delta", "alpha"]);
    // 不同 modelId 且能力不满足同类模型时不做切换（同 modelId 视为同类，不做能力收窄）
    expect(
      selectProviderFallbackCandidates({
        source: facts("alpha"),
        providers: [
          facts("beta", { modelId: "weaker-model", supportsToolCall: false }),
          facts("gamma"),
        ],
      }).map((candidate) => candidate.providerId),
    ).toEqual(["gamma"]);
  });

  it("模型包装保留 primary 的身份与能力表", () => {
    const model = createProviderQuotaFallbackModel({
      primary: attempt("alpha", async () => ok("alpha")),
      fallbacks: [attempt("beta", async () => ok("beta"))],
    });
    expect(model.providerId).toBe(createModelProviderId("alpha"));
    expect(model.modelId).toBe(createModelId(MODEL_ID));
    expect(model.properties.contextWindow).toBe(200_000);
    const bound = model.bind({ maxOutputTokens: 1_024 });
    expect(bound).not.toBe(model);
    expect(bound.providerId).toBe(model.providerId);
  });
});
