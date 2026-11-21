import { describe, expect, it } from "vitest";
import {
  PROMPT_ENHANCE_MAX_DRAFT_CHARS,
  PROMPT_ENHANCE_MAX_MENTIONS,
  describePromptEnhanceError,
  promptEnhanceRequestSchema,
  promptEnhanceResultSchema,
} from "./contract.js";
import { parseEnhancedPromptResponse } from "./pipeline.js";

const baseRequest = {
  requestId: "req_enhance_0001",
  workspacePath: "/repo/zcode",
  target: "chat_user_prompt",
  draftText: "fix the index truncation bug",
} as const;

describe("prompt-enhancer request contract", () => {
  it("defaults style and empty collections without rejecting a minimal request", () => {
    const parsed = promptEnhanceRequestSchema.parse(baseRequest);
    expect(parsed.style).toBe("structured_engineering");
    expect(parsed.preservedMentions).toEqual([]);
    expect(parsed.activeFilePaths).toEqual([]);
  });

  it("rejects unknown fields so transports cannot smuggle extra payload", () => {
    const result = promptEnhanceRequestSchema.safeParse({
      ...baseRequest,
      extra: "unexpected",
    });
    expect(result.success).toBe(false);
  });

  it("enforces the draft and mention limits", () => {
    expect(
      promptEnhanceRequestSchema.safeParse({
        ...baseRequest,
        draftText: "x".repeat(PROMPT_ENHANCE_MAX_DRAFT_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      promptEnhanceRequestSchema.safeParse({
        ...baseRequest,
        preservedMentions: Array.from({ length: PROMPT_ENHANCE_MAX_MENTIONS + 1 }, (_, index) => ({
          kind: "file" as const,
          value: `file-${index}.ts`,
          displayText: `@file-${index}.ts`,
        })),
      }).success,
    ).toBe(false);
  });

  it("requires the enhancer to keep mentions as structured markers, not free text", () => {
    expect(
      promptEnhanceRequestSchema.safeParse({
        ...baseRequest,
        preservedMentions: [{ kind: "file", value: "a.ts" }],
      }).success,
    ).toBe(false);
  });
});

describe("prompt-enhancer result contract", () => {
  const result = {
    requestId: "req_enhance_0001",
    enhancedText: "Fix the index truncation bug in the code index store.",
    style: "structured_engineering",
    modelUsed: { providerId: "openai", modelId: "gpt-5-mini" },
    tokenDelta: { before: 8, after: 62, method: "char-ratio" },
    elapsedMs: 1200,
  } as const;

  it("accepts a minimal result and defaults provenance arrays", () => {
    const parsed = promptEnhanceResultSchema.parse(result);
    expect(parsed.addedClarifications).toEqual([]);
    expect(parsed.assumptions).toEqual([]);
    expect(parsed.usedContext).toEqual([]);
    expect(parsed.framework).toBe("oracle");
    expect(parsed.domain).toBe("general");
    expect(parsed.taskKind).toBe("general");
    expect(parsed.capabilitySuggestions).toEqual([]);
  });

  it("parses capability suggestions and drops malformed entries", () => {
    const parsed = parseEnhancedPromptResponse(
      JSON.stringify({
        enhancedText: "Do the task",
        capabilitySuggestions: [
          { kind: "skill", name: "yandex-direct", reason: "Matches the advertising task" },
          { kind: "unknown", name: "x", reason: "bad kind" },
          { kind: "mcp", name: "", reason: "missing name" },
          { kind: "agent", name: "coder", reason: "Implementation" },
        ],
      }),
    );
    expect(parsed.capabilitySuggestions).toEqual([
      { kind: "skill", name: "yandex-direct", reason: "Matches the advertising task" },
      { kind: "agent", name: "coder", reason: "Implementation" },
    ]);
  });

  it("allows a shrinking rewrite but rejects negative token counts and an empty prompt", () => {
    // `concise_direct` может сократить черновик, поэтому after < before — валидный результат.
    expect(
      promptEnhanceResultSchema.safeParse({
        ...result,
        tokenDelta: { before: 10, after: 5, method: "char-ratio" },
      }).success,
    ).toBe(true);
    expect(
      promptEnhanceResultSchema.safeParse({
        ...result,
        tokenDelta: { before: 10, after: -1, method: "char-ratio" },
      }).success,
    ).toBe(false);
    expect(promptEnhanceResultSchema.safeParse({ ...result, enhancedText: "" }).success).toBe(
      false,
    );
  });
});

describe("prompt-enhancer errors", () => {
  it("describes every code without echoing the user draft", () => {
    expect(describePromptEnhanceError("aborted")).toContain("cancelled");
    expect(describePromptEnhanceError("unsupported_changes")).toContain("protected mentions");
    expect(describePromptEnhanceError("timeout")).toContain("timed out");
  });
});
