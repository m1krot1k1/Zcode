/**
 * Тесты фабрики цикла для агентного хода.
 *
 * Главная проверка — «по умолчанию выключен»: при `enabled: false` цикл не создаётся
 * и ни один исполнитель не вызывается, поэтому поведение 4.1 не меняется.
 */
import { describe, expect, it, vi } from "vitest";
import type { RepairSignal } from "./contract.js";
import { createRuntimeAutoRepairLoop } from "./runtime-factory.js";

const blocking: RepairSignal = {
  source: "typecheck",
  severity: "blocking",
  signature: "typecheck|src/a.ts|1|TS1|bad",
  message: "bad",
  file: "src/a.ts",
  line: 1,
  code: "TS1",
};

describe("createRuntimeAutoRepairLoop", () => {
  it("возвращает undefined при enabled=false и не вызывает исполнителей", async () => {
    const typecheck = vi.fn(async () => ({ signals: [blocking], durationMs: 1 }));
    const loop = createRuntimeAutoRepairLoop({
      enabled: false,
      runners: { typecheck },
    });
    expect(loop).toBeUndefined();
    expect(typecheck).not.toHaveBeenCalled();
  });

  it("собирает порт из включённых исполнителей и сообщает блокирующий сигнал", async () => {
    const typecheck = vi.fn(async () => ({ signals: [blocking], durationMs: 7 }));
    const loop = createRuntimeAutoRepairLoop({
      enabled: true,
      runners: { typecheck },
    });
    expect(loop).toBeDefined();
    const observation = await loop!.step();
    expect(typecheck).toHaveBeenCalledTimes(1);
    expect(observation.needsRepair).toBe(true);
    expect(observation.diagnosis.byFile[0]!.file).toBe("src/a.ts");
  });

  it("пропускает отсутствующие исполнители, не падая на пустом порте", async () => {
    const loop = createRuntimeAutoRepairLoop({ enabled: true, runners: {} });
    const observation = await loop!.step();
    // Ни одного порта — ни одного сигнала: верификация считается пройденной.
    expect(observation.status).toBe("succeeded");
    expect(observation.diagnosis.nextStep).toMatch(/Ничего не требуется/u);
  });

  it("применяет переданные лимиты", async () => {
    const typecheck = vi.fn(async () => ({ signals: [blocking], durationMs: 1 }));
    const loop = createRuntimeAutoRepairLoop({
      enabled: true,
      runners: { typecheck },
      limits: { maxIterations: 1 },
    });
    const first = await loop!.step();
    expect(first.needsRepair).toBe(true);
    const second = await loop!.step();
    expect(second.status).toBe("exhausted-iterations");
    expect(second.stopReason).toBe("iterations-limit");
  });
});
