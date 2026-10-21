import {
  createSessionEvent,
  createSessionId,
  createTurnId,
  SessionEventType,
  type SessionId,
} from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRuntimeTaskRegistry,
  RootRunBudgetExceededError,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";

describe("RootRun resource budget", () => {
  it("counts each raw root and nested-child usage event once by event identity", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-root");
    const child = createSessionId("root-budget-child");
    const grandchild = createSessionId("root-budget-grandchild");
    const turnId = createTurnId("root-budget-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId });
    registry.registerSubagentTask(task("child", root, child, turnId), settled());
    registry.registerSubagentTask(task("grandchild", child, grandchild, turnId), settled());
    const releaseRootReservation = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 50,
      maxTokens: 50,
    });

    const rootUsage = modelComplete(root, turnId, 11);
    const childUsage = modelComplete(child, turnId, 7);
    const grandchildUsage = modelComplete(grandchild, turnId, 5);
    const failedUsage = createSessionEvent(
      SessionEventType.ModelNetworkStatus,
      grandchild,
      { type: "model_request_failed", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
      { turnId },
    );
    registry.recordRootRunUsage(rootUsage);
    registry.recordRootRunUsage(rootUsage);
    registry.recordRootRunUsage(childUsage);
    registry.recordRootRunUsage(grandchildUsage);
    registry.recordRootRunUsage(failedUsage);
    registry.recordRootRunUsage(failedUsage);
    releaseRootReservation();

    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.usedTokens).toBe(26);
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(0);
  });

  it("matches out-of-order terminal usage to the reservation for the same provider request", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-request-match");
    const turnId = createTurnId("root-budget-request-match-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 1_000 });
    const reservationA = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 60,
      maxTokens: 40,
    });
    const reservationB = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 300,
      maxTokens: 200,
    });
    reservationA.associateRequestId("request-a");
    reservationB.associateRequestId("request-b");

    registry.recordRootRunUsage(
      createSessionEvent(
        SessionEventType.ModelNetworkStatus,
        root,
        { type: "model_request_failed", requestId: "request-b" },
        { turnId },
      ),
    );
    registry.recordRootRunUsage(modelComplete(root, turnId, 10, "request-a"));

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 510,
      reservedTokens: 0,
    });
    reservationA();
    reservationB();
  });

  it("caps the next reservation to the remainder and rejects once the cap is fully reserved", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-reservation");
    const turnId = createTurnId("root-budget-reservation-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 100 });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 50,
      maxTokens: 40,
    });
    const releaseRemaining = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 50,
      maxTokens: 40,
    });
    const providerCall = vi.fn();
    expect(() => {
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 50,
        maxTokens: 40,
      });
      providerCall();
    }).toThrow(RootRunBudgetExceededError);
    expect(providerCall).not.toHaveBeenCalled();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(100);
    releaseRemaining();
    release();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(0);
  });

  it("admits an oversized context exclusively up to the remaining cap and debits reported usage", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-oversized-context");
    const turnId = createTurnId("root-budget-oversized-context-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 1_000_000,
      maxTokens: 40_000,
    });
    release.associateRequestId("oversized-success");
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(500_000);

    const providerCall = vi.fn();
    expect(() => {
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 1_000_000,
        maxTokens: 40_000,
      });
      providerCall();
    }).toThrow(RootRunBudgetExceededError);
    expect(providerCall).not.toHaveBeenCalled();

    registry.recordRootRunUsage(modelComplete(root, turnId, 5_000, "oversized-success"));
    release();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 5_000,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    const nextRelease = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 1_000_000,
      maxTokens: 40_000,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(495_000);
    nextRelease();
  });

  it("charges the capped reservation and expires the run when oversized request usage is missing", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-oversized-unknown");
    const turnId = createTurnId("root-budget-oversized-unknown-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 1_000_000,
      maxTokens: 40_000,
    });
    release.associateRequestId("oversized-request");
    const unknownUsage = createSessionEvent(
      SessionEventType.ModelNetworkStatus,
      root,
      { type: "model_request_failed", requestId: "oversized-request" },
      { turnId },
    );
    registry.recordRootRunUsage(unknownUsage);
    release();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 500_000,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(true);
  });

  it("charges the full reservation when a terminal event has unknown usage, and deduplicates it", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-unknown-usage");
    const turnId = createTurnId("root-budget-unknown-usage-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 1_000 });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 70,
      maxTokens: 30,
    });
    release.associateRequestId("unknown-request");
    const unknownUsage = createSessionEvent(
      SessionEventType.ModelNetworkStatus,
      root,
      { type: "model_request_failed", requestId: "unknown-request" },
      { turnId },
    );
    registry.recordRootRunUsage(unknownUsage);
    registry.recordRootRunUsage(unknownUsage);
    release();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      reservedTokens: 0,
      usedTokens: 100,
    });
  });

  it("keeps a finished root turn budget until its background child settles", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-background");
    const child = createSessionId("root-budget-background-child");
    const turnId = createTurnId("root-budget-background-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId });
    registry.registerSubagentTask(task("background", root, child, turnId), settled());
    registry.finishRootRunTurn(rootRunId);
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toBeDefined();

    registry.update("background", (current) => ({ ...current, status: "completed" }));
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toBeUndefined();
  });

  it("debits and clears a child reservation when the child settles without terminal usage", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-child-terminal");
    const child = createSessionId("root-budget-child-terminal-child");
    const sibling = createSessionId("root-budget-child-terminal-sibling");
    const turnId = createTurnId("root-budget-child-terminal-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 1_000 });
    registry.registerSubagentTask(task("child-terminal", root, child, turnId), settled());
    registry.registerSubagentTask(task("sibling-terminal", root, sibling, turnId), settled());
    const releaseChildReservation = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: child,
      contextWindow: 300,
      maxTokens: 100,
    });

    registry.update("child-terminal", (current) => ({ ...current, status: "failed" }));

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 400,
      reservedTokens: 0,
    });
    const releaseSiblingReservation = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: sibling,
      contextWindow: 500,
      maxTokens: 500,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(600);
    releaseChildReservation();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(600);
    releaseSiblingReservation();
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
        onDeadline: abortRoot,
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

function modelComplete(
  sessionId: SessionId,
  turnId: ReturnType<typeof createTurnId>,
  totalTokens: number,
  requestId?: string,
) {
  return createSessionEvent(
    SessionEventType.ModelComplete,
    sessionId,
    { content: "", stopReason: "stop", usage: { totalTokens }, ...(requestId ? { requestId } : {}) },
    { turnId },
  );
}

function settled(): RuntimeTaskCancellationHandle {
  return { abort() {}, settled: Promise.resolve() };
}

function controlled(): RuntimeTaskCancellationHandle & { abort: ReturnType<typeof vi.fn>; resolve: () => void } {
  let resolve!: () => void;
  const settled = new Promise<void>((done) => (resolve = done));
  const abort = vi.fn();
  return { abort, settled, resolve };
}
