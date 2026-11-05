import {
  createSessionId,
  createTurnId,
  type AgentCompletedOutput,
  type SubagentRunRequest,
  type WorkResult,
} from "@zcode/contracts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getSwarmAgentProfiles,
  normalizeAgentProfiles,
  SWARM_AGENT_TYPES,
} from "../src/subagent/profile.js";
import { createExploreSubagentPort, parsePresentationBlock } from "../src/subagent/runner.js";
import { formatAgentOutputForModel } from "../src/tool/handlers/agent.js";

const VALID_PRESENTATION = {
  userText: "Готовый пользовательский ответ",
  facts: ["src/a.ts: исправлено"],
  unknowns: ["стенд недоступен"],
  evidenceRefs: ["pnpm typecheck (exit 0)"],
};

function presentationBlock(payload: unknown = VALID_PRESENTATION): string {
  return `<zcode-presentation>${JSON.stringify(payload)}</zcode-presentation>`;
}

function completedOutput(overrides: Partial<AgentCompletedOutput> = {}): AgentCompletedOutput {
  return {
    status: "completed",
    agentId: "agent_start_1",
    agentType: "start",
    description: "Route the request",
    prompt: "Route it",
    content: [{ type: "text", text: `RAW CHILD TEXT\n${presentationBlock()}` }],
    totalToolUseCount: 1,
    totalDurationMs: 5,
    ...overrides,
  };
}

function workResult(overrides: Partial<WorkResult> = {}): WorkResult {
  return {
    status: "partial",
    summary: "Основное готово",
    files: [],
    evidence: [],
    tests: [],
    unresolved: ["spawn_budget_exhausted: remaining=0"],
    claims: [],
    ...overrides,
  };
}

async function runStartAgent(
  response: string,
  options: {
    agentType?: string;
    internalSwarmNodeID?: string;
  } = {},
): Promise<AgentCompletedOutput> {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-presentation-"));
  const sessionId = createSessionId("presentation-session");
  const turnId = createTurnId("presentation-turn");
  const port = createExploreSubagentPort({
    createAgentId: () => "agent_presentation",
    outputRootDir,
    async emitParentEvent() {},
    async runExploreAgent(request) {
      await request.onSessionReady?.();
      return {
        events: [],
        response,
        traceId: request.traceContext.traceId,
      };
    },
  });
  const request: SubagentRunRequest = {
    agentType: options.agentType ?? "start",
    description: "Present the result",
    parentToolCallId: "call_presentation",
    prompt: "Summarize the delegated work",
    sessionId,
    trace: {
      traceId: "trace-presentation",
      spanId: "span-presentation",
      sessionId,
      turnId,
    },
    turnId,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
  };
  const runOptions =
    options.internalSwarmNodeID === undefined
      ? {}
      : { internalSwarmNodeID: options.internalSwarmNodeID };
  const output = await port.run(request, runOptions);
  expect(output.status).toBe("completed");
  if (output.status !== "completed") throw new Error("expected a completed agent output");
  return output;
}

describe("presentation parsing", () => {
  it("parses a valid strict envelope and keeps the last block", () => {
    expect(parsePresentationBlock(`Итог.\n${presentationBlock()}`)).toEqual(VALID_PRESENTATION);
    expect(
      parsePresentationBlock(`${presentationBlock({ ...VALID_PRESENTATION, userText: "first" })}\n${presentationBlock()}`),
    ).toEqual(VALID_PRESENTATION);
  });

  it("rejects invalid JSON, missing fields, wrong types and extra fields", () => {
    expect(parsePresentationBlock("<zcode-presentation>{not json}</zcode-presentation>")).toBeUndefined();
    expect(
      parsePresentationBlock(
        presentationBlock({ userText: "only text", facts: [], unknowns: [] }),
      ),
    ).toBeUndefined();
    expect(
      parsePresentationBlock(
        presentationBlock({ ...VALID_PRESENTATION, facts: "not-an-array" }),
      ),
    ).toBeUndefined();
    expect(
      parsePresentationBlock(
        presentationBlock({ ...VALID_PRESENTATION, extra: true }),
      ),
    ).toBeUndefined();
    expect(parsePresentationBlock("no block at all")).toBeUndefined();
  });
});

