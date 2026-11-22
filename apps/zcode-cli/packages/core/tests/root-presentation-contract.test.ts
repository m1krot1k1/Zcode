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
  it("asks root for a concise answer while retaining supporting evidence", () => {
    const text = formatAgentOutputForModel(
      completedOutput({
        workResult: {
          status: "partial",
          summary: "Основное готово",
          files: [],
          evidence: [],
          tests: [],
          unresolved: ["active_limit: no worker slot is currently available"],
          claims: [],
        },
        presentation: PRESENTATION,
      }),
    );

    expect(text).toContain("<zcode-start-report>");
    expect(text).toContain("Answer the user's actual request directly in natural, concise language, normally in 1–3 sentences.");
    expect(text).toContain("If status is partial, failed or blocked, say so plainly.");
    expect(text).toContain("Do not copy the internal lists, paths, line numbers, commands or child session IDs into an ordinary reply.");
    expect(text).toContain("Include those details only when the user asks for evidence, sources or a detailed audit.");
    expect(text).not.toContain("Relay userText");
    expect(text).toContain(PRESENTATION.userText);
    for (const fact of PRESENTATION.facts) expect(text).toContain(`- ${fact}`);
    for (const unknown of PRESENTATION.unknowns) expect(text).toContain(`- ${unknown}`);
    for (const ref of PRESENTATION.evidenceRefs) expect(text).toContain(`- ${ref}`);
    expect(text).toContain("status: partial");
    expect(text).toContain(
      "unresolved:\n- active_limit: no worker slot is currently available",
    );
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
          unresolved: ["active_limit: no worker slot is currently available"],
          claims: [],
        },
      }),
    );

    expect(text).toContain(RAW_CHILD_TEXT);
    expect(text).toContain("agentId: agent_start_1");
    expect(text).toContain("<usage>");
    expect(text).toContain("work_result: partial");
    expect(text).toContain(
      "work_result_unresolved: active_limit: no worker slot is currently available",
    );
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
