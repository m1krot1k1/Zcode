import {
  AgentCompletedOutputSchema,
  SessionEventType,
  WorkResultSchema,
  createSessionId,
  createTraceId,
  createTurnId,
  type AgentCompletedOutput,
  type SessionEvent,
  type SubagentTaskDagRequest,
  type WorkResult,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { WorkLedger } from "../src/runtime-task/work-ledger.js";
import {
  aggregateWorkResults,
  boundWorkResult,
  collectWorkResultClaims,
  createExploreSubagentPort,
  deriveWorkResult,
  deriveWorkResultFromOutput,
  executeSubagentTaskDag,
  parseWorkResultBlock,
} from "../src/subagent/runner.js";

function completedOutput(
  agentId: string,
  text: string,
  workResult?: WorkResult,
): AgentCompletedOutput {
  return {
    status: "completed",
    agentId,
    agentType: "general-purpose",
    description: `Task ${agentId}`,
    prompt: `Perform task ${agentId}`,
    content: [{ type: "text", text }],
    totalToolUseCount: 2,
    totalDurationMs: 10,
    totalTokens: 5,
    ...(workResult ? { workResult } : {}),
  };
}

function workResult(overrides: Partial<WorkResult> = {}): WorkResult {
  return {
    status: "completed",
    summary: "Сделано",
    files: [],
    evidence: [],
    tests: [],
    unresolved: [],
    claims: [],
    ...overrides,
  };
}

function event(type: SessionEventType, payload: Record<string, unknown>): SessionEvent {
  return { type, payload } as unknown as SessionEvent;
}

function withWorkResultBlock(payload: unknown): string {
  return `Итог работы.\n<zcode-work-result>${JSON.stringify(payload)}</zcode-work-result>`;
}

describe("WorkResult parsing", () => {
  it("parses a valid zcode-work-result block", () => {
    const parsed = parseWorkResultBlock(
      withWorkResultBlock({
        status: "partial",
        summary: "Основное готово",
        files: ["src/a.ts"],
        evidence: ["pnpm typecheck: passed"],
        tests: [{ command: "pnpm test", status: "passed" }],
        unresolved: ["нет доступа к стенду"],
        confidence: 0.6,
        claims: [{ path: "src/a.ts", runId: "run-1", attemptId: "attempt-1" }],
        metrics: { durationMs: 12, toolUses: 3, tokens: 100 },
      }),
    );

    expect(parsed).toMatchObject({
      status: "partial",
      summary: "Основное готово",
      files: ["src/a.ts"],
      tests: [{ command: "pnpm test", status: "passed" }],
      unresolved: ["нет доступа к стенду"],
      confidence: 0.6,
      claims: [{ path: "src/a.ts", runId: "run-1", attemptId: "attempt-1" }],
    });
  });

  it("ignores invalid JSON and schema-invalid blocks", () => {
    expect(
      parseWorkResultBlock("<zcode-work-result>{not json}</zcode-work-result>"),
    ).toBeUndefined();
    expect(
      parseWorkResultBlock(withWorkResultBlock({ status: "unknown-status", summary: "x" })),
    ).toBeUndefined();
    expect(parseWorkResultBlock(withWorkResultBlock({ status: "completed" }))).toBeUndefined();
  });

  it("falls back to text, tool events and measured metrics", () => {
    const events = [
      event(SessionEventType.ToolCallScheduled, {
        toolCallId: "call-write",
        toolName: "Write",
        input: { file_path: "src/a.ts" },
      }),
      event(SessionEventType.ToolCallResult, {
        toolCallId: "call-write",
        result: { success: true, content: "written" },
      }),
      event(SessionEventType.ToolCallScheduled, {
        toolCallId: "call-test",
        toolName: "Bash",
        input: { command: "pnpm --filter @zcode/core exec vitest run tests/a.test.ts" },
      }),
      event(SessionEventType.ToolCallResult, {
        toolCallId: "call-test",
        result: { success: true, content: "1 passed" },
      }),
      event(SessionEventType.ToolCallScheduled, {
        toolCallId: "call-lint",
        toolName: "Bash",
        input: { command: "pnpm lint" },
      }),
      event(SessionEventType.ToolCallError, {
        toolCallId: "call-lint",
        error: { underlyingErrorMessage: "lint failed" },
      }),
    ];

    const result = deriveWorkResult({
      text: "Готово: поправил файл",
      events,
      durationMs: 42,
      toolUses: 3,
      tokens: 77,
      claims: [{ path: "src/a.ts", runId: "run-1" }],
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Готово: поправил файл");
    expect(result.files).toEqual(["src/a.ts"]);
    expect(result.tests).toEqual([
      {
        command: "pnpm --filter @zcode/core exec vitest run tests/a.test.ts",
        status: "passed",
      },
    ]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        "tool_call_result:Write:call-write",
        "tool_call_error:Bash:call-lint",
      ]),
    );
    expect(result.metrics).toEqual({ durationMs: 42, toolUses: 3, tokens: 77 });
    expect(result.claims).toEqual([{ path: "src/a.ts", runId: "run-1" }]);
  });

  it("prefers a valid block and overrides metrics with measured values", () => {
    const result = deriveWorkResult({
      text: withWorkResultBlock({
        status: "partial",
        summary: "part",
        files: ["src/a.ts"],
      }),
      events: [],
      durationMs: 15,
      toolUses: 4,
      tokens: 50,
    });

    expect(result.status).toBe("partial");
    expect(result.files).toEqual(["src/a.ts"]);
    expect(result.metrics).toEqual({ durationMs: 15, toolUses: 4, tokens: 50 });
    expect(result.claims).toEqual([]);
  });
});

describe("WorkResult aggregation", () => {
  it("is completed only when every node is completed", () => {
    const aggregate = aggregateWorkResults(
      [
        {
          nodeId: "a",
          status: "completed",
          output: completedOutput("a", "ok", workResult({ summary: "a done" })),
        },
        {
          nodeId: "b",
          status: "completed",
          output: completedOutput("b", "ok", workResult({ summary: "b done" })),
        },
      ],
      { description: "objective" },
    );

    expect(aggregate.status).toBe("completed");
    expect(aggregate.summary).toContain("a done");
    expect(aggregate.metrics).toBeUndefined();
  });

  it("is partial when a node is blocked or has a partial WorkResult", () => {
    const blocked = aggregateWorkResults([
      {
        nodeId: "a",
        status: "completed",
        output: completedOutput("a", "ok", workResult({ summary: "a done" })),
      },
      { nodeId: "b", status: "blocked", error: "dependency failed" },
    ]);
    expect(blocked.status).toBe("partial");
    expect(blocked.unresolved.join(" ")).toContain("b: blocked");

    const partial = aggregateWorkResults([
      {
        nodeId: "a",
        status: "completed",
        output: completedOutput("a", "ok", workResult({ status: "partial", summary: "half done" })),
      },
    ]);
    expect(partial.status).toBe("partial");
  });

  it("is failed when a node failed or a WorkResult declares failed", () => {
    expect(aggregateWorkResults([{ nodeId: "a", status: "failed", error: "boom" }]).status).toBe(
      "failed",
    );
    expect(
      aggregateWorkResults([
        {
          nodeId: "a",
          status: "completed",
          output: completedOutput(
            "a",
            "ok",
            workResult({ status: "failed", summary: "failed work" }),
          ),
        },
      ]).status,
    ).toBe("failed");
  });
});

describe("DAG WorkResult and repair", () => {
  it("derives the DAG summary from WorkResult and renders status/files/tests/unresolved", async () => {
    const nodes = [
      {
        id: "a",
        description: "Task a",
        prompt: "Perform a",
        subagent_type: "general-purpose",
      },
      {
        id: "b",
        description: "Task b",
        prompt: "Perform b",
        subagent_type: "general-purpose",
      },
    ];
    const request: SubagentTaskDagRequest = {
      sessionId: createSessionId("work-result-dag"),
      turnId: createTurnId("work-result-dag-turn"),
      parentToolCallId: "work-result-dag-call",
      agentType: "general-purpose",
      description: "Aggregate objective",
      prompt: "Do the objective",
      nodes,
      maxParallel: 2,
      callerCanReadOutputFile: true,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
      trace: {} as SubagentTaskDagRequest["trace"],
    };

    const output = await executeSubagentTaskDag(request, async (node) => {
      if (node.id === "a") {
        return completedOutput(
          "a",
          "a text",
          workResult({
            summary: "a summary",
            files: ["src/a.ts"],
            tests: [{ command: "pnpm typecheck", status: "passed" }],
            unresolved: ["a unresolved"],
          }),
        );
      }
      return completedOutput(
        "b",
        "b text",
        workResult({ summary: "b summary", files: ["src/b.ts"] }),
      );
    });

    const text = output.content.map((block) => block.text).join("\n");
    expect(output.workResult?.status).toBe("completed");
    expect(output.workResult?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(text).toContain("Work result: status=completed");
    expect(text).toContain("Files: src/a.ts, src/b.ts");
    expect(text).toContain("Tests: pnpm typecheck=passed");
    expect(text).toContain("Unresolved: a: a unresolved");
    expect(text).toContain("work_result=completed");
  });

  it("does not retry a failed node and reports failed without a completed result", async () => {
    const nodes = [
      {
        id: "fail",
        description: "Failing task",
        prompt: "Fail once",
        subagent_type: "general-purpose",
      },
    ];
    const request: SubagentTaskDagRequest = {
      sessionId: createSessionId("work-result-fail"),
      turnId: createTurnId("work-result-fail-turn"),
      parentToolCallId: "work-result-fail-call",
      agentType: "general-purpose",
      description: "Fail objective",
      prompt: "Do not retry",
      nodes,
      maxParallel: 1,
      callerCanReadOutputFile: true,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
      trace: {} as SubagentTaskDagRequest["trace"],
    };
    let runs = 0;

    const output = await executeSubagentTaskDag(request, async (node) => {
      runs += 1;
      if (node.id === "fail") throw new Error("node execution failed once");
      return completedOutput(node.id, "ok");
    });

    expect(runs).toBe(1);
    expect(output.status).toBe("completed");
    expect(output.workResult?.status).toBe("failed");
    expect(output.workResult?.unresolved.join(" ")).toContain("node execution failed once");
    const text = output.content.map((block) => block.text).join("\n");
    expect(text).toContain("Work result: status=failed");
  });

  it("derives a WorkResult for legacy outputs without the field", () => {
    const result = deriveWorkResultFromOutput(completedOutput("legacy", "legacy text"));
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("legacy text");
    expect(result.metrics).toEqual({ durationMs: 10, toolUses: 2, tokens: 5 });
  });
});

describe("WorkResult schema bounds", () => {
  it("truncates long derived file paths and test commands instead of failing the schema", () => {
    const longPath = `/workspace/${"a".repeat(1_400)}`;
    const longCommand = `pnpm test ${"b".repeat(2_500)}`;
    const events = [
      event(SessionEventType.ToolCallScheduled, {
        toolCallId: "call-write",
        toolName: "Write",
        input: { file_path: longPath },
      }),
      event(SessionEventType.ToolCallResult, {
        toolCallId: "call-write",
        result: { success: true, content: "written" },
      }),
      event(SessionEventType.ToolCallScheduled, {
        toolCallId: "call-test",
        toolName: "Bash",
        input: { command: longCommand },
      }),
      event(SessionEventType.ToolCallResult, {
        toolCallId: "call-test",
        result: { success: true, content: "1 passed" },
      }),
    ];

    const result = deriveWorkResult({ text: "done", events });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.length).toBeLessThanOrEqual(1_000);
    expect(result.files[0]!.endsWith("…")).toBe(true);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]!.command.length).toBeLessThanOrEqual(2_000);
    expect(result.tests[0]!.command.endsWith("…")).toBe(true);
    expect(WorkResultSchema.safeParse(result).success).toBe(true);
    expect(
      AgentCompletedOutputSchema.safeParse(completedOutput("long-inputs", "done", result)).success,
    ).toBe(true);
  });

  it("caps files, evidence, tests, unresolved and claims at the schema limits", () => {
    const result = boundWorkResult(
      workResult({
        files: Array.from({ length: 350 }, (_, index) => `src/file-${index}.ts`),
        evidence: Array.from({ length: 350 }, (_, index) => `evidence-${index}`),
        tests: Array.from({ length: 150 }, (_, index) => ({
          command: `pnpm test ${index}`,
          status: "passed" as const,
        })),
        unresolved: Array.from({ length: 350 }, (_, index) => `unresolved-${index}`),
        claims: Array.from({ length: 250 }, (_, index) => ({ path: `src/claim-${index}.ts` })),
      }),
    );

    expect(result.files).toHaveLength(200);
    expect(result.evidence).toHaveLength(200);
    expect(result.tests).toHaveLength(100);
    expect(result.unresolved).toHaveLength(200);
    expect(result.claims).toHaveLength(200);
    expect(WorkResultSchema.safeParse(result).success).toBe(true);
  });

  it("truncates an oversized parsed block instead of discarding it", () => {
    const parsed = parseWorkResultBlock(
      withWorkResultBlock({
        status: "partial",
        summary: "s".repeat(9_000),
        files: Array.from({ length: 250 }, (_, index) => `src/file-${index}.ts`),
        claims: Array.from({ length: 250 }, (_, index) => ({ path: `src/claim-${index}.ts` })),
      }),
    );

    expect(parsed).toBeDefined();
    expect(parsed!.summary.length).toBeLessThanOrEqual(8_000);
    expect(parsed!.files).toHaveLength(200);
    expect(parsed!.claims).toHaveLength(200);
    expect(WorkResultSchema.safeParse(parsed).success).toBe(true);
  });

  it("bounds the DAG aggregate for 25 nodes with 20 tests and claims each", async () => {
    const nodes = Array.from({ length: 25 }, (_, index) => ({
      id: `node-${index}`,
      description: `Task ${index}`,
      prompt: `Perform task ${index}`,
      subagent_type: "general-purpose",
    }));
    const request: SubagentTaskDagRequest = {
      sessionId: createSessionId("work-result-bounds-dag"),
      turnId: createTurnId("work-result-bounds-dag-turn"),
      parentToolCallId: "work-result-bounds-dag-call",
      agentType: "general-purpose",
      description: "Bounded aggregate",
      prompt: "Do every node",
      nodes,
      maxParallel: 4,
      callerCanReadOutputFile: true,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
      trace: {} as SubagentTaskDagRequest["trace"],
    };

    const output = await executeSubagentTaskDag(request, async (node) =>
      completedOutput(
        node.id,
        "ok",
        workResult({
          summary: `${node.id} done`,
          tests: Array.from({ length: 20 }, (_, index) => ({
            command: `pnpm test ${node.id} ${index}`,
            status: "passed" as const,
          })),
          claims: Array.from({ length: 20 }, (_, index) => ({
            path: `src/${node.id}-${index}.ts`,
            runId: "run-1",
            attemptId: "attempt-1",
          })),
        }),
      ),
    );

    expect(output.workResult?.tests).toHaveLength(100);
    expect(output.workResult?.claims).toHaveLength(200);
    expect(AgentCompletedOutputSchema.safeParse(output).success).toBe(true);
  });
});

