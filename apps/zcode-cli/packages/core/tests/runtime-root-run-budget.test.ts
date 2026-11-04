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
import { readRootRunTokenLimit } from "@zcode/shared";
import { resolveRootRunReservationMaxOutputTokens } from "../src/runtime/methods/model-token-limits.js";

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
      usedTokens: 210,
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
      maxTokens: 50,
    });
    const releaseRemaining = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 50,
      maxTokens: 50,
    });
    const providerCall = vi.fn();
    expect(() => {
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 50,
        maxTokens: 1,
      });
      providerCall();
    }).toThrow(RootRunBudgetExceededError);
    expect(providerCall).not.toHaveBeenCalled();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(100);
    releaseRemaining();
    release();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(0);
  });

  it("does not cancel active concurrent requests when usage plus reservations reaches the cap", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-concurrent-reservations");
    const turnId = createTurnId("root-budget-concurrent-reservations-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 100 });
    const reservationA = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 25,
      maxTokens: 50,
    });
    const reservationB = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 25,
      maxTokens: 50,
    });
    reservationA.associateRequestId("concurrent-a");
    reservationB.associateRequestId("concurrent-b");

    registry.recordRootRunUsage(modelComplete(root, turnId, 50, "concurrent-a"));

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 50,
      reservedTokens: 50,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(() =>
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 1,
        maxTokens: 1,
      }),
    ).toThrow(RootRunBudgetExceededError);

    registry.recordRootRunUsage(modelComplete(root, turnId, 40, "concurrent-b"));
    reservationA();
    reservationB();

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 90,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    const finalReservation = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 5,
      maxTokens: 5,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(5);
    finalReservation();
  });

  it("reserves output budget instead of the model's maximum context window", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-oversized-context");
    const turnId = createTurnId("root-budget-oversized-context-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 100_000 });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    release.associateRequestId("oversized-success");
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(40_000);

    const parallelRelease = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(80_000);

    registry.recordRootRunUsage(modelComplete(root, turnId, 5_000, "oversized-success"));
    release();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 5_000,
      reservedTokens: 40_000,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    const nextRelease = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(80_000);
    nextRelease();
    parallelRelease();
  });

  it("charges the bounded request reservation when usage is missing", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-oversized-unknown");
    const turnId = createTurnId("root-budget-oversized-unknown-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 500_000,
    });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
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
      usedTokens: 40_000,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
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
      usedTokens: 30,
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
      usedTokens: 100,
      reservedTokens: 0,
    });
    const releaseSiblingReservation = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: sibling,
      contextWindow: 500,
      maxTokens: 500,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(500);
    releaseChildReservation();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(500);
    releaseSiblingReservation();
  });

  it("does not debit or exhaust the budget for a retryable failure without usage", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-retryable-no-usage");
    const turnId = createTurnId("root-budget-retryable-no-usage-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 500_000,
      onExhausted,
    });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    release.associateRequestId("retryable-502");

    registry.recordRootRunUsage(retryableFailure(root, turnId, "retryable-502"));

    // 修复：可重试失败的 attempt 不会再有终态事件，它的预留必须当场归还。
    // 旧行为把 40_000 一直挂在 reservedTokens 上，每次重试再占一份，最终把 root-run 预算占满。
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();

    // 重试 attempt 能重新拿到完整预留，而不是被上一次失败的预留挤掉。
    const retryRelease = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    retryRelease.associateRequestId("retryable-502-retry");
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(40_000);
    retryRelease();
    release();
  });

  it("keeps retrying after repeated retryable failures instead of exhausting the budget on leaked reservations", () => {
    // 事故复现：deepseek-v4.1-flash-1017 的 maxOutputTokens 是 384_000，root-run 预算是 500_000。
    // 两次 502 之后第三次 admission 抛 Root run resource budget is exhausted，请求根本没发出去。
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-retry-leak");
    const turnId = createTurnId("root-budget-retry-leak-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });

    for (const attempt of ["attempt-1", "attempt-2"]) {
      const release = registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 200_000,
        maxTokens: 384_000,
      });
      release.associateRequestId(attempt);
      registry.recordRootRunUsage(retryableFailure(root, turnId, attempt));
      expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(0);
    }

    const third = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 384_000,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(384_000);
    third();
  });

  it("debits reported usage from a retryable failure instead of dropping or overcharging it", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-retryable-usage");
    const turnId = createTurnId("root-budget-retryable-usage-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 500_000,
      onExhausted,
    });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    release.associateRequestId("retryable-partial");

    registry.recordRootRunUsage(retryableFailure(root, turnId, "retryable-partial", 1_234));

    // 部分用量是事实：必须按 1_234 记账，而不是 0（漏记）或 500_000（tokenLimit 兜底）。
    // 预留同时归还：失败 attempt 不会再有终态事件，留着它只会让下一次 admission 无额度可用。
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 1_234,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();

    // 重试成功后按真实 usage 收尾，reservation 不应被失败 attempt 提前吃掉。
    registry.recordRootRunUsage(modelComplete(root, turnId, 766, "retryable-partial"));
    release();
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 2_000,
      reservedTokens: 0,
    });
  });

  it("debits the reservation instead of the token limit when the terminal event lands after release", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-released-late-event");
    const turnId = createTurnId("root-budget-released-late-event-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 500_000,
      onExhausted,
    });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 3_000,
    });
    release.associateRequestId("late-event");
    // adapter 先 release（admission 额度归还），终态事件异步落库，之后才到达。
    release();

    // 终态事件（不可重试的失败）在 release 之后才到达：entry 已被 release 删除，
    // 只能退到 maxReservationTokens，绝不能退到 tokenLimit。
    registry.recordRootRunUsage(
      createSessionEvent(
        SessionEventType.ModelNetworkStatus,
        root,
        { type: "model_request_failed", requestId: "late-event" },
        { turnId },
      ),
    );

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 3_000,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("debits the provider usage of a successful response", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-success-usage");
    const turnId = createTurnId("root-budget-success-usage-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    release.associateRequestId("success-usage");

    registry.recordRootRunUsage(modelComplete(root, turnId, 4_321, "success-usage"));
    release();

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 4_321,
      reservedTokens: 0,
    });
  });

  it("releases orphaned root-session reservations when the root turn closes", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-orphan-cleanup");
    const child = createSessionId("root-budget-orphan-cleanup-child");
    const turnId = createTurnId("root-budget-orphan-cleanup-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });
    registry.registerSubagentTask(task("orphan-child", root, child, turnId), settled());
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    release.associateRequestId("orphan-never-settled");

    registry.finishRootRunTurn(rootRunId);

    // 终态事件永远不来的 reservation 不能一直占住 admission 额度并留在 map 里。
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
    });
    registry.update("orphan-child", (current) => ({ ...current, status: "completed" }));
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toBeUndefined();
  });

  it("never attributes an anonymous terminal event to a reservation that already has a requestId", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-anonymous-fallback");
    const turnId = createTurnId("root-budget-anonymous-fallback-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });
    const owned = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    owned.associateRequestId("owned-request");

    registry.recordRootRunUsage(
      createSessionEvent(SessionEventType.ModelNetworkStatus, root, { type: "model_request_failed" }, {
        turnId,
      }),
    );

    // 已关联 requestId 的预留属于别的 in-flight 请求，不能被匿名事件吃掉。
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(40_000);
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    owned();
  });

  it("treats an unattributable event without any reservation as zero cost", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-no-reservation");
    const turnId = createTurnId("root-budget-no-reservation-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 500_000,
      onExhausted,
    });

    registry.recordRootRunUsage(
      createSessionEvent(SessionEventType.ModelNetworkStatus, root, { type: "model_request_failed" }, {
        turnId,
      }),
    );

    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.usedTokens).toBe(0);
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("charges the reservation when the request reached the network but the provider returned no usage", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-sent-no-usage");
    const child = createSessionId("root-budget-sent-no-usage-child");
    const turnId = createTurnId("root-budget-sent-no-usage-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });
    registry.registerSubagentTask(task("sent-no-usage", root, child, turnId), settled());
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: child,
      contextWindow: 400,
      maxTokens: 300,
    });
    release.associateRequestId("sent-no-usage-request");
    registry.recordRootRunUsage(modelRequestStarted(child, turnId, "sent-no-usage-request"));

    // adapter 在 attempt 结束时先 release，终态事件随后才落库。
    release();
    registry.update("sent-no-usage", (current) => ({ ...current, status: "completed" }));

    // provider 不返回 usage 时按预留上界扣账，而不是相信 0。
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 300,
      reservedTokens: 0,
    });
  });

  it("keeps zero cost when a released reservation never reached the network", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-unsent-no-usage");
    const child = createSessionId("root-budget-unsent-no-usage-child");
    const turnId = createTurnId("root-budget-unsent-no-usage-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });
    registry.registerSubagentTask(task("unsent-no-usage", root, child, turnId), settled());
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: child,
      contextWindow: 400,
      maxTokens: 300,
    });
    release.associateRequestId("unsent-no-usage-request");

    // 没有 model_request_started：请求从未越过网络边界，不产生费用。
    release();
    registry.update("unsent-no-usage", (current) => ({ ...current, status: "completed" }));

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
    });
  });

  it("две отправленные попытки без usage не обходят лимит", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-two-sent");
    const firstChild = createSessionId("root-budget-two-sent-child-1");
    const secondChild = createSessionId("root-budget-two-sent-child-2");
    const turnId = createTurnId("root-budget-two-sent-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 10_000,
      onExhausted,
    });
    registry.registerSubagentTask(task("two-sent-1", root, firstChild, turnId), settled());
    registry.registerSubagentTask(task("two-sent-2", root, secondChild, turnId), settled());
    const runUnmetered = (taskId: string, sessionId: SessionId, requestId: string) => {
      const release = registry.reserveRootRunTokens({
        rootRunId,
        sessionId,
        contextWindow: 200_000,
        maxTokens: 6_000,
      });
      release.associateRequestId(requestId);
      registry.recordRootRunUsage(modelRequestStarted(sessionId, turnId, requestId));
      release();
      registry.update(taskId, (current) => ({ ...current, status: "completed" }));
    };

    runUnmetered("two-sent-1", firstChild, "two-sent-request-1");
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({ usedTokens: 6_000 });

    // 第二次只剩 4 000 可预留：仍被放行，但结算后预算必须真正见底。
    runUnmetered("two-sent-2", secondChild, "two-sent-request-2");

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 10_000,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(true);
    expect(onExhausted).toHaveBeenCalledWith("token_limit");
    expect(() =>
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 200_000,
        maxTokens: 1,
      }),
    ).toThrow(RootRunBudgetExceededError);
  });

  it("drops an unsent released reservation when the root turn closes", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-unsent-orphan");
    const child = createSessionId("root-budget-unsent-orphan-child");
    const turnId = createTurnId("root-budget-unsent-orphan-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 500_000 });
    registry.registerSubagentTask(task("unsent-orphan-child", root, child, turnId), settled());
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 40_000,
    });
    release.associateRequestId("unsent-never-sent");
    release();

    registry.finishRootRunTurn(rootRunId);

    // 从未发出的 reservation 不能留在 map 里，也不能被迟到的匿名终态事件扣账。
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
    });
    registry.update("unsent-orphan-child", (current) => ({ ...current, status: "completed" }));
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toBeUndefined();
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
      expect(abortRoot).toHaveBeenCalledWith("deadline");
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

  it("не списывает 384k за запрос, отклонённый на admission", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-admission-reject");
    const turnId = createTurnId("root-budget-admission-reject-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 500_000,
      onExhausted,
    });
    // 真实请求：admission 预留 384k，provider 实际只花 381_859。
    const spent = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 384_000,
    });
    spent.associateRequestId("real-request");
    registry.recordRootRunUsage(modelComplete(root, turnId, 381_859, "real-request"));
    spent();
    // 第二个请求占满剩余 118_141，第三个请求在 admission 被拒（remaining <= 0，请求从未发出）。
    const inflight = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 384_000,
    });
    inflight.associateRequestId("inflight-request");
    expect(() =>
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 200_000,
        maxTokens: 384_000,
      }),
    ).toThrow(RootRunBudgetExceededError);
    // 被拒请求的终态事件既没有 usage 也没有 reservation：旧实现按最大单次预留 384k 凭空扣账。
    registry.recordRootRunUsage(
      createSessionEvent(SessionEventType.ModelNetworkStatus, root, { type: "model_request_failed" }, {
        turnId,
      }),
    );

    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.usedTokens).toBe(381_859);
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();
    inflight();
  });

  it("реальный расход 381 859 плюс отклонённый запрос не валит турн", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-reject-survives");
    const turnId = createTurnId("root-budget-reject-survives-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 500_000,
      onExhausted,
    });
    const spent = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 384_000,
    });
    spent.associateRequestId("real-request");
    registry.recordRootRunUsage(modelComplete(root, turnId, 381_859, "real-request"));
    spent();
    const inflight = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 384_000,
    });
    inflight.associateRequestId("inflight-request");
    expect(() =>
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 200_000,
        maxTokens: 384_000,
      }),
    ).toThrow(RootRunBudgetExceededError);
    registry.recordRootRunUsage(
      createSessionEvent(SessionEventType.ModelNetworkStatus, root, { type: "model_request_failed" }, {
        turnId,
      }),
    );
    inflight();

    // 被拒请求不产生费用：剩余 118_141 仍可继续 admission，turn 不会被取消。
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 381_859,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();
    const next = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 118_141,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(118_141);
    next();
  });

  it("резерв на попытку не больше 64k", () => {
    // 384k 的模型输出上限不能原样变成 admission 预留，否则单个 in-flight 就占 500k 预算的 77%。
    expect(resolveRootRunReservationMaxOutputTokens({ requestedMaxOutputTokens: 384_000 })).toBe(
      64_000,
    );
    expect(resolveRootRunReservationMaxOutputTokens({ requestedMaxOutputTokens: 20_000 })).toBe(
      20_000,
    );
    expect(
      resolveRootRunReservationMaxOutputTokens({ requestedMaxOutputTokens: undefined }),
    ).toBe(32_000);
  });

  it("настраиваемый tokenLimit отклоняет и пропускает резерв по конфигу", () => {
    const tight = new InMemoryRuntimeTaskRegistry();
    const tightRoot = createSessionId("root-budget-limit-tight");
    const tightTurnId = createTurnId("root-budget-limit-tight-turn");
    const tightRunId = `${tightRoot}:${tightTurnId}`;
    tight.beginRootRunBudget({
      rootRunId: tightRunId,
      rootSessionId: tightRoot,
      turnId: tightTurnId,
      tokenLimit: 100_000,
    });
    const tightSpent = tight.reserveRootRunTokens({
      rootRunId: tightRunId,
      sessionId: tightRoot,
      contextWindow: 200_000,
      maxTokens: 90_000,
    });
    tightSpent.associateRequestId("tight-spent");
    tight.recordRootRunUsage(modelComplete(tightRoot, tightTurnId, 90_000, "tight-spent"));
    tightSpent();
    // 剩余 10k 被下一个请求占满后，后续 admission 被拒。
    const tightRemainder = tight.reserveRootRunTokens({
      rootRunId: tightRunId,
      sessionId: tightRoot,
      contextWindow: 200_000,
      maxTokens: 10_000,
    });
    expect(tight.getRootRunBudgetSnapshot(tightRunId)?.tokenLimit).toBe(100_000);
    expect(() =>
      tight.reserveRootRunTokens({
        rootRunId: tightRunId,
        sessionId: tightRoot,
        contextWindow: 200_000,
        maxTokens: 1,
      }),
    ).toThrow(RootRunBudgetExceededError);
    tightRemainder();

    const loose = new InMemoryRuntimeTaskRegistry();
    const looseRoot = createSessionId("root-budget-limit-loose");
    const looseTurnId = createTurnId("root-budget-limit-loose-turn");
    const looseRunId = `${looseRoot}:${looseTurnId}`;
    loose.beginRootRunBudget({
      rootRunId: looseRunId,
      rootSessionId: looseRoot,
      turnId: looseTurnId,
      tokenLimit: 1_000_000,
    });
    const looseSpent = loose.reserveRootRunTokens({
      rootRunId: looseRunId,
      sessionId: looseRoot,
      contextWindow: 200_000,
      maxTokens: 90_000,
    });
    looseSpent.associateRequestId("loose-spent");
    loose.recordRootRunUsage(modelComplete(looseRoot, looseTurnId, 90_000, "loose-spent"));
    looseSpent();
    const looseNext = loose.reserveRootRunTokens({
      rootRunId: looseRunId,
      sessionId: looseRoot,
      contextWindow: 200_000,
      maxTokens: 384_000,
    });
    expect(loose.getRootRunBudgetSnapshot(looseRunId)).toMatchObject({
      tokenLimit: 1_000_000,
      reservedTokens: 384_000,
    });
    looseNext();
  });

  it("без явной настройки token-бюджет не применяется даже при 10 000 000 токенов", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-default-off");
    const turnId = createTurnId("root-budget-default-off-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, onExhausted });

    const consumeTenMillionAndAdmitNext = () => {
      const release = registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 10_000_000,
        maxTokens: 10_000_000,
      });
      release.associateRequestId("no-limit");
      registry.recordRootRunUsage(modelComplete(root, turnId, 10_000_000, "no-limit"));
      release();
      // 没有 token 上限时后续 admission 仍然放行（不预留）。
      const next = registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 550_000,
        maxTokens: 64_000,
      });
      next();
    };
    expect(consumeTenMillionAndAdmitNext).not.toThrow();

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      tokenLimitEnabled: false,
      tokenLimit: 0,
      usedTokens: 10_000_000,
      reservedTokens: 0,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("настройка меняет лимит: при 250 000 следующий резерв отклоняется", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-configured-limit");
    const turnId = createTurnId("root-budget-configured-limit-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 250_000 });
    const spent = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 400_000,
      maxTokens: 250_000,
    });
    spent.associateRequestId("configured-limit");
    registry.recordRootRunUsage(modelComplete(root, turnId, 250_000, "configured-limit"));
    spent();

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      tokenLimit: 250_000,
      usedTokens: 250_000,
      reservedTokens: 0,
    });
    expect(() =>
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 400_000,
        maxTokens: 1,
      }),
    ).toThrow(RootRunBudgetExceededError);
  });

  it("живой роевой турн на 515 621 токен не падает при явном лимите 1 000 000", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-swarm-survives");
    const turnId = createTurnId("root-budget-swarm-survives-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: root,
      turnId,
      tokenLimit: 1_000_000,
      onExhausted,
    });
    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 550_000,
      maxTokens: 64_000,
    });
    release.associateRequestId("swarm-root");
    // 实机用量：input 507_730 + output 7_891 = 515_621（cache_read 不计入预算）。
    registry.recordRootRunUsage(
      createSessionEvent(
        SessionEventType.ModelComplete,
        root,
        {
          content: "",
          stopReason: "stop",
          usage: { inputTokens: 507_730, outputTokens: 7_891 },
          requestId: "swarm-root",
        },
        { turnId },
      ),
    );
    release();

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 515_621,
      reservedTokens: 0,
      tokenLimitEnabled: true,
      tokenLimit: 1_000_000,
    });
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();
    // Турн жив: следующий запрос роя по-прежнему проходит admission.
    const next = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 550_000,
      maxTokens: 64_000,
    });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.reservedTokens).toBe(64_000);
    next();
  });

  it("предохранитель жив: расход 120 000 при лимите 100 000 валит турн", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-fuse");
    const turnId = createTurnId("root-budget-fuse-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 100_000, onExhausted });
    registry.recordRootRunUsage(modelComplete(root, turnId, 120_000));

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      tokenLimit: 100_000,
      usedTokens: 120_000,
    });
    expect(onExhausted).toHaveBeenCalledOnce();
    expect(onExhausted).toHaveBeenCalledWith("token_limit");
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(true);
  });

  it("tokenLimit: 0 означает отсутствие лимита", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("root-budget-zero-limit");
    const turnId = createTurnId("root-budget-zero-limit-turn");
    const rootRunId = `${root}:${turnId}`;
    const onExhausted = vi.fn();
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, tokenLimit: 0, onExhausted });
    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      tokenLimitEnabled: false,
      tokenLimit: 0,
    });

    const release = registry.reserveRootRunTokens({
      rootRunId,
      sessionId: root,
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
    release.associateRequestId("zero-limit");
    registry.recordRootRunUsage(modelComplete(root, turnId, 120_000, "zero-limit"));
    release();

    expect(registry.getRootRunBudgetSnapshot(rootRunId)).toMatchObject({
      usedTokens: 120_000,
      reservedTokens: 0,
      tokenLimitEnabled: false,
    });
    expect(onExhausted).not.toHaveBeenCalled();
    expect(registry.isRootRunBudgetExpired(rootRunId)).toBe(false);
    expect(() =>
      registry.reserveRootRunTokens({
        rootRunId,
        sessionId: root,
        contextWindow: 200_000,
        maxTokens: 1,
      }),
    ).not.toThrow();
  });
});

