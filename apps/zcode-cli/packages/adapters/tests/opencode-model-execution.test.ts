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
import {
  createEmptyResponseDataError,
  createOpencode,
  OpencodeClientManager,
} from "ai-sdk-provider-opencode-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";
import { classifyModelFailure, inspectProviderFailure } from "../src/model/failure-classifier.js";
import {
  createOpenCodeDiagnosticFetch,
  projectOpenCodePrompt,
} from "../src/model/model-execution.js";
import { TestProviderConfigFixture } from "./test-provider-config.js";

describe("OpenCode SDK model execution", () => {
  it("sends the OpenCode-only prompt projection to the SDK without rewriting the caller history", async () => {
    let receivedPrompt: LanguageModelV3CallOptions["prompt"] | undefined;
    const provider = createFakeOpenCodeProvider({
      model: () =>
        ({
          doGenerate: async (options: LanguageModelV3CallOptions) => {
            receivedPrompt = options.prompt;
            return {
              content: [{ type: "text", text: "ok" }],
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
              warnings: [],
            };
          },
        }) as unknown as LanguageModelV3,
    });
    const registry = createRegistry(provider);
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      {
        role: "system",
        content: "For complex tasks, delegate them with Agent. Use only agent types listed in the current Agent system-reminder, and launch independent calls together in one response.",
      },
    ];
    const options = createCallOptions({ prompt });

    try {
      await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        registry.resolve("opencode/deepseek-v4.1-flash-free").model.doGenerate!(options),
      );
      expect(receivedPrompt).toEqual(projectOpenCodePrompt(prompt));
      expect(receivedPrompt?.[0]).not.toEqual(prompt[0]);
      expect(prompt[0].role === "system" && prompt[0].content).toContain("listed in the current Agent system-reminder");
    } finally {
      await registry.dispose();
    }
  });

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
        code: "model_rate_limited",
        statusCode: 500,
        message:
          "OpenCode's free-model usage limit is exhausted. Wait for its quota to reset or choose another model.",
        reason: "rate_limited",
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

  it("classifies an OpenCode free quota response from the streaming chat path", async () => {
    const requests: string[] = [];
    const fetch = createOpenCodeDiagnosticFetch(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const pathname = new URL(request.url).pathname;
      requests.push(`${request.method} ${pathname}`);
      if (request.method === "POST" && pathname === "/session") {
        return Response.json({
          id: "ses_stream_quota",
          projectID: "global",
          directory: process.cwd(),
          title: "test",
          version: "1.19.3",
          time: { created: 1, updated: 1 },
        });
      }
      if (request.method === "POST" && pathname === "/session/ses_stream_quota/message") {
        return new Response(
          JSON.stringify({
            name: "UnknownError",
            data: {
              code: "INTERNAL_ERROR",
              message: "Free usage limit reached. Free models work in OpenCode.",
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
      let failure: unknown;
      try {
        const output = await runWithModelInvocationContext(
          { workingDirectory: process.cwd() },
          () => model.doStream!(createCallOptions()),
        );
        const reader = output.stream.getReader();
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (part.value.type === "error") failure = part.value.error;
        }
      } catch (error) {
        failure = error;
      }

      expect(requests).toContain("POST /session/ses_stream_quota/message");
      expect(failure).toBeDefined();
      expect(classifyModelFailure(failure)).toMatchObject({
        code: "model_rate_limited",
        statusCode: 500,
        message:
          "OpenCode's free-model usage limit is exhausted. Wait for its quota to reset or choose another model.",
        reason: "rate_limited",
        retryable: false,
      });
      expect(inspectProviderFailure(failure)).toEqual({
        providerErrorCode: "INTERNAL_ERROR",
        providerErrorMessage: "Free usage limit reached. Free models work in OpenCode.",
      });
      expect(String(failure)).not.toContain("must not cross the provider boundary");
    } finally {
      await registry.dispose();
    }
  });

  it("does not infer an invalid model from OpenCode's generic prompt server error", async () => {
    const fetch = createOpenCodeDiagnosticFetch(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const pathname = new URL(request.url).pathname;
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
      return new Response(
        JSON.stringify({
          name: "UnknownError",
          data: {
            code: "INTERNAL_ERROR",
            message: "Unexpected server error. Check server logs for details.",
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
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

      expect(failure).toBeDefined();
      expect(classifyModelFailure(failure)).toMatchObject({
        statusCode: 500,
        reason: "unknown",
        retryable: false,
      });
      expect(inspectProviderFailure(failure)).toEqual({
        providerErrorCode: "INTERNAL_ERROR",
        providerErrorMessage: "Unexpected server error. Check server logs for details.",
      });
      expect(String(failure)).not.toMatch(/invalid model|model id.*invalid/i);
    } finally {
      await registry.dispose();
    }
  });

  it("keeps a free-usage limit inside the SDK empty-response wrapper terminal after sanitizing", async () => {
    const sdkFailure = createEmptyResponseDataError(
      new Error(
        "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
      ),
      { sessionId: "ses_test", modelId: "opencode/deepseek-v4.1-flash-free" },
    );
    const provider = createFakeOpenCodeProvider({
      model: () =>
        ({
          doStream: async () => ({
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.error(sdkFailure);
              },
            }),
          }),
        }) as unknown as LanguageModelV3,
    });
    const registry = createRegistry(provider);

    try {
      const model = registry.resolve("opencode/deepseek-v4.1-flash-free").model;
      const output = await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        model.doStream!(createCallOptions()),
      );
      let failure: unknown;
      try {
        await output.stream.getReader().read();
      } catch (error) {
        failure = error;
      }

      expect(String(failure)).not.toMatch(/invalid model|model id.*invalid/i);
      expect(String(failure)).toContain("Free usage limit reached");
      expect(classifyModelFailure(failure)).toMatchObject({
        code: "model_rate_limited",
        reason: "rate_limited",
        retryable: false,
      });
    } finally {
      await registry.dispose();
    }
  });

  // Bugfix: SDK 会先按会话过滤 SSE；必须接纳 properties/data 两种错误信封，避免把限额错误等到超时后丢失。
  it.each(["properties", "data"] as const)(
    "fails a streaming chat immediately when OpenCode emits the free-usage session error in %s",
    async (payloadField) => {
    const requests: string[] = [];
    let promptStarted = false;
    const fetch = createOpenCodeDiagnosticFetch(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const pathname = new URL(request.url).pathname;
      requests.push(`${request.method} ${pathname}`);
      if (request.method === "POST" && pathname === "/session") {
        return Response.json({
          id: "ses_quota_event",
          projectID: "global",
          directory: process.cwd(),
          title: "test",
          version: "1.19.3",
          time: { created: 1, updated: 1 },
        });
      }
      if (request.method === "GET" && pathname.endsWith("/event")) {
        const quotaPayload = {
          sessionID: "ses_quota_event",
          error: {
            name: "APIError",
            data: {
              message:
                "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
              isRetryable: false,
            },
          },
        };
        const quotaEvent = {
          type: "session.error",
          [payloadField]: quotaPayload,
        };
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(quotaEvent)}\n\n`),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (request.method === "POST" && pathname === "/session/ses_quota_event/message") {
        promptStarted = true;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (request.signal.aborted) {
            abort();
            return;
          }
          request.signal.addEventListener("abort", abort, { once: true });
        });
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
      const output = await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        model.doStream!(createCallOptions()),
      );
      const reader = output.stream.getReader();
      let failure: unknown;
      const deadline = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("session.error did not fail the stream")), 5_000);
      });
      while (!failure) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        if (part.value.type === "error") failure = part.value.error;
      }

      expect(requests.some((request) => request.startsWith("GET ") && request.endsWith("/event"))).toBe(
        true,
      );
      expect(failure).toBeDefined();
      expect(classifyModelFailure(failure)).toMatchObject({
        code: "model_rate_limited",
        reason: "rate_limited",
        retryable: false,
        message:
          "OpenCode's free-model usage limit is exhausted. Wait for its quota to reset or choose another model.",
      });
    } finally {
      await registry.dispose();
    }
    expect(promptStarted).toBe(true);
    },
  );

  it("sanitizes empty-response errors raised after OpenCode streaming starts", async () => {
    const sdkFailure = createEmptyResponseDataError(
      new Error(
        'OpenCode request diagnostic: {"statusCode":500,"code":"INTERNAL_ERROR","message":"Unexpected server error. Check server logs for details."}',
      ),
      { sessionId: "ses_test", modelId: "opencode/deepseek-v4.1-flash-free" },
    );
    const provider = createFakeOpenCodeProvider({
      model: () =>
        ({
          doStream: async () => ({
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.error(sdkFailure);
              },
            }),
          }),
        }) as unknown as LanguageModelV3,
    });
    const registry = createRegistry(provider);

    try {
      const model = registry.resolve("opencode/deepseek-v4.1-flash-free").model;
      const output = await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        model.doStream!(createCallOptions()),
      );
      let failure: unknown;
      try {
        await output.stream.getReader().read();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toMatch(/invalid model|model id.*invalid/i);
      expect(classifyModelFailure(failure)).toMatchObject({
        statusCode: 500,
        reason: "unknown",
        retryable: false,
      });
      expect(inspectProviderFailure(failure)).toEqual({
        providerErrorCode: "INTERNAL_ERROR",
        providerErrorMessage: "Unexpected server error. Check server logs for details.",
      });
    } finally {
      await registry.dispose();
    }
  });

  it("projects prompt_async HTTP diagnostics through the generated client and SDK empty-response wrapper", async () => {
    let promptPath: string | undefined;
    const fetch = createOpenCodeDiagnosticFetch(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      promptPath = new URL(request.url).pathname;
      return new Response(
        JSON.stringify({
          name: "UnknownError",
          data: {
            code: "INTERNAL_ERROR",
            message: "Unexpected server error. Check server logs for details.",
            debug: "must not cross the provider boundary",
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
    const client = createOpencodeClient({ baseUrl: "http://opencode.test", fetch });
    const result = await client.session.promptAsync({
      sessionID: "ses_test",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(promptPath).toBe("/session/ses_test/prompt_async");
    expect(result.error).toBeDefined();

    // The current provider model adapter calls session.prompt (/message), not promptAsync.
    // Exercise the generated promptAsync client and the provider SDK's same empty-response
    // wrapper separately so this endpoint's declared compatibility path remains covered.
    const failure = createEmptyResponseDataError(result.error, {
      sessionId: "ses_test",
      modelId: "opencode/deepseek-v4.1-flash-free",
    });
    expect(failure.message).toContain("OpenCode request diagnostic:");
    expect(classifyModelFailure(failure)).toMatchObject({
      statusCode: 500,
      reason: "unknown",
      retryable: false,
    });
    expect(inspectProviderFailure(failure)).toEqual({
      providerErrorCode: "INTERNAL_ERROR",
      providerErrorMessage: "Unexpected server error. Check server logs for details.",
    });
    expect(failure.message).not.toContain("must not cross the provider boundary");
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

  it("passes the selected OpenCode thinking variant to the SDK model", async () => {
    const calls: Array<{ modelId: string; variant?: string }> = [];
    const provider = createFakeOpenCodeProvider({
      model: (modelId, settings) => {
        calls.push({ modelId, variant: settings?.variant });
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
      const resolved = registry.resolve("opencode/deepseek-v4.1-flash-free", {
        maxOutputTokens: 32_000,
        reasoningLevel: "high",
      });
      await runWithModelInvocationContext({ workingDirectory: process.cwd() }, () =>
        resolved.model.doGenerate!(createCallOptions()),
      );
      expect(calls.at(-1)).toEqual({
        modelId: "deepseek-v4.1-flash-free",
        variant: "high",
      });
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
  model: (modelId: string, settings?: { directory?: string; variant?: string }) => LanguageModelV3;
  dispose?: () => Promise<void>;
}): OpencodeProvider {
  const create = ((modelId: string, settings?: { directory?: string; variant?: string }) =>
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
