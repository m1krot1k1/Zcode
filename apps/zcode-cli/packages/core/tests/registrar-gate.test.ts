import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CoreErrorType,
  createCoreError,
  createSessionId,
  createTraceId,
  createTurnId,
  type AgentOutput,
  type SessionId,
  type SubagentTaskDagRequest,
} from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryRuntimeTaskRegistry,
  WORK_LEDGER_SWEEP_INTERVAL_MS,
  createRuntimeTaskTerminalCatalogEntry,
  readRuntimeTaskTerminalCatalogRecord,
  runtimeTaskOutputFile,
  runtimeTaskSnapshotFromTerminalCatalog,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import {
  createExploreSubagentPort,
  executeSubagentTaskDag,
  isAgentProfileWriteCapable,
  isEffectiveWriteCapable,
  type ExploreSubagentRuntimeResult,
} from "../src/subagent/runner.js";
import { normalizeAgentProfiles } from "../src/subagent/profile.js";
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
    agentType?: string;
    writeCapable?: boolean;
    writePaths?: readonly string[];
  },
): RuntimeTaskSnapshot {
  return {
    taskId: agentId,
    agentId,
    agentType: input.agentType ?? "general-purpose",
    description: input.description ?? `Задача ${agentId}`,
    prompt: input.prompt,
    status: "running",
    startedAt: new Date(),
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId ?? createSessionId("registrar-root"),
    turnId: input.turnId ?? createTurnId(`turn-${agentId}`),
    type: "local_agent",
    workspacePath: input.workspacePath ?? WORKSPACE,
    ...(input.writeCapable === undefined ? {} : { writeCapable: input.writeCapable }),
    ...(input.writePaths === undefined ? {} : { writePaths: input.writePaths }),
  };
}

