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
  type SkillContent,
  type SkillLoadOutcome,
  type SkillPort,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { normalizeAgentProfiles } from "../src/subagent/profile.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSwarmTestSkillPort(loadedSkillNames: string[]): SkillPort {
  const metadata = {
    name: "zcode-verification",
    description: "Verify completed engineering work.",
    path: "/bundled/skills/zcode-verification/SKILL.md",
    directory: "/bundled/skills/zcode-verification",
    rootPath: "/bundled/skills",
    scope: "system" as const,
    source: "bundled" as const,
    safeToAutoLoad: false,
    frontmatterKeys: ["name", "description"],
  };
  const outcome: SkillLoadOutcome = {
    skills: [metadata],
    diagnostics: [],
    totalDiscovered: 1,
  };
  return {
    async discoverSkills() {
      return outcome;
    },
    async loadSkill(request): Promise<SkillContent> {
      if (request.name !== metadata.name) {
        throw new Error(`Unexpected skill request: ${request.name}`);
      }
      loadedSkillNames.push(request.name);
      const content = "NESTED_VERIFICATION_SKILL_BODY_539e";
      return {
        metadata,
        content,
        baseDirectory: metadata.directory,
        bytesRead: content.length,
        sizeBytes: content.length,
        truncated: false,
      };
    },
  };
}

