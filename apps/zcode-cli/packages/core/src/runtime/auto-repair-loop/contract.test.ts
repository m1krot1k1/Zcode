import { describe, expect, it } from "vitest";
import { AUTO_REPAIR_DEFAULTS } from "./contract.js";
import { cliAutoRepairLoopModule } from "./module.js";

describe("cli-auto-repair-loop contract", () => {
  it("объявляет managed-модуль с публичными входами", () => {
    expect(cliAutoRepairLoopModule.id).toBe("cli-auto-repair-loop");
    expect(cliAutoRepairLoopModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("лимиты по умолчанию конечны и осмысленны", () => {
    expect(AUTO_REPAIR_DEFAULTS.maxIterations).toBeGreaterThan(0);
    expect(AUTO_REPAIR_DEFAULTS.maxElapsedMs).toBeGreaterThan(0);
    // Повтор одной сигнатуры должен останавливать цикл, а не крутиться вечно.
    expect(AUTO_REPAIR_DEFAULTS.repeatThreshold).toBeGreaterThanOrEqual(2);
    expect(AUTO_REPAIR_DEFAULTS.maxSignalsPerIteration).toBeGreaterThan(0);
  });
});
