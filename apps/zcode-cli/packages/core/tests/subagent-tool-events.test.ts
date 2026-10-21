import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SESSION_ENTRY_PRISM_TASK_TERMINAL,
  SessionEventType,
  createSessionEvent,
  createModelId,
  createModelProviderId,
  createSessionId,
  createTurnId,
  type SessionEvent,
  type SessionId,
  type SubagentExecutionTerminalPayload,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import {
  isMirroredSubagentEvent,
  mirrorSubagentToolEvent,
} from "../src/subagent/tool-event-mirror.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import {
  InMemoryRuntimeTaskRegistry,
  SUBAGENT_ROOT_MAX_ACTIVE_TASKS,
} from "../src/runtime-task/registry.js";

describe("subagent tool event projection", () => {
  it("runs a DAG in real child sessions and waits for every dependency", async () => {
    const rootSessionId = createSessionId("runtime-subagent-dag-root");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const nodeIds = ["alpha", "beta", "dependent"] as const;
    const nodeDescriptions = new Map(nodeIds.map((id) => [id, `DAG ${id}`]));
    const childSessionByNode = new Map<string, SessionId>();
    const terminalByNode = new Map(
      nodeIds.map((id) => [id, createDeferred<SubagentExecutionTerminalPayload>()]),
    );
    const startedByNode = new Map(nodeIds.map((id) => [id, createDeferred<void>()]));
    const releaseByNode = new Map([
      ["alpha", createDeferred<void>()],
      ["beta", createDeferred<void>()],
    ]);
    const modelRequestCount = new Map<SessionId, number>();

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("dag-runtime-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        eventSink: {
          onSessionEvent(event) {
            if (event.type === SessionEventType.SubagentSpawned) {
              const payload = event.payload as {
                childSessionId?: SessionId;
                description?: string;
              };
              const nodeId = [...nodeDescriptions].find(
                ([, description]) => description === payload.description,
              )?.[0];
              if (nodeId && payload.childSessionId) {
                childSessionByNode.set(nodeId, payload.childSessionId);
              }
              return;
            }
            if (event.type !== SessionEventType.SubagentExecutionTerminal) return;
            const payload = event.payload as SubagentExecutionTerminalPayload;
            const nodeId = [...childSessionByNode].find(
              ([, childSessionId]) => childSessionId === payload.childSessionId,
            )?.[0];
            if (nodeId && payload.terminalStatus === "completed")
              terminalByNode.get(nodeId)?.resolve(payload);
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const count = (modelRequestCount.get(sessionId) ?? 0) + 1;
            modelRequestCount.set(sessionId, count);

            if (sessionId === rootSessionId && count === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_root_task_dag",
                    name: "Agent",
                    input: {
                      description: "Run independent research before synthesis",
                      prompt: "Complete the three-node plan.",
                      task_graph: {
                        max_parallel: 2,
                        nodes: [
                          {
                            id: "alpha",
                            description: nodeDescriptions.get("alpha"),
                            prompt: "Complete alpha.",
                          },
                          {
                            id: "beta",
                            description: nodeDescriptions.get("beta"),
                            prompt: "Complete beta.",
                          },
                          {
                            id: "dependent",
                            description: nodeDescriptions.get("dependent"),
                            prompt: "Synthesize alpha and beta.",
                            depends_on: ["alpha", "beta"],
                          },
                        ],
                      },
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (sessionId === rootSessionId) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "DAG complete.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            const nodeId = [...childSessionByNode].find(
              ([, childSessionId]) => childSessionId === sessionId,
            )?.[0];
            if (!nodeId) throw new Error(`Unexpected DAG child session: ${sessionId}`);
            startedByNode.get(nodeId)?.resolve();
            if (nodeId === "alpha" || nodeId === "beta") {
              await releaseByNode.get(nodeId)!.promise;
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `Result for ${nodeId}`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    const turn = runtime.executeTurn("Run a task DAG with two independent nodes.");
    try {
      await Promise.all([startedByNode.get("alpha")!.promise, startedByNode.get("beta")!.promise]);
      expect(childSessionByNode.size).toBe(2);

      releaseByNode.get("alpha")!.resolve();
      const alphaTerminal = await terminalByNode.get("alpha")!.promise;
      expect(alphaTerminal.terminalStatus).toBe("completed");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rootSpawnsAfterAlpha = (await eventStore.getEvents(rootSessionId)).filter(
        (event) => event.type === SessionEventType.SubagentSpawned,
      );
      expect(rootSpawnsAfterAlpha).toHaveLength(2);
      expect(childSessionByNode.has("dependent")).toBe(false);

      releaseByNode.get("beta")!.resolve();
      await startedByNode.get("dependent")!.promise;
      expect(childSessionByNode.size).toBe(3);
      await turn;
      await expect(terminalByNode.get("beta")!.promise).resolves.toMatchObject({
        terminalStatus: "completed",
      });
      await expect(terminalByNode.get("dependent")!.promise).resolves.toMatchObject({
        terminalStatus: "completed",
      });
      const terminalEntries = await sessionStore.sessionEntries?.({
        sessionID: rootSessionId,
        type: SESSION_ENTRY_PRISM_TASK_TERMINAL,
      });
      expect(terminalEntries).toHaveLength(3);
    } finally {
      releaseByNode.get("alpha")!.resolve();
      releaseByNode.get("beta")!.resolve();
      await runtime.closeBrowserSession();
      await turn.catch(() => undefined);
    }
  });

  it("cancels a real DAG child, waits for settlement, and never starts pending nodes", async () => {
    const rootSessionId = createSessionId("runtime-subagent-dag-cancel-root");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const childStarted = createDeferred<void>();
    const childAbortObserved = createDeferred<void>();
    const childMaySettle = createDeferred<void>();
    const childTerminal = createDeferred<SubagentExecutionTerminalPayload>();
    const modelRequestCount = new Map<SessionId, number>();
    let childSessionId: SessionId | undefined;
    let closeSettled = false;

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("dag-cancel-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        eventSink: {
          onSessionEvent(event) {
            if (event.type !== SessionEventType.SubagentExecutionTerminal) return;
            const payload = event.payload as SubagentExecutionTerminalPayload;
            if (payload.childSessionId === childSessionId) childTerminal.resolve(payload);
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const count = (modelRequestCount.get(sessionId) ?? 0) + 1;
            modelRequestCount.set(sessionId, count);
            if (sessionId === rootSessionId && count === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_root_task_dag_cancel",
                    name: "Agent",
                    input: {
                      description: "Cancel a running node",
                      prompt: "Cancel while a node is running.",
                      task_graph: {
                        max_parallel: 1,
                        nodes: [
                          {
                            id: "active",
                            description: "DAG active",
                            prompt: "Wait for cancellation.",
                          },
                          {
                            id: "pending",
                            description: "DAG pending",
                            prompt: "Must not start after cancellation.",
                            depends_on: ["active"],
                          },
                        ],
                      },
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (sessionId === rootSessionId) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "Unexpected root continuation.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childSessionId = sessionId;
            childStarted.resolve();
            const signal = request.abortSignal;
            if (!signal) throw new Error("DAG child model request did not receive an abort signal");
            return new Promise((resolve) => {
              const onAbort = () => {
                childAbortObserved.resolve();
                void childMaySettle.promise.then(() => {
                  resolve({
                    finishReason: "stop",
                    providerMetadata: undefined,
                    text: "Child settled after cancellation.",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  });
                });
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
          },
        }),
      },
    );

    const turn = runtime.executeTurn("Cancel the active task DAG child.");
    try {
      await childStarted.promise;
      expect(childSessionId).toBeDefined();
      const spawnedBeforeCancel = (await eventStore.getEvents(rootSessionId)).filter(
        (event) => event.type === SessionEventType.SubagentSpawned,
      );
      expect(spawnedBeforeCancel).toHaveLength(1);

      const close = runtime.closeBrowserSession().finally(() => {
        closeSettled = true;
      });
      await childAbortObserved.promise;
      expect(closeSettled).toBe(false);
      expect(
        Object.values(runtimeTaskRegistry.all()).map((task) => task.description),
      ).not.toContain("DAG pending");

      childMaySettle.resolve();
      await close;
      await turn.catch(() => undefined);
      const spawnedAfterCancel = (await eventStore.getEvents(rootSessionId)).filter(
        (event) => event.type === SessionEventType.SubagentSpawned,
      );
      expect(spawnedAfterCancel).toHaveLength(1);
      expect(
        Object.values(runtimeTaskRegistry.all()).map((task) => task.description),
      ).not.toContain("DAG pending");

      const spawn = spawnedAfterCancel[0]?.payload as { agentId?: string } | undefined;
      expect(spawn?.agentId).toBeTruthy();
      expect(runtimeTaskRegistry.get(spawn!.agentId!)?.status).toBe("killed");
      await expect(childTerminal.promise).resolves.toMatchObject({
        childSessionId,
        taskId: spawn!.agentId,
        terminalStatus: "killed",
      });
      const terminalEntries = await sessionStore.sessionEntries?.({
        sessionID: rootSessionId,
        type: SESSION_ENTRY_PRISM_TASK_TERMINAL,
      });
      expect(terminalEntries).toHaveLength(1);
      expect(terminalEntries?.[0]?.data).toMatchObject({
        terminal: { taskId: spawn!.agentId, terminalStatus: "killed" },
      });
    } finally {
      childMaySettle.resolve();
      await runtime.closeBrowserSession();
      await turn.catch(() => undefined);
    }
  });

  it("accounts durable child usage against only its root and blocks the next provider call", async () => {
    const rootSessionId = createSessionId("runtime-subagent-budget-root");
    const independentSessionId = createSessionId("runtime-subagent-budget-independent");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const childStarted = createDeferred<void>();
    const releaseChild = createDeferred<void>();
    const requestCount = new Map<SessionId, number>();
    let childSessionId: SessionId | undefined;

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("root-budget-model"),
        },
        workingDirectory: "/workspace/project",
        subagents: {
          profiles: [
            {
              name: "budget-child",
              description: "Reports a root budget exhausting usage event",
              source: "user",
              systemPrompt: "Complete the budget test task.",
              tools: ["Agent"],
            },
          ],
        },
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const count = (requestCount.get(sessionId) ?? 0) + 1;
            requestCount.set(sessionId, count);
            if (sessionId === rootSessionId && count === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_budget_child",
                    name: "Agent",
                    input: {
                      description: "Spend the root run token budget",
                      prompt: "Run the budget test.",
                      subagent_type: "budget-child",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (sessionId === rootSessionId) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "This request must not be reached after child usage exhausts the root.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childSessionId = sessionId;
            childStarted.resolve();
            await releaseChild.promise;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "Child completed with a durable usage event that exhausts its root budget.",
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 500_001 },
            };
          },
        }),
      },
    );
    const independentRuntime = createTestAgentRuntime(
      independentSessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("independent-budget-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        modelFactory: createTestModelFactory({
          async generateText() {
            requestCount.set(independentSessionId, (requestCount.get(independentSessionId) ?? 0) + 1);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "Independent root completed.",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    const rootTurn = runtime.executeTurn("Exercise a root-scoped budget.");
    try {
      await childStarted.promise;
      await independentRuntime.executeTurn("Independent root run.");
      expect(requestCount.get(independentSessionId)).toBe(1);

      releaseChild.resolve();
      await rootTurn.catch(() => undefined);

      expect(childSessionId).toBeDefined();
      const childEvents = await eventStore.getEvents(childSessionId!);
      expect(childEvents.some((event) =>
        event.type === SessionEventType.ModelComplete &&
        (event.payload as { usage?: { totalTokens?: number } }).usage?.totalTokens === 500_001,
      )).toBe(true);
      expect(requestCount.get(rootSessionId)).toBe(1);
      expect(requestCount.get(childSessionId!)).toBe(1);
      expect(requestCount.get(independentSessionId)).toBe(1);
      const rootEvents = await eventStore.getEvents(rootSessionId);
      const terminal = rootEvents.find(
        (event) => event.type === SessionEventType.SubagentExecutionTerminal,
      );
      const terminalPayload = terminal?.payload as SubagentExecutionTerminalPayload | undefined;
      expect(terminalPayload?.rootRunId).toContain(String(rootSessionId));
      const spawned = rootEvents.find((event) => event.type === SessionEventType.SubagentSpawned);
      const taskId = (spawned?.payload as { agentId?: string } | undefined)?.agentId;
      expect(taskId).toBeTruthy();
      expect(runtimeTaskRegistry.get(taskId!)?.rootRunId).toBe(terminalPayload?.rootRunId);
      expect(terminal?.payload).toMatchObject({
        childSessionId,
      });
      expect(terminalPayload?.terminalStatus).not.toBe("completed");
      expect((await eventStore.getEvents(independentSessionId)).some(
        (event) => event.type === SessionEventType.TurnComplete,
      )).toBe(true);
    } finally {
      releaseChild.resolve();
      await Promise.all([
        runtime.closeBrowserSession(),
        independentRuntime.closeBrowserSession(),
        rootTurn.catch(() => undefined),
      ]);
    }
  });

  it("cascades root shutdown through a real grandchild and waits for persisted settlement", async () => {
    const rootSessionId = createSessionId("runtime-subagent-tree-root");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const grandchildStarted = createDeferred<void>();
    const grandchildAbortObserved = createDeferred<void>();
    const grandchildMaySettle = createDeferred<void>();
    const modelRequestCount = new Map<SessionId, number>();
    let childSessionId: SessionId | undefined;
    let grandchildSessionId: SessionId | undefined;

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("recursive-agent-model"),
        },
        workingDirectory: "/workspace/project",
        subagents: {
          profiles: [
            {
              name: "recursive",
              description: "Can delegate one nested test task",
              source: "user",
              systemPrompt: "Delegate the nested task required by the test.",
              tools: ["Agent"],
            },
          ],
        },
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");

            const count = (modelRequestCount.get(sessionId) ?? 0) + 1;
            modelRequestCount.set(sessionId, count);
            if (sessionId === rootSessionId) {
              if (count === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_root_recursive_agent",
                      name: "Agent",
                      input: {
                        description: "Start the first level",
                        prompt: "Start the nested task.",
                        subagent_type: "recursive",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "Root finished after child shutdown.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (childSessionId === undefined) {
              childSessionId = sessionId;
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_child_recursive_agent",
                    name: "Agent",
                    input: {
                      description: "Start the grandchild",
                      prompt: "Start the grandchild task.",
                      subagent_type: "recursive",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (sessionId === childSessionId) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "Child finished after grandchild shutdown.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (grandchildSessionId === undefined) grandchildSessionId = sessionId;
            if (sessionId !== grandchildSessionId) {
              throw new Error(`Unexpected runtime session in recursive fixture: ${sessionId}`);
            }
            if (count > 1) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "Grandchild settled after cancellation.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            grandchildStarted.resolve();
            if (!request.abortSignal) {
              throw new Error("Grandchild model request did not receive an abort signal");
            }
            return new Promise((resolve) => {
              const onAbort = () => {
                grandchildAbortObserved.resolve();
                void grandchildMaySettle.promise.then(() => {
                  resolve({
                    finishReason: "stop",
                    providerMetadata: undefined,
                    text: "Grandchild settled after cancellation.",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  });
                });
              };
              if (request.abortSignal.aborted) {
                onAbort();
              } else {
                request.abortSignal.addEventListener("abort", onAbort, { once: true });
              }
            });
          },
        }),
      },
    );

    const turn = runtime.executeTurn("Launch a recursive subagent tree.");
    try {
      await grandchildStarted.promise;
      expect(childSessionId).toBeDefined();
      expect(grandchildSessionId).toBeDefined();
      expect(new Set([rootSessionId, childSessionId, grandchildSessionId]).size).toBe(3);

      const rootSpawned = (await eventStore.getEvents(rootSessionId)).find(
        (event) => event.type === SessionEventType.SubagentSpawned,
      )?.payload as { agentId?: string; childSessionId?: SessionId } | undefined;
      const childSpawned = (await eventStore.getEvents(childSessionId!)).find(
        (event) => event.type === SessionEventType.SubagentSpawned,
      )?.payload as { agentId?: string; childSessionId?: SessionId } | undefined;
      expect(rootSpawned?.childSessionId).toBe(childSessionId);
      expect(childSpawned?.childSessionId).toBe(grandchildSessionId);
      expect(rootSpawned?.agentId).toBeTruthy();
      expect(childSpawned?.agentId).toBeTruthy();

      const rootChildTask = runtimeTaskRegistry.get(rootSpawned!.agentId!);
      const grandchildTask = runtimeTaskRegistry.get(childSpawned!.agentId!);
      expect(rootChildTask).toMatchObject({
        childSessionId,
        parentSessionId: rootSessionId,
        rootSessionId,
      });
      expect(grandchildTask).toMatchObject({
        childSessionId: grandchildSessionId,
        parentSessionId: childSessionId,
        rootSessionId,
      });

      let closeSettled = false;
      const close = runtime.closeBrowserSession().finally(() => {
        closeSettled = true;
      });
      await grandchildAbortObserved.promise;
      expect(closeSettled).toBe(false);

      grandchildMaySettle.resolve();
      await close;
      await turn;

      expect(closeSettled).toBe(true);
      expect(runtimeTaskRegistry.get(rootSpawned!.agentId!)?.status).toBe("killed");
      expect(runtimeTaskRegistry.get(childSpawned!.agentId!)?.status).toBe("killed");

      const [rootEvents, childEvents, grandchildEvents] = await Promise.all([
        eventStore.getEvents(rootSessionId),
        eventStore.getEvents(childSessionId!),
        eventStore.getEvents(grandchildSessionId!),
      ]);
      const rootChildTerminal = rootEvents.find(
        (event) => event.type === SessionEventType.SubagentExecutionTerminal,
      );
      const grandchildTerminal = childEvents.find(
        (event) => event.type === SessionEventType.SubagentExecutionTerminal,
      );
      expect(rootChildTerminal?.payload as SubagentExecutionTerminalPayload).toMatchObject({
        childSessionId,
        taskId: rootSpawned!.agentId,
        rootRunId: rootChildTask!.rootRunId,
        terminalStatus: "killed",
      });
      expect(grandchildTerminal?.payload as SubagentExecutionTerminalPayload).toMatchObject({
        childSessionId: grandchildSessionId,
        taskId: childSpawned!.agentId,
        parentTaskId: rootSpawned!.agentId,
        rootRunId: rootChildTask!.rootRunId,
        terminalStatus: "killed",
      });
      const durableTerminalEntries = await sessionStore.sessionEntries!({
        sessionID: rootSessionId,
        type: SESSION_ENTRY_PRISM_TASK_TERMINAL,
      });
      const durableTerminalPayloads = durableTerminalEntries.map(
        (entry) => (entry.data as { terminal?: SubagentExecutionTerminalPayload }).terminal,
      );
      expect(durableTerminalPayloads).toHaveLength(2);
      expect(durableTerminalPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: rootSpawned!.agentId,
            childSessionId,
            terminalStatus: "killed",
          }),
          expect.objectContaining({
            taskId: childSpawned!.agentId,
            parentTaskId: rootSpawned!.agentId,
            childSessionId: grandchildSessionId,
            terminalStatus: "killed",
          }),
        ]),
      );
      for (const events of [rootEvents, childEvents, grandchildEvents]) {
        expect(events.some((event) => event.type === SessionEventType.TurnComplete)).toBe(true);
      }
    } finally {
      grandchildMaySettle.resolve();
      await runtime.closeBrowserSession();
      await turn.catch(() => undefined);
    }
  });

  it("runs a real AgentRuntime chain deeper than the active-work quota and reports its last stage", async () => {
    const rootSessionId = createSessionId("runtime-subagent-deep-chain-root");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const targetDepth = SUBAGENT_ROOT_MAX_ACTIVE_TASKS + 1;
    const depthBySession = new Map<SessionId, number>([[rootSessionId, 0]]);
    const lastStageBySession = new Map<SessionId, string>();
    const taskIdsByChildSession = new Map<SessionId, string>();
    const admittedTaskIds = new Set<string>();
    const modelRequestsBySession = new Map<SessionId, number>();
    const modelFactorySessions = new Set<SessionId>();
    const mirroredEvents: Array<{
      agentId?: string;
      childSessionId?: SessionId;
      childToolCallId?: string;
    }> = [];
    const memorySamples: Array<{ depth: number; heapUsed: number; rss: number }> = [];
    let memoryBudgetTrip:
      | {
          depth: number;
          heapUsed: number;
          taskCount: number;
          lastStage: string | undefined;
          samples: typeof memorySamples;
        }
      | undefined;
    let modelFactoryCalls = 0;

    const recordStage = (sessionId: SessionId, stage: string) => {
      lastStageBySession.set(sessionId, stage);
    };

    const unsubscribeRegistry = runtimeTaskRegistry.subscribe?.(() => {
      for (const task of Object.values(runtimeTaskRegistry.all())) {
        if (!task.childSessionId || !task.parentSessionId) continue;
        const parentDepth = depthBySession.get(task.parentSessionId);
        if (parentDepth === undefined) continue;
        depthBySession.set(task.childSessionId, parentDepth + 1);
        taskIdsByChildSession.set(task.childSessionId, task.taskId);
        if (admittedTaskIds.has(task.taskId)) continue;
        admittedTaskIds.add(task.taskId);
        recordStage(task.childSessionId, "admitted");
      }
    });

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("deep-chain-model"),
        },
        workingDirectory: "/workspace/project",
        subagents: {
          profiles: [
            {
              name: "recursive",
              description: "Can delegate the next node in a bounded test chain",
              source: "user",
              systemPrompt: "Delegate the next nested task until the leaf is reached.",
              tools: ["Agent"],
            },
          ],
        },
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        eventSink: {
          onSessionEvent(event) {
            recordStage(event.sessionId, `event:${event.type}`);
            const eventPayload = event.payload as { source?: unknown; childToolCallId?: unknown };
            if (
              eventPayload.source === "subagent" &&
              typeof eventPayload.childToolCallId === "string"
            ) {
              const mirrorPayload = event.payload as {
                agentId?: string;
                childSessionId?: SessionId;
                childToolCallId?: string;
              };
              mirroredEvents.push(mirrorPayload);
            }
            if (event.type !== SessionEventType.SubagentSpawned) return;
            const payload = event.payload as { agentId?: string; childSessionId?: SessionId };
            if (!payload.agentId || !payload.childSessionId) return;
            const parentDepth = depthBySession.get(event.sessionId);
            if (parentDepth === undefined) return;
            depthBySession.set(payload.childSessionId, parentDepth + 1);
            taskIdsByChildSession.set(payload.childSessionId, payload.agentId);
            recordStage(payload.childSessionId, "SubagentSpawned");
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const depth = depthBySession.get(sessionId);
            if (depth === undefined) {
              throw new Error(`Missing depth mapping for runtime session ${sessionId}`);
            }
            modelFactoryCalls += 1;
            const requestCount = (modelRequestsBySession.get(sessionId) ?? 0) + 1;
            modelRequestsBySession.set(sessionId, requestCount);
            modelFactorySessions.add(sessionId);
            recordStage(sessionId, "model_factory");
            if (modelFactoryCalls > (targetDepth + 1) * 4) {
              throw new Error(
                `Recursive model loop exceeded the bounded test allowance: depth=${depth}, totalCalls=${modelFactoryCalls}, perSession=${requestCount}, stages=${JSON.stringify([...taskIdsByChildSession.entries()].map(([childSessionId, taskId]) => ({ childSessionId, depth: depthBySession.get(childSessionId), taskId, status: runtimeTaskRegistry.get(taskId)?.status, lastStage: lastStageBySession.get(childSessionId) })))}`,
              );
            }
            const heapUsed = process.memoryUsage().heapUsed;
            memorySamples.push({ depth, heapUsed, rss: process.memoryUsage().rss });
            if (heapUsed > 1_500 * 1024 * 1024) {
              memoryBudgetTrip ??= {
                depth,
                heapUsed,
                taskCount: Object.keys(runtimeTaskRegistry.all()).length,
                lastStage: lastStageBySession.get(sessionId),
                samples: [...memorySamples],
              };
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: `Test stopped before the Node heap approached its limit at depth ${depth}.`,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (depth < targetDepth && requestCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: `call_deep_chain_${depth}`,
                    name: "Agent",
                    input: {
                      description: `Create chain node ${depth + 1}`,
                      prompt: `Continue the nested chain at depth ${depth + 1}.`,
                      subagent_type: "recursive",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `Reached leaf at depth ${depth}.`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    const turn = runtime.executeTurn("Run a bounded recursive subagent chain.");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        turn,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const taskStages = Object.values(runtimeTaskRegistry.all()).map((task) => ({
              sessionId: task.childSessionId,
              depth: task.childSessionId ? depthBySession.get(task.childSessionId) : undefined,
              taskId: task.taskId,
              status: task.status,
              lastStage: task.childSessionId
                ? lastStageBySession.get(task.childSessionId)
                : undefined,
              modelRequests: task.childSessionId
                ? (modelRequestsBySession.get(task.childSessionId) ?? 0)
                : undefined,
            }));
            reject(
              new Error(
                `Deep AgentRuntime chain stalled; deepest=${Math.max(...depthBySession.values())}; tasks=${JSON.stringify(taskStages)}`,
              ),
            );
          }, 90_000);
        }),
      ]);

      expect(memoryBudgetTrip).toBeUndefined();
      expect(Math.max(...memorySamples.map((sample) => sample.heapUsed))).toBeLessThan(
        1_500 * 1024 * 1024,
      );
      expect(Math.max(...depthBySession.values())).toBe(targetDepth);
      // Every non-leaf turn makes one follow-up request after its child returns.
      expect(modelFactoryCalls).toBe(targetDepth * 2 + 1);
      expect(taskIdsByChildSession.size).toBe(targetDepth);
      expect(
        [...taskIdsByChildSession.values()].every(
          (taskId) => runtimeTaskRegistry.get(taskId)?.status === "completed",
        ),
      ).toBe(true);
      expect(modelFactorySessions.size).toBe(targetDepth + 1);
      expect(mirroredEvents.length).toBeGreaterThan(0);
      expect(
        mirroredEvents.every(
          ({ agentId, childSessionId, childToolCallId }) =>
            !childToolCallId?.startsWith("tool_subagent_") &&
            depthBySession.get(childSessionId!) === 1 &&
            taskIdsByChildSession.get(childSessionId!) === agentId,
        ),
      ).toBe(true);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      unsubscribeRegistry?.();
      await runtime.closeBrowserSession();
      await turn.catch(() => undefined);
    }
  }, 120_000);

  it("mirrors child blocking interactions into the parent live projection", async () => {
    const sessionId = createSessionId("runtime-subagent-interaction-events");
    const eventStore = createTestSessionEventStore();
    const liveEvents: SessionEvent[] = [];
    const delegatedRequests: Array<Record<string, unknown>> = [];
    let parentCallCount = 0;
    let childCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        permissionBroker: {
          async requestPermission(request) {
            delegatedRequests.push(request as unknown as Record<string, unknown>);
            return {
              decision: "modify",
              modifiedInput: {
                ...(request.input as Record<string, unknown>),
                answers: { "Which path?": "Parent answered" },
              },
              reason: "answered in parent task",
            };
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request: any, observation: any) {
            const invocationSessionId = observation.invocationContext?.traceContext?.sessionId;
            // 根因：允许递归委派后，child 也会暴露 Agent；仅按工具列表识别 root 会把 child 请求误判成父请求。
            // 修复依据：模型调用 observation 携带真实 sessionId，测试按唯一会话所有者分流两层响应。
            if (invocationSessionId === sessionId) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_parent_agent",
                      name: "Agent",
                      input: {
                        description: "Ask from child",
                        prompt: "Ask the user which path to take.",
                        subagent_type: "general-purpose",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "parent received child result",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childCallCount++;
            if (childCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_child_ask",
                    name: "AskUserQuestion",
                    input: {
                      questions: [
                        {
                          header: "Path",
                          multiSelect: false,
                          options: [
                            { description: "Use path A", label: "A" },
                            { description: "Use path B", label: "B" },
                          ],
                          question: "Which path?",
                        },
                      ],
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "child received the answer",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    const unsubscribe = runtime.subscribeEvents({
      onSessionEvent: (event) => {
        liveEvents.push(event);
      },
    });
    try {
      await runtime.executeTurn("Delegate a question to a child.");
    } finally {
      unsubscribe();
    }

    expect(delegatedRequests).toHaveLength(1);
    expect(delegatedRequests[0]).toMatchObject({
      sessionId,
      toolCallId: "call_child_ask",
      toolName: "AskUserQuestion",
      origin: {
        kind: "subagent",
        childSessionId: expect.stringContaining("sess_subagent_agent_"),
        parentSessionId: sessionId,
        parentToolCallId: "call_parent_agent",
      },
    });

    const parentPermissionRequested = liveEvents.find(
      (event) =>
        event.sessionId === sessionId && event.type === SessionEventType.PermissionRequested,
    );
    const parentPermissionResolved = liveEvents.find(
      (event) =>
        event.sessionId === sessionId && event.type === SessionEventType.PermissionResolved,
    );
    expect(parentPermissionRequested?.payload).toMatchObject({
      requestId: expect.stringMatching(/^perm_/),
      toolCallId: expect.not.stringMatching(/^call_child_ask$/),
      toolName: "AskUserQuestion",
      origin: {
        kind: "subagent",
        childSessionId: expect.stringContaining("sess_subagent_agent_"),
        parentSessionId: sessionId,
        parentToolCallId: "call_parent_agent",
      },
    });
    expect(parentPermissionResolved?.payload).toMatchObject({
      requestId: (parentPermissionRequested?.payload as Record<string, unknown>)?.requestId,
      toolCallId: (parentPermissionRequested?.payload as Record<string, unknown>)?.toolCallId,
      decision: "modify",
    });

    const persistedParentEvents = await eventStore.getEvents(sessionId);
    expect(
      persistedParentEvents.some(
        (event) =>
          event.type === SessionEventType.PermissionRequested &&
          (event.payload as Record<string, unknown>).origin !== undefined,
      ),
    ).toBe(false);
  });

  it("mirrors child tool calls to the parent live event sink without persisting them as parent events", async () => {
    const sessionId = createSessionId("runtime-subagent-tool-events");
    const eventStore = createTestSessionEventStore();
    const liveEvents: SessionEvent[] = [];
    let parentCallCount = 0;
    let childCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        fileSystemPort: new MemoryFileSystem({
          "/workspace/project/README.md": "ZCode Explore reads this file.\n",
        }),
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_explore",
                      name: "Agent",
                      input: {
                        description: "Read project readme",
                        prompt: "Read README.md and summarize it.",
                        subagent_type: "Explore",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }

              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "parent saw child result",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childCallCount++;
            if (childCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_child_read",
                    name: "Read",
                    input: { file_path: "README.md" },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "README says Explore can read files.",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    const unsubscribe = runtime.subscribeEvents({
      onSessionEvent: (event) => {
        liveEvents.push(event);
      },
    });
    try {
      await runtime.executeTurn("Use Explore to inspect README.md");
    } finally {
      unsubscribe();
    }

    const parentEvents = await eventStore.getEvents(sessionId);
    const spawnedAgentId = (
      parentEvents.find((event) => event.type === SessionEventType.SubagentSpawned)?.payload as
        | { agentId?: string }
        | undefined
    )?.agentId;
    expect(spawnedAgentId).toMatch(/^agent_/u);
    const childSessionId = parentEvents
      .map((event) => event.payload as Record<string, unknown>)
      .find((payload) => typeof payload.childSessionId === "string")?.childSessionId as
      | string
      | undefined;
    expect(childSessionId).toBeTruthy();

    const childEvents = await eventStore.getEvents(childSessionId as SessionId);
    expect(childEvents.some((event) => event.type === SessionEventType.ToolCallScheduled)).toBe(
      true,
    );

    const mirroredReadEvents = liveEvents.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.source === "subagent" && payload.childToolCallId === "call_child_read";
    });
    const mirroredScheduled = mirroredReadEvents.find(
      (event) => event.type === SessionEventType.ToolCallScheduled,
    );
    const mirroredResult = mirroredReadEvents.find(
      (event) => event.type === SessionEventType.ToolCallResult,
    );

    expect(mirroredScheduled?.sessionId).toBe(sessionId);
    expect(mirroredScheduled?.turnId).toBe(parentEvents[0]?.turnId);
    expect(mirroredScheduled?.payload).toMatchObject({
      agentId: spawnedAgentId,
      childSessionId,
      childToolCallId: "call_child_read",
      description: "Read project readme",
      parentToolCallId: "call_explore",
      source: "subagent",
      toolName: "Read",
    });
    expect(mirroredScheduled?.payload).not.toHaveProperty("background");
    expect((mirroredScheduled?.payload as any).toolCallId).not.toBe("call_child_read");
    expect((mirroredResult?.payload as any).toolCallId).toBe(
      (mirroredScheduled?.payload as any).toolCallId,
    );
    expect(mirroredResult?.payload).toMatchObject({
      toolName: "Read",
    });

    const persistedParentReadEvents = parentEvents.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.source === "subagent" && payload.toolName === "Read";
    });
    expect(persistedParentReadEvents).toEqual([]);
  });

  it("marks child tool events emitted after foreground auto-background with current provenance", async () => {
    const sessionId = createSessionId("runtime-auto-background-subagent-tool-events");
    const eventStore = createTestSessionEventStore();
    const liveEvents: SessionEvent[] = [];
    const childMayEmitTool = createDeferred<void>();
    const backgroundCompletion = createDeferred<void>();
    let parentCallCount = 0;
    let childCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        subagents: { autoBackgroundMs: 1 },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        fileSystemPort: new MemoryFileSystem({
          "/workspace/project/README.md": "ZCode background child reads this file.\n",
        }),
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_auto_background_agent",
                      name: "Agent",
                      input: {
                        description: "Read after moving to background",
                        prompt: "Wait, then read README.md.",
                        subagent_type: "Explore",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }

              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "parent continued after background launch",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childCallCount++;
            if (childCallCount === 1) {
              await childMayEmitTool.promise;
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_background_child_read",
                    name: "Read",
                    input: { file_path: "README.md" },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "README was read after auto-background.",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    const unsubscribe = runtime.subscribeEvents({
      onSessionEvent: (event) => {
        liveEvents.push(event);
        if (event.type === SessionEventType.BackgroundTaskCompleted) {
          backgroundCompletion.resolve();
        }
      },
    });
    try {
      await runtime.executeTurn("Launch a foreground child that will move to background.");
      childMayEmitTool.resolve();
      await Promise.race([
        backgroundCompletion.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for background child")), 1_000),
        ),
      ]);
    } finally {
      childMayEmitTool.resolve();
      unsubscribe();
    }

    const mirroredReadEvents = liveEvents.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return (
        payload.source === "subagent" && payload.childToolCallId === "call_background_child_read"
      );
    });
    expect(mirroredReadEvents.length).toBeGreaterThan(0);
    expect(
      mirroredReadEvents.every(
        (event) => (event.payload as Record<string, unknown>).background === true,
      ),
    ).toBe(true);
  });

  it("mirrors a child permission lifecycle with the same parent tool identity", () => {
    const childSessionId = createSessionId("runtime-denied-child-interaction");
    const parentSessionId = createSessionId("runtime-denied-parent-interaction");
    const parentTurnId = createTurnId("runtime-denied-parent-turn");
    const context = {
      agentId: "agent_denied",
      agentType: "general-purpose",
      background: false,
      childSessionId,
      description: "Run a protected command",
      parentSessionId,
      parentToolCallId: "call_parent_agent",
      parentTurnId,
      toolNameByChildToolCallId: new Map<string, string>(),
    };
    const requestId = "perm_child_bash";
    const requested = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.PermissionRequested, childSessionId, {
        requestId,
        toolCallId: "call_child_bash",
        toolName: "Bash",
        riskLevel: "high",
        reason: "Run a protected command",
        input: { command: "echo protected" },
      }),
      context,
    );
    const resolved = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.PermissionResolved, childSessionId, {
        requestId,
        toolCallId: "call_child_bash",
        decision: "deny",
      }),
      context,
    );
    const denied = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.PermissionDenied, childSessionId, {
        toolCallId: "call_child_bash",
        toolName: "Bash",
        reason: "Denied by the user",
      }),
      context,
    );

    expect(requested).toMatchObject({
      sessionId: parentSessionId,
      turnId: parentTurnId,
      type: SessionEventType.PermissionRequested,
      payload: {
        requestId,
        toolCallId: "tool_subagent_agent_denied_call_child_bash",
        toolName: "Bash",
        origin: {
          kind: "subagent",
          childSessionId,
          parentSessionId,
          parentToolCallId: "call_parent_agent",
        },
      },
    });
    expect(resolved).toMatchObject({
      sessionId: parentSessionId,
      type: SessionEventType.PermissionResolved,
      payload: {
        requestId,
        toolCallId: "tool_subagent_agent_denied_call_child_bash",
        toolName: "Bash",
        decision: "deny",
      },
    });
    expect(denied).toMatchObject({
      sessionId: parentSessionId,
      type: SessionEventType.PermissionDenied,
      payload: {
        toolCallId: "tool_subagent_agent_denied_call_child_bash",
        toolName: "Bash",
        reason: "Denied by the user",
      },
    });
    expect(requested?.payload).not.toHaveProperty("source");
    expect(resolved?.payload).not.toHaveProperty("source");
    expect(denied?.payload).not.toHaveProperty("source");
  });

  it("preserves background provenance on mirrored child permission events", () => {
    const childSessionId = createSessionId("runtime-background-child-permission");
    const parentSessionId = createSessionId("runtime-background-parent-permission");
    const mirrored = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.PermissionRequested, childSessionId, {
        requestId: "permission-child",
        toolCallId: "call_child_bash",
        toolName: "Bash",
      }),
      {
        agentId: "agent_background",
        agentType: "general-purpose",
        background: true,
        childSessionId,
        description: "Run a protected command",
        parentSessionId,
        parentToolCallId: "call_parent_agent",
      },
    );

    expect(mirrored?.payload).toMatchObject({
      background: true,
      childSessionId,
      toolCallId: "tool_subagent_agent_background_call_child_bash",
    });
  });

  it("does not recursively mirror an already projected subagent tool event", () => {
    const childSessionId = createSessionId("runtime-mirrored-child");
    const parentSessionId = createSessionId("runtime-mirrored-parent");
    const mirrored = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.ToolCallStarted, childSessionId, {
        agentId: "agent_inner",
        childSessionId,
        childToolCallId: "call_leaf_read",
        source: "subagent",
        toolCallId: "tool_subagent_agent_inner_call_leaf_read",
        toolName: "Read",
      }),
      {
        agentId: "agent_outer",
        agentType: "general-purpose",
        background: false,
        childSessionId,
        description: "Nested owner",
        parentSessionId,
        parentToolCallId: "call_parent_agent",
      },
    );

    expect(
      isMirroredSubagentEvent(
        createSessionEvent(SessionEventType.ToolCallStarted, childSessionId, {
          childSessionId,
          childToolCallId: "call_leaf_read",
          source: "subagent",
        }),
      ),
    ).toBe(true);
    expect(mirrored).toBeUndefined();
  });

  it("does not re-forward an already wrapped nested permission interaction", () => {
    const childSessionId = createSessionId("runtime-mirrored-permission-child");
    const parentSessionId = createSessionId("runtime-mirrored-permission-parent");
    const original = createSessionEvent(SessionEventType.PermissionRequested, childSessionId, {
      requestId: "permission-nested",
      toolCallId: "call_leaf_bash",
      toolName: "Bash",
    });
    const mirrored = mirrorSubagentToolEvent(original, {
      agentId: "agent_inner",
      agentType: "general-purpose",
      background: false,
      childSessionId,
      description: "Nested permission owner",
      parentSessionId,
      parentToolCallId: "call_parent_agent",
    });

    expect(mirrored).toBeDefined();
    expect(isMirroredSubagentEvent(mirrored!)).toBe(true);
    expect(
      mirrorSubagentToolEvent(mirrored!, {
        agentId: "agent_outer",
        agentType: "general-purpose",
        background: false,
        childSessionId,
        description: "Outer permission owner",
        parentSessionId: createSessionId("runtime-mirrored-permission-root"),
        parentToolCallId: "call_root_agent",
      }),
    ).toBeUndefined();
  });
});

function createDeferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value as T),
  };
}

function waitForRuntimeStage<T>(
  stage: string,
  promise: Promise<T>,
  diagnostic: () => string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${stage}: ${diagnostic()}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function finishWithin(promise: Promise<unknown>, timeoutMs = 5_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const finished = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return finished;
}
