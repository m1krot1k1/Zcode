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

  it("(b) второй спавн на тот же файл видит занятого агента в конверте", () => {
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
    const second = registry.registerSubagentTask(
      task("agent-b", {
        childSessionId: createSessionId("wire-child-b"),
        prompt:
          "Обновить runtime task registry тесты в `apps/zcode-cli/packages/core/src/runtime-task/registry.ts`",
      }),
      pending(),
    );
    expect(first.accepted && second.accepted).toBe(true);

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

  it("(d) ошибка реестра не ломает спавн", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwingLedger = {
      claim() {
        throw new Error("ledger unavailable");
      },
      release() {},
      heartbeat() {},
      list: () => [],
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

    expect(admission.accepted).toBe(true);
    expect(registry.get("agent-a")?.status).toBe("running");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[work-ledger]"),
      expect.any(Error),
    );
  });

  it("(e) извлечение путей консервативно: команды и флаги не становятся путями", () => {
    expect(extractTaskPaths("Запусти `pnpm typecheck` и `--flag`, посмотри text/html")).toEqual(
      [],
    );
    expect(extractTaskPaths("Смотри `src/a.ts:12` и путь path/to/file.ts")).toEqual([
      "src/a.ts",
      "path/to/file.ts",
    ]);
  });
});