describe("readRootRunTokenLimit", () => {
  it("принимает положительное целое и отбрасывает мусор", () => {
    expect(readRootRunTokenLimit("250000")).toBe(250_000);
    expect(readRootRunTokenLimit(" 1500000 ")).toBe(1_500_000);
    expect(readRootRunTokenLimit(undefined)).toBeUndefined();
    expect(readRootRunTokenLimit("")).toBeUndefined();
    expect(readRootRunTokenLimit("abc")).toBeUndefined();
    expect(readRootRunTokenLimit("NaN")).toBeUndefined();
    expect(readRootRunTokenLimit("0")).toBeUndefined();
    expect(readRootRunTokenLimit("-5000")).toBeUndefined();
    expect(readRootRunTokenLimit("1.5")).toBeUndefined();
    expect(readRootRunTokenLimit("Infinity")).toBeUndefined();
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

function modelRequestStarted(
  sessionId: SessionId,
  turnId: ReturnType<typeof createTurnId>,
  requestId?: string,
) {
  return createSessionEvent(
    SessionEventType.ModelNetworkStatus,
    sessionId,
    { type: "model_request_started", ...(requestId ? { requestId } : {}) },
    { turnId },
  );
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

function retryableFailure(
  sessionId: SessionId,
  turnId: ReturnType<typeof createTurnId>,
  requestId: string,
  totalTokens?: number,
) {
  return createSessionEvent(
    SessionEventType.ModelNetworkStatus,
    sessionId,
    {
      type: "model_request_failed",
      retryable: true,
      ...(requestId ? { requestId } : {}),
      ...(totalTokens === undefined ? {} : { usage: { totalTokens } }),
    },
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
