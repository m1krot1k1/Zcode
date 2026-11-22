import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_QUANTIZATION_STRIDE,
  DEFAULT_MAX_CACHE_BREAKPOINTS,
  applyCacheControlToOpenAiCompatibleWireBody,
  createOpenAiCompatibleCacheControlFetch,
  normalizeProviderCacheUsage,
  planCacheBreakpoints,
  resolveProviderCacheCapability,
} from "../src/model/cache-control/index.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1";

function buildWireConversation(turnCount: number) {
  const messages: Array<Record<string, unknown>> = [
    { content: "Immutable system prompt body", role: "system" },
  ];
  for (let i = 1; i <= turnCount; i += 1) {
    messages.push({ content: `User request #${i}`, role: "user" });
    messages.push({ content: `Assistant reply #${i}`, role: "assistant" });
  }
  return {
    messages,
    tools: [
      { function: { description: "Read file", name: "Read", parameters: {} }, type: "function" },
      { function: { description: "Edit file", name: "Edit", parameters: {} }, type: "function" },
    ],
  };
}

function extractMarkedMessageIndices(messages: unknown[]): number[] {
  const marked: number[] = [];
  messages.forEach((msg, index) => {
    const record = msg as { content?: unknown };
    if (
      Array.isArray(record.content) &&
      record.content.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as { cache_control?: { type?: string } }).cache_control?.type === "ephemeral",
      )
    ) {
      marked.push(index);
    }
  });
  return marked;
}

