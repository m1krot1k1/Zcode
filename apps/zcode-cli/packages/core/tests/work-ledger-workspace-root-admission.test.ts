import { createSessionId, createTurnId, type SessionId } from "@zcode/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { normalizeWorkspacePath, WorkLedger } from "../src/runtime-task/work-ledger.js";
import { extractTaskPaths } from "../src/runtime-task/work-ledger-wire.js";

/**
 * Регрессия 3.17.75: prompt, упоминающий абсолютный корень workspace, давал
 * claim с путём "."; "." по контракту pathsOverlap пересекается с любым путём,
 * поэтому все последующие write-capable spawn'ы получали write_claim_conflict.
 *
 * WORKSPACE намеренно из четырёх сегментов без пробелов и расширения: только
 * такой абсолютный путь extractTaskPaths действительно извлекает, то есть тест
 * воспроизводит исходный дефект, а не обходит его.
 */
const WORKSPACE = "/Users/dev/projects/zcode";
const ROOT_SESSION = createSessionId("workspace-root-session");
const FILE_A = "apps/zcode-cli/packages/core/src/runtime-task/registry.ts";
const FILE_B = "apps/zcode-cli/packages/core/tests/work-ledger-wire.test.ts";

const registries: InMemoryRuntimeTaskRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function memoryLedger(): WorkLedger {
  return new WorkLedger({ journalPath: null, now: () => 1_800_000_000_000 });
}

function makeRegistry(ledger?: WorkLedger): InMemoryRuntimeTaskRegistry {
  const registry = new InMemoryRuntimeTaskRegistry(ledger ? { workLedger: ledger } : {});
  registries.push(registry);
  return registry;
}

function task(
  agentId: string,
  input: {
    childSessionId: SessionId;
    prompt: string;
    description?: string;
    parentSessionId?: SessionId;
    workspacePath?: string;
    agentType?: string;
    writeCapable?: boolean;
  },
): RuntimeTaskSnapshot {
  return {
    taskId: agentId,
    agentId,
    agentType: input.agentType ?? "coder",
    description: input.description ?? `Задача ${agentId}`,
    prompt: input.prompt,
    status: "running",
    startedAt: new Date(),
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId ?? ROOT_SESSION,
    turnId: createTurnId(`turn-${agentId}`),
    type: "local_agent",
    workspacePath: input.workspacePath ?? WORKSPACE,
    ...(input.writeCapable === undefined ? {} : { writeCapable: input.writeCapable }),
  };
}

/** Задача остаётся running: settled никогда не резолвится. */
function pending(): RuntimeTaskCancellationHandle {
  return { abort() {}, settled: new Promise<void>(() => {}) };
}

function claimOf(ledger: WorkLedger, agentId: string, workspacePath = WORKSPACE) {
  return ledger.list({ workspacePath, agentId })[0];
}

function activeClaims(ledger: WorkLedger, workspacePath = WORKSPACE) {
  return ledger.list({ workspacePath, status: "active" });
}

/** Инвариант дефекта: ни один активный claim не держит корень workspace как ".". */
function expectNoWorkspaceRootClaim(ledger: WorkLedger, workspacePath = WORKSPACE): void {
  const activePaths = activeClaims(ledger, workspacePath).flatMap((claim) => claim.paths);
  expect(activePaths.map((path) => normalizeWorkspacePath(path, workspacePath))).not.toContain(".");
}

