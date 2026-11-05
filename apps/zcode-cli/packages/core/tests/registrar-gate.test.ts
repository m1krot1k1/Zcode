import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionId, createTurnId, type SessionId } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryRuntimeTaskRegistry,
  WORK_LEDGER_SWEEP_INTERVAL_MS,
  createRuntimeTaskTerminalCatalogEntry,
  readRuntimeTaskTerminalCatalogRecord,
  runtimeTaskSnapshotFromTerminalCatalog,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { WORK_LEDGER_TTL_MS, WorkLedger, type WorkClaim } from "../src/runtime-task/work-ledger.js";

const WORKSPACE = "/workspace/zcode";

/** Стартовое время memory-ledger; periodic-sweep тест выравнивает по нему fake Date. */
const MEMORY_CLOCK_NOW = 1_800_000_000_000;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function memoryLedger(clock?: { now: number }): WorkLedger {
  return new WorkLedger({
    journalPath: null,
    now: () => clock?.now ?? MEMORY_CLOCK_NOW,
  });
}

function task(
  agentId: string,
  input: {
    childSessionId: SessionId;
    prompt: string;
    description?: string;
    parentSessionId?: SessionId;
    workspacePath?: string;
    turnId?: ReturnType<typeof createTurnId>;
  },
): RuntimeTaskSnapshot {
  return {
    taskId: agentId,
    agentId,
    agentType: "general-purpose",
    description: input.description ?? `Задача ${agentId}`,
    prompt: input.prompt,
    status: "running",
    startedAt: new Date(),
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId ?? createSessionId("registrar-root"),
    turnId: input.turnId ?? createTurnId(`turn-${agentId}`),
    type: "local_agent",
    workspacePath: input.workspacePath ?? WORKSPACE,
  };
}

/** Задача остаётся running: settled никогда не резолвится. */
function pending(): RuntimeTaskCancellationHandle {
  return { abort() {}, settled: new Promise<void>(() => {}) };
}

function claimOf(ledger: WorkLedger, agentId: string): WorkClaim | undefined {
  return ledger.list({ workspacePath: WORKSPACE, agentId })[0];
}

async function flushMicrotasks(): Promise<void> {
  for (let iteration = 0; iteration < 8; iteration += 1) await Promise.resolve();
}

