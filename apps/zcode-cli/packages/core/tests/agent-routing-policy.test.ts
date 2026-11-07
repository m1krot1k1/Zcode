import { describe, expect, it, vi } from "vitest";
import { createSessionId, modelMessageContentToText } from "@zcode/contracts";
import { agentToolEntry, taskToolEntry } from "../src/tool/handlers/agent.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const completedOutput = (agentType: string) => ({
  status: "completed" as const,
  agentId: "agent-1",
  agentType,
  description: "delegate",
  prompt: "do the work",
  content: [{ type: "text" as const, text: "done" }],
  totalToolUseCount: 0,
  totalDurationMs: 1,
});

function createContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "sess_parent" as never,
    toolCallId: "toolu_agent_routing",
    traceId: "trace_parent" as never,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    subagentPort: {
      launch: vi.fn(async () => completedOutput("orchestrator")),
    },
    ...overrides,
  } as ToolExecutionContext;
}

const TASK_GRAPH = {
  nodes: [
    {
      id: "alpha",
      description: "Read alpha",
      prompt: "Read alpha",
      subagent_type: "researcher",
    },
  ],
};

const graphWithNode = (subagentType: string, id = "alpha") => ({
  nodes: [
    {
      id,
      description: `Run ${subagentType}`,
      prompt: `Run ${subagentType}`,
      subagent_type: subagentType,
    },
  ],
});

