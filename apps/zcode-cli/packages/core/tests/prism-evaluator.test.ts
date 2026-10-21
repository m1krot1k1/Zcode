import { createHash } from "node:crypto";
import {
  PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA,
  PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
  PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION,
  SessionEventType,
  createSessionEvent,
  createSessionId,
  createTraceId,
  createTurnId,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createBashExecutionEvidence } from "../src/tool/executor/events.js";
import {
  createPrismTaskContract,
  evaluatePrismTaskAcceptance,
  isValidPrismHostEvidenceReceipt,
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
