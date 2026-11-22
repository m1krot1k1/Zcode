import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
  PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
  SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
  SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
  createSessionEvent,
  STREAM_RECOVERY_DISCARDED_FINISH,
  type MessageWithParts,
  type SessionEvent,
  type SessionEntryInfo,
  type SessionInfo,
  type SessionProjection,
  type ToolPart,
} from "@zcode/contracts";
import {
  isOwnedSubagentChild,
  paginateEndedSubagents,
  projectSessionSubagents,
  resolvePrismAcceptanceByChildSessionId,
} from "../src/app/subagent-observation/index.js";
import { createPrismTaskContract, evaluatePrismTaskAcceptance } from "@zcode/core";
import { zcodeSessionSubagentsResultSchema } from "@zcode/shared";

function prismHistory(input: {
  root: SessionInfo;
  child: SessionInfo;
  taskId: string;
  turnId: string;
  parentTaskId?: string;
  branchGeneration?: number;
}) {
  const commandSha256 = createHash("sha256").update("pnpm typecheck", "utf8").digest("hex");
  const attemptId = `attempt-${input.taskId}`;
  const rootRunId = `${input.root.id}:${input.turnId}`;
  const branchGeneration = input.branchGeneration ?? 0;
  const current = {
    rootRunId,
    taskId: input.taskId,
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    attemptId,
    branchGeneration,
  };
  const contract = createPrismTaskContract({
    ...current,
    description: "Run the required typecheck",
    criteria: [
      {
        id: "typecheck",
        description: "The exact command exits successfully",
        evaluatorId: PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
        evaluatorVersion: PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION,
        check: { kind: "bash_exit_code", commandSha256, expectedExitCode: 0 },
      },
    ],
  });
  const turnId = input.turnId as never;
  const traceId = `trace-${input.taskId}` as never;
  const toolCallId = `bash-${input.taskId}`;
  const events = [
    createSessionEvent(
      SessionEventType.ToolCallScheduled,
      input.child.id,
      { toolCallId, toolName: "Bash", input: { command: "pnpm typecheck" } },
      { turnId, traceId, sequenceNumber: 1 },
    ),
    createSessionEvent(
      SessionEventType.ToolCallResult,
      input.child.id,
      {
        toolCallId,
        result: {
          success: true,
          content: "typecheck passed",
          executionEvidence: {
            kind: "bash_process",
            commandSha256,
            status: "completed",
            exitCode: 0,
          },
        },
        duration: 1,
      },
      { turnId, traceId, sequenceNumber: 2 },
    ),
  ];
  const evaluation = evaluatePrismTaskAcceptance({
    contract,
    current,
    childSessionId: input.child.id,
    events,
    observedAt: 123,
  });
  const terminal = {
    schema: "zcode.prism.subagent-terminal.v3",
    terminalId: `${rootRunId}/${input.taskId}/${branchGeneration}/${attemptId}`,
    rootRunId,
    taskId: input.taskId,
    attemptId,
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    branchGeneration,
    childSessionId: input.child.id,
    childStarted: true,
    terminalStatus: "completed",
    provenance: "runtime_lifecycle",
    acceptanceStatus: evaluation.decision.status,
    observedAt: new Date(123),
  } as const;
  const entry = (id: string, type: string, data: unknown): SessionEntryInfo => ({
    id,
    type,
    sessionID: input.root.id,
    time: { created: 1, updated: 1 },
    data,
  });
  return {
    rootRunId,
    contract,
    receipts: evaluation.receipts.map((receipt) =>
      entry(
        `prism-evidence-receipt:${input.root.id}:${receipt.receiptId}`,
        SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
        { receipt },
      ),
    ),
    contractEntry: entry(
      `prism-task-contract:${input.root.id}:${rootRunId}:${input.taskId}:${attemptId}`,
      SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
      { contract },
    ),
    terminalEntry: entry(
      `prism-task-terminal:${input.root.id}:${terminal.terminalId}`,
      SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
      { terminal },
    ),
  };
}

function session(
  id: string,
  taskType: SessionInfo["taskType"] = "subagent_child",
  parentID?: string,
): SessionInfo {
  return {
    id: id as SessionInfo["id"],
    projectID: "project" as SessionInfo["projectID"],
    ...(parentID ? { parentID: parentID as SessionInfo["id"] } : {}),
    taskType,
    slug: id,
    directory: "/workspace",
    title: id,
    version: "test",
    time: { created: 1, updated: 100 },
  };
}