describe("WorkResult claims ownership", () => {
  const workspacePath = "/workspace/zcode";

  it("keeps only active claims of the current attempt", () => {
    const ledger = new WorkLedger({ journalPath: null });
    ledger.claim({
      workspacePath,
      agentId: "agent-a",
      intent: "first attempt",
      paths: ["src/old.ts"],
      runId: "run-1",
      attemptId: "attempt-1",
    });
    ledger.release("agent-a");
    ledger.claim({
      workspacePath,
      agentId: "agent-a",
      intent: "second attempt",
      paths: ["src/new.ts"],
      runId: "run-2",
      attemptId: "attempt-2",
    });
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const task = {
      agentId: "agent-a",
      workspacePath,
      attemptId: "attempt-2",
    } as RuntimeTaskSnapshot;

    try {
      expect(collectWorkResultClaims(registry, task)).toEqual([
        { path: "src/new.ts", runId: "run-2", attemptId: "attempt-2" },
      ]);
      // Активный claim другого attempt не принадлежит текущей попытке.
      expect(collectWorkResultClaims(registry, { ...task, attemptId: "attempt-1" })).toEqual([]);
    } finally {
      registry.dispose();
    }
  });

  it("returns no claims without a ledger or workspace", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    expect(
      collectWorkResultClaims(registry, {
        agentId: "agent-a",
        workspacePath,
      } as RuntimeTaskSnapshot),
    ).toEqual([]);
    expect(collectWorkResultClaims(registry, undefined)).toEqual([]);
    registry.dispose();
  });

  it("lets explicit runtime claims win over claims from the text block", () => {
    const text = withWorkResultBlock({
      status: "completed",
      summary: "ok",
      claims: [{ path: "src/from-text.ts" }],
    });

    expect(deriveWorkResult({ text, events: [], claims: [] }).claims).toEqual([]);
    expect(deriveWorkResult({ text, events: [], claims: [{ path: "src/from-ledger.ts" }] }).claims).toEqual(
      [{ path: "src/from-ledger.ts" }],
    );
    // Без runtime-источника блок остаётся единственным источником claims.
    expect(deriveWorkResult({ text, events: [] }).claims).toEqual([{ path: "src/from-text.ts" }]);
  });

  it("fills a single-run WorkResult with claims from the live ledger, not an empty array", async () => {
    const claimPath = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";
    const agentId = "agent_live_ledger";
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-work-result-live-ledger-"));
    const ledger = new WorkLedger({ journalPath: null });
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    try {
      const port = createExploreSubagentPort({
        outputRootDir,
        runtimeTaskRegistry: registry,
        createAgentId: () => agentId,
        async emitParentEvent() {},
        async runExploreAgent(request) {
          return {
            response: "Прочитал файл, изменений не вносил.",
            traceId: request.traceContext.traceId,
            events: [],
          };
        },
      });
      const sessionId = createSessionId("work-result-live-ledger");
      const turnId = createTurnId("work-result-live-ledger-turn");

      const output = await port.run({
        sessionId,
        turnId,
        parentToolCallId: "work-result-live-ledger-call",
        agentType: "coder",
        description: "Изучить реестр",
        prompt: `Прочитай \`${claimPath}\``,
        writePaths: [claimPath],
        callerCanReadOutputFile: true,
        workingDirectory: workspacePath,
        workspaceRoot: workspacePath,
        trace: { traceId: createTraceId(), sessionId },
      });

      expect(output.status).toBe("completed");
      const completed = output as AgentCompletedOutput;
      // Клейм выдаётся на admission и снимается терминальным update. runId/attemptId
      // существуют только в живом ledger'е, поэтому их совпадение доказывает источник claims.
      const liveClaim = ledger.list({ workspacePath, agentId })[0];
      expect(liveClaim).toMatchObject({ status: "released", paths: [claimPath] });
      expect(liveClaim?.attemptId).toBeDefined();
      expect(completed.agentId).toBe(agentId);
      expect(completed.workResult?.claims).toEqual([
        {
          path: claimPath,
          ...(liveClaim?.runId ? { runId: liveClaim.runId } : {}),
          ...(liveClaim?.attemptId ? { attemptId: liveClaim.attemptId } : {}),
        },
      ]);
    } finally {
      registry.dispose();
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });
});
