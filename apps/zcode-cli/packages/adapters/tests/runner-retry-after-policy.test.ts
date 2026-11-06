import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
  ModelErrorCode,
  ModelFailureReason,
  type ModelNetworkStatusEvent,
} from "@zcode/contracts";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { AiSdkModelAdapterError } from "../src/model/errors.js";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import {
  isRetryAfterBeyondHonoredWait,
  MAX_HONORED_RETRY_AFTER_MS,
} from "../src/model/retry-policy.js";
import { calculateRetryDelay, sleep } from "../src/model/runner-retry.js";

// docs/specs/provider-quota-fallback.md「Retry-After 超过本地可兑现窗口」：
// 5 分钟内的 Retry-After 照常等待重试；超过则按配额/限流耗尽终止，不再用本地短退避空转。
const RETRY = { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 };

describe("Retry-After capacity policy", () => {
  it("honors Retry-After up to five minutes and rejects longer waits", () => {
    expect(MAX_HONORED_RETRY_AFTER_MS).toBe(300_000);
    expect(isRetryAfterBeyondHonoredWait(undefined)).toBe(false);
    expect(isRetryAfterBeyondHonoredWait(300_000)).toBe(false);
    expect(isRetryAfterBeyondHonoredWait(300_001)).toBe(true);
  });

  it("keeps a 429 with an in-capacity Retry-After retryable", () => {
    const failure = classifyModelFailure(rateLimited({ "retry-after": "300" }));
    expect(failure).toMatchObject({
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReason.RateLimited,
      retryAfterMs: 300_000,
      retryable: true,
    });
    expect(failure.providerQuotaExhausted).toBeUndefined();
  });

  it("classifies a 429 beyond the local wait as terminal quota exhaustion", () => {
    const failure = classifyModelFailure(rateLimited({ "retry-after": "301" }));
    expect(failure).toMatchObject({
      code: ModelErrorCode.ModelRateLimited,
      providerQuotaExhausted: true,
      reason: ModelFailureReason.RateLimited,
      retryAfterMs: 301_000,
      retryable: false,
      statusCode: 429,
    });
  });

  it("keeps x-should-retry=false Retry-After out of the wait calculation", () => {
    // 既有语义：provider 明确 x-should-retry=false 时 Retry-After 只作诊断，不驱动等待。
    const failure = classifyModelFailure(
      rateLimited({ "retry-after": "16097", "x-should-retry": "false" }),
    );
    expect(failure.retryAfterMs).toBeUndefined();
  });

  it("never lets a beyond-capacity Retry-After drive the local backoff", () => {
    const retry = { ...RETRY, backoffFactor: 2, maxAttempts: 2 };
    expect(calculateRetryDelay(retry, 1, 300_000)).toBe(300_000);
    // helper 仍可给出本地退避值；真正的终止由重试闸门负责（见下方 runner 断言）。
    expect(calculateRetryDelay(retry, 1, 16_097_000)).toBe(0);
  });
});

describe("retry attempt loop with provider Retry-After", () => {
  it("retries a 429 with Retry-After 1s, then emits only the successful attempt", async () => {
    let attempts = 0;
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { ...RETRY, maxAttempts: 2 },
      runtime: {
        generateText() {
          throw new Error("not used");
        },
        streamText() {
          attempts += 1;
          if (attempts === 1) {
            return { fullStream: failingStream(rateLimited({ "retry-after": "1" })) } as never;
          }
          return {
            fullStream: stream([
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", text: "done" },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
            ]),
          } as never;
        },
      },
    });

    const texts: string[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      messages: [{ role: "user", content: "Ping" }],
      modelId: "model-a" as never,
      providerId: "test" as never,
      statusSink: { publish: (event) => void statusEvents.push(event) },
    })) {
      if (event.type === "text_delta") texts.push(event.text);
    }

    expect(attempts).toBe(2);
    expect(texts).toEqual(["done"]);
    const scheduled = statusEvents.filter((event) => event.type === "model_retry_scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ attempt: 1, delayMs: 1_000, retryAfterMs: 1_000 });
  });

  it("aborts during Retry-After backoff with the caller reason and sends no next request", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const deadline = new Error("task deadline exceeded");
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        setTimeout(() => controller.abort(deadline), 20);
        throw rateLimited({ "retry-after": "2" });
      }),
    });

    const startedAt = Date.now();
    const rejection = await executeAdapterGenerateText(adapter, {
      abortSignal: controller.signal,
      messages: [{ role: "user", content: "Ping" }],
      modelId: "model-a" as never,
      providerId: "test" as never,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(attempts).toBe(1);
    expect(rejection).toBeInstanceOf(AiSdkModelAdapterError);
    expect((rejection as AiSdkModelAdapterError).context).toMatchObject({
      reason: ModelFailureReason.Cancelled,
      retryable: false,
    });
  });

  it("sleep rejects promptly with the abort reason", async () => {
    const deadline = new Error("deadline");
    const preAborted = new AbortController();
    preAborted.abort(deadline);
    await expect(sleep(60_000, preAborted.signal)).rejects.toBe(deadline);

    const midWait = new AbortController();
    setTimeout(() => midWait.abort(deadline), 10);
    await expect(sleep(60_000, midWait.signal)).rejects.toBe(deadline);
  });

  it("stops after one attempt when Retry-After exceeds the local wait", async () => {
    let attempts = 0;
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        throw rateLimited({ "retry-after": "16097" });
      }),
    });

    const rejection = await executeAdapterGenerateText(adapter, {
      messages: [{ role: "user", content: "Ping" }],
      modelId: "model-a" as never,
      providerId: "test" as never,
      statusSink: { publish: (event) => void statusEvents.push(event) },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(attempts).toBe(1);
    expect(rejection).toBeInstanceOf(AiSdkModelAdapterError);
    expect((rejection as AiSdkModelAdapterError).context).toMatchObject({
      maxAttempts: 3,
      providerQuotaExhausted: true,
      reason: ModelFailureReason.RateLimited,
      retryAfterMs: 16_097_000,
      retryable: false,
      statusCode: 429,
    });
    expect(statusEvents.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(0);
    const failed = statusEvents.find((event) => event.type === "model_request_failed");
    expect(failed).toMatchObject({ attempt: 1, retryable: false, statusCode: 429 });
  });

  it("still gives up at maxAttempts for an in-capacity Retry-After", async () => {
    let attempts = 0;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { ...RETRY, baseDelayMs: 0, maxAttempts: 2 },
      runtime: generateRuntime(async () => {
        attempts += 1;
        throw rateLimited({ "retry-after": "1" });
      }),
    });

    const rejection = await executeAdapterGenerateText(adapter, {
      messages: [{ role: "user", content: "Ping" }],
      modelId: "model-a" as never,
      providerId: "test" as never,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(attempts).toBe(2);
    expect(rejection).toBeInstanceOf(AiSdkModelAdapterError);
    expect((rejection as AiSdkModelAdapterError).context).toMatchObject({
      attempt: 2,
      retryable: true,
      statusCode: 429,
    });
  });
});