function toolMessage(input: {
  childSessionId?: string;
  id: string;
  ownerSessionId?: string;
  output?: Record<string, unknown> | string;
  runInBackground?: boolean;
  state?: "completed" | "error" | "running";
  tool?: string;
  agentId?: string;
  turnId?: string;
}): MessageWithParts {
  const state = input.state ?? "completed";
  const ownerSessionId = input.ownerSessionId ?? "parent";
  const common = {
    input: {
      description: `Description ${input.id}`,
      subagent_type: "Explore",
      ...(input.runInBackground ? { run_in_background: true } : {}),
    },
    metadata: {
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
    time: state === "running" ? { start: 10 } : { start: 10, end: 20 },
  };
  const part: ToolPart = {
    id: `part-${input.id}` as ToolPart["id"],
    sessionID: ownerSessionId as ToolPart["sessionID"],
    messageID: input.id as ToolPart["messageID"],
    type: "tool",
    callID: `call-${input.id}`,
    tool: input.tool ?? "Agent",
    state:
      state === "running"
        ? { ...common, status: "running" }
        : state === "error"
          ? { ...common, status: "error", error: "Provider failed" }
          : {
              ...common,
              status: "completed",
              output:
                typeof input.output === "string"
                  ? input.output
                  : JSON.stringify(input.output ?? { result: `Summary ${input.id}` }),
              title: `Description ${input.id}`,
            },
  };
  return {
    info: {
      id: input.id as never,
      sessionID: ownerSessionId as never,
      role: "assistant",
      time: { created: 10, completed: 20 },
      parentID: "user" as never,
      modelID: "model" as never,
      providerID: "provider" as never,
      mode: "build",
      agent: "zcode",
      ...(input.turnId ? { anchor: { turnId: input.turnId as never } } : {}),
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part],
  };
}

function projection(status: SessionProjection["status"]): SessionProjection {
  return {
    id: "child" as never,
    createdAt: new Date(1),
    updatedAt: new Date(2),
    mode: "build",
    status,
    turnCount: 1,
    totalTokenCount: 0,
    contextUsed: 0,
    contextWindow: 1,
    pendingPermissions: [],
    pendingSteerInputs: [],
    activeToolCalls: [],
    streamingToolLedger: [],
    backgroundTasks: [],
    targetCompletionVerifications: [],
    targetCompletionVerificationTimeline: [],
  };
}

function subagentEvent(
  type: typeof SessionEventType.SubagentSpawned | typeof SessionEventType.SubagentStopped,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: "event" as never,
    sessionId: "parent" as never,
    type,
    timestamp: new Date(15),
    traceId: "trace" as never,
    sequenceNumber: 1,
    payload,
  };
}

