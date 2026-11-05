import { createSessionId, createTurnId, type SessionId } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { WorkLedger } from "../src/runtime-task/work-ledger.js";
import {
  buildWorkLedgerEnvelopeBlock,
  extractTaskPaths,
} from "../src/runtime-task/work-ledger-wire.js";

const WORKSPACE = "/workspace/zcode";
const ROOT_SESSION = createSessionId("wire-root");

function memoryLedger(): WorkLedger {
  let now = 1_800_000_000_000;
  return new WorkLedger({
    journalPath: null,
    now: () => {
      now += 1;
      return now;
    },
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
    parentSessionId: input.parentSessionId ?? ROOT_SESSION,
    turnId: createTurnId(`turn-${agentId}`),
    type: "local_agent",
    workspacePath: input.workspacePath ?? WORKSPACE,
  };
}

/** Задача остаётся running: settled никогда не резолвится, иначе registry её финализирует. */
function pending(): RuntimeTaskCancellationHandle {
  return { abort() {}, settled: new Promise<void>(() => {}) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("work ledger wiring", () => {
  it("(a) спавн создаёт claim с intent и извлечёнными путями", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    const admission = registry.registerSubagentTask(
      task("agent-a", {
        childSessionId: createSessionId("wire-child-a"),
        prompt:
          "Поправь `apps/zcode-cli/packages/core/src/runtime-task/registry.ts:1732` и tests/work-ledger-wire.test.ts — остальное не трогай.",
      }),
      pending(),
    );

    expect(admission.accepted).toBe(true);
    const claims = ledger.list({ workspacePath: WORKSPACE, status: "active" });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      agentId: "agent-a",
      parentAgentId: null,
      profile: "general-purpose",
    });
    expect(claims[0]!.intent.startsWith("Поправь")).toBe(true);
    expect(claims[0]!.intent.length).toBeLessThanOrEqual(200);
    expect(claims[0]!.paths).toEqual([
      "apps/zcode-cli/packages/core/src/runtime-task/registry.ts",
      "tests/work-ledger-wire.test.ts",
    ]);
  });

  it("(b) второй агент видит занятый файл в конверте, а спавн на тот же файл блокируется", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    const first = registry.registerSubagentTask(
      task("agent-a", {
        childSessionId: createSessionId("wire-child-a"),
        prompt:
          "Обновить runtime task registry в `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );
    expect(first.accepted).toBe(true);

    // Второй спавн с тем же путём отклоняется hard gate'ом до создания claim'а.
    const second = registry.registerSubagentTask(
      task("agent-b", {
        childSessionId: createSessionId("wire-child-b"),
        prompt:
          "Обновить runtime task registry тесты в `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );
    expect(second).toEqual({ accepted: false, reason: "write_claim_conflict" });
    expect(registry.get("agent-b")).toBeUndefined();
    expect(ledger.list({ workspacePath: WORKSPACE, agentId: "agent-b" })).toHaveLength(0);

    // Конверт всё равно показывает занятые пути: claim второго агента мог быть создан
    // другим путём (SendMessage/resume), а блок строится по ledger'у, не по admission.
    ledger.claim({
      workspacePath: WORKSPACE,
      agentId: "agent-b",
      intent: "Обновить runtime task registry тесты",
      paths: ["apps/zcode-cli/packages/core/src/runtime-task/registry.ts"],
    });
    const block = buildWorkLedgerEnvelopeBlock({
      ledger,
      workspacePath: WORKSPACE,
      agentId: "agent-b",
    });

    expect(block).toBeDefined();
    expect(block).toContain("Сейчас в работе у других агентов:");
    expect(block).toContain("agent-a");
    expect(block).toContain("apps/zcode-cli/packages/core/src/runtime-task/registry.ts");
    expect(block).toContain("Не правь эти файлы без необходимости");
    // Похожие намерения: общий хвост «runtime task registry».
    expect(block).toContain("Похожее намерение уже есть у агента agent-a");
    expect(block!.split("\n").length).toBeLessThanOrEqual(15);
    // Свой claim в списке «других» не появляется.
    expect(block).not.toContain("- agent-b ");
  });

  it("(c) завершение задачи снимает claim", () => {
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });
    const admission = registry.registerSubagentTask(
      task("agent-a", {
        childSessionId: createSessionId("wire-child-a"),
        prompt: "Тронуть `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );
    expect(admission.accepted).toBe(true);
    expect(ledger.list({ workspacePath: WORKSPACE, status: "active" })).toHaveLength(1);

    registry.update("agent-a", (current) => ({ ...current, status: "completed" }));

    expect(ledger.list({ workspacePath: WORKSPACE, status: "active" })).toHaveLength(0);
    expect(ledger.list({ workspacePath: WORKSPACE, agentId: "agent-a" })[0]?.status).toBe(
      "released",
    );
  });

  it("(d) ошибка claim'а отклоняет spawn как work_claim_unavailable и не оставляет задачу", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwingLedger = {
      claim() {
        throw new Error("ledger unavailable");
      },
      release() {},
      heartbeat() {},
      list: () => [],
      findConflicts: () => [],
      findSimilarIntent: () => [],
    } as unknown as WorkLedger;
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: throwingLedger });

    const admission = registry.registerSubagentTask(
      task("agent-a", {
        childSessionId: createSessionId("wire-child-a"),
        prompt: "Тронуть `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );

    expect(admission).toEqual({ accepted: false, reason: "work_claim_unavailable" });
    expect(registry.get("agent-a")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[work-ledger]"), expect.any(Error));
  });

  it("(e) извлечение путей консервативно: команды и флаги не становятся путями", () => {
    expect(extractTaskPaths("Запусти `pnpm typecheck` и `--flag`, посмотри text/html")).toEqual([]);
    expect(extractTaskPaths("Смотри `src/a.ts:12` и путь path/to/file.ts")).toEqual([
      "src/a.ts",
      "path/to/file.ts",
    ]);
  });

  it("(f) не принимает URL, git-refs и ~-пути за workspace-пути", () => {
    expect(
      extractTaskPaths(
        "Смотри https://github.com/m1krot1k1/Zcode/releases/tag/v3.17.67 и refs/heads/dev, refs/tags/v3.17.67",
      ),
    ).toEqual([]);
    expect(extractTaskPaths("Открой ~/.zcode/cli/work-ledger.jsonl")).toEqual([]);
    expect(extractTaskPaths("Смотри /home/dev/project/src/a.ts")).toEqual([
      "/home/dev/project/src/a.ts",
    ]);
  });

  it("(g) backtick-спан с пробелами — один путь, а не набор частичных токенов", () => {
    expect(extractTaskPaths("Правлю `/tmp/zcode workspace/repo/src/a.ts` сейчас")).toEqual([
      "/tmp/zcode workspace/repo/src/a.ts",
    ]);
    expect(extractTaskPaths("Каталог `src/runtime-task` — мой scope")).toEqual([
      "src/runtime-task",
    ]);
    // Команда не становится путём с пробелами: извлекается только её аргумент.
    expect(extractTaskPaths("Запусти `pnpm test src/a.test.ts`")).toEqual(["src/a.test.ts"]);
    expect(extractTaskPaths("MIME `text/html` не путь")).toEqual([]);
  });

  it("(h) workspace с пробелом: absolute и relative ссылки на один файл конфликтуют", () => {
    const workspacePath = "/tmp/zcode workspace/repo";
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    const first = registry.registerSubagentTask(
      task("spaced-a", {
        childSessionId: createSessionId("spaced-child-a"),
        prompt: "Правлю `/tmp/zcode workspace/repo/src/a.ts`",
        workspacePath,
      }),
      pending(),
    );
    expect(first.accepted).toBe(true);
    // Путь внутри workspace нормализован относительно него, пробел не потерян.
    expect(ledger.list({ workspacePath, agentId: "spaced-a" })[0]?.paths).toEqual(["src/a.ts"]);

    const sameFile = registry.registerSubagentTask(
      task("spaced-b", {
        childSessionId: createSessionId("spaced-child-b"),
        prompt: "Тоже правлю `src/a.ts`",
        workspacePath,
      }),
      pending(),
    );
    expect(sameFile).toEqual({ accepted: false, reason: "write_claim_conflict" });

    const otherFile = registry.registerSubagentTask(
      task("spaced-c", {
        childSessionId: createSessionId("spaced-child-c"),
        prompt: "Правлю `src/b.ts`",
        workspacePath,
      }),
      pending(),
    );
    expect(otherFile.accepted).toBe(true);
  });

  it("(i) два разных absolute-файла в workspace с пробелом не дают ложный конфликт", () => {
    const workspacePath = "/tmp/zcode workspace/repo";
    const ledger = memoryLedger();
    const registry = new InMemoryRuntimeTaskRegistry({ workLedger: ledger });

    expect(
      registry.registerSubagentTask(
        task("abs-a", {
          childSessionId: createSessionId("abs-child-a"),
          prompt: "Правлю `/tmp/zcode workspace/repo/src/a.ts`",
          workspacePath,
        }),
        pending(),
      ).accepted,
    ).toBe(true);
    expect(
      registry.registerSubagentTask(
        task("abs-b", {
          childSessionId: createSessionId("abs-child-b"),
          prompt: "Правлю `/tmp/zcode workspace/repo/src/b.ts`",
          workspacePath,
        }),
        pending(),
      ).accepted,
    ).toBe(true);

    expect(ledger.list({ workspacePath, status: "active" })).toHaveLength(2);
    expect(ledger.list({ workspacePath, agentId: "abs-a" })[0]?.paths).toEqual(["src/a.ts"]);
    expect(ledger.list({ workspacePath, agentId: "abs-b" })[0]?.paths).toEqual(["src/b.ts"]);
    // Никакого общего ложного claim на родительский каталог с пробелом.
    expect(ledger.list({ workspacePath }).flatMap((claim) => claim.paths)).not.toContain(
      "/tmp/zcode",
    );
  });

  it("(j) спан с пробелами не превращается в путь целиком, если это текст или команда", () => {
    // Ссылка с номером строки: claim'ом должен стать файл, а не «a.ts line 20».
    expect(extractTaskPaths("Правлю `src/a.ts line 20`")).toEqual(["src/a.ts"]);
    // Команда целиком не должна становиться путём: извлекается только её аргумент.
    const command = extractTaskPaths("Запусти `/usr/bin/pnpm test src/a.ts`");
    expect(command).not.toContain("/usr/bin/pnpm test src/a.ts");
    expect(command).toContain("src/a.ts");
    // Одна группа пробелов внутри каталога — путь остаётся целым.
    expect(extractTaskPaths("Правлю `/tmp/zcode workspace/repo/src/a.ts`")).toEqual([
      "/tmp/zcode workspace/repo/src/a.ts",
    ]);
    expect(extractTaskPaths("Правлю `src/some dir/a.ts`")).toEqual(["src/some dir/a.ts"]);
    // Пробел в самом имени файла с расширением тоже сохраняется.
    expect(extractTaskPaths("Правлю `/tmp/my project/file name.ts`")).toEqual([
      "/tmp/my project/file name.ts",
    ]);
  });
});
