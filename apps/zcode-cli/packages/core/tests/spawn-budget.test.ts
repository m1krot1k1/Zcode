import { createSessionId, createTurnId, type SessionId } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import {
  InMemoryRuntimeTaskRegistry,
  resolveAdaptiveSubagentMaxParallel,
  resolveSubagentMaxParallel,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { buildSpawnEnvelope } from "../src/runtime/methods/subagent.js";

describe("legacy spawn budget compatibility", () => {
  it("ignores persisted task-count budgets and grants without limiting new tasks", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("legacy-budget-root");
    const turnId = createTurnId("legacy-budget-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      // Старое значение могло быть сохранено в настройках; оно больше не лимитирует запуск.
      spawnBudget: 1,
      maxParallel: 1,
    });

    for (let index = 0; index < 160; index += 1) {
      const taskId = `legacy-budget-task-${index}`;
      const admission = registry.registerSubagentTask(
        {
          ...task(taskId, root, createSessionId(`legacy-budget-child-${index}`), turnId),
          spawnGrant: 0,
        },
        settled(),
      );
      expect(admission).toMatchObject({ accepted: true });
      if (!admission.accepted) break;
      expect(admission.task.spawnGrant).toBeUndefined();
      registry.update(taskId, (current) => ({ ...current, status: "completed" }));
    }

    expect(Object.keys(registry.all())).toHaveLength(160);
  });

  it("keeps live concurrency bounded by host capacity and active work", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("worker-capacity-root");
    const turnId = createTurnId("worker-capacity-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, maxParallel: 2 });

    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.maxParallel).toBe(2);
    expect(registry.registerSubagentTask(task("worker-1", root, createSessionId("worker-1-child"), turnId), settled())).toMatchObject({ accepted: true });
    expect(registry.registerSubagentTask(task("worker-2", root, createSessionId("worker-2-child"), turnId), settled())).toMatchObject({ accepted: true });
    expect(registry.registerSubagentTask(task("worker-3", root, createSessionId("worker-3-child"), turnId), settled())).toEqual({ accepted: false, reason: "active_limit" });

    expect(resolveAdaptiveSubagentMaxParallel(1)).toBe(1);
    expect(resolveAdaptiveSubagentMaxParallel(8)).toBe(8);
    expect(resolveSubagentMaxParallel(1)).toBe(1);
    expect(resolveSubagentMaxParallel(999)).toBe(resolveAdaptiveSubagentMaxParallel());
  });

  it("includes only recursion level and available concurrency in the child envelope", () => {
    expect(buildSpawnEnvelope({ level: 2, maxParallel: 3 })).toBe(
      '<zcode-spawn-envelope level="2" max_parallel="3" />',
    );
  });
});

describe("worker capacity wait", () => {
  it("wakes a waiter when an active slot is released", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("capacity-wait-root");
    const turnId = createTurnId("capacity-wait-turn");
    registry.beginRootRunBudget({
      rootRunId: `${root}:${turnId}`,
      rootSessionId: root,
      turnId,
      maxParallel: 1,
    });
    expect(
      registry.registerSubagentTask(
        task("capacity-wait-1", root, createSessionId("capacity-wait-child-1"), turnId),
        settled(),
      ),
    ).toMatchObject({ accepted: true });
    expect(
      registry.registerSubagentTask(
        task("capacity-wait-2", root, createSessionId("capacity-wait-child-2"), turnId),
        settled(),
      ),
    ).toEqual({ accepted: false, reason: "active_limit" });

    let woke = false;
    const waiting = registry.waitForCapacityChange().then(() => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(false);

    registry.update("capacity-wait-1", (current) => ({ ...current, status: "completed" }));
    await waiting;
    expect(woke).toBe(true);
    expect(
      registry.registerSubagentTask(
        task("capacity-wait-2", root, createSessionId("capacity-wait-child-2"), turnId),
        settled(),
      ),
    ).toMatchObject({ accepted: true });
  });

  it("rejects the wait when the parent aborts", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const controller = new AbortController();
    const waiting = registry.waitForCapacityChange({ signal: controller.signal });
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
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
    agentType: "implementer",
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