describe("subagent session query", () => {
  it("requires exact parent ownership for a persisted child row", () => {
    const parent = session("owner-a", "interactive");
    const child = session("child-a", "subagent_child", parent.id);
    const foreignChild = session("child-b", "subagent_child", "owner-b");

    expect(isOwnedSubagentChild(parent.id, child)).toBe(true);
    expect(isOwnedSubagentChild(parent.id, foreignChild)).toBe(false);
    expect(
      isOwnedSubagentChild(parent.id, session("workflow-child", "workflow_child", parent.id)),
    ).toBe(false);
  });

  it("projects Agent and legacy Task refs but omits non-persisted children", () => {
    const result = projectSessionSubagents({
      revision: 3,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({ childSessionId: "child-agent", id: "m1" }),
        toolMessage({ childSessionId: "child-task", id: "m2", tool: "Task" }),
        toolMessage({ childSessionId: "missing", id: "m3" }),
      ],
      childSessionsById: new Map([
        ["child-agent", session("child-agent")],
        ["child-task", session("child-task")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.running).toEqual([]);
    expect(result.ended.map((item) => item.childSessionId)).toEqual(["child-task", "child-agent"]);
    expect(result.ended[0]).toMatchObject({
      status: "success",
      subagentType: "Explore",
      summary: "Summary m2",
    });
  });

  it("uses live child and background state without duplicating the persisted ref", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-1",
        taskKind: "subagent",
        childSessionId: "child-1",
        blocked: true,
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 4,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId: "child-1", id: "m1", state: "running" })],
      childSessionsById: new Map([["child-1", session("child-1")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map([["child-1", projection("waiting")]]),
      parentProjection,
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-1", status: "blocked" }),
    ]);
  });

  it("uses live spawn events for foreground children before the Agent result is persisted", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-live",
        taskKind: "subagent",
        childSessionId: "child-live",
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 5,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ id: "m1", state: "running" })],
      childSessionsById: new Map([["child-live", session("child-live")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-live",
          agentType: "Explore",
          childSessionId: "child-live",
          parentToolCallId: "call-m1",
          description: "Live foreground Agent",
        }),
      ],
      parentProjection,
    });

    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-live", status: "running" }),
    ]);
  });

  it("keeps a launched background child running when a partial projection omits its task", () => {
    const childSessionId = "sess_subagent_agent-keepalive";
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-keepalive\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("does not treat a completed child tool-call model step as a terminal child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-tool";
    const childToolStep = toolMessage({
      id: "child-tool-step",
      state: "running",
      tool: "Bash",
    });
    childToolStep.info.time.completed = 30;
    childToolStep.info.finish = "tool-calls";

    const result = projectSessionSubagents({
      revision: 7,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-tool\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [childToolStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-tool",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child tool Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("does not treat a stream recovery discarded child step as a failed child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-discarded";
    const discardedStep = toolMessage({ id: "child-discarded", state: "running", tool: "Bash" });
    discardedStep.parts = [];
    discardedStep.info.time.completed = 30;
    discardedStep.info.finish = STREAM_RECOVERY_DISCARDED_FINISH;
    discardedStep.info.error = {
      name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
      data: { message: "Partial assistant output was discarded before a streaming retry." },
    };

    const result = projectSessionSubagents({
      revision: 8,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-discarded\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [discardedStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-discarded",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child discarded Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("derives the persisted foreground child id from the completed Agent output agentId", () => {
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          id: "m1",
          output: { agentId: "agent-foreground", result: "Finished foreground work" },
        }),
      ],
      childSessionsById: new Map([
        ["sess_subagent_agent-foreground", session("sess_subagent_agent-foreground")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([
      expect.objectContaining({
        childSessionId: "sess_subagent_agent-foreground",
        summary: "Finished foreground work",
        status: "success",
      }),
    ]);
  });

  it("projects an ended PRISM child as unknown before a terminal entry is durable", async () => {
    const root = session("prism-root", "interactive");
    const child = session("prism-child", "subagent_child", root.id);
    const messages = [
      toolMessage({
        childSessionId: child.id,
        agentId: "prism-task",
        turnId: "prism-turn",
        id: "prism-launch",
      }),
    ];
    const entry: SessionEntryInfo = {
      id: "contract-prism-task",
      sessionID: root.id,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
      time: { created: 1, updated: 1 },
      data: { contract: { taskId: "prism-task", rootRunId: `${root.id}:prism-turn` } },
    };
    const sessionStore = {
      getSession: vi.fn(async () => null),
      messages: vi.fn(async () => messages),
      sessionEntries: vi.fn(async () => [entry]),
    };
    const projectionInput = {
      revision: 1,
      parentSession: root,
      messages,
      childSessionsById: new Map([[child.id, child]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    };
    const initial = projectSessionSubagents(projectionInput);
    const acceptance = await resolvePrismAcceptanceByChildSessionId({
      sessionStore,
      ownerSession: root,
      ownerMessages: messages,
      endedSubagents: initial.ended,
      childSessionsById: projectionInput.childSessionsById,
    });
    const projected = projectSessionSubagents({
      ...projectionInput,
      prismAcceptanceByChildSessionId: acceptance,
    });

    expect(projected.ended[0]?.prismAcceptance).toEqual({
      status: "unknown",
      passedCriteria: 0,
      totalCriteria: 0,
    });
  });

  it("projects a verified historical badge into a protocol-valid direct-child response", async () => {
    const root = session("prism-verified-root", "interactive");
    const child = session("prism-verified-child", "subagent_child", root.id);
    const taskId = "verified-task";
    const turnId = "verified-turn";
    const messages = [
      toolMessage({
        childSessionId: child.id,
        agentId: taskId,
        turnId,
        ownerSessionId: root.id,
        id: "verified-launch",
      }),
    ];
    const history = prismHistory({ root, child, taskId, turnId });
    const entries = [history.contractEntry, ...history.receipts, history.terminalEntry];
    const sessionStore = {
      getSession: vi.fn(async () => null),
      messages: vi.fn(async () => messages),
      sessionEntries: vi.fn(async ({ type }: { type: string }) =>
        entries.filter((entry) => entry.type === type),
      ),
    };
    const projectionInput = {
      revision: 7,
      parentSession: root,
      messages,
      childSessionsById: new Map([[child.id, child]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    };
    const initial = projectSessionSubagents(projectionInput);
    const acceptance = await resolvePrismAcceptanceByChildSessionId({
      sessionStore,
      ownerSession: root,
      ownerMessages: messages,
      endedSubagents: initial.ended,
      childSessionsById: projectionInput.childSessionsById,
    });
    const projection = projectSessionSubagents({
      ...projectionInput,
      prismAcceptanceByChildSessionId: acceptance,
    });
    const response = {
      revision: projection.revision,
      childSessionIds: [child.id],
      running: projection.running,
      ended: { total: projection.ended.length, items: projection.ended },
    };

    expect(acceptance.get(child.id)).toEqual({
      status: "verified",
      passedCriteria: 1,
      totalCriteria: 1,
    });
    expect(zcodeSessionSubagentsResultSchema.safeParse(response).success).toBe(true);
  });

  it("verifies a nested leaf when its parent has a terminal but no PRISM contract", async () => {
    const root = session("prism-nested-verified-root", "interactive");
    const middle = session("prism-nested-verified-middle", "subagent_child", root.id);
    const leaf = session("prism-nested-verified-leaf", "subagent_child", middle.id);
    const rootTurnId = "nested-root-turn";
    const parentTaskId = "parent-agent";
    const taskId = "nested-verified-task";
    const rootMessages = [
      toolMessage({
        childSessionId: middle.id,
        agentId: parentTaskId,
        turnId: rootTurnId,
        ownerSessionId: root.id,
        id: "nested-parent-launch",
      }),
    ];
    const ownerMessages = [
      toolMessage({
        childSessionId: leaf.id,
        agentId: taskId,
        ownerSessionId: middle.id,
        id: "nested-leaf-launch",
      }),
    ];
    const history = prismHistory({
      root,
      child: leaf,
      taskId,
      turnId: rootTurnId,
      parentTaskId,
    });
    const parentTerminal = {
      schema: "zcode.prism.subagent-terminal.v3",
      terminalId: `${history.rootRunId}/${parentTaskId}/0/parent-attempt`,
      rootRunId: history.rootRunId,
      taskId: parentTaskId,
      attemptId: "parent-attempt",
      branchGeneration: 0,
      childSessionId: middle.id,
      childStarted: true,
      terminalStatus: "completed",
      provenance: "runtime_lifecycle",
      acceptanceStatus: "unknown",
      observedAt: new Date(321),
    };
    const parentTerminalEntry: SessionEntryInfo = {
      id: `prism-task-terminal:${root.id}:${parentTerminal.terminalId}`,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
      sessionID: root.id,
      time: { created: 1, updated: 1 },
      data: { terminal: parentTerminal },
    };
    const entries = [
      history.contractEntry,
      ...history.receipts,
      history.terminalEntry,
      parentTerminalEntry,
    ];
    const sessionStore = {
      getSession: vi.fn(async (id: SessionInfo["id"]) => (id === root.id ? root : null)),
      messages: vi.fn(async ({ sessionID }: { sessionID: SessionInfo["id"] }) =>
        sessionID === root.id ? rootMessages : [],
      ),
      sessionEntries: vi.fn(async ({ type }: { type: string }) =>
        entries.filter((entry) => entry.type === type),
      ),
    };
    const projectionInput = {
      revision: 8,
      parentSession: middle,
      messages: ownerMessages,
      childSessionsById: new Map([[leaf.id, leaf]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    };
    const initial = projectSessionSubagents(projectionInput);
    const acceptance = await resolvePrismAcceptanceByChildSessionId({
      sessionStore,
      ownerSession: middle,
      ownerMessages,
      endedSubagents: initial.ended,
      childSessionsById: projectionInput.childSessionsById,
    });

    expect(acceptance.get(leaf.id)).toEqual({
      status: "verified",
      passedCriteria: 1,
      totalCriteria: 1,
    });
  });

  it("resolves nested PRISM root run through the active parent launch chain", async () => {
    const root = session("prism-nested-root", "interactive");
    const middle = session("prism-nested-middle", "subagent_child", root.id);
    const child = session("prism-nested-leaf", "subagent_child", middle.id);
    const rootMessages = [
      toolMessage({
        childSessionId: middle.id,
        agentId: "parent-task",
        turnId: "root-turn",
        id: "parent-launch",
      }),
    ];
    const ownerMessages = [
      toolMessage({
        childSessionId: child.id,
        agentId: "nested-task",
        id: "nested-launch",
      }),
    ];
    const entry: SessionEntryInfo = {
      id: "contract-nested-task",
      sessionID: root.id,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
      time: { created: 1, updated: 1 },
      data: {
        contract: {
          taskId: "nested-task",
          parentTaskId: "parent-task",
          rootRunId: `${root.id}:root-turn`,
        },
      },
    };
    const sessionStore = {
      getSession: vi.fn(async (id: SessionInfo["id"]) => (id === root.id ? root : null)),
      messages: vi.fn(async ({ sessionID }: { sessionID: SessionInfo["id"] }) =>
        sessionID === root.id ? rootMessages : [],
      ),
      sessionEntries: vi.fn(async () => [entry]),
    };
    const projectionInput = {
      revision: 2,
      parentSession: middle,
      messages: ownerMessages,
      childSessionsById: new Map([[child.id, child]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    };
    const initial = projectSessionSubagents(projectionInput);
    const acceptance = await resolvePrismAcceptanceByChildSessionId({
      sessionStore,
      ownerSession: middle,
      ownerMessages,
      endedSubagents: initial.ended,
      childSessionsById: projectionInput.childSessionsById,
    });

    expect(acceptance.get(child.id)).toMatchObject({
      status: "unknown",
      passedCriteria: 0,
      totalCriteria: 0,
    });
    expect(sessionStore.messages).toHaveBeenCalledWith({ sessionID: root.id });
  });

  it("stops on cyclic owner ancestry and keeps the directory query bounded", async () => {
    const first = session("cycle-first", "subagent_child", "cycle-second");
    const second = session("cycle-second", "subagent_child", "cycle-first");
    const sessionStore = {
      getSession: vi.fn(async (id: SessionInfo["id"]) =>
        id === first.id ? first : id === second.id ? second : null,
      ),
      messages: vi.fn(async () => []),
      sessionEntries: vi.fn(async () => []),
    };

    const result = await resolvePrismAcceptanceByChildSessionId({
      sessionStore,
      ownerSession: first,
      ownerMessages: [],
      endedSubagents: [
        {
          childSessionId: "cycle-child",
          agentId: "cycle-task",
          subagentType: "Explore",
          title: "Cycle",
          status: "success",
        },
      ],
      childSessionsById: new Map(),
    });

    expect(result.size).toBe(0);
    expect(sessionStore.getSession).toHaveBeenCalledTimes(2);
    expect(sessionStore.sessionEntries).not.toHaveBeenCalled();
  });

  it("omits optional badges when persisted PRISM metadata cannot be read", async () => {
    const root = session("prism-read-failure-root", "interactive");
    const onReadError = vi.fn();
    const sessionStore = {
      getSession: vi.fn(async () => null),
      messages: vi.fn(async () => []),
      sessionEntries: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    };

    const result = await resolvePrismAcceptanceByChildSessionId({
      sessionStore,
      ownerSession: root,
      ownerMessages: [],
      endedSubagents: [
        {
          childSessionId: "child-prism-read-failure",
          agentId: "task-prism-read-failure",
          subagentType: "Explore",
          title: "Read failure",
          status: "success",
        },
      ],
      childSessionsById: new Map(),
      onReadError,
    });

    expect(result.size).toBe(0);
    expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it("paginates ended children newest-first with an opaque cursor", () => {
    const ended = Array.from({ length: 25 }, (_, index) => ({
      childSessionId: `child-${index}`,
      subagentType: "Explore",
      title: `Child ${index}`,
      status: "success" as const,
      endedAt: 100 - index,
    }));
    const first = paginateEndedSubagents(ended, { limit: 20 });
    const second = paginateEndedSubagents(ended, { cursor: first.nextCursor, limit: 20 });

    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    expect(second.items.map((item) => item.childSessionId)).toEqual([
      "child-20",
      "child-21",
      "child-22",
      "child-23",
      "child-24",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });
});
