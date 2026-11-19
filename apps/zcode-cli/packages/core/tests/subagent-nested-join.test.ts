import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createModelId,
  createModelProviderId,
  createSessionId,
  type SessionId,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

describe("nested subagent fan-out", () => {
  it("joins three turn-scoped Agent calls before the orchestrator reports", async () => {
    const rootSessionId = createSessionId("runtime-nested-join-root");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const depthBySession = new Map<SessionId, number>([[rootSessionId, 0]]);
    const requestCountBySession = new Map<SessionId, number>();
    let orchestratorSessionId: SessionId | undefined;
    let orchestratorFollowUpRequest = "";
    let rootFollowUpRequest = "";
    let branchCount = 0;

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("nested-join-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        eventSink: {
          onSessionEvent(event) {
            if (event.type !== SessionEventType.SubagentSpawned) return;
            const payload = event.payload as { childSessionId?: SessionId };
            if (!payload.childSessionId) return;
            const parentDepth = depthBySession.get(event.sessionId);
            if (parentDepth === undefined) return;
            depthBySession.set(payload.childSessionId, parentDepth + 1);
            if (parentDepth === 0) orchestratorSessionId = payload.childSessionId;
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const depth = depthBySession.get(sessionId);
            if (depth === undefined) throw new Error(`Missing depth for ${sessionId}`);
            const count = (requestCountBySession.get(sessionId) ?? 0) + 1;
            requestCountBySession.set(sessionId, count);

            if (depth === 0 && count === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_root_orchestrator",
                    name: "Agent",
                    input: {
                      description: "Split the work across three branches",
                      prompt: "Run three independent branches, join them, and report.",
                      subagent_type: "orchestrator",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (depth === 0) {
              rootFollowUpRequest = JSON.stringify(request.messages);
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "root received the orchestrator report",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (depth === 1 && count === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [1, 2, 3].map((index) => ({
                  id: `call_orchestrator_branch_${index}`,
                  name: "Task",
                  input: {
                    description: `branch-${index}`,
                    prompt: `Complete branch ${index} and return its result.`,
                    subagent_type: "researcher",
                  },
                })),
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (depth === 1) {
              orchestratorFollowUpRequest = JSON.stringify(request.messages);
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "orchestrator joined three branch reports",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            branchCount += 1;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `BRANCH-${branchCount}`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    const turn = runtime.executeTurn("Delegate one orchestrator fan-out.");
    try {
      await turn;

      expect(orchestratorSessionId).toBeDefined();
      const tasks = Object.values(runtimeTaskRegistry.all());
      const orchestratorTask = tasks.find(
        (task) =>
          task.parentSessionId === rootSessionId && task.childSessionId === orchestratorSessionId,
      );
      expect(
        orchestratorTask,
        JSON.stringify({ rootFollowUpRequest, orchestratorFollowUpRequest }),
      ).toMatchObject({ status: "completed" });
      expect(rootFollowUpRequest, rootFollowUpRequest).toContain(
        "orchestrator joined three branch reports",
      );
      expect(orchestratorFollowUpRequest, orchestratorFollowUpRequest).toContain("BRANCH-1");
      expect(branchCount).toBe(3);
      expect(orchestratorFollowUpRequest).toContain("BRANCH-2");
      expect(orchestratorFollowUpRequest).toContain("BRANCH-3");

      const branchTasks = tasks.filter((task) => task.parentSessionId === orchestratorSessionId);
      expect(branchTasks).toHaveLength(3);
      expect(branchTasks.every((task) => task.status === "completed")).toBe(true);
      expect(branchTasks.every((task) => task.isBackgrounded === false)).toBe(true);
    } finally {
      await runtime.closeBrowserSession();
      await turn.catch(() => undefined);
    }
  }, 15_000);

  it("runs independent branches concurrently on distinct profiles instead of a sequential queue", async () => {
    const rootSessionId = createSessionId("runtime-nested-parallel-root");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const depthBySession = new Map<SessionId, number>([[rootSessionId, 0]]);
    const requestCountBySession = new Map<SessionId, number>();
    let orchestratorSessionId: SessionId | undefined;
    let activeBranches = 0;
    let maxActiveBranches = 0;
    let releaseAllStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      releaseAllStarted = resolve;
    });

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("nested-parallel-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        eventSink: {
          onSessionEvent(event) {
            if (event.type !== SessionEventType.SubagentSpawned) return;
            const payload = event.payload as { childSessionId?: SessionId };
            if (!payload.childSessionId) return;
            const parentDepth = depthBySession.get(event.sessionId);
            if (parentDepth === undefined) return;
            depthBySession.set(payload.childSessionId, parentDepth + 1);
            if (parentDepth === 0) orchestratorSessionId = payload.childSessionId;
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const depth = depthBySession.get(sessionId);
            if (depth === undefined) throw new Error(`Missing depth for ${sessionId}`);
            const count = (requestCountBySession.get(sessionId) ?? 0) + 1;
            requestCountBySession.set(sessionId, count);

            if (depth === 0 && count === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_parallel_orchestrator",
                    name: "Agent",
                    input: {
                      description: "Fan out independent branches",
                      prompt: "Run three independent branches in parallel and join them.",
                      subagent_type: "orchestrator",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (depth === 0) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "root received parallel orchestrator report",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (depth === 1 && count === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  ["branch-researcher", "researcher"],
                  ["branch-debugger", "debugger"],
                  ["branch-tests", "test-engineer"],
                ].map(([description, subagentType], index) => ({
                  id: `call_parallel_branch_${index + 1}`,
                  name: "Task",
                  input: {
                    description,
                    prompt: `Complete independent ${description} work and return the result.`,
                    subagent_type: subagentType,
                  },
                })),
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (depth === 1) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "orchestrator joined parallel branch reports",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            activeBranches += 1;
            maxActiveBranches = Math.max(maxActiveBranches, activeBranches);
            if (activeBranches === 3) releaseAllStarted?.();
            await Promise.race([
              allStarted,
              new Promise((resolve) => setTimeout(resolve, 1_500)),
            ]);
            activeBranches -= 1;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `PARALLEL-${depth}-${count}`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    const startedAt = Date.now();
    const turn = runtime.executeTurn("Delegate one parallel fan-out.");
    try {
      await turn;
      const elapsedMs = Date.now() - startedAt;

      expect(maxActiveBranches).toBe(3);
      expect(elapsedMs).toBeLessThan(3_000);
      const branchTasks = Object.values(runtimeTaskRegistry.all()).filter(
        (task) => task.parentSessionId === orchestratorSessionId,
      );
      expect(branchTasks).toHaveLength(3);
      expect(branchTasks.every((task) => task.status === "completed")).toBe(true);
      expect(new Set(branchTasks.map((task) => task.agentType))).toEqual(
        new Set(["researcher", "debugger", "test-engineer"]),
      );
    } finally {
      await runtime.closeBrowserSession();
      await turn.catch(() => undefined);
    }
  }, 15_000);
});
