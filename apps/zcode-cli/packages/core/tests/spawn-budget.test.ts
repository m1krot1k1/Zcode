import {
  SessionEventType,
  createSessionId,
  createTraceId,
  createTurnId,
  type AgentCompletedOutput,
  type AgentOutput,
  type SessionEvent,
  type SessionId,
  type SubagentTaskDagRequest,
  type SubagentRunOptions,
  type SubagentRunRequest,
} from "@zcode/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPAWN_BUDGET,
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import {
  createExploreSubagentPort,
  executeSubagentTaskDag,
  resolveActualMaxParallel,
  resolveSpawnGrant,
  resolveSwarmParallelismWithCapacity,
} from "../src/subagent/runner.js";
import type {
  ExploreSubagentPortOptions,
  ExploreSubagentRuntimeRequest,
} from "../src/subagent/runner.js";
import { buildSpawnEnvelope } from "../src/runtime/methods/subagent.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

describe("subagent spawn budget", () => {
  it("defaults to 32 and rejects the next spawn once the root budget is exhausted (a)", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-budget-root");
    const turnId = createTurnId("spawn-budget-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId });

    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.spawnBudget).toBe(DEFAULT_SPAWN_BUDGET);

    for (let index = 0; index < DEFAULT_SPAWN_BUDGET; index += 1) {
      const result = registry.registerSubagentTask(
        task(`spawn-${index}`, root, createSessionId(`spawn-child-${index}`), turnId),
        settled(),
      );
      expect(result).toMatchObject({ accepted: true });
      // 主动结束该任务以释放 24 个 active slot；本用例只验证 spawn 预算，
      // 不应被并发上限提前截断。
      if (result.accepted) {
        expect(registry.beginSubagentTaskFinalization(result.task.taskId)).toBe(true);
      }
      await flushMicrotasks();
    }

    const rejected = registry.registerSubagentTask(
      task("spawn-overflow", root, createSessionId("spawn-child-overflow"), turnId),
      settled(),
    );
    expect(rejected).toEqual({ accepted: false, reason: "spawn_budget_exhausted" });
    const snapshot = registry.getRootRunBudgetSnapshot(rootRunId);
    expect(snapshot?.spawnsUsed).toBe(DEFAULT_SPAWN_BUDGET);
    expect(snapshot?.remainingSpawnsBySession.get(root)).toBe(0);
  });

  it("keeps child budgets strictly smaller than the parent and conserves the sum (b)", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-monotonic-root");
    const child = createSessionId("spawn-monotonic-child");
    const grandchild = createSessionId("spawn-monotonic-grandchild");
    const turnId = createTurnId("spawn-monotonic-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      spawnBudget: 8,
    });

    const first = registry.registerSubagentTask(
      task("monotonic-1", root, child, turnId),
      settled(),
    );
    expect(first.accepted && first.task.spawnGrant).toBe(7);
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.remainingSpawnsBySession.get(root)).toBe(
      7,
    );

    const second = registry.registerSubagentTask(
      task("monotonic-2", child, grandchild, turnId),
      settled(),
    );
    expect(second.accepted && second.task.spawnGrant).toBe(6);
    const snapshot = registry.getRootRunBudgetSnapshot(rootRunId);
    expect(snapshot?.remainingSpawnsBySession.get(child)).toBe(6);
    expect(snapshot?.remainingSpawnsBySession.get(grandchild)).toBe(6);
    expect(snapshot?.spawnsUsed).toBe(2);
    // 父级 8 = 自身保留 + 已发出 1 个 + 子级剩余 7；每层严格递减。
    expect(snapshot?.remainingSpawnsBySession.get(root)).toBe(7);
    expect(snapshot?.remainingSpawnsBySession.get(child)).toBeLessThan(7);
  });

  it("splits a DAG batch with keep/pool/n and leaves the remainder to the parent (c)", async () => {
    const grants: Array<number | undefined> = [];
    const request = makeTaskDagRequest([dagNode("a"), dagNode("b"), dagNode("c")], 8);

    await executeSubagentTaskDag(
      request,
      async (node, _prompt, spawnGrant) => {
        grants.push(spawnGrant);
        return completedDagOutput(node.id);
      },
      { internalSpawnGrant: 32 },
    );

    // r=32, nodeCount=3 → actual maxParallel=3: keep=3, pool=29, каждый узел получает 9.
    expect(grants).toEqual([9, 9, 9]);
  });

  it("blocks every spawn when the configured budget is 0 (d)", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-zero-root");
    const turnId = createTurnId("spawn-zero-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      spawnBudget: 0,
    });

    expect(
      registry.registerSubagentTask(
        task("zero-1", root, createSessionId("spawn-zero-child"), turnId),
        settled(),
      ),
    ).toEqual({ accepted: false, reason: "spawn_budget_exhausted" });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.spawnsUsed).toBe(0);
  });

  it("clamps a model-supplied remaining_spawns to the host grant (e)", () => {
    const request = { spawnBudget: 999 } as SubagentRunRequest;
    const runOptions = { internalSpawnGrant: 7 } as SubagentRunOptions;
    const options = { spawnBudget: 32 } as ExploreSubagentPortOptions;

    expect(resolveSpawnGrant(request, runOptions, options)).toBe(6);
    expect(resolveSpawnGrant({ spawnBudget: 3 } as SubagentRunRequest, runOptions, options)).toBe(
      3,
    );
    expect(resolveSpawnGrant({} as SubagentRunRequest, undefined, options)).toBe(31);

    // registry 也独立把子级声明的 grant 夹到 hostGrant，不能靠伪造字段绕过。
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-clamp-root");
    const turnId = createTurnId("spawn-clamp-turn");
    registry.beginRootRunBudget({
      rootRunId: `${root}:${turnId}`,
      rootSessionId: root,
      turnId,
      spawnBudget: 32,
    });
    const accepted = registry.registerSubagentTask(
      { ...task("clamp-1", root, createSessionId("spawn-clamp-child"), turnId), spawnGrant: 999 },
      settled(),
    );
    expect(accepted.accepted && accepted.task.spawnGrant).toBe(31);
  });

  it("does not gate legacy callers without a root-run state (f)", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-legacy-root");
    const turnId = createTurnId("spawn-legacy-turn");

    const accepted = registry.registerSubagentTask(
      task("legacy-1", root, createSessionId("spawn-legacy-child"), turnId),
      settled(),
    );
    expect(accepted.accepted).toBe(true);
    expect(accepted.accepted && accepted.task.spawnGrant).toBeUndefined();
  });

  it("counts registry remaining budget for grants instead of the port fallback (g)", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-registry-root");
    const turnId = createTurnId("spawn-registry-turn");
    registry.beginRootRunBudget({
      rootRunId: `${root}:${turnId}`,
      rootSessionId: root,
      turnId,
      spawnBudget: 4,
    });
    const options = { spawnBudget: 32 } as ExploreSubagentPortOptions;

    expect(
      resolveSpawnGrant(
        { sessionId: root, turnId } as SubagentRunRequest,
        undefined,
        options,
        registry,
      ),
    ).toBe(3);
  });

  it("computes actual maxParallel from nodeCount, request, remaining and active cap (h)", () => {
    expect(
      resolveActualMaxParallel({ nodeCount: 5, requestedMaxParallel: 8, remainingSpawns: 2 }),
    ).toBe(2);
    // max(1): даже при нулевом остатке один узел должен дойти до admission.
    expect(
      resolveActualMaxParallel({ nodeCount: 5, requestedMaxParallel: 8, remainingSpawns: 0 }),
    ).toBe(1);
    expect(
      resolveActualMaxParallel({
        nodeCount: 5,
        requestedMaxParallel: 8,
        activeCount: 24,
        activeCap: 24,
      }),
    ).toBe(1);

    expect(
      resolveSwarmParallelismWithCapacity({
        nodeCount: 5,
        requestedMaxParallel: 8,
        remainingSpawns: 2,
      }),
    ).toMatchObject({ route: "orchestrate", maxParallel: 2 });
    expect(
      resolveSwarmParallelismWithCapacity({
        nodeCount: 5,
        spawnBudget: 8,
        remainingSpawns: 0,
      }),
    ).toMatchObject({ route: "integrate_inline", maxParallel: 0 });
    expect(
      resolveSwarmParallelismWithCapacity({
        nodeCount: 5,
        spawnBudget: 8,
        activeCount: 24,
        activeCap: 24,
      }),
    ).toMatchObject({ route: "integrate_inline", maxParallel: 0 });
  });

  it("prints the actual max_parallel in the spawn envelope, never a hardcoded 8 (i)", () => {
    expect(buildSpawnEnvelope({ level: 1, spawnGrant: 2, maxParallel: 2 })).toBe(
      '<zcode-spawn-envelope level="1" remaining_spawns="2" max_parallel="2" />',
    );
    expect(buildSpawnEnvelope({ level: 2, spawnGrant: 2, maxParallel: 2 })).not.toContain(
      'max_parallel="8"',
    );
    expect(buildSpawnEnvelope({ level: 1, spawnGrant: 2 })).toBe(
      '<zcode-spawn-envelope level="1" remaining_spawns="2" />',
    );
    expect(buildSpawnEnvelope({})).toBeUndefined();
  });

  it("clamps a 5-node DAG to the registry remaining=2 and surfaces exhausted spawns (j)", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-dag-remaining-root");
    const turnId = createTurnId("spawn-dag-remaining-turn");
    registry.beginRootRunBudget({
      rootRunId: `${root}:${turnId}`,
      rootSessionId: root,
      turnId,
      spawnBudget: 2,
    });
    let active = 0;
    let maxActive = 0;
    const port = createExploreSubagentPort({
      outputRootDir: "/tmp/zcode-spawn-dag-remaining",
      runtimeTaskRegistry: registry,
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { events: [], response: "node done", traceId: request.traceContext.traceId };
      },
    });

    const output = (await port.runTaskDag?.({
      ...makeTaskDagRequest(
        ["n1", "n2", "n3", "n4", "n5"].map((id) => ({
          ...dagNode(id),
          subagent_type: "Explore",
        })),
        8,
      ),
      sessionId: root,
      turnId,
    })) as AgentCompletedOutput;

    expect(maxActive).toBe(2);
    expect(output.workResult?.status).toBe("failed");
    const text = output.content.map((block) => block.text).join("\n");
    expect(text).toContain("Work result: status=failed");
    expect(text).toContain("Spawn budget exhausted");
  });

  it("keeps spawn_budget_exhausted visible in DAG output and WorkResult when remaining=0 (k)", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-dag-zero-root");
    const turnId = createTurnId("spawn-dag-zero-turn");
    registry.beginRootRunBudget({
      rootRunId: `${root}:${turnId}`,
      rootSessionId: root,
      turnId,
      spawnBudget: 0,
    });
    let childRuns = 0;
    const port = createExploreSubagentPort({
      outputRootDir: "/tmp/zcode-spawn-dag-zero",
      runtimeTaskRegistry: registry,
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        childRuns += 1;
        return { events: [], response: "should not run", traceId: request.traceContext.traceId };
      },
    });

    const output = (await port.runTaskDag?.({
      ...makeTaskDagRequest([dagNode("z1"), dagNode("z2")], 8),
      sessionId: root,
      turnId,
      nodes: [
        { ...dagNode("z1"), subagent_type: "Explore" },
        { ...dagNode("z2"), subagent_type: "Explore" },
      ],
    })) as AgentCompletedOutput;

    expect(childRuns).toBe(0);
    expect(output.workResult?.status).toBe("failed");
    expect(output.workResult?.unresolved.join(" ")).toContain("spawn_budget_exhausted");
    const text = output.content.map((block) => block.text).join("\n");
    expect(text).toContain("Work result: status=failed");
    expect(text).toContain("Spawn budget exhausted");
  });

  it("feeds the DAG child request with the registry-clamped capacity, not the requested 8 (m)", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-envelope-dag-root");
    const turnId = createTurnId("spawn-envelope-dag-turn");
    registry.beginRootRunBudget({
      rootRunId: `${root}:${turnId}`,
      rootSessionId: root,
      turnId,
      spawnBudget: 2,
    });
    const childRequests: ExploreSubagentRuntimeRequest[] = [];
    const port = createExploreSubagentPort({
      outputRootDir: "/tmp/zcode-spawn-envelope-dag",
      runtimeTaskRegistry: registry,
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        childRequests.push(request);
        return { events: [], response: "node done", traceId: request.traceContext.traceId };
      },
    });

    await port.runTaskDag?.({
      ...makeTaskDagRequest(
        ["envelope-a", "envelope-b"].map((id) => ({
          ...dagNode(id),
          subagent_type: "Explore",
        })),
        8,
      ),
      sessionId: root,
      turnId,
    });

    const envelopeInputs = childRequests.map((request) => ({
      level: request.level,
      spawnGrant: request.spawnGrant,
      maxParallel: request.maxParallel,
      prompt: request.prompt,
    }));

    expect(envelopeInputs).toHaveLength(2);
    // DAG-узел получает уровень 2 (root -> DAG -> child) и grant строго меньше
    // родительского: при бюджете 2 registry выдаёт 1 первому ребёнку и 0 второму.
    expect(envelopeInputs.map((input) => input.level)).toEqual([2, 2]);
    expect(envelopeInputs.map((input) => input.spawnGrant).sort()).toEqual([0, 1]);
    expect(envelopeInputs.map((input) => input.maxParallel).sort()).toEqual([0, 1]);
    // Fake runExploreAgent получает task prompt узла; конверт spawn собирает реальный
    // runExploreAgent из этих полей в system prompt (проверяется тестом (n)).
    expect(
      envelopeInputs.every(
        (input) =>
          input.prompt.includes("Overall objective: Execute a dependency graph") &&
          input.prompt.includes("Task node"),
      ),
    ).toBe(true);
    const envelopes = envelopeInputs
      .map((input) =>
        buildSpawnEnvelope({
          level: input.level,
          spawnGrant: input.spawnGrant,
          maxParallel: input.maxParallel,
        }),
      )
      .sort();
    expect(envelopes).toEqual([
      '<zcode-spawn-envelope level="2" remaining_spawns="0" max_parallel="0" />',
      '<zcode-spawn-envelope level="2" remaining_spawns="1" max_parallel="1" />',
    ]);
    expect(envelopes.join("\n")).not.toContain('max_parallel="8"');
  });

  it("prints the actual max_parallel in the real child system prompt (n)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "zcode-spawn-envelope-real-"));
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-envelope-real-root");
    const turnId = createTurnId("spawn-envelope-real-turn");
    registry.beginRootRunBudget({
      rootRunId: `${root}:${turnId}`,
      rootSessionId: root,
      turnId,
      spawnBudget: 2,
    });
    const childSystemPrompts: string[] = [];
    const runtime = createTestAgentRuntime(
      root,
      { mode: "build", workingDirectory: workspace },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: createRecordingSubagentSessionStore(),
        runtimeTaskRegistry: registry,
        fileSystemPort: new MemoryFileSystem({}),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const sessionId = observation.invocationContext?.traceContext?.sessionId;
            if (sessionId !== root) {
              childSystemPrompts.push(
                (request.messages ?? [])
                  .filter((message) => message.role === "system")
                  .map((message) =>
                    typeof message.content === "string"
                      ? message.content
                      : JSON.stringify(message.content),
                  )
                  .join("\n"),
              );
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "child done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    try {
      const port = (runtime as any).subagentPort;
      const output = (await port.runTaskDag({
        sessionId: root,
        turnId,
        parentToolCallId: "spawn-envelope-real-call",
        agentType: "Explore",
        description: "Real child envelope probe",
        prompt: "Complete the requested graph objective",
        nodes: [
          { ...dagNode("real-a"), subagent_type: "Explore" },
          { ...dagNode("real-b"), subagent_type: "Explore" },
        ],
        maxParallel: 8,
        callerCanReadOutputFile: true,
        workingDirectory: workspace,
        workspaceRoot: workspace,
        trace: {
          traceId: createTraceId("trace-spawn-envelope-real"),
          sessionId: root,
          turnId,
        },
      })) as AgentCompletedOutput;

      expect(output.status).toBe("completed");
      expect(childSystemPrompts).toHaveLength(2);
      const envelopes = childSystemPrompts
        .flatMap((prompt) => prompt.match(/<zcode-spawn-envelope [^>]*\/>/g) ?? [])
        .sort();
      expect(envelopes).toEqual([
        '<zcode-spawn-envelope level="2" remaining_spawns="0" max_parallel="0" />',
        '<zcode-spawn-envelope level="2" remaining_spawns="1" max_parallel="1" />',
      ]);
      expect(envelopes.join("\n")).not.toContain('max_parallel="8"');
    } finally {
      await runtime.closeBrowserSession();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("emits runId/attemptId in SubagentSpawned and the actual maxParallel to the child (l)", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-correlation-root");
    const turnId = createTurnId("spawn-correlation-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, spawnBudget: 4 });
    const events: SessionEvent[] = [];
    const childMaxParallel: Array<number | undefined> = [];
    const port = createExploreSubagentPort({
      outputRootDir: "/tmp/zcode-spawn-correlation",
      runtimeTaskRegistry: registry,
      emitParentEvent: async (event) => {
        events.push(event);
      },
      runExploreAgent: async (request) => {
        childMaxParallel.push(request.maxParallel);
        return { events: [], response: "ok", traceId: request.traceContext.traceId };
      },
    });

    await port.run({
      sessionId: root,
      turnId,
      parentToolCallId: "spawn-correlation-call",
      agentType: "Explore",
      description: "Correlation probe",
      prompt: "Return a short answer.",
      callerCanReadOutputFile: true,
      workingDirectory: "/tmp/zcode-spawn-correlation",
      workspaceRoot: "/tmp/zcode-spawn-correlation",
      trace: {
        traceId: "trace_spawn_correlation",
        spanId: "span_spawn_correlation",
        sessionId: root,
        turnId,
      },
    });

    const spawned = events.find((event) => event.type === SessionEventType.SubagentSpawned);
    expect(spawned?.payload).toMatchObject({
      runId: rootRunId,
      attemptId: expect.any(String),
    });
    // grant = remaining(4) - 1 = 3; активных слотов нет, cap 24 → max_parallel = 3.
    expect(childMaxParallel).toEqual([3]);
  });
});

function task(
  taskId: string,
  parentSessionId: SessionId,
  childSessionId: SessionId,
  turnId: ReturnType<typeof createTurnId>,
): RuntimeTaskSnapshot {
  return {
    taskId,
    agentId: taskId,
    agentType: "general-purpose",
    description: taskId,
    status: "running",
    startedAt: new Date(),
    childSessionId,
    parentSessionId,
    turnId,
    type: "local_agent",
  };
}

function settled(): RuntimeTaskCancellationHandle {
  return { abort() {}, settled: Promise.resolve() };
}

async function flushMicrotasks(): Promise<void> {
  for (let iteration = 0; iteration < 8; iteration += 1) await Promise.resolve();
}

function makeTaskDagRequest(
  nodes: SubagentTaskDagRequest["nodes"],
  maxParallel = 8,
): SubagentTaskDagRequest {
  return {
    sessionId: createSessionId("spawn-budget-dag-session"),
    turnId: createTurnId("spawn-budget-dag-turn"),
    parentToolCallId: "spawn-budget-dag-tool-call",
    agentType: "general-purpose",
    description: "Execute a dependency graph",
    prompt: "Complete the requested graph objective",
    nodes,
    maxParallel,
    callerCanReadOutputFile: true,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    trace: {} as SubagentTaskDagRequest["trace"],
  };
}

function dagNode(id: string) {
  return {
    id,
    description: `Task ${id}`,
    prompt: `Perform task ${id}`,
    subagent_type: "general-purpose",
  };
}

function completedDagOutput(agentId: string): AgentOutput {
  return {
    status: "completed",
    agentId,
    agentType: "general-purpose",
    description: `Task ${agentId}`,
    prompt: `Perform task ${agentId}`,
    content: [{ type: "text", text: `Result for ${agentId}` }],
    totalToolUseCount: 1,
    totalDurationMs: 1,
  };
}
