import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createSessionEvent,
  createSessionId,
  createTraceId,
  createTurnId,
} from "@zcode/contracts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { createBashExecutionEvidence } from "../src/tool/executor/events.js";

const checkCommand = "pnpm typecheck";

describe("PRISM task lifecycle", () => {
  it("persists the accepted contract before child start and reduces the Host receipt", async () => {
    const sessionId = createSessionId("prism-lifecycle-parent");
    const turnId = createTurnId("prism-lifecycle-turn");
    const traceId = createTraceId();
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-prism-lifecycle-"));
    const parentEvents: Array<{ type: string; payload: unknown }> = [];
    let childSessionId: string | undefined;
    const commandOutcome = createBashExecutionEvidence(
      "Bash",
      { command: checkCommand },
      { stdout: "", stderr: "", status: "completed", exitCode: 0, interrupted: false },
    );

    const port = createExploreSubagentPort({
      createAgentId: () => "agent_prism_lifecycle",
      outputRootDir,
      emitParentEvent: async (event) => {
        parentEvents.push({ type: event.type, payload: event.payload });
      },
      getChildEventCursor: async () => 0,
      getChildEventsAfter: async (childId) => {
        childSessionId = childId;
        const schedule = createSessionEvent(
          SessionEventType.ToolCallScheduled,
          childId,
          {
            toolCallId: "toolcall_prism_typecheck",
            toolName: "Bash",
            input: { command: checkCommand },
          },
          { turnId, traceId },
        );
        const result = createSessionEvent(
          SessionEventType.ToolCallResult,
          childId,
          {
            toolCallId: "toolcall_prism_typecheck",
            result: {
              success: true,
              content: "formatted text is not evidence",
              executionEvidence: commandOutcome,
            },
            duration: 1,
          },
          { turnId, traceId },
        );
        return [
          { ...schedule, sequenceNumber: 1 },
          { ...result, sequenceNumber: 2 },
        ];
      },
      runExploreAgent: async (request) => {
        const lastPrismEvent = parentEvents.find(
          ({ type }) => type === SessionEventType.PrismTaskContractDeclared,
        );
        expect(lastPrismEvent).toBeDefined();
        await request.onSessionReady?.();
        return { response: "The command completed.", traceId, events: [] };
      },
    });

    const result = await port.run({
      sessionId,
      turnId,
      parentToolCallId: "toolcall_prism_parent",
      agentType: "implementer",
      description: "Run typecheck",
      prompt: "Run typecheck.",
      acceptanceCriteria: [
        {
          id: "typecheck",
          description: "The exact typecheck command exits successfully",
          check: {
            kind: "bash_exit_code",
            command: checkCommand,
            expectedExitCode: 0,
          },
        },
      ],
      workingDirectory: outputRootDir,
      workspaceRoot: outputRootDir,
      trace: { traceId, sessionId, turnId },
    });

    expect(childSessionId).toBeDefined();
    expect(result).toMatchObject({ status: "completed", acceptance: { status: "verified" } });
    expect(parentEvents.map(({ type }) => type)).toContain(
      SessionEventType.PrismEvidenceReceiptObserved,
    );
    const declaredContractEvent = parentEvents.find(
      ({ type }) => type === SessionEventType.PrismTaskContractDeclared,
    );
    expect(declaredContractEvent?.type).toBe(SessionEventType.PrismTaskContractDeclared);
    expect(JSON.stringify(declaredContractEvent?.payload)).not.toContain(checkCommand);
    expect(
      parentEvents.findIndex(({ type }) => type === SessionEventType.PrismTaskContractDeclared),
    ).toBeLessThan(parentEvents.findIndex(({ type }) => type === SessionEventType.SubagentSpawned));
    expect(
      parentEvents.find(({ type }) => type === SessionEventType.SubagentExecutionTerminal)?.payload,
    ).toMatchObject({ acceptanceStatus: "verified", childStarted: true });
  });

  it("keeps acceptance unknown when no explicit criteria were declared", async () => {
    const sessionId = createSessionId("prism-no-criteria-parent");
    const traceId = createTraceId();
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-prism-no-criteria-"));
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_prism_no_criteria",
      outputRootDir,
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return { response: "The worker claims completion.", traceId, events: [] };
      },
    });

    const result = await port.run({
      sessionId,
      parentToolCallId: "toolcall_prism_no_criteria",
      agentType: "implementer",
      description: "Unverified task",
      prompt: "Do a task without machine-verifiable criteria.",
      workingDirectory: outputRootDir,
      workspaceRoot: outputRootDir,
      trace: { traceId, sessionId },
    });

    expect(result).toMatchObject({ status: "completed", acceptance: { status: "unknown" } });
  });

  it("records a terminal unknown attempt when cancellation arrives after contract declaration", async () => {
    const sessionId = createSessionId("prism-prestart-cancel-parent");
    const turnId = createTurnId("prism-prestart-cancel-turn");
    const traceId = createTraceId();
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-prism-prestart-cancel-"));
    const controller = new AbortController();
    const parentEvents: Array<{ type: string; payload: unknown }> = [];
    let childStarted = false;
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_prism_prestart_cancel",
      outputRootDir,
      emitParentEvent: async (event) => {
        parentEvents.push({ type: event.type, payload: event.payload });
        if (event.type === SessionEventType.PrismTaskContractDeclared) controller.abort();
      },
      runExploreAgent: async () => {
        childStarted = true;
        throw new Error("child must not start after cancellation");
      },
    });

    await expect(
      port.run(
        {
          sessionId,
          turnId,
          parentToolCallId: "toolcall_prism_prestart_cancel",
          agentType: "implementer",
          description: "Cancel before child start",
          prompt: "Run a check.",
          acceptanceCriteria: [
            {
              id: "check",
              description: "The exact command exits successfully",
              check: {
                kind: "bash_exit_code",
                command: checkCommand,
                expectedExitCode: 0,
              },
            },
          ],
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
          trace: { traceId, sessionId, turnId },
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeDefined();

    expect(childStarted).toBe(false);
    expect(parentEvents.map(({ type }) => type)).toContain(
      SessionEventType.SubagentExecutionTerminal,
    );
    const terminal = parentEvents.find(
      ({ type }) => type === SessionEventType.SubagentExecutionTerminal,
    )?.payload as {
      acceptanceStatus: string;
      childStarted: boolean;
      terminalStatus: string;
    };
    expect(terminal).toMatchObject({
      acceptanceStatus: "unknown",
      childStarted: false,
      terminalStatus: "cancelled",
    });
  });
});