describe("retry boundary vs tool dispatch", () => {
  it("retries before tool dispatch and emits the tool call exactly once", async () => {
    let attempts = 0;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { ...RETRY, maxAttempts: 2 },
      runtime: {
        generateText() {
          throw new Error("not used");
        },
        streamText() {
          attempts += 1;
          if (attempts === 1) {
            return { fullStream: failingStream(rateLimited({ "retry-after": "1" })) } as never;
          }
          return {
            fullStream: stream([
              { id: "call-1", toolName: "Write", type: "tool-input-start" },
              { delta: '{"file_path":"a.txt"}', id: "call-1", type: "tool-input-delta" },
              { id: "call-1", type: "tool-input-end" },
              {
                input: '{"file_path":"a.txt"}',
                toolCallId: "call-1",
                toolName: "Write",
                type: "tool-call",
              },
              {
                finishReason: "tool-calls",
                totalUsage: usage(1, 1),
                type: "finish",
              },
            ]),
          } as never;
        },
      },
    });

    const events: string[] = [];
    const toolCalls: unknown[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      messages: [{ role: "user", content: "Write a.txt" }],
      modelId: "model-a" as never,
      providerId: "test" as never,
    })) {
      events.push(event.type);
      if (event.type === "tool_call") toolCalls.push(event.toolCall);
    }

    expect(attempts).toBe(2);
    // 重试只重发模型请求；第一次尝试没有输出，第二次的 tool_call 只能出现一次。
    expect(toolCalls).toEqual([{ id: "call-1", input: { file_path: "a.txt" }, name: "Write" }]);
    expect(events.filter((type) => type === "tool_input_delta")).toEqual(["tool_input_delta"]);
  });

  it("does not retry after a tool call chunk has been emitted", async () => {
    let attempts = 0;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: {
        generateText() {
          throw new Error("not used");
        },
        streamText() {
          attempts += 1;
          return {
            fullStream: streamThenFail(
              [
                { id: "call-1", toolName: "Write", type: "tool-input-start" },
                { id: "call-1", type: "tool-input-end" },
                {
                  input: '{"file_path":"a.txt"}',
                  toolCallId: "call-1",
                  toolName: "Write",
                  type: "tool-call",
                },
              ],
              rateLimited({ "retry-after": "1" }),
            ),
          } as never;
        },
      },
    });

    const toolCalls: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of executeAdapterStreamText(adapter, {
          messages: [{ role: "user", content: "Write a.txt" }],
          modelId: "model-a" as never,
          providerId: "test" as never,
        })) {
          if (event.type === "tool_call") toolCalls.push(event.toolCall);
        }
      })(),
    ).rejects.toBeInstanceOf(AiSdkModelAdapterError);

    expect(attempts).toBe(1);
    expect(toolCalls).toHaveLength(1);
  });
});

function registry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      test: {
        createLanguageModel: (modelId) => ({ modelId }) as never,
        kind: "custom",
      },
    },
  });
}

function generateRuntime(generateText: () => Promise<unknown>): AiSdkModelRuntime {
  return {
    generateText: generateText as never,
    streamText() {
      throw new Error("not used");
    },
  };
}

function rateLimited(responseHeaders?: Record<string, string>): Error {
  return new APICallError({
    isRetryable: true,
    message: "rate limited",
    ...(responseHeaders === undefined ? {} : { responseHeaders }),
    statusCode: 429,
  });
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokenDetails: {
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      noCacheTokens: inputTokens,
    },
    inputTokens,
    outputTokenDetails: { reasoningTokens: undefined, textTokens: outputTokens },
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) yield chunk;
}

async function* failingStream(error: unknown) {
  throw error;
}

async function* streamThenFail(chunks: unknown[], error: unknown) {
  for (const chunk of chunks) yield chunk;
  throw error;
}
