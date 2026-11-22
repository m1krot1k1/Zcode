import { createHash } from "node:crypto";
import {
  PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA,
  PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
  PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION,
  SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
  SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
  SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
  SessionEventType,
  createSessionEvent,
  createSessionId,
  createTraceId,
  createTurnId,
  type SessionEntryInfo,
  type SessionInfo,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createBashExecutionEvidence } from "../src/tool/executor/events.js";
import {
  createPrismTaskContract,
  evaluatePrismTaskAcceptance,
  isValidPrismHostEvidenceReceipt,
  projectPrismHistoricalAcceptanceForTask,
  reducePrismTaskAcceptance,
} from "../src/runtime-task/registry.js";

const command = "pnpm typecheck";
const commandSha256 = createHash("sha256").update(command, "utf8").digest("hex");
const childSessionId = createSessionId("prism-evaluator-child");
const turnId = createTurnId("prism-evaluator-turn");
const traceId = createTraceId();
const current = {
  rootRunId: "root-run-prism-evaluator",
  taskId: "agent-prism-evaluator",
  attemptId: "attempt-prism-evaluator",
  branchGeneration: 2,
};
const contract = createPrismTaskContract({
  ...current,
  description: "Run the required typecheck",
  criteria: [
    {
      id: "typecheck",
      description: "The exact typecheck command exits successfully",
      evaluatorId: PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
      evaluatorVersion: PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION,
      check: { kind: "bash_exit_code", commandSha256, expectedExitCode: 0 },
    },
  ],
});

function scheduledEvent(options: { withoutTurnId?: boolean } = {}) {
  return createSessionEvent(
    SessionEventType.ToolCallScheduled,
    childSessionId,
    { toolCallId: "toolcall-typecheck", toolName: "Bash", input: { command } },
    options.withoutTurnId ? { traceId } : { turnId, traceId },
  );
}

function resultEvent(
  input: {
    status?: "completed" | "backgrounded";
    exitCode?: number;
    commandDigest?: string;
    withoutTurnId?: boolean;
  } = {},
) {
  return createSessionEvent(
    SessionEventType.ToolCallResult,
    childSessionId,
    {
      toolCallId: "toolcall-typecheck",
      result: {
        success: true,
        content: "formatted model output is not used as evidence",
        executionEvidence: {
          kind: "bash_process",
          commandSha256: input.commandDigest ?? commandSha256,
          status: input.status ?? "completed",
          ...(input.exitCode === undefined ? { exitCode: 0 } : { exitCode: input.exitCode }),
        },
      },
      duration: 1,
    },
    input.withoutTurnId ? { traceId } : { turnId, traceId },
  );
}

