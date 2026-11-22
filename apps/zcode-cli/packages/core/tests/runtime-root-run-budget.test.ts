import { createSessionId, createTurnId, type SessionId } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROOT_RUN_DEADLINE_MS,
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";

describe("RootRun deadline budget", () => {
  it("has no wall-clock deadline by default and keeps the run until it finishes", () => {
    vi.useFakeTimers();
    try {
      const registry = new InMemoryRuntimeTaskRegistry();
      const root = createSessionId("root-budget-default-deadline");
      const turnId = createTurnId("root-budget-default-deadline-turn");
      const rootRunId = `${root}:${turnId}`;
      const startedAt = new Date("2026-11-08T00:00:00.000Z");
      registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, startedAt: startedAt.getTime() });

      // По умолчанию срок не задан: root выполняется до завершения или Stop.
      expect(DEFAULT_ROOT_RUN_DEADLINE_MS).toBeUndefined();
      expect(registry.getRootRunBudgetSnapshot(rootRunId)?.deadlineAt).toBeUndefined();
      expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
      // Даже спустя много часов без явного deadline run остаётся живым.
      vi.advanceTimersByTime(24 * 60 * 60_000);
      expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours an explicit deadline when the caller supplies one", () => {
    vi.useFakeTimers();
    try {
      const registry = new InMemoryRuntimeTaskRegistry();
      const root = createSessionId("root-budget-explicit-deadline");
      const turnId = createTurnId("root-budget-explicit-deadline-turn");
      const rootRunId = `${root}:${turnId}`;
      const startedAt = new Date("2026-11-08T00:00:00.000Z");
      registry.beginRootRunBudget({
        rootRunId,
        rootSessionId: root,
        turnId,
        startedAt: startedAt.getTime(),
        deadlineMs: 60 * 60_000,
      });

      expect(registry.getRootRunBudgetSnapshot(rootRunId)?.deadlineAt).toBe(
        startedAt.getTime() + 60 * 60_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("deadline aborts the root and waits through the existing child cancellation handle", async () => {
    vi.useFakeTimers();
    try {
      const registry = new InMemoryRuntimeTaskRegistry();
      const root = createSessionId("root-budget-deadline");
      const child = createSessionId("root-budget-deadline-child");
      const turnId = createTurnId("root-budget-deadline-turn");
      const rootRunId = `${root}:${turnId}`;
      const cancellation = controlled();
      const abortRoot = vi.fn();
      registry.beginRootRunBudget({
        rootRunId,
        rootSessionId: root,
        turnId,
        deadlineMs: 5,
        onExhausted: abortRoot,
      });
      registry.registerSubagentTask(task("deadline-child", root, child, turnId), cancellation);
      await vi.advanceTimersByTimeAsync(5);
      expect(abortRoot).toHaveBeenCalledOnce();
      expect(cancellation.abort).toHaveBeenCalledOnce();
      expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(true);
      let settled = false;
      const cancellationWait = registry.waitForRootRunCancellation(rootRunId).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      cancellation.resolve();
      await cancellationWait;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

function controlled(): RuntimeTaskCancellationHandle & {
  abort: ReturnType<typeof vi.fn>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const settled = new Promise<void>((done) => (resolve = done));
  const abort = vi.fn();
  return { abort, settled, resolve };
}
