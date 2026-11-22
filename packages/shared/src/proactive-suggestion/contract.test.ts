import { describe, expect, it } from "vitest";

import {
  PROACTIVE_SUGGESTION_MAX_DIFFS,
  PROACTIVE_SUGGESTION_MAX_MESSAGES,
  PROACTIVE_SUGGESTION_MAX_OPEN_FILES,
  PROACTIVE_SUGGESTION_MAX_TEST_RESULTS,
  PROACTIVE_SUGGESTION_MAX_TOOL_RESULTS,
  proactiveSuggestionRequestSchema,
  proactiveSuggestionResponseSchema,
} from "./contract.js";
import { sharedProactiveSuggestionModule } from "./module.js";

describe("shared-proactive-suggestion contract", () => {
  it("declares its module manifest", () => {
    expect(sharedProactiveSuggestionModule.id).toBe("shared-proactive-suggestion");
  });

  it("rejects a non-empty draft and oversized context", () => {
    expect(() =>
      proactiveSuggestionRequestSchema.parse({
        requestId: "request-1",
        sessionId: "s1",
        turnId: "t1",
        draftEmpty: false,
        workspacePath: "/repo",
      }),
    ).toThrow();
    expect(() =>
      proactiveSuggestionRequestSchema.parse({
        requestId: "request-1",
        sessionId: "s1",
        turnId: "t1",
        draftEmpty: true,
        workspacePath: "/repo",
        context: {
          messages: Array.from({ length: PROACTIVE_SUGGESTION_MAX_MESSAGES + 1 }, () => ({
            role: "user" as const,
            text: "x",
          })),
        },
      }),
    ).toThrow();
  });

  it("держит те же лимиты контекста, что UI-контроллер композера", () => {
    // Совпадение с PROACTIVE_SUGGESTION_CONTEXT_LIMITS в UI; расхождение даёт
    // invalid_request на реальном снимке контекста.
    expect(PROACTIVE_SUGGESTION_MAX_MESSAGES).toBe(8);
    expect(PROACTIVE_SUGGESTION_MAX_OPEN_FILES).toBe(16);
    expect(PROACTIVE_SUGGESTION_MAX_DIFFS).toBe(6);
    expect(PROACTIVE_SUGGESTION_MAX_TOOL_RESULTS).toBe(8);
    expect(PROACTIVE_SUGGESTION_MAX_TEST_RESULTS).toBe(4);
  });

  it("принимает верхнюю границу контекста вместе с testResults", () => {
    const parsed = proactiveSuggestionRequestSchema.parse({
      requestId: "request-1",
      sessionId: "s1",
      turnId: "t1",
      draftEmpty: true,
      workspacePath: "/repo",
      context: {
        messages: Array.from({ length: PROACTIVE_SUGGESTION_MAX_MESSAGES }, () => ({
          role: "user" as const,
          text: "x",
        })),
        toolResults: Array.from({ length: PROACTIVE_SUGGESTION_MAX_TOOL_RESULTS }, () => ({
          toolName: "bash",
          summary: "ok",
        })),
        testResults: Array.from({ length: PROACTIVE_SUGGESTION_MAX_TEST_RESULTS }, () => ({
          toolName: "bash pnpm vitest run",
          status: "success",
          summary: "12 passed",
        })),
        diffs: Array.from({ length: PROACTIVE_SUGGESTION_MAX_DIFFS }, (_, index) => ({
          path: `file-${index}.ts`,
        })),
        openFiles: Array.from(
          { length: PROACTIVE_SUGGESTION_MAX_OPEN_FILES },
          (_, index) => `open-${index}.ts`,
        ),
      },
    });
    expect(parsed.context.testResults).toHaveLength(PROACTIVE_SUGGESTION_MAX_TEST_RESULTS);
    expect(parsed.context.openFiles).toHaveLength(PROACTIVE_SUGGESTION_MAX_OPEN_FILES);
  });

  it("отклоняет контекст выше лимитов diffs/openFiles/testResults", () => {
    const base = {
      requestId: "request-1",
      sessionId: "s1",
      turnId: "t1",
      draftEmpty: true as const,
      workspacePath: "/repo",
    };
    expect(() =>
      proactiveSuggestionRequestSchema.parse({
        ...base,
        context: {
          testResults: Array.from({ length: PROACTIVE_SUGGESTION_MAX_TEST_RESULTS + 1 }, () => ({
            toolName: "vitest",
            status: "success",
            summary: "ok",
          })),
        },
      }),
    ).toThrow();
    expect(() =>
      proactiveSuggestionRequestSchema.parse({
        ...base,
        context: {
          diffs: Array.from({ length: PROACTIVE_SUGGESTION_MAX_DIFFS + 1 }, (_, index) => ({
            path: `file-${index}.ts`,
          })),
        },
      }),
    ).toThrow();
    expect(() =>
      proactiveSuggestionRequestSchema.parse({
        ...base,
        context: {
          openFiles: Array.from(
            { length: PROACTIVE_SUGGESTION_MAX_OPEN_FILES + 1 },
            (_, index) => `file-${index}.ts`,
          ),
        },
      }),
    ).toThrow();
  });

  it("accepts a null suggestion with a skip reason", () => {
    const parsed = proactiveSuggestionResponseSchema.parse({
      requestId: "request-1",
      suggestion: null,
      reason: "assistant_voice",
      latencyMs: 12,
    });
    expect(parsed.suggestion).toBeNull();
    expect(parsed.reason).toBe("assistant_voice");
  });
});
