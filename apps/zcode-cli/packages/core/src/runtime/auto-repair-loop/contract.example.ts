/**
 * Канонический сценарий: после мутации проверить инварианты, получить диагноз
 * и, если ремонт нужен, выполнить один шаг и повторить.
 */
import type {
  AutoRepairLoopContract,
  RepairLoopObservation,
  RepairSignal,
  RepairVerificationPort,
} from "./contract.js";
import { makeSignal } from "./telemetry-aggregator.js";

/** Пример порта: typecheck вернул одну ошибку типов. */
export function createTypecheckPort(signals: readonly RepairSignal[]): RepairVerificationPort {
  return {
    async runTypecheck() {
      return {
        ok: signals.length === 0,
        signals,
        summary: signals.length === 0 ? "Типы в порядке" : `${signals.length} ошибок типов`,
        durationMs: 1200,
        truncatedSources: [],
      };
    },
  };
}

export async function verifyAndRepairOnce(
  loop: AutoRepairLoopContract,
  repair: (observation: RepairLoopObservation) => Promise<void>,
): Promise<RepairLoopObservation> {
  const observation = await loop.step();
  if (observation.needsRepair) {
    // Диагноз уже содержит byFile/unattributed и nextStep — модель получает факты,
    // а не пересказ. Ремонт выполняет вызывающий.
    await repair(observation);
  }
  return observation;
}

export const EXAMPLE_TYPE_SIGNAL = makeSignal({
  source: "typecheck",
  severity: "blocking",
  file: "src/index.ts",
  line: 42,
  code: "TS2345",
  message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
});
