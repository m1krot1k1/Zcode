import {
  createSessionId,
  createTurnId,
  type AgentOutput,
  type SessionId,
  type SubagentTaskDagRequest,
  type SubagentRunOptions,
  type SubagentRunRequest,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPAWN_BUDGET,
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { executeSubagentTaskDag, resolveSpawnGrant } from "../src/subagent/runner.js";
import type { ExploreSubagentPortOptions } from "../src/subagent/runner.js";

describe("subagent spawn budget", () => {
  it("defaults to 32 and rejects the next spawn once the root budget is exhausted (a)", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("spawn-budget-root");
    const turnId = createTurnId("spawn-budget-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId });

    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.spawnBudget).toBe(
      DEFAULT_SPAWN_BUDGET,
    );

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

    // r=32, maxParallel=8, n=3: keep=8, pool=24, each=8，余数 0 留给父级。
    expect(grants).toEqual([8, 8, 8]);
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
    expect(
      resolveSpawnGrant({ spawnBudget: 3 } as SubagentRunRequest, runOptions, options),
    ).toBe(3);
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
