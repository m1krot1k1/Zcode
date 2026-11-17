import { describe, expect, it, vi } from "vitest";
import { PromptEnhanceError, type PromptEnhanceRequest } from "@zcode/shared";
import {
  createPromptEnhancerService,
  findMissingMentions,
  parseEnhancerResponse,
  pickLowestReasoningLevel,
  type PromptEnhancerTextGenerator,
} from "../../src/prompt-enhancer/index.js";
import { createServiceLogger } from "../../src/logger/serviceLogger.js";

const silentLogger = createServiceLogger("prompt-enhancer-test");

function baseRequest(overrides: Partial<PromptEnhanceRequest> = {}): PromptEnhanceRequest {
  return {
    requestId: "req_test_000001",
    workspacePath: "/repo/zcode",
    target: "chat_user_prompt",
    style: "structured_engineering",
    draftText: "fix the index truncation bug",
    preservedMentions: [],
    activeFilePaths: [],
    ...overrides,
  } as PromptEnhanceRequest;
}

function generatorReturning(...texts: string[]): PromptEnhancerTextGenerator & {
  calls: Array<Parameters<PromptEnhancerTextGenerator["generateText"]>[0]>;
} {
  const queue = [...texts];
  const calls: Array<Parameters<PromptEnhancerTextGenerator["generateText"]>[0]> = [];
  return {
    calls,
    async generateText(params) {
      calls.push(params);
      const next = queue.shift();
      if (next === undefined) throw new Error("generator exhausted");
      return {
        text: next,
        selection: { providerId: params.selection.providerId, modelId: params.selection.modelId },
      };
    },
  };
}

function jsonResponse(payload: {
  enhancedText: string;
  addedClarifications?: string[];
  assumptions?: Array<{ text: string; origin: string }>;
}): string {
  return JSON.stringify(payload);
}

