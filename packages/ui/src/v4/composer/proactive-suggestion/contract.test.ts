import { describe, expect, it } from "vitest";

import {
  PROACTIVE_SUGGESTION_MAX_DIFF_CHARS,
  PROACTIVE_SUGGESTION_MAX_TEST_RESULT_CHARS,
  PROACTIVE_SUGGESTION_MAX_TEST_RESULT_TOOL_NAME_CHARS,
  PROACTIVE_SUGGESTION_MAX_TOOL_NAME_CHARS,
  PROACTIVE_SUGGESTION_MAX_TOOL_RESULT_CHARS,
  proactiveSuggestionRequestSchema,
} from "@zcode/shared";

import {
  buildProactiveSuggestionContext,
  buildProactiveSuggestionTransactionDiffs,
  canShowProactiveSuggestion,
  PROACTIVE_SUGGESTION_CONTEXT_LIMITS,
  readProactiveSuggestionRows,
  resolveProactiveSuggestionTurnId,
} from "./contract.js";
import { composerProactiveSuggestionModule } from "./module.js";

describe("ui-composer-proactive-suggestion contract", () => {
  it("declares its module manifest", () => {
    expect(composerProactiveSuggestionModule.id).toBe("ui-composer-proactive-suggestion");
  });

  it("разрешает триггер только для completed + пустого черновика", () => {
    const base = {
      enabled: true,
      hasService: true,
      phase: "completedSuccess",
      draft: "",
      disabled: false,
      sessionId: "s1",
      turnId: "t1",
      decided: false,
    };
    expect(canShowProactiveSuggestion(base)).toBe(true);
    expect(canShowProactiveSuggestion({ ...base, phase: "running" })).toBe(false);
    expect(canShowProactiveSuggestion({ ...base, draft: "x" })).toBe(false);
    expect(canShowProactiveSuggestion({ ...base, decided: true })).toBe(false);
  });

  it("строит контекст, диффы и testResults из строк проекции", () => {
    const rows = [
      { kind: "userInput", turnId: "t1", text: "Добавь тест" },
      {
        kind: "toolCall",
        turnId: "t1",
        toolName: "bash",
        status: "success",
        input: { command: "pnpm vitest run packages/ui" },
        output: { text: "1 passed" },
        fileChanges: [{ path: "packages/ui/a.ts", additions: 3, deletions: 1 }],
      },
      { kind: "assistantText", turnId: "t1", text: "Готово" },
    ];
    expect(resolveProactiveSuggestionTurnId(rows)).toBe("t1");

    const context = buildProactiveSuggestionContext({
      rows,
      openFiles: ["a.ts"],
    });
    expect(context.messages).toEqual([
      { role: "user", text: "Добавь тест" },
      { role: "assistant", text: "Готово" },
    ]);
    expect(context.assistantResult).toBe("Готово");
    expect(context.diffs).toEqual([{ path: "packages/ui/a.ts", summary: "+3 -1" }]);
    expect(context.toolResults).toEqual([]);
    expect(context.testResults).toEqual([
      {
        toolName: "bash pnpm vitest run packages/ui",
        status: "success",
        summary: "1 passed",
      },
    ]);
    expect(context.openFiles).toEqual(["a.ts"]);
  });

  it("читает реальные строки проекции: assistantText и агрегат fileChanges безопасны", () => {
    const rows = readProactiveSuggestionRows({
      rows: {
        window: [
          { kind: "userInput", turnId: "t1", text: "Переименуй" },
          {
            kind: "turnHeader",
            turnId: "t1",
            state: "completedSuccess",
            fileChanges: { additions: 1, deletions: 0, files: 1 },
          },
          {
            kind: "toolCall",
            turnId: "t1",
            toolName: "bash",
            status: "error",
            inputText: "pnpm test",
            input: { command: "pnpm test" },
            error: { code: "x", message: "1 failed" },
          },
          { kind: "assistantText", turnId: "t1", text: "Готово", state: "complete" },
        ],
      },
    });
    const context = buildProactiveSuggestionContext({ rows });
    expect(context.assistantResult).toBe("Готово");
    expect(context.messages).toEqual([
      { role: "user", text: "Переименуй" },
      { role: "assistant", text: "Готово" },
    ]);
    expect(context.diffs).toEqual([]);
    expect(context.testResults).toEqual([
      { toolName: "bash pnpm test", status: "error", summary: "1 failed" },
    ]);
  });

  it("собирает диффы из файловых транзакций и пропускает откат", () => {
    expect(
      buildProactiveSuggestionTransactionDiffs([
        {
          status: "committed",
          files: [{ path: "a.ts", operation: "update", additions: 2, deletions: 1 }],
        },
        {
          status: "rolled_back",
          files: [{ path: "b.ts", operation: "delete", additions: 0, deletions: 4 }],
        },
      ]),
    ).toEqual([{ path: "a.ts", summary: "update +2 -1" }]);
  });

  it("обрезает строковые поля до shared-лимитов, чтобы strict-parse не падал", () => {
    const long = "x".repeat(1_000);
    const rows = [
      {
        kind: "toolCall",
        turnId: "t1",
        toolName: "t".repeat(200),
        status: "success",
        output: { text: long },
        fileChanges: [{ path: "a.ts", summary: long }],
      },
      {
        kind: "toolCall",
        turnId: "t1",
        toolName: "vitest",
        status: "success",
        input: { command: `pnpm vitest run ${long}` },
        output: { text: long },
      },
    ];
    const context = buildProactiveSuggestionContext({
      rows,
      diffs: [{ path: "b.ts", summary: long }],
    });

    const [tool] = context.toolResults;
    expect(tool?.toolName).toHaveLength(PROACTIVE_SUGGESTION_MAX_TOOL_NAME_CHARS);
    expect(tool?.summary).toHaveLength(PROACTIVE_SUGGESTION_MAX_TOOL_RESULT_CHARS);
    const [test] = context.testResults;
    expect(test?.toolName.length).toBeLessThanOrEqual(
      PROACTIVE_SUGGESTION_MAX_TEST_RESULT_TOOL_NAME_CHARS,
    );
    expect(test?.summary).toHaveLength(PROACTIVE_SUGGESTION_MAX_TEST_RESULT_CHARS);
    expect(
      context.diffs.every(
        (diff) => (diff.summary?.length ?? 0) <= PROACTIVE_SUGGESTION_MAX_DIFF_CHARS,
      ),
    ).toBe(true);
    expect(
      buildProactiveSuggestionTransactionDiffs([
        { status: "committed", files: [{ path: "c.ts", operation: long }] },
      ])[0]?.summary,
    ).toHaveLength(PROACTIVE_SUGGESTION_MAX_DIFF_CHARS);

    // Снимок после обрезки обязан проходить strict-схему запроса.
    expect(() =>
      proactiveSuggestionRequestSchema.parse({
        requestId: "request-1",
        sessionId: "s1",
        turnId: "t1",
        draftEmpty: true,
        workspacePath: "/repo",
        context,
      }),
    ).not.toThrow();
  });

  it("применяет лимиты messages/openFiles/diffs/toolResults/testResults", () => {
    expect(PROACTIVE_SUGGESTION_CONTEXT_LIMITS).toEqual({
      messages: 8,
      openFiles: 16,
      diffs: 6,
      toolResults: 8,
      testResults: 4,
    });
    const rows = Array.from({ length: 20 }, (_, index) => ({
      kind: "userInput",
      turnId: "t1",
      text: `message ${index}`,
    }));
    const context = buildProactiveSuggestionContext({
      rows,
      openFiles: Array.from({ length: 30 }, (_, index) => `f${index}.ts`),
      diffs: Array.from({ length: 10 }, (_, index) => ({ path: `d${index}.ts` })),
    });
    expect(context.messages).toHaveLength(8);
    expect(context.openFiles).toHaveLength(16);
    expect(context.diffs).toHaveLength(6);
    expect(context.diffs.at(-1)?.path).toBe("d9.ts");
  });
});
