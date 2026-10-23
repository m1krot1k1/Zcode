import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { runWithModelInvocationContext } from "@zcode/contracts";
import type { OpencodeProvider } from "ai-sdk-provider-opencode-sdk";
import { describe, expect, it, vi } from "vitest";
import { TestProviderConfigFixture } from "./test-provider-config.js";

describe("OpenCode SDK model execution", () => {
  it("uses local-auth without constructing a URL or an API key and routes by the active workspace", async () => {
    const calls: Array<{ modelId: string; directory?: string }> = [];
    const provider = createFakeOpenCodeProvider({
      model: (modelId, settings) => {
        calls.push({ modelId, directory: settings?.directory });
        return {
          doGenerate: async () => ({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          }),
        } as unknown as LanguageModelV3;
      },
    });
    const registry = createRegistry(provider);

    try {
      const resolved = registry.resolve("opencode/deepseek-v4.1-flash-free");
      const result = await runWithModelInvocationContext(
        { workingDirectory: "/workspace/project-a" },
        () => resolved.model.doGenerate!(createCallOptions()),
      );

      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(calls).toHaveLength(3);
      expect(calls.at(-1)).toEqual({
        modelId: "deepseek-v4.1-flash-free",
        directory: "/workspace/project-a",
      });
      expect(resolved.baseURL).toBeUndefined();
      expect(resolved.headers).toBeUndefined();
      expect(resolved.providerKind).toBe("opencode-sdk");
    } finally {
      await registry.dispose();
    }
  });

  it("passes a foreign provider/model id to the OpenCode SDK unchanged", async () => {
    const calls: string[] = [];
    const provider = createFakeOpenCodeProvider({
      model: (modelId) => {
        calls.push(modelId);
        return {
          doGenerate: async () => ({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          }),
        } as unknown as LanguageModelV3;
      },
    });
    const registry = createRegistry(provider);
    const modelId = "anthropic/claude-sonnet-4-5";

    try {
      const resolved = registry.resolve(`opencode/${modelId}`);
      await resolved.model.doGenerate!(createCallOptions());
      expect(calls.at(-1)).toBe(modelId);
      expect(resolved.modelId).toBe(modelId);
    } finally {
      await registry.dispose();
    }
  });

  it("passes the standard request AbortSignal through OpenCode streaming and disposes its injected provider", async () => {
    let providerSignal: AbortSignal | undefined;
    const dispose = vi.fn(async () => undefined);
    const provider = createFakeOpenCodeProvider({
      dispose,
      model: () => ({
        doStream: async (options) => {
          providerSignal = options.abortSignal;
          const stream = new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              const abort = () => controller.error(new Error("cancelled"));
              options.abortSignal?.addEventListener("abort", abort, { once: true });
            },
          });
          return { stream };
        },
      }) as unknown as LanguageModelV3,
    });
    const registry = createRegistry(provider);
    const controller = new AbortController();

    try {
      const resolved = registry.resolve("opencode/deepseek-v4.1-flash-free");
      const model = resolved.model as LanguageModelV3;
      const output = await model.doStream(createCallOptions({ abortSignal: controller.signal }));
      expect(providerSignal).toBe(controller.signal);

      controller.abort();
      await expect(output.stream.getReader().read()).rejects.toThrow("cancelled");
    } finally {
      await registry.dispose();
    }

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not execute provider-side tool observations in the adapter", async () => {
    const observedPart = {
      type: "tool-call",
      toolCallId: "oc-tool-1",
      toolName: "Read",
      input: { filePath: "README.md" },
      providerExecuted: true,
    } as unknown as LanguageModelV3StreamPart;
    const provider = createFakeOpenCodeProvider({
      model: () => ({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue(observedPart);
              controller.close();
            },
          }),
        }),
      }) as unknown as LanguageModelV3,
    });
    const registry = createRegistry(provider);

    try {
      const model = registry.resolve("opencode/deepseek-v4.1-flash-free").model as LanguageModelV3;
      const output = await model.doStream(createCallOptions());
      const reader = output.stream.getReader();
      await expect(reader.read()).resolves.toEqual({ done: false, value: observedPart });
      // OpenCode's providerExecuted marker survives the factory unchanged, so downstream ZCode
      // tool dispatch can continue to exclude this already-run provider-side tool.
      expect(observedPart.providerExecuted).toBe(true);
    } finally {
      await registry.dispose();
    }
  });
});

function createRegistry(provider: OpencodeProvider) {
  return new TestProviderConfigFixture(
    {
      env: {},
      providers: {
        opencode: { kind: "opencode-sdk" },
      },
    },
    { opencodeProvider: provider },
  );
}

function createFakeOpenCodeProvider(options: {
  model: (
    modelId: string,
    settings?: { directory?: string },
  ) => LanguageModelV3;
  dispose?: () => Promise<void>;
}): OpencodeProvider {
  const create = ((modelId: string, settings?: { directory?: string }) =>
    options.model(modelId, settings)) as OpencodeProvider;
  Object.assign(create, {
    provider: "opencode",
    specificationVersion: "v3",
    languageModel: create,
    chat: create,
    embeddingModel: () => {
      throw new Error("not supported");
    },
    imageModel: () => {
      throw new Error("not supported");
    },
    dispose: options.dispose ?? (async () => undefined),
  });
  return create;
}

function createCallOptions(
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return { prompt: [], ...overrides };
}