describe("PromptEnhancerService.enhance", () => {
  it("returns a structured result with provenance and token delta", async () => {
    const generator = generatorReturning(
      jsonResponse({
        enhancedText:
          "Fix the index truncation bug in the code index store. Acceptance: existing index tests pass.",
        addedClarifications: ["Acceptance criteria: existing index tests pass"],
        assumptions: [{ text: "The bug is in the code index store", origin: "draft" }],
      }),
    );
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
      estimateTokens: (text) => ({ tokens: Math.ceil(text.length / 4), method: "char-ratio" }),
    });

    const result = await service.enhance(baseRequest());
    expect(result.enhancedText).toContain("Acceptance");
    expect(result.style).toBe("structured_engineering");
    expect(result.addedClarifications).toHaveLength(1);
    expect(result.assumptions[0]?.origin).toBe("draft");
    expect(result.tokenDelta.after).toBeGreaterThan(result.tokenDelta.before);
    expect(result.modelUsed).toEqual({ providerId: "o", modelId: "m" });
    expect(generator.calls[0]?.querySource).toBe("prompt_enhance");
    expect(generator.calls[0]?.messages[0]?.content).toContain("Non-negotiable rules");
  });

  it("fails with unsupported_changes when protected mentions are dropped twice", async () => {
    const mention = {
      kind: "file" as const,
      value: "packages/ui/src/hooks/useCommands.ts",
      displayText: "@useCommands.ts",
    };
    const generator = generatorReturning(
      jsonResponse({ enhancedText: "Rewrite the commands hook." }),
      jsonResponse({ enhancedText: "Rewrite the commands hook, carefully." }),
    );
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
    });

    await expect(
      service.enhance(baseRequest({ preservedMentions: [mention] })),
    ).rejects.toMatchObject({ code: "unsupported_changes" });
    expect(generator.calls).toHaveLength(2);
    // Второй вызов обязан содержать диагностику утерянных маркеров.
    expect(generator.calls[1]?.messages.at(-1)?.content).toContain("@useCommands.ts");
  });

  it("accepts the repair pass when the model restores the mention", async () => {
    const mention = {
      kind: "file" as const,
      value: "a.ts",
      displayText: "@a.ts",
    };
    const generator = generatorReturning(
      jsonResponse({ enhancedText: "Change the file." }),
      jsonResponse({ enhancedText: "Change @a.ts in place, then run its tests." }),
    );
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
    });

    const result = await service.enhance(baseRequest({ preservedMentions: [mention] }));
    expect(result.enhancedText).toContain("@a.ts");
    expect(generator.calls).toHaveLength(2);
  });

  it("falls back to plain text when the model ignores the JSON contract", async () => {
    const generator = generatorReturning("Goal: fix the bug. Acceptance: tests pass.");
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
    });

    const result = await service.enhance(baseRequest());
    expect(result.enhancedText).toBe("Goal: fix the bug. Acceptance: tests pass.");
    expect(result.addedClarifications).toEqual([]);
  });

  it("rejects an invalid request before touching the model", async () => {
    const generator = generatorReturning("never");
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
    });

    await expect(
      service.enhance(baseRequest({ draftText: "x" })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(generator.calls).toHaveLength(0);
  });

  it("reports model_unavailable when no selection can be resolved", async () => {
    const generator = generatorReturning("never");
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => null },
      logger: silentLogger,
    });

    await expect(service.enhance(baseRequest())).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(generator.calls).toHaveLength(0);
  });

  it("cancels an in-flight request and reports aborted", async () => {
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const generator: PromptEnhancerTextGenerator = {
      async generateText(params) {
        startedResolve?.();
        return await new Promise((_, reject) => {
          params.signal.addEventListener(
            "abort",
            () => reject(new PromptEnhanceError("aborted", "c")),
            { once: true },
          );
        });
      },
    };
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
    });

    const pending = service.enhance(baseRequest({ requestId: "req_cancel_0001" }));
    await started;
    await service.cancel({ requestId: "req_cancel_0001" });
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("times out and reports timeout instead of hanging", async () => {
    const generator: PromptEnhancerTextGenerator = {
      async generateText(params) {
        return await new Promise((_, reject) => {
          params.signal.addEventListener(
            "abort",
            () => reject(new PromptEnhanceError("aborted", "timeout")),
            { once: true },
          );
        });
      },
    };
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
      requestTimeoutMs: 10,
    });

    await expect(service.enhance(baseRequest())).rejects.toBeInstanceOf(PromptEnhanceError);
  }, 5_000);

  it("rejects a duplicate requestId while the first one is running", async () => {
    const generator: PromptEnhancerTextGenerator = {
      async generateText(params) {
        return await new Promise((_, reject) => {
          params.signal.addEventListener(
            "abort",
            () => reject(new PromptEnhanceError("aborted", "c")),
            { once: true },
          );
        });
      },
    };
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
    });

    const request = baseRequest({ requestId: "req_dupe_000001" });
    const first = service.enhance(request);
    await expect(service.enhance(request)).rejects.toMatchObject({ code: "invalid_request" });
    await service.cancel({ requestId: "req_dupe_000001" });
    await expect(first).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("PromptEnhancerService context collection", () => {
  it("includes repository context when ports are available", async () => {
    const generator = generatorReturning(jsonResponse({ enhancedText: "Do the thing." }));
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
      contextPorts: {
        codeSearch: {
          async search() {
            return {
              results: [{ path: "packages/services/src/index.ts", startLine: 12, score: 0.9 }],
            };
          },
        },
        git: {
          async getChanges() {
            return [{ path: "packages/ui/src/hooks/useCommands.ts" }];
          },
        },
        files: {
          async readTextFile() {
            return { content: "# Rules\n- index truncation must not drop rows\n" };
          },
        },
      },
    });

    const result = await service.enhance(baseRequest());
    expect(result.usedContext.map((source) => source.kind)).toEqual([
      "code_index",
      "git_diff",
      "agents_md",
    ]);
    const userMessage = generator.calls[0]?.messages[1]?.content ?? "";
    expect(userMessage).toContain("<code_index>");
    expect(userMessage).toContain("<uncommitted_changes>");
    expect(userMessage).toContain("<project_rules>");
    expect(userMessage).toContain("index truncation must not drop rows");
  });

  it("still enhances when every context source fails", async () => {
    const generator = generatorReturning(jsonResponse({ enhancedText: "Do the thing." }));
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
      contextPorts: {
        codeSearch: {
          async search() {
            throw new Error("index down");
          },
        },
        git: {
          async getChanges() {
            throw new Error("not a repo");
          },
        },
        files: {
          async readTextFile() {
            throw new Error("permission denied");
          },
        },
      },
    });

    const result = await service.enhance(baseRequest());
    expect(result.enhancedText).toBe("Do the thing.");
    expect(result.usedContext).toEqual([]);
  });

  it("does not log draft or enhanced text at info level", async () => {
    const infoSpy = vi.fn();
    const debugSpy = vi.fn();
    const generator = generatorReturning(
      jsonResponse({ enhancedText: "SECRET_ENHANCED_TEXT_MARKER" }),
    );
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: { ...silentLogger, info: infoSpy, debug: debugSpy } as unknown as typeof silentLogger,
    });

    await service.enhance(baseRequest({ draftText: "SECRET_DRAFT_MARKER please fix" }));
    const infoPayloads = JSON.stringify(infoSpy.mock.calls);
    const debugPayloads = JSON.stringify(debugSpy.mock.calls);
    expect(infoPayloads).not.toContain("SECRET_DRAFT_MARKER");
    expect(infoPayloads).not.toContain("SECRET_ENHANCED_TEXT_MARKER");
    expect(debugPayloads).not.toContain("SECRET_DRAFT_MARKER");
    expect(debugPayloads).not.toContain("SECRET_ENHANCED_TEXT_MARKER");
  });
});