describe("workspace-root prompt admission", () => {
  it("filters a text-derived absolute workspace root before conflict check and claim", () => {
    const ledger = memoryLedger();
    const registry = makeRegistry(ledger);
    const prompt = `Твоя область — \`${WORKSPACE}\`; правь только \`${FILE_A}\`.`;

    // Санити: экстрактор действительно видит абсолютный корень. Без фильтра он
    // нормализуется в "." и блокирует любой последующий write-spawn.
    expect(extractTaskPaths(prompt)).toContain(WORKSPACE);

    const admission = registry.registerSubagentTask(
      task("root-mention-coder", {
        childSessionId: createSessionId("workspace-root-child-a"),
        prompt,
      }),
      pending(),
    );

    expect(admission.accepted).toBe(true);
    // Остальные извлечённые пути остаются без изменений: отброшен только корень.
    expect(claimOf(ledger, "root-mention-coder")?.paths).toEqual([FILE_A]);
    expectNoWorkspaceRootClaim(ledger);
  });

  it("does not block a second writer on a normal file", () => {
    const ledger = memoryLedger();
    const registry = makeRegistry(ledger);

    expect(
      registry.registerSubagentTask(
        task("root-first-writer", {
          childSessionId: createSessionId("workspace-root-child-first"),
          prompt: `Область \`${WORKSPACE}\`, правлю \`${FILE_A}\`.`,
        }),
        pending(),
      ).accepted,
    ).toBe(true);

    const second = registry.registerSubagentTask(
      task("root-second-writer", {
        childSessionId: createSessionId("workspace-root-child-second"),
        prompt: `Правлю \`${FILE_B}\`.`,
      }),
      pending(),
    );

    expect(second.accepted).toBe(true);
    expect(claimOf(ledger, "root-second-writer")?.paths).toEqual([FILE_B]);
    expectNoWorkspaceRootClaim(ledger);

    // Файловая семантика не сужена: тот же FILE_A по-прежнему конфликтует.
    const sameFile = registry.registerSubagentTask(
      task("root-third-writer", {
        childSessionId: createSessionId("workspace-root-child-third"),
        prompt: `Тоже правлю \`${FILE_A}\`.`,
      }),
      pending(),
    );
    expect(sameFile).toEqual({ accepted: false, reason: "write_claim_conflict" });
    expect(claimOf(ledger, "root-third-writer")).toBeUndefined();
  });

  it.each([
    ["trailing slash", `${WORKSPACE}/`],
    ["dot segment", `${WORKSPACE}/./`],
    // Экстрактор срезает завершающие точки, поэтому ".." остаётся только перед "/".
    ["parent segment", `${WORKSPACE}/src/../`],
  ])("filters the root spelling with %s", (_label, rootMention) => {
    const ledger = memoryLedger();
    const registry = makeRegistry(ledger);
    const prompt = `Работай в \`${rootMention}\` и опиши результат.`;
    expect(extractTaskPaths(prompt)).toContain(rootMention);

    const admission = registry.registerSubagentTask(
      task("root-spelling-coder", {
        childSessionId: createSessionId("workspace-root-spelling-child"),
        prompt,
      }),
      pending(),
    );

    expect(admission.accepted).toBe(true);
    // Корень — единственное упоминание пути: claim остаётся без путей.
    expect(claimOf(ledger, "root-spelling-coder")?.paths).toEqual([]);
    expectNoWorkspaceRootClaim(ledger);

    // Следующий writer на нормальный файл не блокируется.
    expect(
      registry.registerSubagentTask(
        task("root-spelling-next", {
          childSessionId: createSessionId("workspace-root-spelling-next-child"),
          prompt: `Правлю \`${FILE_B}\`.`,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
  });

  it("filters a plain absolute workspace root whose last segment looks like an extension", () => {
    // Голый путь без backticks извлекается, только если последний сегмент похож
    // на расширение: `/.../zcode.main`. Это второй вариант «plainly in the envelope».
    const workspacePath = "/Users/dev/projects/zcode.main";
    const ledger = memoryLedger();
    const registry = makeRegistry(ledger);
    const prompt = `Рабочая область ${workspacePath} — правь только ${FILE_A}`;
    expect(extractTaskPaths(prompt)).toContain(workspacePath);

    const admission = registry.registerSubagentTask(
      task("plain-root-coder", {
        childSessionId: createSessionId("workspace-plain-root-child"),
        prompt,
        workspacePath,
      }),
      pending(),
    );

    expect(admission.accepted).toBe(true);
    expect(claimOf(ledger, "plain-root-coder", workspacePath)?.paths).toEqual([FILE_A]);
    expectNoWorkspaceRootClaim(ledger, workspacePath);

    expect(
      registry.registerSubagentTask(
        task("plain-root-next", {
          childSessionId: createSessionId("workspace-plain-root-next-child"),
          prompt: `Правлю \`${FILE_B}\`.`,
          workspacePath,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
  });

  it("filters a backticked Windows workspace root after separator normalization", () => {
    // Экстрактор теперь принимает `C:\...`: корень не должен превратиться в "." claim.
    const workspacePath = "C:\\Users\\dev\\projects\\zcode";
    const ledger = memoryLedger();
    const registry = makeRegistry(ledger);
    const prompt = `Твоя область — \`${workspacePath}\`; правь только \`${FILE_A}\`.`;
    expect(extractTaskPaths(prompt)).toContain("C:/Users/dev/projects/zcode");

    const admission = registry.registerSubagentTask(
      task("win-root-coder", {
        childSessionId: createSessionId("workspace-win-root-child"),
        prompt,
        workspacePath,
      }),
      pending(),
    );

    expect(admission.accepted).toBe(true);
    expect(claimOf(ledger, "win-root-coder", workspacePath)?.paths).toEqual([FILE_A]);
    expectNoWorkspaceRootClaim(ledger, workspacePath);
  });

  it("keeps explicit whole-workspace claim semantics unchanged", () => {
    const ledger = memoryLedger();
    const registry = makeRegistry(ledger);
    ledger.claim({
      workspacePath: WORKSPACE,
      agentId: "explicit-root",
      intent: "явно беру весь workspace",
      paths: ["."],
    });

    expect(claimOf(ledger, "explicit-root")?.paths).toEqual(["."]);
    expect(
      ledger.findConflicts({
        workspacePath: WORKSPACE,
        paths: [FILE_A],
        agentId: "another-agent",
      }).map((conflict) => conflict.path),
    ).toContain(FILE_A);

    // Admission не сужает публичный API: явный root claim блокирует writer'а.
    const admission = registry.registerSubagentTask(
      task("explicit-root-blocked", {
        childSessionId: createSessionId("workspace-explicit-root-child"),
        prompt: `Правлю \`${FILE_B}\`.`,
      }),
      pending(),
    );
    expect(admission).toEqual({ accepted: false, reason: "write_claim_conflict" });
  });
});
