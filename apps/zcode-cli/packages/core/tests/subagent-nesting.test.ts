import {
  createSessionId,
  createTurnId,
  type SessionId,
} from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRuntimeTaskRegistry,
  SUBAGENT_ROOT_MAX_ACTIVE_TASKS,
  SUBAGENT_ROOT_MAX_TASKS,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";

describe("subagent root admission and ownership", () => {
  it("permits recursive nesting while the root active quota has room", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId("subagent-unbounded-depth-root");
    const turnId = createTurnId("subagent-unbounded-depth-turn");
    let parentSessionId = rootSessionId;

    for (
      let depth = 0;
      depth < SUBAGENT_ROOT_MAX_ACTIVE_TASKS - 1;
      depth += 1
    ) {
      const childSessionId = createSessionId(`subagent-depth-${depth}`);
      const admission = registry.registerSubagentTask(
        createTask(
          `agent_depth_${depth}`,
          parentSessionId,
          childSessionId,
          turnId,
        ),
        settledCancellation(),
      );
      expect(admission.accepted).toBe(true);
      if (!admission.accepted) break;
      expect(admission.task.rootSessionId).toBe(rootSessionId);
      parentSessionId = childSessionId;
    }

    expect(Object.keys(registry.all())).toHaveLength(
      SUBAGENT_ROOT_MAX_ACTIVE_TASKS - 1,
    );
  });

  it("admits exactly 128 nodes and rejects node 129 before registration", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId("subagent-total-budget-root");
    const turnId = createTurnId("subagent-total-budget-turn");

    for (let index = 0; index < SUBAGENT_ROOT_MAX_TASKS; index += 1) {
      const taskId = `agent_total_${index}`;
      const admission = registry.registerSubagentTask(
        createTask(
          taskId,
          rootSessionId,
          createSessionId(`${taskId}_session`),
          turnId,
        ),
        settledCancellation(),
      );
      expect(admission.accepted).toBe(true);
      registry.update(taskId, (task) => ({ ...task, status: "completed" }));
    }

    const denied = registry.registerSubagentTask(
      createTask(
        "agent_total_129",
        rootSessionId,
        createSessionId("agent_total_129_session"),
        turnId,
      ),
      settledCancellation(),
    );
    expect(denied).toEqual({ accepted: false, reason: "total_limit" });
    expect(Object.keys(registry.all())).toHaveLength(SUBAGENT_ROOT_MAX_TASKS);
  });

  it("admits 24 active nodes and rejects the 25th", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId("subagent-active-budget-root");
    const turnId = createTurnId("subagent-active-budget-turn");

    for (let index = 0; index < SUBAGENT_ROOT_MAX_ACTIVE_TASKS; index += 1) {
      const taskId = `agent_active_${index}`;
      const admission = registry.registerSubagentTask(
        createTask(
          taskId,
          rootSessionId,
          createSessionId(`${taskId}_session`),
          turnId,
        ),
        settledCancellation(),
      );
      expect(admission.accepted).toBe(true);
    }

    const denied = registry.registerSubagentTask(
      createTask(
        "agent_active_25",
        rootSessionId,
        createSessionId("agent_active_25_session"),
        turnId,
      ),
      settledCancellation(),
    );
    expect(denied).toEqual({ accepted: false, reason: "active_limit" });
    expect(Object.keys(registry.all())).toHaveLength(
      SUBAGENT_ROOT_MAX_ACTIVE_TASKS,
    );
  });

  it("applies the active ceiling across root runs from different turns", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId(
      "subagent-cross-turn-active-budget-root",
    );
    const rootRunIds = new Set<string>();

    for (let index = 0; index < SUBAGENT_ROOT_MAX_ACTIVE_TASKS; index += 1) {
      const taskId = `agent_cross_turn_active_${index}`;
      const admission = registry.registerSubagentTask(
        createTask(
          taskId,
          rootSessionId,
          createSessionId(`${taskId}_session`),
          createTurnId(`subagent-cross-turn-${index}`),
        ),
        settledCancellation(),
      );
      expect(admission.accepted).toBe(true);
      if (admission.accepted) rootRunIds.add(admission.task.rootRunId!);
    }

    expect(rootRunIds.size).toBe(SUBAGENT_ROOT_MAX_ACTIVE_TASKS);
    expect(
      registry.registerSubagentTask(
        createTask(
          "agent_cross_turn_active_25",
          rootSessionId,
          createSessionId("agent_cross_turn_active_25_session"),
          createTurnId("subagent-cross-turn-25"),
        ),
        settledCancellation(),
      ),
    ).toEqual({ accepted: false, reason: "active_limit" });
  });

  it("admits no more than 24 simultaneous nodes from concurrent requests", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId(
      "subagent-concurrent-active-budget-root",
    );
    const turnId = createTurnId("subagent-concurrent-active-budget-turn");

    const admissions = await Promise.all(
      Array.from({ length: SUBAGENT_ROOT_MAX_ACTIVE_TASKS + 1 }, (_, index) =>
        Promise.resolve().then(() =>
          registry.registerSubagentTask(
            createTask(
              `agent_concurrent_active_${index}`,
              rootSessionId,
              createSessionId(`agent_concurrent_active_${index}_session`),
              turnId,
            ),
            settledCancellation(),
          ),
        ),
      ),
    );

    expect(admissions.filter((admission) => admission.accepted)).toHaveLength(
      SUBAGENT_ROOT_MAX_ACTIVE_TASKS,
    );
    expect(admissions.filter((admission) => !admission.accepted)).toEqual([
      { accepted: false, reason: "active_limit" },
    ]);
    expect(Object.keys(registry.all())).toHaveLength(
      SUBAGENT_ROOT_MAX_ACTIVE_TASKS,
    );
  });

  it("keeps a resumed task in its original root-run budget", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId("subagent-resume-budget-root");
    const originalTurnId = createTurnId("subagent-resume-budget-original-turn");
    const resumeTurnId = createTurnId("subagent-resume-budget-resume-turn");
    const childSessionId = createSessionId("subagent-resume-budget-child");
    const task = createTask(
      "agent_resumed_budget",
      rootSessionId,
      childSessionId,
      originalTurnId,
    );
    const first = registry.registerSubagentTask(task, settledCancellation());
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;
    registry.update(task.taskId, (current) => ({
      ...current,
      status: "completed",
    }));

    const resumed = registry.registerSubagentTask(
      { ...task, status: "running", turnId: resumeTurnId },
      settledCancellation(),
    );

    expect(resumed.accepted).toBe(true);
    if (!resumed.accepted) return;
    expect(resumed.task.rootRunId).toBe(first.task.rootRunId);
    expect(
      Object.values(registry.all()).filter(
        (candidate) => candidate.rootRunId === first.task.rootRunId,
      ),
    ).toHaveLength(1);
  });

  it("stamps generic tasks from their root, child, or sibling owner generation", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootA = createSessionId("subagent-generation-root-a");
    const rootB = createSessionId("subagent-generation-root-b");
    const turnId = createTurnId("subagent-generation-turn");
    registry.setBranchGenerationForSession(rootA, 4);
    registry.setBranchGenerationForSession(rootB, 0);
    registry.setActiveBranchGeneration(99);

    const firstSession = createSessionId("subagent-generation-first");
    const first = registry.registerSubagentTask(
      createTask("generation_first", rootA, firstSession, turnId),
      settledCancellation(),
    );
    expect(first.accepted && first.task.branchGeneration).toBe(4);

    const siblingSession = createSessionId("subagent-generation-sibling");
    const sibling = registry.registerSubagentTask(
      createTask("generation_sibling", rootA, siblingSession, turnId),
      settledCancellation(),
    );
    expect(sibling.accepted && sibling.task.branchGeneration).toBe(4);

    registry.setBranchGenerationForSession(firstSession, 9);
    registry.setBranchGenerationForSession(siblingSession, 6);
    const nested = registry.registerSubagentTask(
      createTask(
        "generation_nested",
        firstSession,
        createSessionId("generation_nested_session"),
        turnId,
      ),
      settledCancellation(),
    );
    expect(nested.accepted && nested.task.rootSessionId).toBe(rootA);
    expect(nested.accepted && nested.task.branchGeneration).toBe(9);

    const genericTasks = [
      registerGenericTask(registry, "generic_root", rootA),
      registerGenericTask(registry, "generic_child", firstSession),
      registerGenericTask(registry, "generic_sibling", siblingSession),
      registerGenericTask(registry, "generic_other_root", rootB),
    ];
    expect(genericTasks.map((task) => task.branchGeneration)).toEqual([
      4, 9, 6, 0,
    ]);
    expect(genericTasks.map((task) => task.ownerSessionId)).toEqual([
      rootA,
      firstSession,
      siblingSession,
      rootB,
    ]);

    expect(registry.getBranchGenerationForSession(rootA)).toBe(4);
    expect(registry.getBranchGenerationForSession(firstSession)).toBe(9);
    expect(registry.getBranchGenerationForSession(siblingSession)).toBe(6);
    expect(registry.getBranchGenerationForSession(rootB)).toBe(0);
    const otherRootTask = registry.registerSubagentTask(
      createTask(
        "generation_other_root",
        rootB,
        createSessionId("generation_other_root_session"),
        turnId,
      ),
      settledCancellation(),
    );
    expect(otherRootTask.accepted && otherRootTask.task.branchGeneration).toBe(
      0,
    );
  });

  it("rejects duplicate child ownership and cyclic session lineage before registration", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId("subagent-lineage-root");
    const turnId = createTurnId("subagent-lineage-turn");
    const childSessionId = createSessionId("subagent-lineage-child");
    register(
      registry,
      createTask("lineage_first", rootSessionId, childSessionId, turnId),
      settledCancellation(),
    );

    expect(
      registry.registerSubagentTask(
        createTask("lineage_duplicate", rootSessionId, childSessionId, turnId),
        settledCancellation(),
      ),
    ).toEqual({ accepted: false, reason: "lineage_conflict" });
    expect(
      registry.registerSubagentTask(
        createTask("lineage_cycle", childSessionId, rootSessionId, turnId),
        settledCancellation(),
      ),
    ).toEqual({ accepted: false, reason: "lineage_conflict" });
    expect(Object.keys(registry.all())).toHaveLength(1);
  });

  it("cancels only a target subtree and waits for every runtime to settle", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId("subagent-cascade-root");
    const turnId = createTurnId("subagent-cascade-turn");
    const parentChildSession = createSessionId(
      "subagent-cascade-parent-session",
    );
    const grandchildSession = createSessionId(
      "subagent-cascade-grandchild-session",
    );
    const parentCancellation = controlledCancellation();
    const grandchildCancellation = controlledCancellation();
    const siblingCancellation = controlledCancellation();

    register(
      registry,
      createTask("target", rootSessionId, parentChildSession, turnId),
      parentCancellation,
    );
    register(
      registry,
      createTask("grandchild", parentChildSession, grandchildSession, turnId),
      grandchildCancellation,
    );
    register(
      registry,
      createTask(
        "sibling",
        rootSessionId,
        createSessionId("sibling-session"),
        turnId,
      ),
      siblingCancellation,
    );

    let settled = false;
    const cancellation = registry.cancelSubagentSubtree("target").then(() => {
      settled = true;
    });
    expect(parentCancellation.abort).toHaveBeenCalledTimes(1);
    expect(grandchildCancellation.abort).toHaveBeenCalledTimes(1);
    expect(siblingCancellation.abort).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    parentCancellation.resolve();
    grandchildCancellation.resolve();
    await cancellation;
    expect(settled).toBe(true);
  });

  it("holds terminal waiters and re-admission through finalization, preserving the cancelled snapshot", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId("subagent-finalization-barrier-root");
    const childSessionId = createSessionId(
      "subagent-finalization-barrier-child",
    );
    const turnId = createTurnId("subagent-finalization-barrier-turn");
    let resolveSettled!: (snapshot: RuntimeTaskSnapshot) => void;
    const settled = new Promise<RuntimeTaskSnapshot>((resolve) => {
      resolveSettled = resolve;
    });
    const cancellation = { abort: vi.fn(), settled };
    const task = createTask(
      "finalizing_task",
      rootSessionId,
      childSessionId,
      turnId,
    );
    register(registry, task, cancellation);

    const cancelPromise = registry.cancelSubagentSubtree(task.taskId);
    expect(cancellation.abort).toHaveBeenCalledTimes(1);
    expect(registry.beginSubagentTaskFinalization(task.taskId)).toBe(true);
    registry.update(task.taskId, (current) => ({
      ...current,
      status: "killed",
    }));

    let terminalWaitSettled = false;
    const terminalWait = registry.waitForTerminal(task.taskId).then((snapshot) => {
      terminalWaitSettled = true;
      const reAdmission = registry.registerSubagentTask(
        { ...task, status: "running" },
        settledCancellation(),
      );
      expect(reAdmission.accepted).toBe(true);
      return snapshot;
    });
    expect(terminalWaitSettled).toBe(false);
    expect(registry.isSubagentTaskFinalizing(task.taskId)).toBe(true);
    expect(
      registry.registerSubagentTask(
        { ...task, status: "running" },
        settledCancellation(),
      ),
    ).toEqual({ accepted: false, reason: "task_finalizing" });

    const cancelledSnapshot = registry.get(task.taskId)!;
    resolveSettled(cancelledSnapshot);
    const [cancelResult, terminalResult] = await Promise.all([
      cancelPromise,
      terminalWait,
    ]);

    expect(cancelResult).toMatchObject({
      taskId: task.taskId,
      status: "killed",
    });
    expect(terminalResult).toMatchObject({
      taskId: task.taskId,
      status: "killed",
    });
    expect(registry.get(task.taskId)?.status).toBe("running");
  });

  it("teardown closes direct background children and their descendants before resolving", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const rootSessionId = createSessionId("subagent-owner-teardown-root");
    const turnId = createTurnId("subagent-owner-teardown-turn");
    const childSessionId = createSessionId("subagent-owner-teardown-child");
    const grandchildSessionId = createSessionId(
      "subagent-owner-teardown-grandchild",
    );
    const direct = controlledCancellation();
    const nested = controlledCancellation();
    register(
      registry,
      createTask("direct", rootSessionId, childSessionId, turnId),
      direct,
    );
    register(
      registry,
      createTask("nested", childSessionId, grandchildSessionId, turnId),
      nested,
    );

    let settled = false;
    const teardown = registry.cancelSubagentChildren(rootSessionId).then(() => {
      settled = true;
    });
    expect(direct.abort).toHaveBeenCalledTimes(1);
    expect(nested.abort).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    direct.resolve();
    nested.resolve();
    await teardown;
    expect(settled).toBe(true);
    expect(
      registry.registerSubagentTask(
        createTask(
          "late",
          rootSessionId,
          createSessionId("late-session"),
          turnId,
        ),
        settledCancellation(),
      ),
    ).toEqual({ accepted: false, reason: "owner_closed" });
  });
});

function createTask(
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

function registerGenericTask(
  registry: InMemoryRuntimeTaskRegistry,
  taskId: string,
  ownerSessionId: SessionId,
): RuntimeTaskSnapshot {
  registry.register({
    taskId,
    agentId: taskId,
    agentType: "Bash",
    description: taskId,
    status: "running",
    startedAt: new Date(),
    ownerSessionId,
    type: "local_bash",
  });
  return registry.get(taskId)!;
}

function register(
  registry: InMemoryRuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  cancellation: RuntimeTaskCancellationHandle,
): void {
  expect(registry.registerSubagentTask(task, cancellation).accepted).toBe(true);
}

function settledCancellation(): RuntimeTaskCancellationHandle {
  return { abort: () => undefined, settled: Promise.resolve() };
}

function controlledCancellation(): RuntimeTaskCancellationHandle & {
  resolve(): void;
  abort: ReturnType<typeof vi.fn>;
} {
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  const abort = vi.fn();
  return { abort, settled, resolve };
}
