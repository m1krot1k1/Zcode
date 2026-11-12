import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemorySessionEventStore,
  PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA,
  SessionEventType,
  createProjectId,
  createRootTraceContext,
  createSessionEvent,
  createSessionId,
  createTurnId,
  SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
  SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
  SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
} from "@zcode/contracts";
import {
  InMemoryRuntimeTaskRegistry,
  createPrismHostEvidenceReceipt,
  createPrismTaskContract,
  projectPrismHistoricalAcceptanceForTask,
} from "../../core/src/runtime-task/registry.js";
import { AgentRuntime } from "../../core/src/runtime.js";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

describe("PRISM SQLite projection recovery", () => {
  it("recovers the durable event envelope after closing and reopening SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-prism-projection-recovery-"));
    const dbPath = join(root, "session.sqlite");
    const rootSessionId = createSessionId("prism-sqlite-recovery-root");
    const childSessionId = createSessionId("prism-sqlite-recovery-child");
    const turnId = createTurnId("prism-sqlite-recovery-turn");
    const workingDirectory = root;
    let store = await createSqliteSessionStore({ dbPath });
    let runtime: AgentRuntime | undefined;
    try {
      await store.createSession({
        id: rootSessionId,
        projectID: createProjectId("prism-sqlite-recovery"),
        slug: "prism-sqlite-recovery",
        directory: workingDirectory,
        path: workingDirectory,
        title: "PRISM projection recovery",
        version: "test",
      });

      const registry = new InMemoryRuntimeTaskRegistry();
      const eventStore = new InMemorySessionEventStore({ retention: "unbounded" });
      runtime = createRuntime({
        eventStore,
        registry,
        rootSessionId,
        store,
        workingDirectory,
      });
      const admission = registry.registerSubagentTask(
        {
          taskId: "prism-sqlite-recovery-task",
          agentId: "prism-sqlite-recovery-task",
          agentType: "Explore",
          description: "Persist PRISM facts to SQLite",
          status: "running",
          startedAt: new Date(100),
          childSessionId,
          parentSessionId: rootSessionId,
          turnId,
          type: "local_agent",
        },
        { abort: () => undefined, settled: Promise.resolve() },
      );
      if (!admission.accepted) throw new Error("PRISM SQLite task fixture was not admitted");

      const lineage = {
        rootRunId: admission.task.rootRunId!,
        taskId: admission.task.taskId,
        attemptId: admission.task.attemptId!,
        branchGeneration: admission.task.branchGeneration!,
      };
      const commandSha256 = hashCommand("true");
      const contract = createPrismTaskContract({
        ...lineage,
        description: "Verify SQLite projection recovery",
        criteria: [
          {
            id: "sqlite-projection",
            description: "The event envelope survives closing SQLite",
            evaluatorId: "sqlite-test-verifier",
            evaluatorVersion: "1",
            check: { kind: "bash_exit_code", commandSha256, expectedExitCode: 0 },
          },
        ],
      });
      const traceContext = createRootTraceContext({ sessionId: rootSessionId, turnId });
      const contractEvent = createSessionEvent(
        SessionEventType.PrismTaskContractDeclared,
        rootSessionId,
        { contract },
        { turnId, traceId: traceContext.traceId },
      );
      const receipt = createPrismHostEvidenceReceipt({
        ...lineage,
        criterionId: "sqlite-projection",
        contractSha256: contract.contractSha256,
        evaluatorId: "sqlite-test-verifier",
        evaluatorVersion: "1",
        verifierInvocationId: "sqlite-reopen-invocation",
        result: "pass",
        artifact: {
          uri: "zcode-artifact://tests/prism-sqlite-projection",
          ...createPrismArtifact(commandSha256, childSessionId),
        },
        observedAt: 123,
      });
      const receiptEvent = createSessionEvent(
        SessionEventType.PrismEvidenceReceiptObserved,
        rootSessionId,
        { receipt },
        { turnId, traceId: traceContext.traceId },
      );

      const completedTask = registry.update(lineage.taskId, (task) => ({
        ...task,
        status: "completed",
        completedAt: new Date(125),
        output: {
          status: "completed",
          agentId: task.agentId,
          agentType: task.agentType,
          description: task.description,
          prompt: "Persist the verified contract, receipt, and terminal facts.",
          content: [],
          totalToolUseCount: 1,
          totalDurationMs: 25,
          acceptance: {
            status: "verified",
            passedCriterionIds: ["sqlite-projection"],
            failedCriterionIds: [],
            missingCriterionIds: [],
          },
        },
      }));
      if (!completedTask) throw new Error("PRISM SQLite task disappeared before terminal save");
      const terminalPayload = {
        schema: "zcode.prism.subagent-terminal.v3" as const,
        attemptId: completedTask.attemptId!,
        terminalId: `${completedTask.rootRunId}/${completedTask.taskId}/${completedTask.branchGeneration}/${completedTask.attemptId}`,
        rootRunId: completedTask.rootRunId!,
        taskId: completedTask.taskId,
        branchGeneration: completedTask.branchGeneration!,
        childSessionId,
        childStarted: true,
        terminalStatus: "completed" as const,
        provenance: "runtime_lifecycle" as const,
        acceptanceStatus: "verified" as const,
        observedAt: new Date(125),
      };
      const terminalEvent = createSessionEvent(
        SessionEventType.SubagentExecutionTerminal,
        rootSessionId,
        terminalPayload,
        { turnId, traceId: traceContext.traceId },
      );

      for (const event of [contractEvent, receiptEvent, terminalEvent]) {
        const append = eventStore.append.bind(eventStore);
        eventStore.append = async (candidate) => {
          if (candidate.id === event.id) throw new Error("fixture event projection failure");
          return await append(candidate);
        };
        try {
          await runtime.appendEvent(event, traceContext);
        } finally {
          eventStore.append = append;
        }
      }
      expect(await store.sessionEntries({ sessionID: rootSessionId })).toHaveLength(3);
      expect(await eventStore.getEvents(rootSessionId)).toHaveLength(0);

      runtime.beginShutdown();
      runtime = undefined;
      store.close();
      store = await createSqliteSessionStore({ dbPath });

      const restoredEventStore = new InMemorySessionEventStore({ retention: "unbounded" });
      const restoredRuntime = createRuntime({
        eventStore: restoredEventStore,
        registry: new InMemoryRuntimeTaskRegistry(),
        rootSessionId,
        store,
        workingDirectory,
      });
      runtime = restoredRuntime;
      await restoredRuntime.resumeFromStore({
        traceContext: createRootTraceContext({ sessionId: rootSessionId }),
      });

      const recovered = (await restoredEventStore.getEvents(rootSessionId)).filter(
        ({ type }) =>
          type === SessionEventType.PrismTaskContractDeclared ||
          type === SessionEventType.PrismEvidenceReceiptObserved ||
          type === SessionEventType.SubagentExecutionTerminal,
      );
      expect(recovered.map(({ id }) => id)).toEqual([
        contractEvent.id,
        receiptEvent.id,
        terminalEvent.id,
      ]);
      expect(recovered.map(({ type }) => type)).toEqual([
        SessionEventType.PrismTaskContractDeclared,
        SessionEventType.PrismEvidenceReceiptObserved,
        SessionEventType.SubagentExecutionTerminal,
      ]);
      expect(
        recovered.map(({ timestamp, turnId: recoveredTurnId, traceId }) => ({
          timestamp,
          turnId: recoveredTurnId,
          traceId,
        })),
      ).toEqual(
        [contractEvent, receiptEvent, terminalEvent].map(({ timestamp, turnId, traceId }) => ({
          timestamp,
          turnId,
          traceId,
        })),
      );

      const [contracts, receipts, terminals, owner] = await Promise.all([
        store.sessionEntries!({
          sessionID: rootSessionId,
          type: SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
        }),
        store.sessionEntries!({
          sessionID: rootSessionId,
          type: SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
        }),
        store.sessionEntries!({
          sessionID: rootSessionId,
          type: SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
        }),
        store.getSession(rootSessionId),
      ]);
      if (!owner) throw new Error("PRISM SQLite root session disappeared after reopen");
      const child = {
        ...owner,
        id: childSessionId,
        parentID: rootSessionId,
        taskType: "subagent_child" as const,
      };
      expect(
        projectPrismHistoricalAcceptanceForTask({
          rootSessionId,
          rootRunId: lineage.rootRunId,
          taskId: lineage.taskId,
          childSessionId,
          ownerSessionId: rootSessionId,
          ownerBranchGeneration: lineage.branchGeneration,
          ownerSessionsById: new Map([
            [rootSessionId, owner],
            [childSessionId, child],
          ]),
          contracts,
          receipts,
          terminals,
        }),
      ).toMatchObject({
        status: "verified",
        passedCriterionIds: ["sqlite-projection"],
        failedCriterionIds: [],
        missingCriterionIds: [],
      });
      expect(contracts.length + receipts.length + terminals.length).toBe(3);
    } finally {
      runtime?.beginShutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createRuntime(input: {
  eventStore: InMemorySessionEventStore;
  registry: InMemoryRuntimeTaskRegistry;
  rootSessionId: ReturnType<typeof createSessionId>;
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  workingDirectory: string;
}): AgentRuntime {
  return new AgentRuntime(
    input.rootSessionId,
    {
      mode: "build",
      workingDirectory: input.workingDirectory,
      memory: { enabled: false },
      compact: { enabled: false },
    },
    {
      eventStore: input.eventStore,
      runtimeTaskRegistry: input.registry,
      sessionStore: input.store,
      modelFactory: createTestModelFactory({}),
    },
  );
}

function createPrismArtifact(
  commandSha256: string,
  childSessionId: ReturnType<typeof createSessionId>,
) {
  const evidence = {
    schema: PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA,
    childSessionId,
    commandSha256,
    scheduledEventId: "sqlite-scheduled-event",
    scheduledSequence: 1,
    resultEventId: "sqlite-result-event",
    resultSequence: 2,
    toolCallId: "sqlite-tool-call",
    turnId: createTurnId("prism-sqlite-child-turn"),
    status: "completed" as const,
    exitCode: 0,
  };
  const canonical = JSON.stringify([
    evidence.schema,
    evidence.childSessionId,
    evidence.commandSha256,
    evidence.scheduledEventId,
    evidence.scheduledSequence,
    evidence.resultEventId,
    evidence.resultSequence,
    evidence.toolCallId,
    evidence.turnId,
    evidence.status,
    evidence.exitCode,
  ]);
  return {
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
    bytes: Buffer.byteLength(canonical, "utf8"),
    evidence,
  };
}

function hashCommand(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}
