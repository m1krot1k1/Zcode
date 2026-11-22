/**
 * Тесты цикла самовосстановления.
 *
 * Все сценарии используют инжектированные порты и управляемое время (`now`),
 * поэтому они детерминированы и не требуют реального typecheck/браузера.
 * Проверяются: успех, диагностика, лимиты итераций/бюджета, дедупликация,
 * осцилляция и порядок сортировки.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  RepairLoopObservation,
  RepairSignal,
  RepairVerificationPort,
  RepairVerificationVerdict,
} from "./contract.js";
import {
  buildNextStep,
  dedupeSignals,
  mergeVerdicts,
  signalSignature,
  sortSignals,
} from "./telemetry-aggregator.js";
import { AutoRepairLoop, runAutoRepairLoopToCompletion } from "./loop.js";

const emptyVerdict: RepairVerificationVerdict = {
  ok: true,
  signals: [],
  summary: "Все инварианты выполнены.",
  durationMs: 5,
  truncatedSources: [],
};

function verdictWith(signals: RepairSignal[], durationMs = 10): RepairVerificationVerdict {
  return {
    ok: signals.filter((signal) => signal.severity === "blocking").length === 0,
    signals,
    summary: `${signals.length} сигналов`,
    durationMs,
    truncatedSources: [],
  };
}

function signal(partial: Partial<RepairSignal> & Pick<RepairSignal, "source" | "message">): RepairSignal {
  const base: Omit<RepairSignal, "signature"> = {
    severity: "blocking",
    ...partial,
  };
  return { ...base, signature: signalSignature(base) };
}

/** Порт, отдающий заранее заданную последовательность вердиктов. */
function sequencePort(verdicts: RepairVerificationVerdict[]): {
  port: RepairVerificationPort;
  calls: () => number;
} {
  let index = 0;
  return {
    port: {
      async runTypecheck() {
        const verdict = verdicts[Math.min(index, verdicts.length - 1)]!;
        index += 1;
        return verdict;
      },
    },
    calls: () => index,
  };
}

const typeSignal = (message = "TS2345 in index"): RepairSignal =>
  signal({
    source: "typecheck",
    severity: "blocking",
    file: "src/index.ts",
    line: 42,
    code: "TS2345",
    message,
  });

describe("AutoRepairLoop: успех", () => {
  it("останавливается на первой чистой итерации со статусом succeeded", async () => {
    const { port, calls } = sequencePort([emptyVerdict]);
    const loop = new AutoRepairLoop({ port });
    const observation = await loop.step();
    expect(observation.status).toBe("succeeded");
    expect(observation.needsRepair).toBe(false);
    expect(observation.iteration).toBe(1);
    expect(observation.diagnosis.nextStep).toMatch(/Ничего не требуется/u);
    expect(observation.budget.iterationsUsed).toBe(1);
    expect(calls()).toBe(1);
  });
});

describe("AutoRepairLoop: диагноз и ремонт", () => {
  it("возвращает сгруппированный по файлам диагноз и конкретный следующий шаг", async () => {
    const { port } = sequencePort([verdictWith([typeSignal()])]);
    const loop = new AutoRepairLoop({ port });
    const observation = await loop.step();

    expect(observation.status).toBe("awaiting-repair");
    expect(observation.needsRepair).toBe(true);
    expect(observation.diagnosis.byFile).toHaveLength(1);
    expect(observation.diagnosis.byFile[0]!.file).toBe("src/index.ts");
    expect(observation.diagnosis.byFile[0]!.signals[0]!.code).toBe("TS2345");
    expect(observation.diagnosis.nextStep).toContain("src/index.ts:42");
    expect(observation.diagnosis.nextStep).toMatch(/TS2345/u);
    expect(observation.report).toContain("[auto-repair]");
  });

  it("считает отчёты по unattributed-сигналам (сеть/консоль)", async () => {
    const { port } = sequencePort([
      verdictWith([
        signal({
          source: "browser-network",
          severity: "blocking",
          message: "GET /api/data → 500",
        }),
      ]),
    ]);
    const loop = new AutoRepairLoop({ port });
    const observation = await loop.step();
    expect(observation.diagnosis.unattributed).toHaveLength(1);
    expect(observation.diagnosis.byFile).toHaveLength(0);
    expect(observation.diagnosis.nextStep).toMatch(/сетевой вызов/u);
  });
});