/** Задача остаётся running: settled никогда не резолвится. */
function pending(): RuntimeTaskCancellationHandle {
  return { abort() {}, settled: new Promise<void>(() => {}) };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/** Держит первый запуск активным, пока второй проходит admission. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

  it("uses explicit writePaths instead of shared prompt paths", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    // Orchestrator часто копирует общий план веток в каждый prompt. Эти пути — контекст,
    // а не write-intent; явный writePaths должен победить text extraction.
    const sharedPlan =
      "Общий план: UI правит `apps/zcode-cli/packages/ui/src/settings/Panel.tsx`, backend правит `apps/zcode-cli/packages/core/src/runtime/runner.ts`.";
    const uiPath = "apps/zcode-cli/packages/ui/src/settings/Panel.tsx";
    const backendPath = "apps/zcode-cli/packages/core/src/runtime/runner.ts";

    const ui = registry.registerSubagentTask(
      task("agent-ui", {
        childSessionId: createSessionId("registrar-child-ui"),
        prompt: sharedPlan,
        writePaths: [uiPath],
      }),
      pending(),
    );
    const backend = registry.registerSubagentTask(
      task("agent-backend", {
        childSessionId: createSessionId("registrar-child-backend"),
        prompt: sharedPlan,
        writePaths: [backendPath],
      }),
      pending(),
    );

    expect(ui.accepted).toBe(true);
    expect(backend.accepted).toBe(true);
    expect(claimOf(ledger, "agent-ui")?.paths).toEqual([uiPath]);
    expect(claimOf(ledger, "agent-backend")?.paths).toEqual([backendPath]);
  });

  it("still rejects overlapping explicit writePaths", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const path = "apps/zcode-cli/packages/core/src/runtime/runner.ts";

    expect(
      registry.registerSubagentTask(
        task("agent-writer-a", {
          childSessionId: createSessionId("registrar-child-writer-a"),
          prompt: "Правлю writer A",
          writePaths: [path],
        }),
        pending(),
      ).accepted,
    ).toBe(true);

    expect(
      registry.registerSubagentTask(
        task("agent-writer-b", {
          childSessionId: createSessionId("registrar-child-writer-b"),
          prompt: "Правлю writer B",
          writePaths: [path],
        }),
        pending(),
      ),
    ).toEqual({ accepted: false, reason: "write_claim_conflict" });
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

  // Spawn-бюджет удалён (docs/specs/root-run-budget-removed.md): отклонённый по
  // write-claim конфликту admission не должен оставлять в registry второй задачи.
  it("does not register a task on a rejected write-claim conflict", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const root = createSessionId("registrar-root");
    const turnId = createTurnId("registrar-budget-turn");
    const rootRunId = `${root}:${turnId}`;
    registry.beginRootRunBudget({ rootRunId, rootSessionId: root, turnId });
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

    // Отклонённый admission не создаёт задачу и не оставляет claim'а.
    expect(registry.get("budget-b")).toBeUndefined();
    expect(Object.keys(registry.all())).toEqual(["budget-a"]);
    expect(registry.getRootRunBudgetSnapshot(rootRunId)?.maxParallel).toBeGreaterThan(0);
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

describe("write-capability admission", () => {
  it("treats a wildcard profile as write-capable unless both write tools are denied", () => {
    expect(isAgentProfileWriteCapable({ tools: ["*"] })).toBe(true);
    expect(isAgentProfileWriteCapable({ tools: ["*"], disallowedTools: ["Write"] })).toBe(true);
    expect(
      isAgentProfileWriteCapable({ tools: ["*"], disallowedTools: ["Write", "Edit"] }),
    ).toBe(false);
  });

  it("treats omitted or empty tools as an inherited write surface", () => {
    // Runtime наследует родительский tool surface при tools: undefined / [].
    expect(isAgentProfileWriteCapable({ tools: undefined })).toBe(true);
    expect(isAgentProfileWriteCapable({ tools: [] })).toBe(true);
    expect(
      isAgentProfileWriteCapable({ tools: undefined, disallowedTools: ["Write", "Edit"] }),
    ).toBe(false);
    expect(isAgentProfileWriteCapable({ tools: [], disallowedTools: ["Write", "Edit"] })).toBe(
      false,
    );
    // Один запрещённый инструмент не закрывает наследованную запись целиком.
    expect(isAgentProfileWriteCapable({ tools: [], disallowedTools: ["Write"] })).toBe(true);
  });

  it("normalizes disallowedTools rule syntax before classifying", () => {
    expect(isAgentProfileWriteCapable({ tools: ["Write"], disallowedTools: ["Write(*)"] })).toBe(
      false,
    );
    expect(
      isAgentProfileWriteCapable({ tools: ["Write"], disallowedTools: ["  Write(*)  "] }),
    ).toBe(false);
    // Bash-only профиль (встроенные researcher/reviewer/evaluator) не пишет файлы.
    expect(isAgentProfileWriteCapable({ tools: ["Bash"] })).toBe(false);
  });

  it("marks exactly the read-only swarm roles as non-writers", () => {
    const profiles = new Map(normalizeAgentProfiles([]).map((profile) => [profile.name, profile]));
    for (const role of [
      "start",
      "orchestrator",
      "researcher",
      "reviewer",
      "security-reviewer",
      "evaluator",
    ]) {
      expect(profiles.get(role), role).toBeDefined();
      expect(isAgentProfileWriteCapable(profiles.get(role)!), role).toBe(false);
    }
    for (const role of [
      "implementer",
      "coder",
      "frontend-coder",
      "backend-coder",
      "infra-coder",
      "test-engineer",
      "self-improver",
      "knowledge-curator",
      "subagent-factory",
    ]) {
      expect(profiles.get(role), role).toBeDefined();
      expect(isAgentProfileWriteCapable(profiles.get(role)!), role).toBe(true);
    }
  });

  it("passes profile write-capability into task registration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-registrar-port-"));
    directories.push(directory);
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const traceId = createTraceId();
    const sessionId = createSessionId("registrar-port-parent");
    const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";
    let agentSequence = 0;
    const port = createExploreSubagentPort({
      outputRootDir: directory,
      runtimeTaskRegistry: registry,
      profiles: normalizeAgentProfiles([]),
      createAgentId: () => `registrar-port-agent-${(agentSequence += 1)}`,
      async emitParentEvent() {},
      async runExploreAgent() {
        return { response: "done", traceId, events: [] };
      },
    });
    const run = (agentType: string, prompt: string) =>
      port.run({
        agentType,
        description: `${agentType} task`,
        prompt,
        sessionId,
        trace: { traceId, sessionId },
        workingDirectory: WORKSPACE,
        workspaceRoot: WORKSPACE,
      });

    const researcher = await run("researcher", `Исследую \`${path}\``);
    expect(researcher.status).toBe("completed");
    expect(registry.get("registrar-port-agent-1")?.writeCapable).toBe(false);
    expect(claimOf(ledger, "registrar-port-agent-1")).toBeUndefined();

    const coder = await run("coder", `Правлю \`${path}\``);
    expect(coder.status).toBe("completed");
    expect(registry.get("registrar-port-agent-2")?.writeCapable).toBe(true);
    expect(claimOf(ledger, "registrar-port-agent-2")?.paths).toEqual([path]);
  });

  it("claims the path for a custom profile with an empty tools list", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-registrar-inherit-"));
    directories.push(directory);
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const traceId = createTraceId();
    const sessionId = createSessionId("registrar-inherit-parent");
    const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";
    let agentSequence = 0;
    const pendingRun = deferred<ExploreSubagentRuntimeResult>();
    const port = createExploreSubagentPort({
      outputRootDir: directory,
      runtimeTaskRegistry: registry,
      // Custom/plugin профиль без tools наследует write surface родителя.
      profiles: normalizeAgentProfiles([
        {
          name: "plugin-writer",
          description: "Custom profile without an explicit tools list",
          source: "project",
          systemPrompt: "Edit files when the task requires it.",
          tools: [],
        },
      ]),
      createAgentId: () => `registrar-inherit-agent-${(agentSequence += 1)}`,
      async emitParentEvent() {},
      runExploreAgent: () => pendingRun.promise,
    });
    const run = (prompt: string) =>
      port.run({
        agentType: "plugin-writer",
        description: "plugin writer task",
        prompt,
        sessionId,
        trace: { traceId, sessionId },
        workingDirectory: WORKSPACE,
        workspaceRoot: WORKSPACE,
      });

    // writeCapable выводится настоящим классификатором внутри порта, а не задаётся вручную.
    const first = run(`Правлю \`${path}\``);
    await flushMicrotasks();
    expect(registry.get("registrar-inherit-agent-1")?.writeCapable).toBe(true);
    expect(claimOf(ledger, "registrar-inherit-agent-1")?.paths).toEqual([path]);

    await expect(run(`Тоже правлю \`${path}\``)).rejects.toMatchObject({
      context: expect.objectContaining({ reason: "write_claim_conflict" }),
    });
    expect(registry.get("registrar-inherit-agent-2")).toBeUndefined();
    expect(claimOf(ledger, "registrar-inherit-agent-2")).toBeUndefined();
    expect(ledger.list({ workspacePath: WORKSPACE, status: "active" })).toHaveLength(1);

    pendingRun.resolve({ response: "done", traceId, events: [] });
    await first;
  });

  it("admits two researchers on the same path without creating claims", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";

    const first = registry.registerSubagentTask(
      task("researcher-a", {
        childSessionId: createSessionId("researcher-child-a"),
        prompt: `Исследую \`${path}\``,
        agentType: "researcher",
        writeCapable: false,
      }),
      pending(),
    );
    const second = registry.registerSubagentTask(
      task("researcher-b", {
        childSessionId: createSessionId("researcher-child-b"),
        prompt: `Тоже исследую \`${path}\``,
        agentType: "researcher",
        writeCapable: false,
      }),
      pending(),
    );

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(claimOf(ledger, "researcher-a")).toBeUndefined();
    expect(claimOf(ledger, "researcher-b")).toBeUndefined();
    expect(ledger.list({ workspacePath: WORKSPACE, status: "active" })).toHaveLength(0);
  });

  it("rejects two write-capable coders on the same path", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";

    expect(
      registry.registerSubagentTask(
        task("coder-a", {
          childSessionId: createSessionId("coder-child-a"),
          prompt: `Правлю \`${path}\``,
          agentType: "coder",
          writeCapable: true,
        }),
        pending(),
      ).accepted,
    ).toBe(true);

    const second = registry.registerSubagentTask(
      task("coder-b", {
        childSessionId: createSessionId("coder-child-b"),
        prompt: `Тоже правлю \`${path}\``,
        agentType: "coder",
        writeCapable: true,
      }),
      pending(),
    );

    expect(second).toEqual({ accepted: false, reason: "write_claim_conflict" });
    expect(claimOf(ledger, "coder-b")).toBeUndefined();
    expect(ledger.list({ workspacePath: WORKSPACE, status: "active" })).toHaveLength(1);
  });

  it("does not create claims for start and orchestrator routers", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";

    for (const role of ["start", "orchestrator"]) {
      expect(
        registry.registerSubagentTask(
          task(`${role}-router`, {
            childSessionId: createSessionId(`${role}-router-child`),
            prompt: `Маршрутизирую работу по \`${path}\``,
            agentType: role,
            writeCapable: false,
          }),
          pending(),
        ).accepted,
        role,
      ).toBe(true);
      expect(claimOf(ledger, `${role}-router`), role).toBeUndefined();
    }

    // Ни один router не удерживает путь: writer получает claim без конфликта.
    expect(
      registry.registerSubagentTask(
        task("router-coder", {
          childSessionId: createSessionId("router-coder-child"),
          prompt: `Правлю \`${path}\``,
          agentType: "coder",
          writeCapable: true,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
    expect(claimOf(ledger, "router-coder")?.status).toBe("active");
  });

  it("does not block a read-only researcher behind an active writer claim", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";

    expect(
      registry.registerSubagentTask(
        task("researcher-behind-writer-coder", {
          childSessionId: createSessionId("researcher-behind-writer-child"),
          prompt: `Правлю \`${path}\``,
          agentType: "coder",
          writeCapable: true,
        }),
        pending(),
      ).accepted,
    ).toBe(true);

    expect(
      registry.registerSubagentTask(
        task("researcher-behind-writer", {
          childSessionId: createSessionId("researcher-behind-writer-child-2"),
          prompt: `Исследую \`${path}\``,
          agentType: "researcher",
          writeCapable: false,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
    expect(ledger.list({ workspacePath: WORKSPACE, status: "active" })).toHaveLength(1);
  });
});

describe("effective write-capability", () => {
  const writerSurface = ["Read", "Write", "Edit", "Task"] as const;
  const readOnlySurface = ["Read", "Glob", "Grep", "Task"] as const;

  it("requires Write or Edit in the effective parent surface", () => {
    expect(isEffectiveWriteCapable({ tools: ["Write"] }, readOnlySurface)).toBe(false);
    expect(isEffectiveWriteCapable({ tools: ["Edit"] }, readOnlySurface)).toBe(false);
    expect(isEffectiveWriteCapable({ tools: ["Write"] }, writerSurface)).toBe(true);
    // Legacy-вызов без поверхности родителя сохраняет прежнюю классификацию.
    expect(isEffectiveWriteCapable({ tools: ["Write"] }, undefined)).toBe(true);
  });

  it("keeps read-only built-in profiles non-writers even under a writer surface", () => {
    const profiles = new Map(normalizeAgentProfiles([]).map((profile) => [profile.name, profile]));
    for (const role of ["start", "orchestrator", "researcher", "reviewer", "evaluator"]) {
      expect(isEffectiveWriteCapable(profiles.get(role)!, writerSurface), role).toBe(false);
    }
    expect(isEffectiveWriteCapable(profiles.get("coder")!, writerSurface)).toBe(true);
    // Профиль пишет, но родитель не выдал Write/Edit — фактической записи нет.
    expect(isEffectiveWriteCapable(profiles.get("coder")!, readOnlySurface)).toBe(false);
  });

  it("wires the effective parent surface into task registration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-effective-write-"));
    directories.push(directory);
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const traceId = createTraceId();
    const sessionId = createSessionId("effective-write-parent");
    const path = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";
    const profiles = normalizeAgentProfiles([
      {
        name: "plugin-writer",
        description: "Custom profile with explicit write tools",
        source: "project",
        systemPrompt: "Edit files when the task requires it.",
        tools: ["Write"],
      },
    ]);

    const makeRun = (prefix: string, parentToolNames?: readonly string[]) => {
      let sequence = 0;
      const agentIds: string[] = [];
      const port = createExploreSubagentPort({
        outputRootDir: directory,
        runtimeTaskRegistry: registry,
        profiles,
        ...(parentToolNames === undefined ? {} : { parentToolNames }),
        createAgentId: () => {
          const agentId = `${prefix}-${(sequence += 1)}`;
          agentIds.push(agentId);
          return agentId;
        },
        async emitParentEvent() {},
        async runExploreAgent() {
          return { response: "done", traceId, events: [] };
        },
      });
      return {
        agentIds,
        run: (prompt: string) =>
          port.run({
            agentType: "plugin-writer",
            description: "plugin writer task",
            prompt,
            sessionId,
            trace: { traceId, sessionId },
            workingDirectory: WORKSPACE,
            workspaceRoot: WORKSPACE,
          }),
      };
    };

    const readOnlyParent = makeRun("effective-read-only", readOnlySurface);
    expect((await readOnlyParent.run(`Правлю \`${path}\``)).status).toBe("completed");
    expect(registry.get(readOnlyParent.agentIds[0]!)?.writeCapable).toBe(false);
    expect(claimOf(ledger, readOnlyParent.agentIds[0]!)).toBeUndefined();

    const writerParent = makeRun("effective-writer", writerSurface);
    expect((await writerParent.run(`Правлю \`${path}\``)).status).toBe("completed");
    expect(registry.get(writerParent.agentIds[0]!)?.writeCapable).toBe(true);
    expect(claimOf(ledger, writerParent.agentIds[0]!)?.paths).toEqual([path]);

    // Legacy-порт без parentToolNames продолжает считать такой профиль writer'ом.
    const legacyParent = makeRun("effective-legacy");
    const legacyPath = "apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts";
    expect((await legacyParent.run(`Правлю \`${legacyPath}\``)).status).toBe("completed");
    expect(registry.get(legacyParent.agentIds[0]!)?.writeCapable).toBe(true);
  });
});

describe("subagent task deadline", () => {
  it("fails and releases a foreground task whose child never settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-deadline-"));
    directories.push(directory);
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: memoryLedger() });
    const traceId = createTraceId();
    const sessionId = createSessionId("deadline-parent");
    const agentId = "deadline-agent";
    let childSignal: AbortSignal | undefined;
    const port = createExploreSubagentPort({
      outputRootDir: directory,
      runtimeTaskRegistry: registry,
      profiles: normalizeAgentProfiles([]),
      parentToolNames: ["Read", "Glob", "Grep"],
      createAgentId: () => agentId,
      getTaskTimeoutMs: (agentType) => (agentType === "start" ? 10 : undefined),
      async emitParentEvent() {},
      runExploreAgent: (_request, options) => {
        childSignal = options?.signal;
        // Child никогда не завершается и не реагирует на abort: задача обязана
        // стать terminal по deadline, а не остаться running.
        return new Promise<ExploreSubagentRuntimeResult>(() => {});
      },
    });

    const startedAt = Date.now();
    await expect(
      port.run({
        agentType: "start",
        description: "stalled router task",
        prompt: "Route this task",
        sessionId,
        trace: { traceId, sessionId },
        workingDirectory: WORKSPACE,
        workspaceRoot: WORKSPACE,
      }),
    ).rejects.toThrow("Subagent task deadline exceeded");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(childSignal?.aborted).toBe(true);
    await expect(registry.waitForTerminal(agentId)).resolves.toMatchObject({
      status: "failed",
      error: "Subagent task deadline exceeded",
    });
  });

});

describe("DAG write-claim conflicts", () => {
  it("blocks only the conflicting branch and finishes independent branches", async () => {
    const request = makeTaskDagRequest([
      dagNode("writer-a", "coder"),
      dagNode("writer-b", "coder"),
      dagNode("dependent", "coder", ["writer-b"]),
      dagNode("researcher-c", "researcher"),
    ]);
    const started: string[] = [];

    const result = await executeSubagentTaskDag(request, async (node) => {
      started.push(node.id);
      if (node.id === "writer-b") {
        throw createCoreError(CoreErrorType.ToolExecutionFailed, "Work claim conflict", {
          context: {
            code: "agent_subagent_admission_rejected",
            reason: "write_claim_conflict",
            parentSessionId: request.sessionId,
            parentToolCallId: request.parentToolCallId,
          },
          recoverable: true,
        });
      }
      return completedDagOutput(node.id);
    });

    const text = result.content.map((block) => block.text).join("\n");
    expect(started).toContain("writer-a");
    expect(started).toContain("researcher-c");
    expect(started).not.toContain("dependent");
    expect(text).toContain('[blocked] "writer-b"');
    expect(text).toContain('[blocked] "dependent"');
    expect(text).toContain('[completed] "writer-a"');
    expect(text).toContain('[completed] "researcher-c"');
    expect(result.workResult?.status).toBe("partial");
  });
});

function makeTaskDagRequest(
  nodes: SubagentTaskDagRequest["nodes"],
  maxParallel = 8,
): SubagentTaskDagRequest {
  return {
    sessionId: createSessionId("registrar-dag-session"),
    turnId: createTurnId("registrar-dag-turn"),
    parentToolCallId: "registrar-dag-tool-call",
    agentType: "orchestrator",
    description: "Execute a dependency graph",
    prompt: "Complete the requested graph objective",
    nodes,
    maxParallel,
    callerCanReadOutputFile: true,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    trace: {} as SubagentTaskDagRequest["trace"],
  };
}

function dagNode(id: string, subagentType: string, dependsOn: string[] = []) {
  return {
    id,
    description: `Task ${id}`,
    prompt: `Perform task ${id}`,
    subagent_type: subagentType,
    ...(dependsOn.length === 0 ? {} : { depends_on: dependsOn }),
  };
}

function completedDagOutput(agentId: string): AgentOutput {
  return {
    status: "completed",
    agentId,
    agentType: "coder",
    description: `Task ${agentId}`,
    prompt: `Perform task ${agentId}`,
    content: [{ type: "text", text: `Result for ${agentId}` }],
    totalToolUseCount: 1,
    totalDurationMs: 1,
  };
}

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