describe("Agent/Task caller routing policy", () => {
  it.each([
    ["Agent", agentToolEntry],
    ["Task", taskToolEntry],
  ] as const)("%s rejects start -> coder before spawn", async (_name, entry) => {
    const launch = vi.fn();
    await expect(
      entry.handler(
        { description: "delegate", prompt: "implement", subagent_type: "coder" },
        createContext({
          callerAgentType: "start",
          availableAgentTypes: ["orchestrator"],
          subagentPort: { launch } as never,
        }),
      ),
    ).rejects.toThrow("Agent type 'coder' is not available to start");
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects start -> coder even when a stale catalog still lists it", async () => {
    const launch = vi.fn();
    await expect(
      agentToolEntry.handler(
        { description: "delegate", prompt: "implement", subagent_type: "coder" },
        createContext({
          callerAgentType: "start",
          availableAgentTypes: ["orchestrator", "coder"],
          subagentPort: { launch } as never,
        }),
      ),
    ).rejects.toThrow("start must delegate through Task(orchestrator)");
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["start", "orchestrator"])("rejects coder -> %s before spawn", async (target) => {
    const launch = vi.fn();
    await expect(
      agentToolEntry.handler(
        { description: "delegate", prompt: "route", subagent_type: target },
        createContext({
          callerAgentType: "coder",
          availableAgentTypes: ["coder", "researcher", "orchestrator", "start"],
          subagentPort: { launch } as never,
        }),
      ),
    ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it("lets a worker delegate to another worker", async () => {
    const launch = vi.fn(async () => completedOutput("coder"));
    await agentToolEntry.handler(
      { description: "delegate", prompt: "implement", subagent_type: "coder" },
      createContext({
        callerAgentType: "coder",
        availableAgentTypes: ["coder", "researcher"],
        subagentPort: { launch } as never,
      }),
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each(["coder", "implementer"] as const)(
    "lets %s delegate bounded evidence to researcher",
    async (callerAgentType) => {
      const launch = vi.fn(async () => completedOutput("researcher"));
      await agentToolEntry.handler(
        {
          description: "collect evidence",
          prompt: "inspect one call site",
          subagent_type: "researcher",
        },
        createContext({
          callerAgentType,
          availableAgentTypes: ["researcher"],
          subagentPort: { launch } as never,
        }),
      );
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );

  it("lets the root delegate to start", async () => {
    const launch = vi.fn(async () => completedOutput("start"));
    await agentToolEntry.handler(
      { description: "delegate", prompt: "route", subagent_type: "start" },
      createContext({
        availableAgentTypes: ["start", "orchestrator", "coder"],
        subagentPort: { launch } as never,
      }),
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("lets reviewer delegate bounded evidence to researcher", async () => {
    const launch = vi.fn(async () => completedOutput("researcher"));
    await agentToolEntry.handler(
      { description: "collect evidence", prompt: "inspect one call site", subagent_type: "researcher" },
      createContext({
        callerAgentType: "reviewer",
        availableAgentTypes: ["researcher"],
        subagentPort: { launch } as never,
      }),
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rejects reviewer -> coder", async () => {
    const launch = vi.fn();
    await expect(
      agentToolEntry.handler(
        { description: "delegate", prompt: "implement", subagent_type: "coder" },
        createContext({
          callerAgentType: "reviewer",
          availableAgentTypes: ["researcher", "coder"],
          subagentPort: { launch } as never,
        }),
      ),
    ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects reviewer -> test-engineer before spawn", async () => {
    const launch = vi.fn();
    await expect(
      agentToolEntry.handler(
        { description: "delegate", prompt: "run the tests", subagent_type: "test-engineer" },
        createContext({
          callerAgentType: "reviewer",
          availableAgentTypes: ["researcher", "test-engineer"],
          subagentPort: { launch } as never,
        }),
      ),
    ).rejects.toThrow("not available to reviewer");
    expect(launch).not.toHaveBeenCalled();
  });

  it("lets researcher delegate nested research", async () => {
    const launch = vi.fn(async () => completedOutput("researcher"));
    await agentToolEntry.handler(
      { description: "nested research", prompt: "inspect one module", subagent_type: "researcher" },
      createContext({
        callerAgentType: "researcher",
        availableAgentTypes: ["researcher"],
        subagentPort: { launch } as never,
      }),
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rejects researcher -> coder", async () => {
    const launch = vi.fn();
    await expect(
      agentToolEntry.handler(
        { description: "delegate", prompt: "implement", subagent_type: "coder" },
        createContext({
          callerAgentType: "researcher",
          availableAgentTypes: ["researcher", "coder"],
          subagentPort: { launch } as never,
        }),
      ),
    ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it("lets start delegate to orchestrator", async () => {
    const launch = vi.fn(async () => completedOutput("orchestrator"));

    await agentToolEntry.handler(
      { description: "delegate", prompt: "route the work", subagent_type: "orchestrator" },
      createContext({
        callerAgentType: "start",
        availableAgentTypes: ["orchestrator"],
        subagentPort: { launch } as never,
      }),
    );

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ agentType: "orchestrator" });
  });

  it.each([
    ["Agent", agentToolEntry],
    ["Task", taskToolEntry],
  ] as const)("%s rejects task_graph from start with the routing message", async (_name, entry) => {
    const launch = vi.fn();
    const runTaskDag = vi.fn();

    await expect(
      entry.handler(
        {
          description: "orchestrate",
          prompt: "run the graph",
          subagent_type: "orchestrator",
          task_graph: TASK_GRAPH,
        },
        createContext({
          callerAgentType: "start",
          availableAgentTypes: ["orchestrator"],
          subagentPort: { launch, runTaskDag } as never,
        }),
      ),
    ).rejects.toThrow("start must use Task(orchestrator), not task_graph");
    expect(runTaskDag).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([undefined, "orchestrator"])(
    "keeps task_graph available for %s",
    async (callerAgentType) => {
      const runTaskDag = vi.fn(async () => completedOutput("orchestrator"));

      await agentToolEntry.handler(
        {
          description: "orchestrate",
          prompt: "run the graph",
          // orchestrator cannot re-enter a router role, so its DAG root is a worker role.
          subagent_type: callerAgentType === undefined ? "orchestrator" : "researcher",
          task_graph: TASK_GRAPH,
        },
        createContext({
          ...(callerAgentType === undefined ? {} : { callerAgentType }),
          ...(callerAgentType === undefined
            ? {}
            : { availableAgentTypes: ["researcher", "coder", "test-engineer"] }),
          subagentPort: { runTaskDag } as never,
        }),
      );

      expect(runTaskDag).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["start", "orchestrator"])(
    "rejects an orchestrator task_graph node with subagent_type %s",
    async (nodeType) => {
      const runTaskDag = vi.fn();

      await expect(
        agentToolEntry.handler(
          {
            description: "orchestrate",
            prompt: "run the graph",
            subagent_type: "researcher",
            task_graph: graphWithNode(nodeType),
          },
          createContext({
            callerAgentType: "orchestrator",
            availableAgentTypes: ["researcher", "coder", "test-engineer"],
            subagentPort: { runTaskDag } as never,
          }),
        ),
      ).rejects.toThrow(
        `Agent type '${nodeType}' is not available to orchestrator. task_graph node 'alpha' must delegate to a worker role`,
      );
      expect(runTaskDag).not.toHaveBeenCalled();
    },
  );

  it("allows an orchestrator task_graph with a worker node", async () => {
    const runTaskDag = vi.fn(async () => completedOutput("researcher"));

    await agentToolEntry.handler(
      {
        description: "orchestrate",
        prompt: "run the graph",
        subagent_type: "researcher",
        task_graph: graphWithNode("coder"),
      },
      createContext({
        callerAgentType: "orchestrator",
        availableAgentTypes: ["researcher", "coder", "test-engineer"],
        subagentPort: { runTaskDag } as never,
      }),
    );

    expect(runTaskDag).toHaveBeenCalledTimes(1);
  });

  it("allows a root task_graph with a worker node", async () => {
    const runTaskDag = vi.fn(async () => completedOutput("orchestrator"));

    await agentToolEntry.handler(
      {
        description: "orchestrate",
        prompt: "run the graph",
        subagent_type: "orchestrator",
        task_graph: graphWithNode("coder"),
      },
      createContext({
        availableAgentTypes: ["orchestrator", "researcher", "coder", "test-engineer"],
        subagentPort: { runTaskDag } as never,
      }),
    );

    expect(runTaskDag).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown task_graph node role before runTaskDag", async () => {
    const runTaskDag = vi.fn();

    await expect(
      agentToolEntry.handler(
        {
          description: "orchestrate",
          prompt: "run the graph",
          subagent_type: "orchestrator",
          task_graph: graphWithNode("stale-role"),
        },
        createContext({
          availableAgentTypes: ["orchestrator", "researcher", "coder"],
          subagentPort: { runTaskDag } as never,
        }),
      ),
    ).rejects.toThrow("task_graph node 'alpha' uses an unknown agent type 'stale-role'");
    expect(runTaskDag).not.toHaveBeenCalled();
  });

  it("lets orchestrator delegate to a worker", async () => {
    const launch = vi.fn(async () => completedOutput("coder"));

    await agentToolEntry.handler(
      { description: "delegate", prompt: "implement", subagent_type: "coder" },
      createContext({
        callerAgentType: "orchestrator",
        availableAgentTypes: ["researcher", "coder", "test-engineer"],
        subagentPort: { launch } as never,
      }),
    );

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rejects orchestrator -> orchestrator and orchestrator -> start", async () => {
    for (const forbidden of ["start", "orchestrator"]) {
      const launch = vi.fn();
      await expect(
        agentToolEntry.handler(
          { description: "delegate", prompt: "route", subagent_type: forbidden },
          createContext({
            callerAgentType: "orchestrator",
            availableAgentTypes: ["researcher", "coder"],
            subagentPort: { launch } as never,
          }),
        ),
      ).rejects.toThrow("must delegate to worker roles");
      expect(launch).not.toHaveBeenCalled();
    }
  });

  it("rejects an unresolvable role from the runtime catalog before spawn", async () => {
    const launch = vi.fn();
    const runtime = createTestAgentRuntime(
      createSessionId("agent-routing-unknown-role"),
      { mode: "yolo", titleGeneration: { enabled: false }, compact: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        subagentPort: { launch } as never,
      },
    );

    const result = await runtime.getToolExecutor().execute({
      id: "call_unknown_role",
      name: "Agent",
      input: { description: "delegate", prompt: "inspect", subagent_type: "stale-role" },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Agent type 'stale-role' not found");
    expect(launch).not.toHaveBeenCalled();
  });

  it("uses the start-scoped runtime catalog for admission", async () => {
    const launch = vi.fn(async () => completedOutput("orchestrator"));
    const runtime = createTestAgentRuntime(
      createSessionId("agent-routing-start-runtime"),
      {
        mode: "yolo",
        agentType: "start",
        titleGeneration: { enabled: false },
        compact: { enabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        subagentPort: { launch } as never,
      },
    );

    const rejected = await runtime.getToolExecutor().execute({
      id: "call_start_coder",
      name: "Agent",
      input: { description: "delegate", prompt: "implement", subagent_type: "coder" },
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.message).toContain("not available to start");

    const accepted = await runtime.getToolExecutor().execute({
      id: "call_start_orchestrator",
      name: "Agent",
      input: { description: "delegate", prompt: "route", subagent_type: "orchestrator" },
    });
    expect(accepted.success).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("stamps the child runtime with its routing identity from the spawn request", async () => {
    let rootCalls = 0;
    let childCalls = 0;
    let childSawRejection = false;

    const runtime = createTestAgentRuntime(
      createSessionId("agent-routing-child-identity"),
      {
        mode: "yolo",
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        compact: { enabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const isChild =
              observation.invocationContext?.metadata?.querySource === "subagent";
            if (!isChild) {
              rootCalls += 1;
              if (rootCalls === 1) {
                return {
                  text: "",
                  finishReason: "tool-calls",
                  usage: {},
                  toolCalls: [
                    {
                      id: "root_task_start",
                      name: "Task",
                      input: {
                        description: "route",
                        prompt: "route the work",
                        subagent_type: "start",
                      },
                    },
                  ],
                };
              }
              return { text: "root done", finishReason: "stop", usage: {} };
            }

            childCalls += 1;
            if (childCalls === 1) {
              return {
                text: "",
                finishReason: "tool-calls",
                usage: {},
                toolCalls: [
                  {
                    id: "child_task_coder",
                    name: "Task",
                    input: {
                      description: "implement",
                      prompt: "implement directly",
                      subagent_type: "coder",
                    },
                  },
                ],
              };
            }
            const toolText = request.messages
              .filter((message) => message.role === "tool")
              .map((message) => modelMessageContentToText(message.content))
              .join("\n");
            childSawRejection = toolText.includes("not available to start");
            return { text: "start child report", finishReason: "stop", usage: {} };
          },
        }),
      },
    );

    await runtime.executeTurn("route the work");

    expect(childCalls).toBe(2);
    expect(childSawRejection).toBe(true);
  });
});
