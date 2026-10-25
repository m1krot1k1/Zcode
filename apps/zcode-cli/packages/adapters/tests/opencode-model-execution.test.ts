import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { runWithModelInvocationContext } from "@zcode/contracts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OpencodeProvider } from "ai-sdk-provider-opencode-sdk";
import { createOpencode, OpencodeClientManager } from "ai-sdk-provider-opencode-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";
import { classifyModelFailure, inspectProviderFailure } from "../src/model/failure-classifier.js";
import { createOpenCodeDiagnosticFetch } from "../src/model/model-execution.js";
import { TestProviderConfigFixture } from "./test-provider-config.js";

describe("OpenCode SDK model execution", () => {
  it("preserves sanitized prompt HTTP diagnostics through the real SDK wrapper", async () => {
    const requests: string[] = [];
    const fetch = createOpenCodeDiagnosticFetch(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const pathname = new URL(request.url).pathname;
      requests.push(`${request.method} ${pathname}`);
      if (request.method === "POST" && pathname === "/session") {
        return Response.json({
          id: "ses_test",
          projectID: "global",
          directory: process.cwd(),
          title: "test",
          version: "1.19.3",
          time: { created: 1, updated: 1 },
        });
      }
      if (request.method === "POST" && pathname === "/session/ses_test/message") {
        return new Response(
          JSON.stringify({
            name: "UnknownError",
            data: {
              code: "INTERNAL_ERROR",
              message: "Free usage limit reached. OpenCode Go is required.",
              debug: "must not cross the provider boundary",
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ name: "NotFound", data: { message: "not found" } }, { status: 404 });
    });
    const client = createOpencodeClient({ baseUrl: "http://opencode.test", fetch });
    const provider = createOpencode({
      clientManager: OpencodeClientManager.createInstance({ client }),
    });
    const registry = createRegistry(provider);

    try {
      const model = registry.resolve("opencode/deepseek-v4.1-flash-free").model;
      const result = runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        model.doGenerate!(createCallOptions()),
      );
      let failure: unknown;
      try {
        await result;
      } catch (error) {
        failure = error;
      }

      expect(requests).toContain("POST /session/ses_test/message");
      expect(failure).toBeDefined();
      expect(classifyModelFailure(failure)).toMatchObject({
        statusCode: 500,
        reason: "unknown",
        retryable: false,
      });
      expect(inspectProviderFailure(failure)).toEqual({
        providerErrorCode: "INTERNAL_ERROR",
        providerErrorMessage: "Free usage limit reached. OpenCode Go is required.",
      });
      expect(String(failure)).not.toContain("must not cross the provider boundary");
    } finally {
      await registry.dispose();
    }
  });

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
      const result = await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        resolved.model.doGenerate!(createCallOptions()),
      );

      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(calls).toHaveLength(3);
      expect(calls.at(-1)).toEqual({
        modelId: "deepseek-v4.1-flash-free",
        directory: process.cwd(),
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
      await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        resolved.model.doGenerate!(createCallOptions()),
      );
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
      model: () =>
        ({
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
      const output = await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        model.doStream(createCallOptions({ abortSignal: controller.signal })),
      );
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
      model: () =>
        ({
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
      const output = await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        model.doStream(createCallOptions()),
      );
      const reader = output.stream.getReader();
      await expect(reader.read()).resolves.toEqual({ done: false, value: observedPart });
      // OpenCode's providerExecuted marker survives the factory unchanged, so downstream ZCode
      // tool dispatch can continue to exclude this already-run provider-side tool.
      expect(observedPart.providerExecuted).toBe(true);
    } finally {
      await registry.dispose();
    }
  });

  it.each([
    ["missing invocation directory", undefined],
    ["removed workspace", join(tmpdir(), `zcode-opencode-missing-${randomUUID()}`)],
    ["file instead of a directory", process.execPath],
  ])("fails closed before the SDK request for %s", async (_label, workingDirectory) => {
    let sdkRequests = 0;
    const provider = createFakeOpenCodeProvider({
      model: () =>
        ({
          doGenerate: async () => {
            sdkRequests += 1;
            throw new Error("SDK must not receive an invalid workspace");
          },
        }) as unknown as LanguageModelV3,
    });
    const registry = createRegistry(provider);

    try {
      const model = registry.resolve("opencode/deepseek-v4.1-flash-free").model;
      const invoke = () => model.doGenerate!(createCallOptions());
      const result = runWithModelInvocationContext(
        workingDirectory ? { workingDirectory } : {},
        invoke,
      );
      await expect(result).rejects.toThrow(
        "OpenCode needs an available workspace folder. Reopen or restore the workspace, then try again.",
      );
      expect(sdkRequests).toBe(0);
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
  model: (modelId: string, settings?: { directory?: string }) => LanguageModelV3;
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
