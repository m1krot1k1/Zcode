/**
 * Сборка цикла для агентного хода.
 *
 * Зачем отдельный файл: контракт и цикл не знают про `AgentRuntimeOptions`,
 * а ход не должен собирать порты руками. Здесь единственное место, где флаг
 * `enableAutoRepairLoop` превращается в конкретный цикл с реальными портами.
 *
 * Порты создаются лениво: если флаг выключен (по умолчанию), не выделяется ни
 * один ресурс и не запускается ни одна проверка — поведение 4.1 сохраняется.
 */
import type { RepairVerificationPort, RepairSignal } from "./contract.js";
import { createAutoRepairLoop, type AutoRepairLoop } from "./loop.js";

/** Внешние исполнители проверок; `core` не знает, как они устроены. */
export interface AutoRepairVerificationRunners {
  typecheck?: () => Promise<{ signals: readonly RepairSignal[]; durationMs: number }>;
  lint?: () => Promise<{ signals: readonly RepairSignal[]; durationMs: number }>;
  tests?: () => Promise<{ signals: readonly RepairSignal[]; durationMs: number }>;
  browser?: () => Promise<{ signals: readonly RepairSignal[]; durationMs: number }>;
  pty?: () => Promise<{ signals: readonly RepairSignal[]; durationMs: number }>;
  fileState?: () => Promise<{ signals: readonly RepairSignal[]; durationMs: number }>;
}

export interface CreateRuntimeAutoRepairLoopOptions {
  enabled: boolean;
  runners: AutoRepairVerificationRunners;
  limits?: {
    maxIterations?: number;
    maxElapsedMs?: number;
    repeatThreshold?: number;
    maxSignalsPerIteration?: number;
  };
}

/**
 * Готовит порты из переданных исполнителей.
 *
 * Каждый исполнитель оборачивается одинаково: результат приводится к вердикту,
 * а `truncatedSources` остаётся пустым (усечение считает агрегатор по бюджету).
 */
function buildPort(runners: AutoRepairVerificationRunners): RepairVerificationPort {
  const wrap = (
    runner: (() => Promise<{ signals: readonly RepairSignal[]; durationMs: number }>) | undefined,
  ) => {
    if (!runner) return undefined;
    return async () => {
      const { signals, durationMs } = await runner();
      return {
        ok: signals.every((signal) => signal.severity !== "blocking"),
        signals,
        summary: signals.length === 0 ? "Проверка пройдена" : `${signals.length} сигналов`,
        durationMs,
        truncatedSources: [] as RepairSignal["source"][],
      };
    };
  };
  const port: RepairVerificationPort = {};
  const typecheck = wrap(runners.typecheck);
  if (typecheck) port.runTypecheck = typecheck;
  const lint = wrap(runners.lint);
  if (lint) port.runLint = lint;
  const tests = wrap(runners.tests);
  if (tests) port.runTests = tests;
  const browser = wrap(runners.browser);
  if (browser) port.collectBrowserSignals = browser;
  const pty = wrap(runners.pty);
  if (pty) port.collectPtySignals = pty;
  const fileState = wrap(runners.fileState);
  if (fileState) port.checkFileState = fileState;
  return port;
}

/**
 * Возвращает цикл или `undefined`, если флаг выключен.
 *
 * Вызывающий (агентный ход) должен трактовать `undefined` как «петля недоступна»
 * и не менять существующее поведение.
 */
export function createRuntimeAutoRepairLoop(
  options: CreateRuntimeAutoRepairLoopOptions,
): AutoRepairLoop | undefined {
  if (!options.enabled) return undefined;
  return createAutoRepairLoop({
    port: buildPort(options.runners),
    ...(options.limits ? { limits: options.limits } : {}),
  });
}