describe("presentation ownership", () => {
  it("attaches a presentation parsed from a start agent response", async () => {
    const output = await runStartAgent(`Промежуточный текст\n${presentationBlock()}`);

    expect(output.presentation).toEqual(VALID_PRESENTATION);
    expect(output.agentType).toBe("start");
  });

  it("keeps backward compatibility when start omits or invalidates the block", async () => {
    const withoutBlock = await runStartAgent("Обычный ответ без конверта");
    expect(withoutBlock.presentation).toBeUndefined();

    const invalid = await runStartAgent("<zcode-presentation>{broken}</zcode-presentation>");
    expect(invalid.presentation).toBeUndefined();
  });

  it("does not parse presentation for worker roles", async () => {
    const output = await runStartAgent(presentationBlock(), { agentType: "implementer" });
    expect(output.presentation).toBeUndefined();
  });

  it("does not parse presentation for DAG nodes even when the role is start", async () => {
    const output = await runStartAgent(presentationBlock(), { internalSwarmNodeID: "node-1" });
    expect(output.presentation).toBeUndefined();
  });

  it("adds the presentation instruction only to the start profile prompt", () => {
    const profiles = getSwarmAgentProfiles(normalizeAgentProfiles([]));
    const promptOf = (name: string) =>
      profiles.find((profile) => profile.name === name)?.systemPrompt ?? "";

    expect(promptOf("start")).toContain("<zcode-presentation>");
    expect(promptOf("start")).toContain('"userText"');
    for (const role of SWARM_AGENT_TYPES.filter((name) => name !== "start")) {
      expect(promptOf(role), role).not.toContain("<zcode-presentation>");
    }
  });
});

describe("presentation formatter", () => {
  it("passes through exactly userText, status, facts, unknowns, evidenceRefs and unresolved", () => {
    const text = formatAgentOutputForModel(
      completedOutput({
        workResult: workResult(),
        presentation: VALID_PRESENTATION,
      }),
    );

    expect(text).toBe(
      [
        "Готовый пользовательский ответ",
        "status: partial",
        "facts: src/a.ts: исправлено",
        "unknowns: стенд недоступен",
        "evidence_refs: pnpm typecheck (exit 0)",
        "unresolved: spawn_budget_exhausted: remaining=0",
      ].join("\n"),
    );
    expect(text).not.toContain("RAW CHILD TEXT");
    expect(text).not.toContain("agentId:");
    expect(text).not.toContain("<usage>");
  });

  it("defaults the visible status to completed when WorkResult is absent", () => {
    const text = formatAgentOutputForModel(
      completedOutput({ presentation: VALID_PRESENTATION }),
    );

    expect(text).toContain("status: completed");
    expect(text).toContain("unresolved: none");
  });

  it("keeps partial, failed and blocked statuses visible", () => {
    for (const status of ["partial", "failed", "blocked"] as const) {
      const text = formatAgentOutputForModel(
        completedOutput({
          workResult: workResult({ status, unresolved: ["repair: node failed"] }),
          presentation: VALID_PRESENTATION,
        }),
      );
      expect(text).toContain(`status: ${status}`);
      expect(text).toContain("unresolved: repair: node failed");
    }
  });

  it("keeps the Branch B format when presentation is absent", () => {
    const text = formatAgentOutputForModel(
      completedOutput({
        content: [{ type: "text", text: "RAW CHILD TEXT" }],
        workResult: workResult(),
      }),
    );

    expect(text).toContain("RAW CHILD TEXT");
    expect(text).toContain("agentId: agent_start_1");
    expect(text).toContain("<usage>");
    expect(text).toContain("work_result: partial");
    expect(text).toContain("work_result_unresolved: spawn_budget_exhausted: remaining=0");
  });
});