describe("registrar work-claim hard gate", () => {
  it("rejects a same-file spawn before creating a task or a claim", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    const first = registry.registerSubagentTask(
      task("agent-a", {
        childSessionId: createSessionId("registrar-child-a"),
        prompt: "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );
    expect(first.accepted).toBe(true);

    const second = registry.registerSubagentTask(
      task("agent-b", {
        childSessionId: createSessionId("registrar-child-b"),
        prompt: "Тоже правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );

    expect(second).toEqual({ accepted: false, reason: "write_claim_conflict" });
    expect(registry.get("agent-b")).toBeUndefined();
    expect(claimOf(ledger, "agent-b")).toBeUndefined();
    expect(ledger.list({ workspacePath: WORKSPACE, status: "active" })).toHaveLength(1);
  });

  it("rejects a directory-overlap spawn", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    expect(
      registry.registerSubagentTask(
        task("agent-parent", {
          childSessionId: createSessionId("registrar-child-parent"),
          prompt: "Работаю в каталоге `apps/zcode-cli/packages/core/src/runtime-task`",
        }),
        pending(),
      ).accepted,
    ).toBe(true);

    const nested = registry.registerSubagentTask(
      task("agent-child", {
        childSessionId: createSessionId("registrar-child-nested"),
        prompt: "Правлю `apps/zcode-cli/packages/core/src/runtime-task/work-ledger.ts`",
      }),
      pending(),
    );
    expect(nested).toEqual({ accepted: false, reason: "write_claim_conflict" });
  });

  it("keeps the old behavior when no ledger is wired", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const prompt = "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`";

    expect(
      registry.registerSubagentTask(
        task("no-ledger-a", {
          childSessionId: createSessionId("no-ledger-child-a"),
          prompt,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
    expect(
      registry.registerSubagentTask(
        task("no-ledger-b", {
          childSessionId: createSessionId("no-ledger-child-b"),
          prompt,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
  });

  it("does not consume spawn budget on a rejected conflict", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const root = createSessionId("registrar-root");
    const turnId = createTurnId("registrar-budget-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, spawnBudget: 4 });
    const prompt = "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`";

    expect(
      registry.registerSubagentTask(
        task("budget-a", {
          childSessionId: createSessionId("budget-child-a"),
          prompt,
          parentSessionId: root,
          turnId,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
    expect(
      registry.registerSubagentTask(
        task("budget-b", {
          childSessionId: createSessionId("budget-child-b"),
          prompt,
          parentSessionId: root,
          turnId,
        }),
        pending(),
      ),
    ).toEqual({ accepted: false, reason: "write_claim_conflict" });

    const snapshot = registry.getRootRunBudgetSnapshot(rootRunId);
    expect(snapshot?.spawnsUsed).toBe(1);
    expect(snapshot?.remainingSpawnsBySession.get(root)).toBe(3);
  });

  it.each(["failed", "cancelled", "killed", "stopped", "lost"] as const)(
    "releases the claim and allows a new claim after terminal status %s",
    async (status) => {
      const ledger = memoryLedger();
      const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
      const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";

      expect(
        registry.registerSubagentTask(
          task(`release-${status}-a`, {
            childSessionId: createSessionId(`release-${status}-child-a`),
            prompt: `Правлю \`${path}\``,
          }),
          pending(),
        ).accepted,
      ).toBe(true);
      expect(claimOf(ledger, `release-${status}-a`)?.status).toBe("active");

      registry.update(`release-${status}-a`, (current) => ({ ...current, status }));
      await flushMicrotasks();

      expect(claimOf(ledger, `release-${status}-a`)?.status).toBe("released");
      expect(
        registry.registerSubagentTask(
          task(`release-${status}-b`, {
            childSessionId: createSessionId(`release-${status}-child-b`),
            prompt: `Правлю \`${path}\``,
          }),
          pending(),
        ).accepted,
      ).toBe(true);
    },
  );

  it("removes the claim when an active task is removed", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    registry.registerSubagentTask(
      task("remove-a", {
        childSessionId: createSessionId("remove-child-a"),
        prompt: "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );
    expect(claimOf(ledger, "remove-a")?.status).toBe("active");

    registry.remove("remove-a");
    expect(claimOf(ledger, "remove-a")?.status).toBe("released");
    expect(
      registry.registerSubagentTask(
        task("remove-b", {
          childSessionId: createSessionId("remove-child-b"),
          prompt: "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
        }),
        pending(),
      ).accepted,
    ).toBe(true);
  });

  it("lets a stale claim expire lazily and admits a new agent on the same path", () => {
    const clock = { now: 1_800_000_000_000 };
    const ledger = memoryLedger(clock);
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    expect(
      registry.registerSubagentTask(
        task("stale-a", {
          childSessionId: createSessionId("stale-child-a"),
          prompt: "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
        }),
        pending(),
      ).accepted,
    ).toBe(true);

    clock.now += WORK_LEDGER_TTL_MS + 1;

    expect(
      registry.registerSubagentTask(
        task("stale-b", {
          childSessionId: createSessionId("stale-child-b"),
          prompt: "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
        }),
        pending(),
      ).accepted,
    ).toBe(true);
    expect(claimOf(ledger, "stale-a")?.status).toBe("stale");
    expect(claimOf(ledger, "stale-b")?.status).toBe("active");
  });

  it("rejects a two-segment source directory scope overlapping a nested file", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    expect(
      registry.registerSubagentTask(
        task("dir-scope-parent", {
          childSessionId: createSessionId("dir-scope-child-parent"),
          prompt: "Работаю в `src/runtime-task`",
        }),
        pending(),
      ).accepted,
    ).toBe(true);
    expect(claimOf(ledger, "dir-scope-parent")?.paths).toEqual(["src/runtime-task"]);

    const nested = registry.registerSubagentTask(
      task("dir-scope-child", {
        childSessionId: createSessionId("dir-scope-child-nested"),
        prompt: "Правлю `src/runtime-task/work-ledger.ts`",
      }),
      pending(),
    );
    expect(nested).toEqual({ accepted: false, reason: "write_claim_conflict" });
  });

  it("keeps a running task's claim alive across TTL and stales non-running claims", () => {
    const clock = { now: 1_800_000_000_000 };
    const ledger = memoryLedger(clock);
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";

    expect(
      registry.registerSubagentTask(
        task("live-a", {
          childSessionId: createSessionId("live-child-a"),
          prompt: `Правлю \`${path}\``,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
    // Claim без running-задачи: его больше никто не продлевает.
    ledger.claim({
      workspacePath: WORKSPACE,
      agentId: "ghost",
      intent: "старая работа",
      paths: [path],
    });

    clock.now += WORK_LEDGER_TTL_MS + 1;
    registry.sweepWorkLedger(clock.now);

    expect(claimOf(ledger, "live-a")?.status).toBe("active");
    expect(claimOf(ledger, "live-a")?.heartbeatAt).toBe(clock.now);
    expect(claimOf(ledger, "ghost")?.status).toBe("stale");

    // После terminal claim освобождается и больше не продлевается.
    registry.update("live-a", (current) => ({
      ...current,
      status: "completed",
      completedAt: new Date(clock.now),
    }));
    expect(claimOf(ledger, "live-a")?.status).toBe("released");

    clock.now += WORK_LEDGER_TTL_MS + 1;
    registry.sweepWorkLedger(clock.now);
    expect(claimOf(ledger, "live-a")?.status).toBe("released");
    expect(
      registry.registerSubagentTask(
        task("live-b", {
          childSessionId: createSessionId("live-child-b"),
          prompt: `Правлю \`${path}\``,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
  });

  it("stamps a new attemptId on every re-admission", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const root = createSessionId("attempt-root");
    const turnId = createTurnId("attempt-turn");
    const childSessionId = createSessionId("attempt-child");
    const snapshot = task("attempt-agent", {
      childSessionId,
      prompt: "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      parentSessionId: root,
    });

    const first = registry.registerSubagentTask(snapshot, {
      abort() {},
      settled: Promise.resolve(),
    });
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;
    const firstAttempt = first.task.attemptId;
    registry.update("attempt-agent", (current) => ({
      ...current,
      status: "completed",
      completedAt: new Date(),
    }));
    await flushMicrotasks();

    const second = registry.registerSubagentTask(
      { ...snapshot, turnId },
      { abort() {}, settled: new Promise<void>(() => {}) },
    );
    expect(second.accepted).toBe(true);
    expect(second.accepted && second.task.attemptId).toBeDefined();
    expect(second.accepted && second.task.attemptId).not.toBe(firstAttempt);
  });

  it("persists runId/attemptId into the claim journal and the terminal catalog", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-registrar-"));
    directories.push(directory);
    const journalPath = join(directory, "work-ledger.jsonl");
    const ledger = new WorkLedger({ journalPath });
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const root = createSessionId("audit-root");
    const turnId = createTurnId("audit-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId, spawnBudget: 4 });

    const admission = registry.registerSubagentTask(
      task("audit-agent", {
        childSessionId: createSessionId("audit-child"),
        parentSessionId: root,
        turnId,
        prompt: "Правлю `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );
    expect(admission.accepted).toBe(true);
    if (!admission.accepted) return;

    const claim = claimOf(ledger, "audit-agent");
    expect(claim).toMatchObject({
      runId: rootRunId,
      attemptId: admission.task.attemptId,
    });

    await ledger.flush();
    const claimLine = readFileSync(journalPath, "utf8")
      .split("\n")
      .find((line) => line.includes('"type":"claim"'));
    expect(claimLine).toBeDefined();
    expect(JSON.parse(claimLine!)).toMatchObject({
      claim: { runId: rootRunId, attemptId: admission.task.attemptId },
    });

    const terminal: RuntimeTaskSnapshot = {
      ...admission.task,
      status: "completed",
      completedAt: new Date(),
    };
    const entry = createRuntimeTaskTerminalCatalogEntry(terminal);
    expect(entry).toBeDefined();
    const record = readRuntimeTaskTerminalCatalogRecord(entry!);
    expect(record?.attemptId).toBe(admission.task.attemptId);
    expect((record as { runId?: string } | undefined)?.runId).toBe(rootRunId);

    const restored = runtimeTaskSnapshotFromTerminalCatalog(record!, root, "/tmp/zcode-audit");
    expect(restored.rootRunId).toBe(rootRunId);
    expect(restored.attemptId).toBe(admission.task.attemptId);
  });
});

describe("periodic work-ledger sweep", () => {
  it("materializes a ghost claim as stale from the interval timer and disposes cleanly", () => {
    vi.useFakeTimers();
    let registry: InMemoryRuntimeTaskRegistry | undefined;
    try {
      // ledger.now и fake Date стартуют из одной точки, иначе sweepStale получит
      // Date.now(), не совпадающий с часами ledger'а, и TTL посчитается неверно.
      vi.setSystemTime(MEMORY_CLOCK_NOW);
      const ledger = memoryLedger();
      registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
      const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";

      // Ghost claim: running-задачи нет, поэтому heartbeat никто не продлевает.
      ledger.claim({
        workspacePath: WORKSPACE,
        agentId: "ghost-periodic",
        intent: "старая работа",
        paths: [path],
      });
      expect(claimOf(ledger, "ghost-periodic")?.status).toBe("active");
      expect(vi.getTimerCount()).toBe(1);
      const sweep = vi.spyOn(ledger, "sweepStale");

      // TTL = 2 × sweep interval: первый тик не должен гасить ещё живой claim.
      vi.advanceTimersByTime(WORK_LEDGER_SWEEP_INTERVAL_MS);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(sweep).toHaveBeenLastCalledWith(MEMORY_CLOCK_NOW + WORK_LEDGER_SWEEP_INTERVAL_MS);
      expect(claimOf(ledger, "ghost-periodic")?.status).toBe("active");

      // Второй тик попадает на границу TTL и материализует stale без ручного sweepWorkLedger.
      // ledger.now здесь фиксирован на MEMORY_CLOCK_NOW, поэтому lazy expire из list()
      // не мог перевести claim в stale — это сделал именно интервал.
      vi.advanceTimersByTime(WORK_LEDGER_SWEEP_INTERVAL_MS);
      expect(sweep).toHaveBeenCalledTimes(2);
      expect(claimOf(ledger, "ghost-periodic")?.status).toBe("stale");

      registry.dispose();
      expect(vi.getTimerCount()).toBe(0);
      // Повторный dispose безопасен: таймера уже нет.
      expect(() => registry?.dispose()).not.toThrow();
    } finally {
      registry?.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