describe("AutoRepairLoop: лимиты", () => {
  it("останавливается на maxIterations с exhausted-iterations", async () => {
    const { port } = sequencePort([
      verdictWith([typeSignal("first")]),
      verdictWith([typeSignal("second")]),
    ]);
    const loop = new AutoRepairLoop({ port, limits: { maxIterations: 2 } });

    const first = await loop.step();
    expect(first.needsRepair).toBe(true);
    const second = await loop.step();
    expect(second.needsRepair).toBe(true);
    // Третья итерация уже за лимитом — цикл не запускает новую проверку.
    const third = await loop.step();
    expect(third.status).toBe("exhausted-iterations");
    expect(third.stopReason).toBe("iterations-limit");
    expect(third.needsRepair).toBe(false);
    expect(third.iteration).toBe(2);
  });

  it("останавливается по бюджету времени с exhausted-budget", async () => {
    let clock = 0;
    const { port } = sequencePort([verdictWith([typeSignal("a")]), verdictWith([typeSignal("b")])]);
    const loop = new AutoRepairLoop({
      port,
      limits: { maxIterations: 10, maxElapsedMs: 100 },
      now: () => clock,
    });
    const first = await loop.step();
    expect(first.needsRepair).toBe(true);
    clock = 150; // бюджет исчерпан между итерациями
    const second = await loop.step();
    expect(second.status).toBe("exhausted-budget");
    expect(second.stopReason).toBe("time-budget");
    expect(second.needsRepair).toBe(false);
  });

  it("ограничивает число сигналов бюджетом и сообщает об усечении", () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      signal({
        source: "lint",
        severity: "blocking",
        file: `src/file${index}.ts`,
        code: "no-unused-vars",
        message: `unused ${index}`,
      }),
    );
    const merged = mergeVerdicts([verdictWith(many)], { maxSignals: 2 });
    expect(merged.signals).toHaveLength(2);
    // Усечение делает вердикт не-ok: модель не должна считать проверку пройденной.
    expect(merged.ok).toBe(false);
    expect(merged.summary).toMatch(/усечён/u);
    expect(merged.truncatedSources).toContain("lint");
  });
});

describe("AutoRepairLoop: осцилляция и дедупликация", () => {
  it("останавливается при повторе одной сигнатуры repeatThreshold раз", async () => {
    const { port } = sequencePort([
      verdictWith([typeSignal("same")]),
      verdictWith([typeSignal("same")]),
      verdictWith([typeSignal("same")]),
    ]);
    const loop = new AutoRepairLoop({ port, limits: { repeatThreshold: 2, maxIterations: 10 } });

    const first = await loop.step();
    expect(first.needsRepair).toBe(true);
    const second = await loop.step();
    expect(second.status).toBe("repeated-error");
    expect(second.stopReason).toBe("repeated-signature");
    expect(second.needsRepair).toBe(false);
    expect(second.diagnosis.nextStep).toMatch(/CodeIndex/u);
  });

  it("не останавливает цикл, если сигнатуры меняются", async () => {
    const { port } = sequencePort([
      verdictWith([typeSignal("one")]),
      verdictWith([typeSignal("two")]),
      emptyVerdict,
    ]);
    const loop = new AutoRepairLoop({ port, limits: { repeatThreshold: 2, maxIterations: 10 } });
    const first = await loop.step();
    const second = await loop.step();
    const third = await loop.step();
    expect(first.needsRepair).toBe(true);
    expect(second.needsRepair).toBe(true);
    expect(third.status).toBe("succeeded");
  });

  it("дедуплицирует одинаковые сигналы из разных портов, усиливая серьёзность", () => {
    const warningVersion = signal({
      source: "lint",
      severity: "warning",
      file: "src/a.ts",
      line: 1,
      code: "X",
      message: "same defect",
    });
    const blockingVersion = { ...warningVersion, severity: "blocking" as const };
    const deduped = dedupeSignals([warningVersion, blockingVersion]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.severity).toBe("blocking");
  });
});

