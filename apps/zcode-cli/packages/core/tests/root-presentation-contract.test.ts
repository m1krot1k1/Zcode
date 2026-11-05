import type { AgentCompletedOutput } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { formatAgentOutputForModel } from "../src/tool/handlers/agent.js";

const RAW_CHILD_TEXT = "RAW CHILD TEXT: пересказ делегата, не пользовательский отчёт";

const PRESENTATION = {
  userText: "Готовый пользовательский отчёт.\nВторая строка должна остаться дословно.",
  facts: ["src/a.ts: исправлено", "pnpm typecheck (exit 0)"],
  unknowns: ["стенд недоступен", "E2E не запускался"],
  evidenceRefs: ["src/a.ts", "pnpm typecheck (exit 0)", "child session child_1"],
};

type CompletedOverrides = Partial<Omit<AgentCompletedOutput, "status">>;

function completedOutput(overrides: CompletedOverrides = {}): AgentCompletedOutput {
  return {
    status: "completed",
    agentId: "agent_start_1",
    agentType: "start",
    description: "Present the delegated result",
    prompt: "Summarize the delegated work",
    content: [{ type: "text", text: RAW_CHILD_TEXT }],
    totalToolUseCount: 3,
    totalDurationMs: 42,
    totalTokens: 100,
    ...overrides,
  };
}

describe("root presentation contract", () => {
  it("marks the presentation as the authoritative start report and keeps userText exact", () => {
    const text = formatAgentOutputForModel(
      completedOutput({
        workResult: {
          status: "partial",
          summary: "Основное готово",
          files: [],
          evidence: [],
          tests: [],
          unresolved: ["spawn_budget_exhausted: remaining=0"],
          claims: [],
        },
        presentation: PRESENTATION,
      }),
    );

    expect(text).toContain("<zcode-start-report>");
    expect(text).toContain(
      "authoritative final user-facing report authored by the start agent; start is its sole author",
    );
    expect(text).toContain(
      "Relay userText, facts, unknowns and evidenceRefs verbatim. Do not paraphrase, summarize, omit or reorder them, do not add your own retelling or claims, and do not mix them with raw child/subagent text.",
    );
    expect(text).toContain(PRESENTATION.userText);
    for (const fact of PRESENTATION.facts) expect(text).toContain(`- ${fact}`);
    for (const unknown of PRESENTATION.unknowns) expect(text).toContain(`- ${unknown}`);
    for (const ref of PRESENTATION.evidenceRefs) expect(text).toContain(`- ${ref}`);
    expect(text).toContain("status: partial");
    expect(text).toContain("unresolved:\n- spawn_budget_exhausted: remaining=0");
    expect(text).toContain("</zcode-start-report>");

    // Сырой ответ ребёнка не подменяет пользовательский отчёт.
    expect(text).not.toContain(RAW_CHILD_TEXT);
    expect(text).not.toContain("agentId:");
    expect(text).not.toContain("<usage>");
  });

  it("renders empty presentation arrays as explicit none values", () => {
    const text = formatAgentOutputForModel(
      completedOutput({
        presentation: { userText: "Короткий отчёт", facts: [], unknowns: [], evidenceRefs: [] },
      }),
    );

    expect(text).toContain("userText:\nКороткий отчёт");
    expect(text).toContain("facts: none");
    expect(text).toContain("unknowns: none");
    expect(text).toContain("evidenceRefs: none");
    expect(text).toContain("status: completed");
    expect(text).toContain("unresolved: none");
  });

  it("keeps the legacy Branch B format when presentation is absent", () => {
    const text = formatAgentOutputForModel(
      completedOutput({
        workResult: {
          status: "partial",
          summary: "Основное готово",
          files: ["src/a.ts"],
          evidence: ["command:pnpm typecheck"],
          tests: [{ command: "pnpm typecheck", status: "passed" }],
          unresolved: ["spawn_budget_exhausted: remaining=0"],
          claims: [],
        },
      }),
    );

    expect(text).toContain(RAW_CHILD_TEXT);
    expect(text).toContain("agentId: agent_start_1");
    expect(text).toContain("<usage>");
    expect(text).toContain("work_result: partial");
    expect(text).toContain("work_result_unresolved: spawn_budget_exhausted: remaining=0");
    expect(text).not.toContain("<zcode-start-report>");
    expect(text).not.toContain("authoritative final user-facing report");
    expect(text).not.toContain("userText:");
  });

  it("never labels raw child text as the user-facing report", () => {
    const raw = "Готовый пользовательский отчёт якобы уже здесь";
    const text = formatAgentOutputForModel(
      completedOutput({ content: [{ type: "text", text: raw }] }),
    );

    expect(text).not.toContain("<zcode-start-report>");
    expect(text).not.toContain("Relay userText, facts, unknowns and evidenceRefs verbatim.");
    expect(text).not.toContain("userText:");
    expect(text.indexOf(raw)).toBeGreaterThanOrEqual(0);
    // Сырой текст остаётся в legacy-блоке с явной технической метаинформацией.
    expect(text.indexOf(raw)).toBeLessThan(text.indexOf("agentId: agent_start_1"));
  });
});