describe("PromptEnhancerService stream deltas", () => {
  it("emits the final text and supports unsubscribing", async () => {
    const generator = generatorReturning(
      jsonResponse({ enhancedText: "Final prompt." }),
      jsonResponse({ enhancedText: "Second prompt." }),
    );
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "o", modelId: "m" }) },
      logger: silentLogger,
    });
    const seen: string[] = [];
    const unsubscribe = service.onStreamDelta((event) => seen.push(event.accumulated));
    await service.enhance(baseRequest());
    unsubscribe();
    await service.enhance(baseRequest({ requestId: "req_test_000002" }));

    expect(seen).toEqual(["Final prompt."]);
  });
});

describe("parseEnhancerResponse and findMissingMentions", () => {
  it("strips reasoning blocks and markdown fences", () => {
    const parsed = parseEnhancerResponse(
      '<think>hidden</think>\n```json\n{"enhancedText":"Prompt body."}\n```',
    );
    expect(parsed.enhancedText).toBe("Prompt body.");
  });

  it("rejects an empty object", () => {
    expect(() => parseEnhancerResponse('{"enhancedText":"   "}')).toThrow(PromptEnhanceError);
  });

  it("detects every missing mention", () => {
    const missing = findMissingMentions("only @a.ts here", {
      ...baseRequest(),
      preservedMentions: [
        { kind: "file", value: "a.ts", displayText: "@a.ts" },
        { kind: "file", value: "b.ts", displayText: "@b.ts" },
      ],
    });
    expect(missing).toEqual(["@b.ts"]);
  });
});

describe("PromptEnhancer reasoning level regression", () => {
  it("не подставляет неподдерживаемый minimal, если модель знает только disabled", async () => {
    // Регрессия Этапа 6.1b: opencode-go-messages/minimax-m3 принимает только `disabled`,
    // а сервис раньше всегда отправлял `minimal` и падал с
    // "Reasoning level is required for opencode-go-messages/minimax-m3".
    const generator = generatorReturning("<prompt>улучшенный текст</prompt>");
    const service = createPromptEnhancerService({
      textGenerator: generator,
      modelResolver: {
        async resolveDefaultSelection() {
          return {
            providerId: "opencode-go-messages",
            modelId: "minimax-m3",
            reasoningLevels: ["disabled"],
          };
        },
      },
      logger: silentLogger,
      now: () => 0,
    });

    await service.enhance(baseRequest());

    expect(generator.calls[0]?.selection.options?.reasoningLevel).toBe("disabled");
  });

  it("pickLowestReasoningLevel берёт первый уровень и не додумывает значения", () => {
    expect(pickLowestReasoningLevel(["disabled", "low", "high"])).toBe("disabled");
    expect(pickLowestReasoningLevel(["minimal"])).toBe("minimal");
    expect(pickLowestReasoningLevel([])).toBeUndefined();
    expect(pickLowestReasoningLevel(undefined)).toBeUndefined();
  });
});