describe("PRISM Host Bash evaluator", () => {
  it("verifies only the exact Host-observed command with exit code zero", () => {
    const events = [
      { ...scheduledEvent(), sequenceNumber: 1 },
      { ...resultEvent(), sequenceNumber: 2 },
    ];

    const result = evaluatePrismTaskAcceptance({
      contract,
      current,
      childSessionId,
      events,
      observedAt: 123,
    });

    expect(result.decision).toMatchObject({
      status: "verified",
      passedCriterionIds: ["typecheck"],
    });
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({
      issuer: "host_evaluator",
      result: "pass",
      evaluatorId: PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
      contractSha256: contract.contractSha256,
      artifact: {
        uri: expect.stringContaining("zcode-session-event://"),
        bytes: expect.any(Number),
        evidence: {
          schema: PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA,
          commandSha256,
          scheduledSequence: 1,
          resultSequence: 2,
          exitCode: 0,
        },
      },
    });
    expect(JSON.stringify(contract)).not.toContain(command);

    const replayedReceipt = JSON.parse(JSON.stringify(result.receipts[0])) as unknown;
    expect(isValidPrismHostEvidenceReceipt(replayedReceipt)).toBe(true);
    expect(
      reducePrismTaskAcceptance({ contract, receipts: [replayedReceipt], current }).status,
    ).toBe("verified");
    const tamperedReceipt = JSON.parse(JSON.stringify(replayedReceipt)) as {
      artifact: { evidence: { exitCode: number } };
    };
    tamperedReceipt.artifact.evidence.exitCode = 1;
    expect(
      reducePrismTaskAcceptance({ contract, receipts: [tamperedReceipt], current }).status,
    ).toBe("unknown");
  });

  it("rejects a Host-observed nonzero exit and never trusts formatted tool text", () => {
    const events = [
      { ...scheduledEvent(), sequenceNumber: 1 },
      { ...resultEvent({ exitCode: 2 }), sequenceNumber: 2 },
    ];

    const result = evaluatePrismTaskAcceptance({ contract, current, childSessionId, events });

    expect(result.decision).toMatchObject({
      status: "rejected",
      failedCriterionIds: ["typecheck"],
    });
    expect(result.receipts[0]?.result).toBe("fail");
  });

  it("does not reuse an earlier success after a repeated toolCallId is scheduled", () => {
    const events = [
      { ...scheduledEvent(), sequenceNumber: 1 },
      { ...resultEvent(), sequenceNumber: 2 },
      { ...scheduledEvent(), sequenceNumber: 3 },
    ];

    const result = evaluatePrismTaskAcceptance({ contract, current, childSessionId, events });

    expect(result.decision.status).toBe("unknown");
    expect(result.receipts).toHaveLength(0);
  });

  it("rejects ambiguous reused IDs even when turn IDs are missing", () => {
    const events = [
      { ...scheduledEvent({ withoutTurnId: true }), sequenceNumber: 1 },
      { ...resultEvent({ withoutTurnId: true }), sequenceNumber: 2 },
      { ...scheduledEvent({ withoutTurnId: true }), sequenceNumber: 3 },
    ];

    const result = evaluatePrismTaskAcceptance({ contract, current, childSessionId, events });

    expect(result.decision.status).toBe("unknown");
    expect(result.receipts).toHaveLength(0);
  });

  it("verifies a schedule without a turn ID against a result without a turn ID", () => {
    const events = [
      { ...scheduledEvent({ withoutTurnId: true }), sequenceNumber: 1 },
      { ...resultEvent({ withoutTurnId: true }), sequenceNumber: 2 },
    ];

    const result = evaluatePrismTaskAcceptance({ contract, current, childSessionId, events });

    expect(result.decision).toMatchObject({
      status: "verified",
      passedCriterionIds: ["typecheck"],
    });
    expect(result.receipts).toHaveLength(1);
  });

  it("rejects a result with a turn ID when the schedule has no turn ID", () => {
    const events = [
      { ...scheduledEvent({ withoutTurnId: true }), sequenceNumber: 1 },
      { ...resultEvent(), sequenceNumber: 2 },
    ];

    const result = evaluatePrismTaskAcceptance({ contract, current, childSessionId, events });

    expect(result.decision.status).toBe("unknown");
    expect(result.receipts).toHaveLength(0);
  });

  it("uses sequence order rather than input array order and rejects invalid sequences", () => {
    const outOfArrayOrder = [
      { ...resultEvent(), sequenceNumber: 2 },
      { ...scheduledEvent(), sequenceNumber: 1 },
    ];
    expect(
      evaluatePrismTaskAcceptance({
        contract,
        current,
        childSessionId,
        events: outOfArrayOrder,
      }).decision.status,
    ).toBe("verified");

    for (const events of [
      [
        { ...scheduledEvent(), sequenceNumber: 0 },
        { ...resultEvent(), sequenceNumber: 1 },
      ],
      [
        { ...scheduledEvent(), sequenceNumber: 1 },
        { ...resultEvent(), sequenceNumber: 1 },
      ],
    ]) {
      expect(
        evaluatePrismTaskAcceptance({ contract, current, childSessionId, events }).decision.status,
      ).toBe("unknown");
    }
  });

  it.each([
    ["missing result", [scheduledEvent()]],
    ["background execution", [scheduledEvent(), resultEvent({ status: "backgrounded" })]],
    ["different command", [scheduledEvent(), resultEvent({ commandDigest: "f".repeat(64) })]],
  ])("leaves %s as unknown", (_label, rawEvents) => {
    const events = rawEvents.map((event, index) => ({ ...event, sequenceNumber: index + 1 }));
    const result = evaluatePrismTaskAcceptance({ contract, current, childSessionId, events });

    expect(result.decision).toMatchObject({
      status: "unknown",
      missingCriterionIds: ["typecheck"],
    });
    expect(result.receipts).toHaveLength(0);
  });

  it("emits bounded Bash evidence without command text or output", () => {
    const evidence = createBashExecutionEvidence(
      "Bash",
      { command },
      {
        stdout: "sensitive output",
        stderr: "",
        status: "completed",
        exitCode: 0,
        interrupted: false,
      },
    );

    expect(evidence).toEqual({
      kind: "bash_process",
      commandSha256,
      status: "completed",
      exitCode: 0,
    });
    expect(JSON.stringify(evidence)).not.toContain(command);
    expect(JSON.stringify(evidence)).not.toContain("sensitive output");
    expect(
      createBashExecutionEvidence("OtherTool", { command }, { status: "completed" }),
    ).toBeUndefined();
  });
});