describe("Increment 4.1 (F-04): OpenRouter & native prompt cache_control breakpoint placement", () => {
  it.each([
    {
      expectedFamily: "openrouter-qwen",
      expectToolBreakpoint: true,
      modelId: "qwen/qwen3.6-plus",
    },
    {
      expectedFamily: "openrouter-anthropic",
      expectToolBreakpoint: true,
      modelId: "anthropic/claude-sonnet-4.5",
    },
    {
      expectedFamily: "openrouter-gemini",
      expectToolBreakpoint: true,
      modelId: "google/gemini-2.5-pro",
    },
    {
      expectedFamily: "openrouter-deepseek",
      expectToolBreakpoint: false,
      modelId: "deepseek/deepseek-chat",
    },
  ])(
    "places <= 4 ephemeral cache_control breakpoints for OpenRouter $modelId",
    ({ expectedFamily, expectToolBreakpoint, modelId }) => {
      const capability = resolveProviderCacheCapability({
        baseURL: OPENROUTER_URL,
        modelId,
        providerId: "openrouter",
        providerKind: "openai-compatible",
      });

      expect(capability.supportsExplicitBreakpoints).toBe(true);
      expect(capability.family).toBe(expectedFamily);
      expect(capability.maxBreakpoints).toBe(DEFAULT_MAX_CACHE_BREAKPOINTS);

      const baseBody = {
        model: modelId,
        ...buildWireConversation(10),
      };
      const patched = applyCacheControlToOpenAiCompatibleWireBody(baseBody, { capability });

      const tools = patched.tools as Array<Record<string, unknown>>;
      const messages = patched.messages as Array<Record<string, unknown>>;

      const markedTools = tools.filter(
        (tool) => (tool.cache_control as { type?: string } | undefined)?.type === "ephemeral",
      );
      expect(markedTools).toHaveLength(expectToolBreakpoint ? 1 : 0);
      if (expectToolBreakpoint) {
        expect((tools.at(-1)?.cache_control as { type?: string } | undefined)?.type).toBe(
          "ephemeral",
        );
      }

      const markedMessageIndices = extractMarkedMessageIndices(messages);
      // Всегда помечен ведущий неизменяемый system-промпт (индекс 0) + квантованные исторические якоря.
      expect(markedMessageIndices[0]).toBe(0);
      expect(markedTools.length + markedMessageIndices.length).toBeLessThanOrEqual(4);
      expect(patched.provider).toEqual({
        allow_fallbacks: true,
        require_parameters: false,
      });
    },
  );

  it("quantizes historical cache_control anchors so single-step additions do NOT invalidate cached prefix", () => {
    const capability = resolveProviderCacheCapability({
      baseURL: OPENROUTER_URL,
      modelId: "qwen/qwen3.6-plus",
      providerId: "openrouter",
      providerKind: "openai-compatible",
    });

    // На шаге 8 (ровно 2 кванта по stride=4) якоря стоят на кванте #1 и кванте #2.
    const step8 = applyCacheControlToOpenAiCompatibleWireBody(
      { model: "qwen/qwen3.6-plus", ...buildWireConversation(8) },
      { capability, quantizationStride: DEFAULT_CACHE_QUANTIZATION_STRIDE },
    );
    const step9 = applyCacheControlToOpenAiCompatibleWireBody(
      { model: "qwen/qwen3.6-plus", ...buildWireConversation(9) },
      { capability, quantizationStride: DEFAULT_CACHE_QUANTIZATION_STRIDE },
    );
    const step11 = applyCacheControlToOpenAiCompatibleWireBody(
      { model: "qwen/qwen3.6-plus", ...buildWireConversation(11) },
      { capability, quantizationStride: DEFAULT_CACHE_QUANTIZATION_STRIDE },
    );

    const anchorsAt8 = extractMarkedMessageIndices(step8.messages as unknown[]);
    const anchorsAt9 = extractMarkedMessageIndices(step9.messages as unknown[]);
    const anchorsAt11 = extractMarkedMessageIndices(step11.messages as unknown[]);

    // При переходах 8 -> 9 -> 11 внутри одного кванта индексы cache_control не сдвигаются ни на байт!
    expect(anchorsAt9).toEqual(anchorsAt8);
    expect(anchorsAt11).toEqual(anchorsAt8);
    expect((step9.messages as unknown[]).slice(0, (step8.messages as unknown[]).length)).toEqual(
      step8.messages,
    );

    // На шаге 12 (следующая граница кванта кратная 4) предыдущий старший якорь сохраняется во втором слоте!
    const step12 = applyCacheControlToOpenAiCompatibleWireBody(
      { model: "qwen/qwen3.6-plus", ...buildWireConversation(12) },
      { capability, quantizationStride: DEFAULT_CACHE_QUANTIZATION_STRIDE },
    );
    const anchorsAt12 = extractMarkedMessageIndices(step12.messages as unknown[]);
    expect(anchorsAt12).toContain(0);
    expect(anchorsAt12).toContain(anchorsAt8.at(-1));
    expect(anchorsAt12.at(-1)).toBeGreaterThan(anchorsAt8.at(-1)!);
  });

  it("injects wire cache_control transparently via createOpenAiCompatibleCacheControlFetch and normalizes cache usage", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const wrappedFetch = createOpenAiCompatibleCacheControlFetch({
      baseURL: OPENROUTER_URL,
      defaultModelId: "anthropic/claude-sonnet-4.5",
      fetch: async (_req, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: "cmpl_test" }), { status: 200 });
      },
      providerId: "openrouter",
    });

    await wrappedFetch(`${OPENROUTER_URL}/chat/completions`, {
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.5",
        ...buildWireConversation(5),
      }),
      method: "POST",
    });

    expect(sentBody).toBeDefined();
    expect(extractMarkedMessageIndices(sentBody!.messages as unknown[])[0]).toBe(0);
    expect(
      ((sentBody!.tools as Array<Record<string, unknown>>).at(-1)?.cache_control as {
        type?: string;
      })?.type,
    ).toBe("ephemeral");

    expect(
      normalizeProviderCacheUsage({
        rawUsage: {
          cache_creation_input_tokens: 1_400,
          prompt_tokens_details: { cached_tokens: 9_800 },
        },
      }),
    ).toEqual({
      cacheReadTokens: 9_800,
      cacheWriteTokens: 1_400,
    });

    const nativePlan = planCacheBreakpoints({
      capability: resolveProviderCacheCapability({
        modelId: "claude-sonnet-4-5",
        providerId: "anthropic",
        providerKind: "anthropic",
      }),
      messages: [
        { cacheControl: { type: "ephemeral" }, hasNonEmptyContent: true, role: "system" },
        { hasNonEmptyContent: true, role: "user" },
      ],
      toolCount: 3,
    });
    expect(nativePlan.breakpoints).toEqual([
      { index: 2, kind: "tools" },
      { index: 0, kind: "system" },
      { index: 1, kind: "history-anchor" },
    ]);
  });
});