describe("AutoRepairLoop: детерминизм порядка", () => {
  it("сортирует по severity → source → file → line → code → message", () => {
    const signals = [
      signal({ source: "pty", severity: "warning", file: "z.ts", message: "warn pty" }),
      signal({ source: "typecheck", severity: "blocking", file: "b.ts", line: 2, message: "b" }),
      signal({ source: "typecheck", severity: "blocking", file: "a.ts", line: 5, message: "a5" }),
      signal({ source: "typecheck", severity: "blocking", file: "a.ts", line: 1, message: "a1" }),
      signal({ source: "lint", severity: "blocking", file: "c.ts", message: "lint c" }),
    ];
    const sorted = sortSignals(signals);
    expect(sorted.map((item) => `${item.source}:${item.file}:${item.line ?? 0}`)).toEqual([
      "typecheck:a.ts:1",
      "typecheck:a.ts:5",
      "typecheck:b.ts:2",
      "lint:c.ts:0",
      "pty:z.ts:0",
    ]);
  });

  it("даёт одинаковый отчёт при одинаковом входе (два прогона)", async () => {
    const build = () =>
      new AutoRepairLoop({ port: sequencePort([verdictWith([typeSignal("stable")])]).port });
    const first = await build().step();
    const second = await build().step();
    expect(first.report).toBe(second.report);
    expect(first.diagnosis.nextStep).toBe(second.diagnosis.nextStep);
  });
});

describe("AutoRepairLoop: падение порта", () => {
  it("превращает исключение порта в блокирующий сигнал tool-call", async () => {
    const loop = new AutoRepairLoop({
      port: {
        async runTypecheck() {
          throw new Error("tsc crashed: ENOSPC");
        },
      },
    });
    const observation = await loop.step();
    expect(observation.needsRepair).toBe(true);
    expect(observation.diagnosis.byFile).toHaveLength(0);
    expect(observation.diagnosis.unattributed[0]!.source).toBe("tool-call");
    expect(observation.diagnosis.unattributed[0]!.message).toContain("ENOSPC");
  });
});

describe("AutoRepairLoop: внешний предохранитель", () => {
  it("runAutoRepairLoopToCompletion останавливается по hardLimit даже при вечном needsRepair", async () => {
    // Каждая итерация даёт НОВУЮ сигнатуру, поэтому защита от осцилляции не сработает.
    // maxIterations намеренно выше hardLimit (32): предохранитель прогона должен
    // оказаться более жёсткой границей, иначе ошибка в самом цикле увела бы прогон вдаль.
    let counter = 0;
    const loop = new AutoRepairLoop({
      port: {
        async runTypecheck() {
          counter += 1;
          return verdictWith([typeSignal(`unique-${counter}`)]);
        },
      },
      limits: { maxIterations: 1000, repeatThreshold: 1000 },
    });
    const repair = vi.fn(async () => undefined);
    const outcome = await runAutoRepairLoopToCompletion(loop, { repairStep: repair });
    // hardLimit=32 меньше maxIterations=1000, поэтому прогон завершается на 32-й итерации.
    expect(outcome.status).toBe("exhausted-iterations");
    expect(outcome.stopReason).toBe("iterations-limit");
    expect(outcome.iterations).toBe(32);
    expect(outcome.observations).toHaveLength(32);
    expect(repair).toHaveBeenCalledTimes(32);
  }, 30_000);
});

describe("AutoRepairLoop: reset", () => {
  it("очищает историю и счётчики между задачами", async () => {
    const { port } = sequencePort([verdictWith([typeSignal("x")])]);
    const loop = new AutoRepairLoop({ port });
    await loop.step();
    expect(loop.status().iterations).toBe(1);
    loop.reset();
    expect(loop.status()).toEqual({ status: "idle", iterations: 0 });
    const observation: RepairLoopObservation = await loop.step();
    expect(observation.signatureHistory).toHaveLength(1);
  });
});

describe("buildNextStep: приоритет источников", () => {
  it("ставит ошибки типов выше предупреждений браузера", () => {
    const step = buildNextStep([
      signal({ source: "browser-console", severity: "warning", message: "warn" }),
      typeSignal(),
    ]);
    expect(step).toMatch(/ошибку типов/u);
  });
});