describe("PRISM historical acceptance projection", () => {
  function sessionInfo(
    id: string,
    taskType: SessionInfo["taskType"],
    branchGeneration: number,
    parentID?: string,
  ): SessionInfo {
    return {
      id: id as SessionInfo["id"],
      projectID: "prism-project" as SessionInfo["projectID"],
      ...(parentID ? { parentID: parentID as SessionInfo["id"] } : {}),
      taskType,
      slug: id,
      directory: "/workspace",
      title: id,
      version: "test",
      revert: { messageID: "rewind" as never, branchGeneration },
      time: { created: 1, updated: 2 },
    };
  }

  function entry(
    id: string,
    type: SessionEntryInfo["type"],
    sessionID: SessionInfo["id"],
    data: unknown,
  ): SessionEntryInfo {
    return { id, type, sessionID, data, time: { created: 1, updated: 1 } };
  }

  function historicalFixture() {
    const rootSessionId = "prism-historical-root" as SessionInfo["id"];
    const childId = childSessionId as SessionInfo["id"];
    const root = sessionInfo(rootSessionId, "interactive", current.branchGeneration);
    const child = sessionInfo(childId, "subagent_child", 0, rootSessionId);
    const evaluation = evaluatePrismTaskAcceptance({
      contract,
      current,
      childSessionId,
      events: [
        { ...scheduledEvent(), sequenceNumber: 1 },
        { ...resultEvent(), sequenceNumber: 2 },
      ],
      observedAt: 123,
    });
    const terminal = {
      schema: "zcode.prism.subagent-terminal.v3",
      terminalId: `${current.rootRunId}/${current.taskId}/${current.branchGeneration}/${current.attemptId}`,
      rootRunId: current.rootRunId,
      taskId: current.taskId,
      attemptId: current.attemptId,
      branchGeneration: current.branchGeneration,
      childSessionId: childId,
      childStarted: true,
      terminalStatus: "completed",
      provenance: "runtime_lifecycle",
      acceptanceStatus: "verified",
      observedAt: new Date(123),
    } as const;
    const terminalEntryId = `prism-task-terminal:${rootSessionId}:${terminal.terminalId}`;
    return {
      input: {
        rootSessionId,
        rootRunId: current.rootRunId,
        taskId: current.taskId,
        childSessionId: childId,
        ownerSessionId: rootSessionId,
        ownerBranchGeneration: current.branchGeneration,
        ownerSessionsById: new Map([
          [rootSessionId, root],
          [childId, child],
        ]),
        contracts: [
          entry(
            `prism-task-contract:${rootSessionId}:${current.rootRunId}:${current.taskId}:${current.attemptId}`,
            SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
            rootSessionId,
            { contract },
          ),
        ],
        receipts: evaluation.receipts.map((receipt) =>
          entry(
            `prism-evidence-receipt:${rootSessionId}:${receipt.receiptId}`,
            SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
            rootSessionId,
            { receipt },
          ),
        ),
        terminals: [
          entry(
            terminalEntryId,
            SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
            rootSessionId,
            JSON.parse(JSON.stringify({ terminal })) as unknown,
          ),
        ],
      },
      rootSessionId,
      childId,
      terminalEntryId,
    };
  }

  it("recomputes a cold persisted receipt and accepts ISO timestamps", () => {
    const fixture = historicalFixture();
    const decision = projectPrismHistoricalAcceptanceForTask(fixture.input);
    expect(decision).toMatchObject({
      status: "verified",
      passedCriterionIds: ["typecheck"],
      failedCriterionIds: [],
      missingCriterionIds: [],
    });
  });

  it("fails closed when the current owner branch was rewound after the task", () => {
    const fixture = historicalFixture();
    const root = fixture.input.ownerSessionsById.get(fixture.rootSessionId)!;
    const rewoundRoot = {
      ...root,
      revert: { messageID: "rewind" as never, branchGeneration: current.branchGeneration + 1 },
    };
    const decision = projectPrismHistoricalAcceptanceForTask({
      ...fixture.input,
      ownerSessionsById: new Map([
        ...fixture.input.ownerSessionsById,
        [fixture.rootSessionId, rewoundRoot],
      ]),
    });
    expect(decision?.status).toBe("unknown");
  });

  it("recomputes a nested child only when every parent task edge is durable", () => {
    const fixture = historicalFixture();
    const middleId = "prism-historical-middle" as SessionInfo["id"];
    const ownerGeneration = 5;
    const middle = sessionInfo(middleId, "subagent_child", ownerGeneration, fixture.rootSessionId);
    const leaf = sessionInfo(fixture.childId, "subagent_child", 0, middleId);
    const nestedCurrent = {
      ...current,
      parentTaskId: "parent-agent",
      branchGeneration: ownerGeneration,
    };
    const nestedContract = createPrismTaskContract({
      ...nestedCurrent,
      description: "Run the required typecheck",
      criteria: contract.criteria,
    });
    const nestedEvaluation = evaluatePrismTaskAcceptance({
      contract: nestedContract,
      current: nestedCurrent,
      childSessionId: fixture.childId,
      events: [
        { ...scheduledEvent(), sequenceNumber: 1 },
        { ...resultEvent(), sequenceNumber: 2 },
      ],
      observedAt: 456,
    });
    const parentTerminal = {
      schema: "zcode.prism.subagent-terminal.v3",
      terminalId: `${current.rootRunId}/parent-agent/${current.branchGeneration}/parent-attempt`,
      rootRunId: current.rootRunId,
      taskId: "parent-agent",
      attemptId: "parent-attempt",
      branchGeneration: current.branchGeneration,
      childSessionId: middleId,
      childStarted: true,
      terminalStatus: "completed",
      provenance: "runtime_lifecycle",
      acceptanceStatus: "unknown",
      observedAt: new Date(321),
    } as const;
    const leafTerminal = {
      schema: "zcode.prism.subagent-terminal.v3",
      terminalId: `${nestedCurrent.rootRunId}/${nestedCurrent.taskId}/${nestedCurrent.branchGeneration}/${nestedCurrent.attemptId}`,
      rootRunId: nestedCurrent.rootRunId,
      taskId: nestedCurrent.taskId,
      attemptId: nestedCurrent.attemptId,
      parentTaskId: nestedCurrent.parentTaskId,
      branchGeneration: nestedCurrent.branchGeneration,
      childSessionId: fixture.childId,
      childStarted: true,
      terminalStatus: "completed",
      provenance: "runtime_lifecycle",
      acceptanceStatus: "verified",
      observedAt: new Date(456),
    } as const;
    const nestedProjection = {
      rootSessionId: fixture.rootSessionId,
      rootRunId: current.rootRunId,
      taskId: current.taskId,
      parentTaskId: "parent-agent",
      childSessionId: fixture.childId,
      ownerSessionId: middleId,
      ownerBranchGeneration: ownerGeneration,
      ownerSessionsById: new Map([
        [fixture.rootSessionId, fixture.input.ownerSessionsById.get(fixture.rootSessionId)!],
        [middleId, middle],
        [fixture.childId, leaf],
      ]),
      contracts: [
        entry(
          `prism-task-contract:${fixture.rootSessionId}:${nestedContract.rootRunId}:${nestedContract.taskId}:${nestedContract.attemptId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
          fixture.rootSessionId,
          { contract: nestedContract },
        ),
      ],
      receipts: nestedEvaluation.receipts.map((receipt) =>
        entry(
          `prism-evidence-receipt:${fixture.rootSessionId}:${receipt.receiptId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
          fixture.rootSessionId,
          { receipt },
        ),
      ),
      terminals: [
        entry(
          `prism-task-terminal:${fixture.rootSessionId}:${parentTerminal.terminalId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
          fixture.rootSessionId,
          { terminal: parentTerminal },
        ),
        entry(
          `prism-task-terminal:${fixture.rootSessionId}:${leafTerminal.terminalId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
          fixture.rootSessionId,
          { terminal: leafTerminal },
        ),
      ],
    };
    const decision = projectPrismHistoricalAcceptanceForTask(nestedProjection);

    expect(decision).toMatchObject({ status: "verified", passedCriterionIds: ["typecheck"] });

    const parentTerminalEntry = nestedProjection.terminals[0]!;
    const malformedAncestorDuplicate = {
      ...parentTerminalEntry,
      id: `${parentTerminalEntry.id}:malformed-duplicate`,
      data: {
        terminal: {
          schema: "zcode.prism.subagent-terminal.v3",
          rootRunId: current.rootRunId,
          taskId: "parent-agent",
          childSessionId: middleId,
          terminalStatus: "completed",
        },
      },
    };
    const ambiguousAncestorDecision = projectPrismHistoricalAcceptanceForTask({
      ...nestedProjection,
      terminals: [...nestedProjection.terminals, malformedAncestorDuplicate],
    });
    expect(ambiguousAncestorDecision?.status).toBe("unknown");
    const malformedWrongRootDuplicate = {
      ...malformedAncestorDuplicate,
      id: `${parentTerminalEntry.id}:wrong-root-duplicate`,
      data: {
        terminal: {
          ...malformedAncestorDuplicate.data.terminal,
          rootRunId: "different-root-run",
        },
      },
    };
    const wrongRootAncestorDecision = projectPrismHistoricalAcceptanceForTask({
      ...nestedProjection,
      terminals: [...nestedProjection.terminals, malformedWrongRootDuplicate],
    });
    expect(wrongRootAncestorDecision?.status).toBe("unknown");

    const rewoundMiddle = {
      ...middle,
      revert: { messageID: "rewind" as never, branchGeneration: ownerGeneration + 1 },
    };
    const staleNestedDecision = projectPrismHistoricalAcceptanceForTask({
      rootSessionId: fixture.rootSessionId,
      rootRunId: current.rootRunId,
      taskId: current.taskId,
      parentTaskId: "parent-agent",
      childSessionId: fixture.childId,
      ownerSessionId: middleId,
      ownerBranchGeneration: ownerGeneration,
      ownerSessionsById: new Map([
        [fixture.rootSessionId, fixture.input.ownerSessionsById.get(fixture.rootSessionId)!],
        [middleId, rewoundMiddle],
        [fixture.childId, leaf],
      ]),
      contracts: [
        entry(
          `prism-task-contract:${fixture.rootSessionId}:${nestedContract.rootRunId}:${nestedContract.taskId}:${nestedContract.attemptId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
          fixture.rootSessionId,
          { contract: nestedContract },
        ),
      ],
      receipts: nestedEvaluation.receipts.map((receipt) =>
        entry(
          `prism-evidence-receipt:${fixture.rootSessionId}:${receipt.receiptId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
          fixture.rootSessionId,
          { receipt },
        ),
      ),
      terminals: [
        entry(
          `prism-task-terminal:${fixture.rootSessionId}:${parentTerminal.terminalId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
          fixture.rootSessionId,
          { terminal: parentTerminal },
        ),
        entry(
          `prism-task-terminal:${fixture.rootSessionId}:${leafTerminal.terminalId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
          fixture.rootSessionId,
          { terminal: leafTerminal },
        ),
      ],
    });
    expect(staleNestedDecision?.status).toBe("unknown");
  });

  it("rejects a completed terminal that did not start its child", () => {
    const fixture = historicalFixture();
    const terminalEntry = fixture.input.terminals[0]!;
    const terminal = (terminalEntry.data as { terminal: Record<string, unknown> }).terminal;
    const decision = projectPrismHistoricalAcceptanceForTask({
      ...fixture.input,
      terminals: [
        {
          ...terminalEntry,
          data: { terminal: { ...terminal, childStarted: false } },
        },
      ],
    });
    expect(decision?.status).toBe("unknown");
  });

  it("fails closed when a malformed duplicate terminal belongs to the same child", () => {
    const fixture = historicalFixture();
    const terminalEntry = fixture.input.terminals[0]!;
    const malformedDuplicate = {
      ...terminalEntry,
      id: `${terminalEntry.id}-malformed`,
      data: {
        terminal: {
          schema: "zcode.prism.subagent-terminal.v3",
          taskId: current.taskId,
          childSessionId: fixture.childId,
          terminalStatus: "completed",
        },
      },
    };
    const decision = projectPrismHistoricalAcceptanceForTask({
      ...fixture.input,
      terminals: [...fixture.input.terminals, malformedDuplicate],
    });
    expect(decision?.status).toBe("unknown");
  });

  it("fails closed on a valid terminal duplicate with a conflicting parent task", () => {
    const fixture = historicalFixture();
    const terminalEntry = fixture.input.terminals[0]!;
    const terminal = (terminalEntry.data as { terminal: Record<string, unknown> }).terminal;
    const conflictingTerminal = {
      ...terminal,
      terminalId: `${current.rootRunId}/${current.taskId}/${current.branchGeneration}/other-attempt`,
      attemptId: "other-attempt",
      parentTaskId: "conflicting-parent",
    };
    const decision = projectPrismHistoricalAcceptanceForTask({
      ...fixture.input,
      terminals: [
        ...fixture.input.terminals,
        {
          ...terminalEntry,
          id: `prism-task-terminal:${fixture.rootSessionId}:${conflictingTerminal.terminalId}`,
          data: { terminal: conflictingTerminal },
        },
      ],
    });
    expect(decision?.status).toBe("unknown");
  });

  it("fails closed when a nested owner's terminal edge is missing", () => {
    const fixture = historicalFixture();
    const middleId = "prism-historical-middle" as SessionInfo["id"];
    const middle = sessionInfo(
      middleId,
      "subagent_child",
      current.branchGeneration,
      fixture.rootSessionId,
    );
    const leaf = sessionInfo(fixture.childId, "subagent_child", 0, middleId);
    const contractWithParent = createPrismTaskContract({
      ...current,
      parentTaskId: "parent-agent",
      description: "Run the required typecheck",
      criteria: contract.criteria,
    });
    const childTerminal = {
      schema: "zcode.prism.subagent-terminal.v3",
      terminalId: `${current.rootRunId}/${current.taskId}/${current.branchGeneration}/${current.attemptId}`,
      rootRunId: current.rootRunId,
      taskId: current.taskId,
      attemptId: current.attemptId,
      parentTaskId: "parent-agent",
      branchGeneration: current.branchGeneration,
      childSessionId: fixture.childId,
      childStarted: true,
      terminalStatus: "completed",
      provenance: "runtime_lifecycle",
      acceptanceStatus: "verified",
      observedAt: new Date(123),
    } as const;
    const decision = projectPrismHistoricalAcceptanceForTask({
      ...fixture.input,
      parentTaskId: "parent-agent",
      ownerSessionId: middleId,
      ownerBranchGeneration: current.branchGeneration,
      ownerSessionsById: new Map([
        [fixture.rootSessionId, fixture.input.ownerSessionsById.get(fixture.rootSessionId)!],
        [middleId, middle],
        [fixture.childId, leaf],
      ]),
      contracts: [
        entry(
          `prism-task-contract:${fixture.rootSessionId}:${current.rootRunId}:${current.taskId}:${current.attemptId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
          fixture.rootSessionId,
          { contract: contractWithParent },
        ),
      ],
      terminals: [
        entry(
          `prism-task-terminal:${fixture.rootSessionId}:${childTerminal.terminalId}`,
          SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
          fixture.rootSessionId,
          { terminal: childTerminal },
        ),
      ],
    });
    expect(decision?.status).toBe("unknown");
  });
});
