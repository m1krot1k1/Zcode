import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
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
import {
  DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS,
  ModelFirstTokenTimeoutError,
} from "../src/model/first-token-watchdog.js";
import { AiSdkModelAdapter, type AiSdkModelRuntime } from "../src/model/runner.js";
import { createTestModelProperties } from "./test-model-format.js";

const MAX_OUTPUT_TOKENS = 32_000;

type Chunk = Record<string, unknown>;

function finishChunk(): Chunk {
  return {
    type: "finish",
    finishReason: "stop",
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

/** 模拟 provider 已接受请求但流被挂起：没有 chunk，直到 attempt 被 abort。 */
function stallUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function harness(options: {
  script: (signal: AbortSignal) => AsyncGenerator<Chunk>;
  firstTokenTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxAttempts?: number;
}) {
  const status: ModelNetworkStatusEvent[] = [];
  const visible: ModelStreamEvent[] = [];
  const signals: AbortSignal[] = [];
  const caller = new AbortController();
  let attempts = 0;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("Expected streaming request");
    },
    streamText(request) {
      attempts += 1;
      const signal = request.abortSignal!;
      signals.push(signal);
      return { fullStream: options.script(signal) } as never;
    },
  };
  const adapter = new AiSdkModelAdapter({
    env: { ZCODE_RUNTIME_ENV: "test" },
    runtime,
    retry: {
      maxAttempts: options.maxAttempts ?? 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    },
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
    firstTokenTimeoutMs: options.firstTokenTimeoutMs ?? DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS,
  });
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "test-api-key" },
      api: { type: "anthropic-messages", baseUrl: "https://watchdog.invalid/v1" },
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
    providerId: "test",
    modelId: "model-a",
    providerConfig: provider.config,
    modelConfig: config.config,
    options: { maxOutputTokens: MAX_OUTPUT_TOKENS, reasoningLevel: "disabled" },
  });
  return {
    status,
    visible,
    signals,
    caller,
    get attempts() {
      return attempts;
    },
    async read() {
      const stream = runWithModelInvocationContext(
        { statusSink: { publish: (event) => void status.push(event) } },
        () =>
          model.streamText({
            abortSignal: caller.signal,
            messages: [{ role: "user", content: "Write test.txt" }],
          }),
      );
      for await (const event of stream) {
        visible.push(event);
      }
    },
  };
}

/** 用假定时器推进到条件成立，避免依赖真实时钟和固定 tick 数。 */
async function advanceUntil(
  predicate: () => boolean,
  stepMs = 1,
  maxSteps = 2_000,
): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error("advanceUntil: condition was not reached");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("model first token watchdog", () => {
  it("aborts the attempt with first_token_timeout when the provider never starts streaming", async () => {
    const run = harness({
      script: async function* (signal) {
        // 只有建连，没有任何 provider 输出。
        await stallUntilAbort(signal);
      },
    });
    const settled = run.read().then(
      () => null,
      (error: unknown) => error,
    );

    await advanceUntil(() => run.attempts === 1);
    // 窗口未到时不得打断；此时也不能被 600s idle 超时提前中止。
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS - 30_000);
    expect(run.signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    const error = await settled;

    expect(error).toMatchObject({
      name: "AiSdkModelAdapterError",
      code: "first_token_timeout",
    });
    expect(run.signals[0]?.aborted).toBe(true);
    expect(run.status.find((event) => event.type === "model_request_failed")).toMatchObject({
      errorCode: "first_token_timeout",
      // maxAttempts=1：分类层可重试，但预算已耗尽，状态里不会安排下一次重试。
      retryable: false,
    });
    // 失败 attempt 不允许泄漏半截输出。
    expect(run.visible).toEqual([]);
  });

  it("cancels the watchdog after the first delta so the stream can run past the window", async () => {
    let releaseStream!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const run = harness({
      script: async function* () {
        yield { type: "start" };
        yield { type: "text-delta", id: "text-live", text: "поток" };
        await released;
        yield finishChunk();
      },
    });
    const read = run.read();

    await advanceUntil(() => run.visible.some((event) => event.type === "text_delta"));
    expect(run.visible.find((event) => event.type === "text_delta")).toMatchObject({
      type: "text_delta",
      text: "поток",
    });

    // 首个增量已到达：即使远超首 token 窗口，attempt 也不能被看门狗中止。
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS * 3);
    expect(run.signals[0]?.aborted).toBe(false);

    releaseStream();
    await read;

    expect(run.visible[run.visible.length - 1]).toMatchObject({
      type: "finish",
      finishReason: "stop",
    });
    expect(run.status.find((event) => event.type === "model_request_failed")).toBeUndefined();
  });

  it("keeps the 600s idle timeout authoritative after the first token", async () => {
    const run = harness({
      script: async function* (signal) {
        yield { type: "start" };
        yield { type: "text-delta", id: "text-live", text: "ok" };
        // 首 token 之后流卡住：应由既有的 idle 超时接管，而不是看门狗。
        await stallUntilAbort(signal);
      },
    });
    const settled = run.read().then(
      () => null,
      (error: unknown) => error,
    );

    await advanceUntil(() => run.visible.some((event) => event.type === "text_delta"));
    // 越过首 token 窗口数倍：看门狗已取消，不得中止。
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS * 2);
    expect(run.signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS);
    const error = await settled;

    expect(error).toMatchObject({ code: "model_request_timeout" });
    expect(run.status.find((event) => event.type === "model_request_failed")).toMatchObject({
      errorCode: "model_request_timeout",
      // maxAttempts=1：idle 失败可重试，但这里只验证错误码与超时来源。
      retryable: false,
    });
  });

  it("keeps the default windows independent (90s first token, 600s idle)", () => {
    expect(DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(600_000);
  });

  it("classifies the watchdog error as timeout before generic abort semantics", () => {
    const controller = new AbortController();
    const watchdogError = new ModelFirstTokenTimeoutError(DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS);
    // 看门狗通过 controller.abort(reason) 中止，读取端拿到的是 signal.reason。
    controller.abort(watchdogError);

    expect(classifyModelFailure(controller.signal.reason, controller.signal)).toMatchObject({
      code: "first_token_timeout",
      reason: "timeout",
      retryable: true,
    });

    // 普通取消仍必须是 cancelled，证明首 token 分支没有放宽 abort 语义。
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      classifyModelFailure(new DOMException("aborted", "AbortError"), cancelled.signal),
    ).toMatchObject({ code: "model_request_cancelled", retryable: false });
  });
});
