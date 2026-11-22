import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
  runWithModelInvocationContext,
  type ModelNetworkStatusEvent,
  type ModelStreamEvent,
} from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
} from "@zcode/provider";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import { AiSdkModelAdapter, type AiSdkModelRuntime } from "../src/model/runner.js";
import { createTestModelProperties } from "./test-model-format.js";

// OpenCode Zen 免费额度耗尽时上游返回的原文，1.19.x 会把它塞进 session.status(retry)。
const FREE_LIMIT_MESSAGE =
  "Free usage limit reached. Free models work in OpenCode; subscribe to OpenCode Go";
const MAX_ATTEMPTS = 11;
const MAX_OUTPUT_TOKENS = 32_000;

function quotaError(headers?: Record<string, string>, message = FREE_LIMIT_MESSAGE): APICallError {
  return new APICallError({
    message,
    url: "opencode://session",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: headers,
    isRetryable: false,
    data: { errorType: "FreeUsageLimitError" },
  });
}

function rateLimitError(headers?: Record<string, string>, message = "rate limited"): APICallError {
  return new APICallError({
    message,
    url: "opencode://session",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: headers,
    isRetryable: true,
  });
}

function harness(chunks: Array<Record<string, unknown>>) {
  const status: ModelNetworkStatusEvent[] = [];
  const visible: ModelStreamEvent[] = [];
  let attempts = 0;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("Expected streaming request");
    },
    streamText() {
      attempts += 1;
      return {
        fullStream: (async function* () {
          yield* chunks;
        })(),
      } as never;
    },
  };
  const adapter = new AiSdkModelAdapter({
    env: { ZCODE_RUNTIME_ENV: "test" },
    runtime,
    retry: { maxAttempts: MAX_ATTEMPTS, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    streamIdleTimeoutMs: 5,
  });
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "test-key" },
      api: { type: "anthropic-messages", baseUrl: "https://opencode.invalid/v1" },
    }),
  );
  const config = createRegistryModelConfig(
    parseModelConfig({
      enabled: true,
      properties: createTestModelProperties(),
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: { max: MAX_OUTPUT_TOKENS, map: '{"max_tokens": maxOutputTokens}' },
      },
    }),
  );
  if (!provider.ok || !config.ok) throw new Error("Invalid model fixture config");
  const model = adapter.createModel({
    providerId: "opencode",
    modelId: "big-pickle",
    providerConfig: provider.config,
    modelConfig: config.config,
    options: { maxOutputTokens: MAX_OUTPUT_TOKENS, reasoningLevel: "disabled" },
  });
  return {
    status,
    visible,
    get attempts() {
      return attempts;
    },
    async read() {
      const stream = runWithModelInvocationContext(
        { statusSink: { publish: (event) => void status.push(event) } },
        () => model.streamText({ messages: [{ role: "user", content: "hi" }] }),
      );
      for await (const event of stream) {
        visible.push(event);
      }
    },
  };
}

describe("OpenCode free usage limit", () => {
  it("classifies the Zen free-limit error as a terminal OpenCode quota error", () => {
    const failure = classifyModelFailure(quotaError({ "retry-after": "15995" }));
    expect(failure).toMatchObject({
      code: "OPENCODE_FREE_LIMIT_REACHED",
      retryable: false,
      statusCode: 429,
      retryAfterSeconds: 15995,
    });
    expect(failure.message).toBe(
      "OpenCode free usage limit reached. Resets in about 4 hours, or switch to another model.",
    );
  });

  it("keeps a short 429 retryable", () => {
    expect(classifyModelFailure(rateLimitError({ "retry-after": "30" }))).toMatchObject({
      code: "model_rate_limited",
      retryable: true,
      retryAfterSeconds: 30,
    });
  });

  it("stops retrying a 429 whose Retry-After exceeds ten minutes", () => {
    expect(classifyModelFailure(rateLimitError({ "retry-after": "15995" }))).toMatchObject({
      code: "model_rate_limited",
      retryable: false,
      retryAfterSeconds: 15995,
    });
  });

  it("fails the stream immediately instead of waiting for the first-token watchdog", async () => {
    const run = harness([{ type: "error", error: quotaError({ "retry-after": "15995" }) }]);
    const startedAt = Date.now();
    await expect(run.read()).rejects.toMatchObject({
      name: "AiSdkModelAdapterError",
      code: "OPENCODE_FREE_LIMIT_REACHED",
    });

    // 90s first-token 看门狗 + 11 次重试都不能发生在配额错误上。
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(run.attempts).toBe(1);
    expect(run.status.some((event) => event.type === "model_retry_scheduled")).toBe(false);
  });

  it("leaves a normal 200 stream untouched", async () => {
    const run = harness([
      { type: "text-delta", id: "text-1", text: "hello" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
    await run.read();
    expect(run.visible[0]).toMatchObject({ type: "text_delta", text: "hello" });
    expect(run.attempts).toBe(1);
  });
});
