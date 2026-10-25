import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createModelId,
  createModelProviderId,
  createSessionId,
  type SessionId,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("swarm planner to real AgentRuntime child sessions", () => {
  it("runs independent children concurrently, reads a fixture, and synthesizes their real session results", async () => {
    const rootSessionId = createSessionId("runtime-swarm-real-children");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const sessionStore = (await import("./subagent-test-store.js")).createRecordingSubagentSessionStore();
    const workspace = await mkdtemp(join(tmpdir(), "zcode-swarm-real-children-"));
    const fixturePath = join(workspace, "swarm-fixture.txt");
    const markers = {
      alpha: "SWARM_FIXTURE_ALPHA_73c1",
      beta: "SWARM_FIXTURE_BETA_94a8",
    } as const;
    const childBySession = new Map<SessionId, "alpha" | "beta">();
    const directChildSessions = new Set<SessionId>();
    const childStarted = new Set<SessionId>();
    const bothChildrenStarted = deferred<void>();
    const synthesisReceived = deferred<string>();
    const requestCountBySession = new Map<SessionId, number>();
    const descendantPlannerSessions = new Set<SessionId>();
    const splitPlannerSessions = new Set<SessionId>();
    const plannerWorkingDirectories: Array<string | undefined> = [];
    const plannerReasoningLevels: Array<string | undefined> = [];

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-swarm-integration-test"),
          modelId: createModelId("swarm-integration-test-model"),
          options: { reasoningLevel: "high" },
        },
        workingDirectory: workspace,
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        fileSystemPort: new MemoryFileSystem({
          [fixturePath]: `${markers.alpha}\n${markers.beta}\n`,
        }),
        eventSink: {
          onSessionEvent(event) {
            if (event.type !== SessionEventType.SubagentSpawned) return;
            const payload = event.payload as { childSessionId?: SessionId; description?: string };
            if (!payload.childSessionId || !payload.description) return;
            const node = payload.description.includes("alpha") ? "alpha" :
              payload.description.includes("beta") ? "beta" : undefined;
            if (node) {
              childBySession.set(payload.childSessionId, node);
              if (payload.description.startsWith("Read ")) directChildSessions.add(payload.childSessionId);
            }
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const callCount = (requestCountBySession.get(sessionId) ?? 0) + 1;
            requestCountBySession.set(sessionId, callCount);
            const requestText = request.messages.map((message) =>
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
            ).join("\n");

            if (requestText.includes("Decide whether this task needs independent parallel work")) {
              plannerWorkingDirectories.push(observation.invocationContext?.workingDirectory);
              plannerReasoningLevels.push(observation.model.options.reasoningLevel);
            }

            if (sessionId === rootSessionId && requestText.includes("Decide whether this task needs independent parallel work")) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: JSON.stringify({
                  decision: "split",
                  graph: {
                    max_parallel: 2,
                    nodes: [
                    {
                      id: "alpha",
                      description: "Read alpha marker",
                      prompt: `Read ${fixturePath} and report ${markers.alpha}.`,
                    },
                    {
                      id: "beta",
                      description: "Read beta marker",
                      prompt: `Read ${fixturePath} and report ${markers.beta}.`,
                    },
                    ],
                  },
                }),
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (sessionId !== rootSessionId && requestText.includes("Decide whether this task needs independent parallel work")) {
              descendantPlannerSessions.add(sessionId);
              const isGrandchild = requestText.includes("Grandchild alpha");
              const shouldSplit = nodeForPrompt(requestText, markers.alpha) && !isGrandchild;
              if (shouldSplit) {
                splitPlannerSessions.add(sessionId);
                return {
                  finishReason: "stop",
                  providerMetadata: undefined,
                  text: JSON.stringify({
                    decision: "split",
                    graph: {
                      max_parallel: 2,
                      nodes: [
                        {
                          id: "grandchild-alpha-one",
                          description: "Grandchild alpha one",
                          prompt: `Grandchild alpha one: read ${fixturePath} and report ${markers.alpha}.`,
                        },
                        {
                          id: "grandchild-alpha-two",
                          description: "Grandchild alpha two",
                          prompt: `Grandchild alpha two: read ${fixturePath} and report ${markers.alpha}.`,
                        },
                      ],
                    },
                  }),
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: JSON.stringify({ decision: "leaf", reason: isGrandchild ? "The fixture read is a single focused task." : "The beta fixture read is a single focused task." }),
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (sessionId === rootSessionId) {
              synthesisReceived.resolve(requestText);
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "Swarm synthesis completed from child reports.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            const node = childBySession.get(sessionId);
            if (!node) throw new Error(`Unexpected child runtime session: ${sessionId}`);
            if (callCount === 2) {
              if (splitPlannerSessions.has(sessionId)) {
                return {
                  finishReason: "stop",
                  providerMetadata: undefined,
                  text: `Alpha child synthesized nested reports containing ${markers.alpha}.`,
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              childStarted.add(sessionId);
              if (childStarted.size >= 2) bothChildrenStarted.resolve();
              await bothChildrenStarted.promise;
              const availableTools = (request.tools ?? []).map((tool) => tool.name);
              if (!availableTools.includes("Read")) {
                throw new Error(`Real child runtime does not expose Read; tools=${availableTools.join(",")}`);
              }
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: `call_read_swarm_fixture_${node}`,
                    name: "Read",
                    input: { file_path: fixturePath },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (!requestText.includes(markers[node])) {
              throw new Error(`Child ${node} did not receive its Read tool result`);
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `Read fixture marker ${markers[node]}.`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    try {
      const result = await runtime.executeTurn("Read both independent fixture markers using the swarm.", undefined, {
        intent: { orchestrationMode: "swarm" },
      });
      const rootEvents = await eventStore.getEvents(rootSessionId);
      const terminalSwarmEvent = rootEvents
        .filter((event) => event.type === SessionEventType.SwarmRunUpdated)
        .map((event) => event.payload as { status: string; childSessionIds?: string[] })
        .find((event) => event.status === "completed");
      const childSessionIds = [...childBySession.keys()];
      const childEvents = await Promise.all(childSessionIds.map((sessionId) => eventStore.getEvents(sessionId)));
      const descendantSwarmTerminals = childEvents.flat().filter((event) =>
        event.type === SessionEventType.SwarmRunUpdated &&
        (event.payload as { status?: string }).status === "completed",
      );
      const toolEvents = childEvents.flat().filter((event) =>
        event.type === SessionEventType.ToolCallScheduled || event.type === SessionEventType.ToolCallResult,
      );
      const synthesizedInput = await synthesisReceived.promise;

      expect(childStarted.size).toBe(3);
      expect(descendantPlannerSessions.size).toBe(4);
      expect(plannerWorkingDirectories).toEqual(Array(5).fill(workspace));
      expect(plannerReasoningLevels).toEqual(Array(5).fill("high"));
      expect(childSessionIds).toHaveLength(4);
      expect(new Set(childSessionIds).size).toBe(4);
      expect(directChildSessions.size).toBe(2);
      expect(childEvents).toHaveLength(4);
      expect(descendantSwarmTerminals).toHaveLength(4);
      expect(toolEvents.filter((event) => event.type === SessionEventType.ToolCallScheduled)).toHaveLength(3);
      expect(toolEvents.filter((event) => event.type === SessionEventType.ToolCallResult)).toHaveLength(3);
      for (const events of childEvents.filter((events) =>
        events.some((event) => event.type === SessionEventType.ToolCallScheduled),
      )) {
        expect(events.some((event) => event.type === SessionEventType.ToolCallScheduled)).toBe(true);
        expect(events.some((event) => event.type === SessionEventType.ToolCallResult)).toBe(true);
      }
      expect(terminalSwarmEvent?.childSessionIds).toEqual(expect.arrayContaining([...directChildSessions]));
      expect(terminalSwarmEvent?.childSessionIds).toHaveLength(2);
      const taskSnapshots = Object.values(runtimeTaskRegistry.all()).filter((snapshot) =>
        snapshot.type === "local_agent" && childSessionIds.includes(snapshot.childSessionId!),
      );
      expect(taskSnapshots).toHaveLength(4);
      expect(new Set(taskSnapshots.map((snapshot) => snapshot.rootRunId)).size).toBe(1);
      expect(taskSnapshots.every((snapshot) => typeof snapshot.rootRunId === "string")).toBe(true);
      const alphaParent = taskSnapshots.find((snapshot) => snapshot.description === "Read alpha marker");
      const alphaGrandchildren = taskSnapshots.filter((snapshot) => snapshot.description.startsWith("Grandchild alpha"));
      expect(alphaParent).toBeDefined();
      expect(alphaGrandchildren).toHaveLength(2);
      expect(alphaGrandchildren.every((snapshot) => snapshot.parentSessionId === alphaParent?.childSessionId)).toBe(true);
      expect(synthesizedInput).toContain(markers.alpha);
      expect(synthesizedInput).toContain(markers.beta);
      expect(result.response).toBe("Swarm synthesis completed from child reports.");
    } finally {
      await runtime.closeBrowserSession();
    }
  }, 30_000);

  it("persists failed child IDs and a bounded child failure reason on the terminal swarm row", async () => {
    const rootSessionId = createSessionId("runtime-swarm-failed-child");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const sessionStore = (await import("./subagent-test-store.js")).createRecordingSubagentSessionStore();
    const workspace = await mkdtemp(join(tmpdir(), "zcode-swarm-failed-child-"));
    const childDescriptions = new Map<SessionId, string>();
    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-swarm-failure-test"),
          modelId: createModelId("swarm-failure-test-model"),
        },
        workingDirectory: workspace,
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        eventSink: {
          onSessionEvent(event) {
            if (event.type !== SessionEventType.SubagentSpawned) return;
            const payload = event.payload as { childSessionId?: SessionId; description?: string };
            if (payload.childSessionId && payload.description) {
              childDescriptions.set(payload.childSessionId, payload.description);
            }
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const requestText = request.messages.map((message) =>
              typeof message.content === "string" ? message.content : JSON.stringify(message.content),
            ).join("\n");

            if (requestText.includes("Decide whether this task needs independent parallel work")) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: sessionId === rootSessionId
                  ? JSON.stringify({
                      decision: "split",
                      graph: {
                        nodes: [
                          { id: "failing-child", description: "Failing child", prompt: "Fail predictably." },
                          { id: "successful-child", description: "Successful child", prompt: "Complete normally." },
                        ],
                      },
                    })
                  : JSON.stringify({ decision: "leaf", reason: "The child task is already focused." }),
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (
              sessionId !== rootSessionId &&
              childDescriptions.get(sessionId)?.includes("Failing child")
            ) {
              throw new Error("Fixture child execution failed with a provider timeout.");
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "Child completed.",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    try {
      const turnError = await runtime.executeTurn(
        "Run two child tasks and report their completion.",
        undefined,
        {
          intent: { orchestrationMode: "swarm" },
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      const rootEvents = await eventStore.getEvents(rootSessionId);
      const failedSwarmEvent = rootEvents
        .filter((event) => event.type === SessionEventType.SwarmRunUpdated)
        .map((event) => event.payload as { status: string; summary?: string; childSessionIds?: string[] })
        .find((event) => event.status === "failed");
      const failedChildSessionId = [...childDescriptions]
        .find(([, description]) => description.includes("Failing child"))?.[0];

      expect(turnError).toBeDefined();
      expect(failedSwarmEvent?.summary).toContain("Fixture child execution failed with a provider timeout.");
      expect(failedSwarmEvent?.childSessionIds).toEqual(expect.arrayContaining([
        ...childDescriptions.keys(),
      ]));
      expect(failedSwarmEvent?.childSessionIds).toContain(failedChildSessionId);
    } finally {
      await runtime.closeBrowserSession();
    }
  }, 30_000);
});

function nodeForPrompt(prompt: string, marker: string): boolean {
  return prompt.includes(marker);
}