describe("swarm planner to real AgentRuntime child sessions", () => {
  it("keeps answer-only root turns direct without creating an agent child", async () => {
    const rootSessionId = createSessionId("runtime-cursor-answer-only");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const sessionStore = (
      await import("./subagent-test-store.js")
    ).createRecordingSubagentSessionStore();
    const workspace = await mkdtemp(join(tmpdir(), "zcode-cursor-answer-only-"));
    let rootRequestCount = 0;
    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-cursor-answer-test"),
          modelId: createModelId("cursor-answer-test-model"),
        },
        workingDirectory: workspace,
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            if (observation.invocationContext?.traceContext?.sessionId !== rootSessionId) {
              throw new Error("Answer-only request unexpectedly created a child session");
            }
            rootRequestCount += 1;
            expect(request.tools?.map((tool) => tool.name)).toContain("Task");
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "Direct answer from the selected model.",
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    try {
      await runtime.executeTurn("What is 2 + 2?");

      expect(rootRequestCount).toBe(1);
      const rootEvents = await eventStore.getEvents(rootSessionId);
      expect(rootEvents.some((event) => event.type === SessionEventType.SubagentSpawned)).toBe(
        false,
      );
    } finally {
      await runtime.closeBrowserSession();
    }
  }, 30_000);

  it("routes an actionable ordinary root turn through the exact Task(start) dispatch", async () => {
    const rootSessionId = createSessionId("runtime-cursor-start-gateway");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const sessionStore = (
      await import("./subagent-test-store.js")
    ).createRecordingSubagentSessionStore();
    const workspace = await mkdtemp(join(tmpdir(), "zcode-cursor-start-gateway-"));
    const rootToolNames: string[][] = [];
    const childSessionIds: SessionId[] = [];
    let rootRequestCount = 0;

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-cursor-start-test"),
          modelId: createModelId("cursor-start-test-model"),
        },
        workingDirectory: workspace,
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const requestText = request.messages
              .map((message) =>
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              )
              .join("\n");
            if (sessionId === rootSessionId) {
              rootRequestCount += 1;
              rootToolNames.push((request.tools ?? []).map((tool) => tool.name));
              if (rootRequestCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_cursor_start_gateway",
                      name: "Task",
                      input: {
                        description: "Route the workspace task",
                        prompt: "Return the verified start-gateway marker.",
                        subagent_type: "start",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              if (!requestText.includes("START_GATEWAY_CHILD_RESULT_65e2")) {
                throw new Error("Root did not receive the result of Task(start)");
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "Root synthesized the start-gateway result.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childSessionIds.push(sessionId);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "START_GATEWAY_CHILD_RESULT_65e2",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    try {
      await runtime.executeTurn("Inspect the workspace and report the concrete result.");

      expect(rootToolNames[0]).toContain("Task");
      expect(rootRequestCount).toBe(2);
      expect(childSessionIds).toHaveLength(1);
      const rootEvents = await eventStore.getEvents(rootSessionId);
      expect(rootEvents.some((event) => event.type === SessionEventType.SubagentSpawned)).toBe(
        true,
      );
    } finally {
      await runtime.closeBrowserSession();
    }
  }, 30_000);

  it("runs independent children concurrently, reads a fixture, and synthesizes their real session results", async () => {
    const rootSessionId = createSessionId("runtime-swarm-real-children");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const sessionStore = (
      await import("./subagent-test-store.js")
    ).createRecordingSubagentSessionStore();
    const workspace = await mkdtemp(join(tmpdir(), "zcode-swarm-real-children-"));
    const fixturePath = join(workspace, "swarm-fixture.txt");
    const markers = {
      alpha: "SWARM_FIXTURE_ALPHA_73c1",
      beta: "SWARM_FIXTURE_BETA_94a8",
    } as const;
    const workspaceInstructionMarker = "WORKSPACE_RULES_SURVIVE_L1_L4_4a62";
    const childBySession = new Map<SessionId, "alpha" | "beta">();
    const childDescriptionBySession = new Map<SessionId, string>();
    const nestedRoleRequests: Array<{ system: string; tools: string[] }> = [];
    const modelRequestTextBySession = new Map<SessionId, string[]>();
    const levelFourCallCounts: number[] = [];
    const loadedSkillNames: string[] = [];
    const directChildSessions = new Set<SessionId>();
    const childStarted = new Set<SessionId>();
    const bothChildrenStarted = deferred<void>();
    const synthesisReceived = deferred<string>();
    const requestCountBySession = new Map<SessionId, number>();
    const regularRequestCountBySession = new Map<SessionId, number>();
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
        skillPort: createSwarmTestSkillPort(loadedSkillNames),
        contextSourcePort: {
          async resolveContextSources(request) {
            const content = `Always preserve ${workspaceInstructionMarker}.`;
            return {
              workingDirectory: request.workingDirectory,
              currentDate: request.currentDate,
              diagnostics: [],
              envInfo: request.envInfo ?? {
                cwd: request.workingDirectory,
                platform: "test",
                shell: "test",
                osVersion: "test",
                nodeVersion: "test",
              },
              userInstructions: {
                filePath: join(workspace, "AGENTS.md"),
                fileName: "AGENTS.md",
                content,
                bytesRead: content.length,
                sizeBytes: content.length,
                truncated: false,
              },
            };
          },
        },
        fileSystemPort: new MemoryFileSystem({
          [fixturePath]: `${markers.alpha}\n${markers.beta}\n`,
        }),
        eventSink: {
          onSessionEvent(event) {
            if (event.type !== SessionEventType.SubagentSpawned) return;
            const payload = event.payload as { childSessionId?: SessionId; description?: string };
            if (!payload.childSessionId || !payload.description) return;
            childDescriptionBySession.set(payload.childSessionId, payload.description);
            const node = payload.description.includes("alpha")
              ? "alpha"
              : payload.description.includes("beta")
                ? "beta"
                : undefined;
            if (node) {
              childBySession.set(payload.childSessionId, node);
              if (payload.description.startsWith("Read "))
                directChildSessions.add(payload.childSessionId);
            }
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const callCount = (requestCountBySession.get(sessionId) ?? 0) + 1;
            requestCountBySession.set(sessionId, callCount);
            const requestText = request.messages
              .map((message) =>
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              )
              .join("\n");
            const isPlannerRequest = requestText.includes(
              "Decide whether this task needs independent parallel work",
            );
            const regularCallCount = isPlannerRequest
              ? 0
              : (regularRequestCountBySession.get(sessionId) ?? 0) + 1;
            if (!isPlannerRequest) regularRequestCountBySession.set(sessionId, regularCallCount);
            const requestContextText = `${request.system ?? ""}\n${requestText}`;
            const sessionRequests = modelRequestTextBySession.get(sessionId) ?? [];
            sessionRequests.push(requestContextText);
            modelRequestTextBySession.set(sessionId, sessionRequests);

            if (requestText.includes("Decide whether this task needs independent parallel work")) {
              plannerWorkingDirectories.push(observation.invocationContext?.workingDirectory);
              plannerReasoningLevels.push(observation.model.options.reasoningLevel);
            }

            if (
              sessionId === rootSessionId &&
              requestText.includes("Decide whether this task needs independent parallel work")
            ) {
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
                        subagent_type: "orchestrator",
                      },
                      {
                        id: "beta",
                        description: "Read beta marker",
                        prompt: `Read ${fixturePath} and report ${markers.beta}.`,
                        subagent_type: "researcher",
                      },
                    ],
                  },
                }),
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (
              sessionId !== rootSessionId &&
              requestText.includes("Decide whether this task needs independent parallel work")
            ) {
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
                          subagent_type: "orchestrator",
                        },
                        {
                          id: "grandchild-alpha-two",
                          description: "Grandchild alpha two",
                          prompt: `Grandchild alpha two: read ${fixturePath} and report ${markers.alpha}.`,
                          subagent_type: "orchestrator",
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
                text: JSON.stringify({
                  decision: "leaf",
                  reason: isGrandchild
                    ? "The fixture read is a single focused task."
                    : "The beta fixture read is a single focused task.",
                }),
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
            if (childDescriptionBySession.get(sessionId) === "L4 alpha leaf") {
              levelFourCallCounts.push(callCount);
            }
            if (regularCallCount === 1) {
              const description = childDescriptionBySession.get(sessionId) ?? "";
              if (description.startsWith("Grandchild alpha") || description === "L4 alpha leaf") {
                nestedRoleRequests.push({
                  system: [
                    typeof request.system === "string"
                      ? request.system
                      : JSON.stringify(request.system),
                    requestText,
                  ].join("\n"),
                  tools: (request.tools ?? []).map((tool) => tool.name),
                });
              }
              if (directChildSessions.has(sessionId)) {
                // 原因：alpha 的 nested-split fixture 会在常规响应分支提前返回，绕过下方的并发屏障；beta 因此永久等待 alpha。
                // 修复依据：先让两个根子任务都进入常规轮次，再分别执行 nested synthesis 或文件读取。
                childStarted.add(sessionId);
                if (childStarted.size >= 2) bothChildrenStarted.resolve();
                await bothChildrenStarted.promise;
              }
              if (splitPlannerSessions.has(sessionId)) {
                return {
                  finishReason: "stop",
                  providerMetadata: undefined,
                  text: `Alpha child synthesized nested reports containing ${markers.alpha}.`,
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              if (description === "Grandchild alpha one") {
                const availableTools = (request.tools ?? []).map((tool) => tool.name);
                if (!availableTools.includes("Task")) {
                  throw new Error(
                    `Nested specialist cannot delegate; tools=${availableTools.join(",")}`,
                  );
                }
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_task_swarm_level_four",
                      name: "Task",
                      input: {
                        description: "L4 alpha leaf",
                        prompt: `Grandchild alpha level 4: read ${fixturePath} and report ${markers.alpha}.`,
                        subagent_type: "test-engineer",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              if (description === "L4 alpha leaf") {
                const availableTools = (request.tools ?? []).map((tool) => tool.name);
                if (!availableTools.includes("Skill")) {
                  throw new Error(
                    `Level-four specialist cannot load skills; tools=${availableTools.join(",")}`,
                  );
                }
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_skill_swarm_level_four",
                      name: "Skill",
                      input: { name: "zcode-verification" },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
            }

            if (
              regularCallCount === 2 &&
              childDescriptionBySession.get(sessionId) === "L4 alpha leaf"
            ) {
              if (!requestText.includes("NESTED_VERIFICATION_SKILL_BODY_539e")) {
                throw new Error(
                  "Level-four specialist did not receive the skill loaded through SkillPort",
                );
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: `Level-four specialist used the verification skill and received ${markers.alpha}.`,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (
              regularCallCount === 2 &&
              childDescriptionBySession.get(sessionId) === "Grandchild alpha one"
            ) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: `Grandchild delegated level four work and received ${markers.alpha}.`,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (regularCallCount === 1) {
              const availableTools = (request.tools ?? []).map((tool) => tool.name);
              if (!availableTools.includes("Read")) {
                throw new Error(
                  `Real child runtime does not expose Read; tools=${availableTools.join(",")}`,
                );
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
      const result = await runtime.executeTurn(
        "Read both independent fixture markers using the swarm.",
        undefined,
        {
          intent: { orchestrationMode: "swarm" },
        },
      );
      const rootEvents = await eventStore.getEvents(rootSessionId);
      const spawnEventIndexBySession = new Map(
        rootEvents
          .filter((event) => event.type === SessionEventType.SubagentSpawned)
          .map((event) => [
            (event.payload as { childSessionId: string }).childSessionId,
            rootEvents.indexOf(event),
          ]),
      );
      const swarmProgressEvents = rootEvents
        .filter((event) => event.type === SessionEventType.SwarmRunUpdated)
        .map((event) => ({ event, index: rootEvents.indexOf(event) }))
        .filter(
          ({ event }) =>
            Array.isArray((event.payload as { childSessionIds?: string[] }).childSessionIds) &&
            (event.payload as { childSessionIds: string[] }).childSessionIds.length > 0,
        );
      for (const { event } of swarmProgressEvents) {
        for (const childSessionId of (event.payload as { childSessionIds: string[] })
          .childSessionIds) {
          expect(spawnEventIndexBySession.get(childSessionId)).toBeDefined();
          expect(spawnEventIndexBySession.get(childSessionId)!).toBeLessThan(
            rootEvents.indexOf(event),
          );
        }
      }
      const terminalSwarmEvent = rootEvents
        .filter((event) => event.type === SessionEventType.SwarmRunUpdated)
        .map(
          (event) =>
            event.payload as {
              status: string;
              childSessionIds?: string[];
              childAgentTypes?: Record<string, string>;
              outcomeAcceptance?: string;
            },
        )
        .find((event) => event.status === "completed");
      const childSessionIds = [...childBySession.keys()];
      const childEvents = await Promise.all(
        childSessionIds.map((sessionId) => eventStore.getEvents(sessionId)),
      );
      const descendantSwarmTerminals = childEvents
        .flat()
        .filter(
          (event) =>
            event.type === SessionEventType.SwarmRunUpdated &&
            (event.payload as { status?: string }).status === "completed",
        );
      const toolEvents = childEvents
        .flat()
        .filter(
          (event) =>
            event.type === SessionEventType.ToolCallScheduled ||
            event.type === SessionEventType.ToolCallResult,
        );
      const synthesizedInput = await synthesisReceived.promise;

      expect(childStarted.size).toBe(2);
      expect(descendantPlannerSessions.size).toBe(4);
      expect(plannerWorkingDirectories).toEqual(Array(5).fill(workspace));
      expect(plannerReasoningLevels).toEqual(Array(5).fill("high"));
      expect(childSessionIds).toHaveLength(5);
      expect(levelFourCallCounts).toEqual([1, 2]);
      expect(nestedRoleRequests).toHaveLength(3);
      for (const nestedRequest of nestedRoleRequests) {
        expect(nestedRequest.system).toMatch(/Ты (?:оркестратор|тест-инженер) ZCode/u);
        expect(nestedRequest.tools).toContain("Read");
        expect(nestedRequest.tools).toContain("Task");
        expect(nestedRequest.tools).toContain("RespondToCoordinator");
      }
      expect(new Set(childSessionIds).size).toBe(5);
      expect(directChildSessions.size).toBe(2);
      expect(childEvents).toHaveLength(5);
      // Только реально разбитая child задача создаёт swarm lifecycle; leaf-продолжения не засоряют историю.
      expect(descendantSwarmTerminals).toHaveLength(1);
      for (const events of childEvents.filter((events) =>
        events.some((event) => event.type === SessionEventType.ToolCallScheduled),
      )) {
        expect(events.some((event) => event.type === SessionEventType.ToolCallScheduled)).toBe(
          true,
        );
        expect(
          events.some((event) => event.type === SessionEventType.ToolCallResult),
          `${events[0]?.sessionId}: ${JSON.stringify(events.filter((event) => event.type === SessionEventType.ToolCallError).map((event) => event.payload))}`,
        ).toBe(true);
      }
      expect(terminalSwarmEvent?.childSessionIds).toEqual(
        expect.arrayContaining([...directChildSessions]),
      );
      expect(terminalSwarmEvent?.outcomeAcceptance).toBe("unknown");
      expect(terminalSwarmEvent?.childSessionIds).toHaveLength(2);
      expect(terminalSwarmEvent?.childAgentTypes).toEqual(
        Object.fromEntries(
          [...directChildSessions].map((sessionId) => [
            sessionId,
            childDescriptionBySession.get(sessionId)?.includes("alpha")
              ? "orchestrator"
              : "researcher",
          ]),
        ),
      );
      const taskSnapshots = Object.values(runtimeTaskRegistry.all()).filter(
        (snapshot) =>
          snapshot.type === "local_agent" && childSessionIds.includes(snapshot.childSessionId!),
      );
      expect(taskSnapshots).toHaveLength(5);
      expect(
        taskSnapshots.find((snapshot) => snapshot.description === "L4 alpha leaf")?.status,
      ).toBe("completed");
      expect(
        taskSnapshots.map(({ description, status, error }) => ({ description, status, error })),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ description: "L4 alpha leaf", status: "completed" }),
        ]),
      );
      const levelFourTask = taskSnapshots.find(
        (snapshot) => snapshot.description === "L4 alpha leaf",
      );
      expect(
        childEvents
          .find((events) => events[0]?.sessionId === levelFourTask?.childSessionId)
          ?.filter((event) => event.type === SessionEventType.ModelComplete)
          .at(-1)?.payload as { content?: string } | undefined,
      ).toEqual(
        expect.objectContaining({
          content: expect.stringContaining("Level-four specialist used the verification skill"),
        }),
      );
      expect(
        toolEvents.filter((event) => event.type === SessionEventType.ToolCallScheduled),
      ).toHaveLength(4);
      expect(
        toolEvents.filter((event) => event.type === SessionEventType.ToolCallResult),
      ).toHaveLength(4);
      expect(loadedSkillNames).toEqual(["zcode-verification"]);
      expect(new Set(taskSnapshots.map((snapshot) => snapshot.rootRunId)).size).toBe(1);
      expect(taskSnapshots.every((snapshot) => typeof snapshot.rootRunId === "string")).toBe(true);
      const alphaParent = taskSnapshots.find(
        (snapshot) => snapshot.description === "Read alpha marker",
      );
      const alphaGrandchildren = taskSnapshots.filter((snapshot) =>
        snapshot.description.startsWith("Grandchild alpha"),
      );
      expect(alphaParent).toBeDefined();
      expect(alphaGrandchildren).toHaveLength(2);
      expect(
        alphaGrandchildren.every(
          (snapshot) => snapshot.parentSessionId === alphaParent?.childSessionId,
        ),
      ).toBe(true);
      expect(levelFourTask?.parentSessionId).toBe(
        alphaGrandchildren.find((snapshot) => snapshot.description === "Grandchild alpha one")
          ?.childSessionId,
      );
      expect(modelRequestTextBySession.get(levelFourTask!.childSessionId!)?.join("\n")).toContain(
        "NESTED_VERIFICATION_SKILL_BODY_539e",
      );
      expect(synthesizedInput).toContain(markers.alpha);
      expect(synthesizedInput).toContain(markers.beta);
      expect(result.response).toBe("Swarm synthesis completed from child reports.");
      expect(modelRequestTextBySession.get(rootSessionId)?.join("\n")).toContain(
        workspaceInstructionMarker,
      );
      for (const childSessionId of childSessionIds) {
        expect(modelRequestTextBySession.get(childSessionId)?.join("\n")).toContain(
          workspaceInstructionMarker,
        );
      }
    } finally {
      await runtime.closeBrowserSession();
    }
  }, 30_000);

  it("persists failed child IDs and a bounded child failure reason on the terminal swarm row", async () => {
    const rootSessionId = createSessionId("runtime-swarm-failed-child");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const sessionStore = (
      await import("./subagent-test-store.js")
    ).createRecordingSubagentSessionStore();
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
            const requestText = request.messages
              .map((message) =>
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              )
              .join("\n");

            if (requestText.includes("Decide whether this task needs independent parallel work")) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text:
                  sessionId === rootSessionId
                    ? JSON.stringify({
                        decision: "split",
                        graph: {
                          nodes: [
                            {
                              id: "failing-child",
                              description: "Failing child",
                              prompt: "Fail predictably.",
                              subagent_type: "reviewer",
                            },
                            {
                              id: "successful-child",
                              description: "Successful child",
                              prompt: "Complete normally.",
                              subagent_type: "implementer",
                            },
                          ],
                        },
                      })
                    : JSON.stringify({
                        decision: "leaf",
                        reason: "The child task is already focused.",
                      }),
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
      const turnError = await runtime
        .executeTurn("Run two child tasks and report their completion.", undefined, {
          intent: { orchestrationMode: "swarm" },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const rootEvents = await eventStore.getEvents(rootSessionId);
      const failedSwarmEvent = rootEvents
        .filter((event) => event.type === SessionEventType.SwarmRunUpdated)
        .map(
          (event) =>
            event.payload as { status: string; summary?: string; childSessionIds?: string[] },
        )
        .find((event) => event.status === "failed");
      const failedChildSessionId = [...childDescriptions].find(([, description]) =>
        description.includes("Failing child"),
      )?.[0];

      expect(turnError).toBeDefined();
      expect(failedSwarmEvent?.summary).toContain(
        "Fixture child execution failed with a provider timeout.",
      );
      expect(failedSwarmEvent?.childSessionIds).toEqual(
        expect.arrayContaining([...childDescriptions.keys()]),
      );
      expect(failedSwarmEvent?.childSessionIds).toContain(failedChildSessionId);
    } finally {
      await runtime.closeBrowserSession();
    }
  }, 30_000);

  it("executes an explicit SWARM D1-D5 probe without a planner and returns the leaf result to root", async () => {
    const rootSessionId = createSessionId("runtime-swarm-depth-five-chain");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const sessionStore = (
      await import("./subagent-test-store.js")
    ).createRecordingSubagentSessionStore();
    const workspace = await mkdtemp(join(tmpdir(), "zcode-swarm-depth-five-chain-"));
    const leafMarker = "SWARM_DEPTH_FIVE_LEAF_MARKER_85c1";
    const childDescriptionBySession = new Map<SessionId, string>();
    const sessionByDescription = new Map<string, SessionId>();
    const taskCallDescriptions: string[] = [];
    const taskCallCountsBySession = new Map<SessionId, number>();
    const modelInvocationTrace: string[] = [];
    const observedContextRequests: string[] = [];
    const observedAgentRequests: string[] = [];
    const plannerInvocationSessions: SessionId[] = [];
    let contextSourceResolveCount = 0;
    const bundledRuleMarker = "BUNDLED_HARNESS_RULE_REACHES_D1_D5_76ab";
    const workspaceRuleMarker = "WORKSPACE_RULE_REACHES_D1_D5_93ef";
    let rootSawLeafMarker = false;

    const runtime = createTestAgentRuntime(
      rootSessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-swarm-depth-five-test"),
          modelId: createModelId("swarm-depth-five-test-model"),
        },
        workingDirectory: workspace,
      },
      {
        eventStore,
        sessionStore,
        runtimeTaskRegistry,
        contextSourcePort: {
          async resolveContextSources(request) {
            contextSourceResolveCount += 1;
            return {
              workingDirectory: request.workingDirectory,
              currentDate: request.currentDate,
              envInfo: request.envInfo ?? {
                cwd: request.workingDirectory,
                platform: "test",
                shell: "test",
                osVersion: "test",
                nodeVersion: "test",
              },
              diagnostics: [],
              bundledHarnessRules: [
                {
                  id: "00-evidence",
                  description: "Keep claims tied to runtime evidence.",
                  content: bundledRuleMarker,
                },
              ],
              workspaceRules: [
                {
                  filePath: join(workspace, ".zcode", "rules", "depth-probe.mdc"),
                  fileName: "depth-probe.mdc",
                  globs: [],
                  alwaysApply: true,
                  appliedBy: "alwaysApply",
                  content: workspaceRuleMarker,
                  bytesRead: workspaceRuleMarker.length,
                  sizeBytes: workspaceRuleMarker.length,
                  truncated: false,
                },
              ],
            };
          },
        },
        loadAgentDefinitions: async () => ({
          activeAgents: normalizeAgentProfiles([
            {
              name: "recursive-probe",
              description: "Agent profile for a bounded recursive Task regression.",
              source: "project",
              systemPrompt: "Follow the requested serial Task chain exactly.",
              tools: ["Task"],
              skills: [],
            },
          ]),
        }),
        eventSink: {
          onSessionEvent(event) {
            if (event.type !== SessionEventType.SubagentSpawned) return;
            const payload = event.payload as {
              childSessionId?: SessionId;
              description?: string;
              parentSessionId?: SessionId;
            };
            if (!payload.childSessionId || !payload.description) return;
            childDescriptionBySession.set(payload.childSessionId, payload.description);
            sessionByDescription.set(payload.description, payload.childSessionId);
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (!sessionId) throw new Error("Expected a session-scoped model invocation");
            const requestText = request.messages
              .map((message) =>
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              )
              .join("\n");
            observedContextRequests.push(requestText);
            if (requestText.includes("Decide whether this task needs independent parallel work")) {
              plannerInvocationSessions.push(sessionId);
            } else {
              observedAgentRequests.push(requestText);
            }
            const description = childDescriptionBySession.get(sessionId);
            modelInvocationTrace.push(`${sessionId}:${description ?? "root"}`);
            const promptDepth = requestText.match(/serial capability probe at D(\d)/)?.[1];
            const depth = description ? Number(description.slice(1)) : Number(promptDepth ?? 0);
            const nextDescription = `D${depth + 1}`;

            if (sessionId === rootSessionId) {
              rootSawLeafMarker = requestText.includes(leafMarker);
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: rootSawLeafMarker
                  ? `Root received ${leafMarker}.`
                  : "Root did not receive the leaf result.",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (depth === 5) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: leafMarker,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            if (taskCallCountsBySession.has(sessionId)) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: requestText.includes(leafMarker)
                  ? `${description} returned ${leafMarker}.`
                  : `${description} completed its child task.`,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            const availableTools = (request.tools ?? []).map((tool) => String(tool.name));
            if (sessionId === rootSessionId) {
              throw new Error(
                `Unexpected root tool request during probe synthesis; tools=${availableTools.join(",")}`,
              );
            }
            if (!availableTools.includes("Task")) {
              throw new Error(
                `${description ?? "Root"} cannot continue the recursive probe; tools=${availableTools.join(",")}`,
              );
            }
            taskCallCountsBySession.set(
              sessionId,
              (taskCallCountsBySession.get(sessionId) ?? 0) + 1,
            );
            taskCallDescriptions.push(nextDescription);
            return {
              finishReason: "tool-calls",
              providerMetadata: undefined,
              text: "",
              toolCalls: [
                {
                  id: `call_task_depth_${depth + 1}`,
                  name: "Task",
                  input: {
                    description: nextDescription,
                    prompt: `Continue the serial capability probe at ${nextDescription}.`,
                    subagent_type: "orchestrator",
                  },
                },
              ],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    try {
      let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        runtime.executeTurn(
          "Проверь только рекурсивную вложенность Task на глубине D1-D5.",
          undefined,
          { intent: { orchestrationMode: "swarm" } },
        ),
        new Promise<never>((_, reject) => {
          diagnosticTimer = setTimeout(() => {
            const firstChild = sessionByDescription.get("D1");
            void (firstChild ? eventStore.getEvents(firstChild) : Promise.resolve([])).then(
              (events) =>
                reject(
                  new Error(
                    `Recursive probe did not finish; invocations=${JSON.stringify(modelInvocationTrace.slice(0, 12))}; children=${JSON.stringify([...sessionByDescription])}; contextResolves=${contextSourceResolveCount}; taskCount=${Object.keys(runtimeTaskRegistry.all()).length}; childEvents=${JSON.stringify(events.map(({ type }) => type))}`,
                  ),
                ),
            );
          }, 5_000);
        }),
      ]).finally(() => {
        if (diagnosticTimer) clearTimeout(diagnosticTimer);
      });
      const taskSnapshots = Object.values(runtimeTaskRegistry.all()).filter(
        (snapshot) =>
          snapshot.type === "local_agent" &&
          childDescriptionBySession.has(snapshot.childSessionId!),
      );
      const childEvents = await Promise.all(
        [...sessionByDescription.values()].map((sessionId) => eventStore.getEvents(sessionId)),
      );
      const allTaskEvents = [await eventStore.getEvents(rootSessionId), ...childEvents]
        .flat()
        .filter(
          (event) =>
            event.type === SessionEventType.ToolCallScheduled ||
            event.type === SessionEventType.ToolCallResult,
        );

      expect(taskCallDescriptions).toEqual(["D2", "D3", "D4", "D5"]);
      expect(sessionByDescription.size).toBe(5);
      expect([...sessionByDescription.keys()]).toEqual(["D1", "D2", "D3", "D4", "D5"]);
      expect(taskSnapshots).toHaveLength(5);
      expect(taskSnapshots.map((snapshot) => snapshot.description)).toEqual([
        "D1",
        "D2",
        "D3",
        "D4",
        "D5",
      ]);
      expect(taskSnapshots[0]?.parentSessionId).toBe(rootSessionId);
      for (let index = 1; index < 5; index += 1) {
        expect(taskSnapshots[index]?.parentSessionId).toBe(
          taskSnapshots[index - 1]?.childSessionId,
        );
      }
      expect(new Set(taskSnapshots.map((snapshot) => snapshot.rootRunId)).size).toBe(1);
      expect(taskSnapshots.every((snapshot) => snapshot.status === "completed")).toBe(true);
      for (let index = 0; index < taskSnapshots.length; index += 1) {
        expect(
          taskSnapshots.filter(
            (snapshot) => snapshot.parentSessionId === taskSnapshots[index]?.parentSessionId,
          ),
        ).toHaveLength(1);
      }
      expect(plannerInvocationSessions).not.toContain(rootSessionId);
      for (const description of ["D1", "D2", "D3", "D4"]) {
        expect(taskCallCountsBySession.get(sessionByDescription.get(description)!)).toBe(1);
      }
      expect(taskCallCountsBySession.has(sessionByDescription.get("D5")!)).toBe(false);
      expect(childEvents).toHaveLength(5);
      expect(
        allTaskEvents.filter((event) => event.type === SessionEventType.ToolCallScheduled),
      ).toHaveLength(4);
      expect(
        allTaskEvents.filter((event) => event.type === SessionEventType.ToolCallResult),
      ).toHaveLength(4);
      const scheduledToolNames = allTaskEvents
        .filter((event) => event.type === SessionEventType.ToolCallScheduled)
        .map((event) => (event.payload as { toolName: string }).toolName);
      expect(scheduledToolNames.filter((name) => name === "Task")).toHaveLength(4);
      expect(scheduledToolNames.filter((name) => name === "Agent")).toHaveLength(0);
      expect(rootSawLeafMarker).toBe(true);
      expect(result.response).toContain(leafMarker);
      expect(contextSourceResolveCount).toBe(1);
      expect(observedContextRequests.length).toBeGreaterThanOrEqual(6);
      expect(observedAgentRequests.every((request) => request.includes(bundledRuleMarker))).toBe(
        true,
      );
      expect(observedAgentRequests.every((request) => request.includes(workspaceRuleMarker))).toBe(
        true,
      );
    } finally {
      await runtime.closeBrowserSession();
    }
  }, 30_000);
});

function nodeForPrompt(prompt: string, marker: string): boolean {
  return prompt.includes(marker);
}
