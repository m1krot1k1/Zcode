/**
 * Реализация детерминированного цикла самовосстановления.
 *
 * Владелец состояния — этот класс: только он хранит счётчики итераций, бюджет времени
 * и историю сигнатур. Внешние порты (typecheck/lint/тесты/браузер/PTY/файлы) внедряются
 * вызывающим, поэтому ядро цикла не зависит от конкретных исполнителей.
 *
 * Детерминизм: при одинаковой последовательности вердиктов `step()` даёт одинаковые
 * наблюдения; сравнение сигнатур идёт по множествам с сортировкой.
 */
import {
  AUTO_REPAIR_DEFAULTS,
  type AutoRepairLoopContract,
  type RepairLoopLimits,
  type RepairLoopObservation,
  type RepairLoopStatus,
  type RepairLoopStopReason,
  type RepairVerificationPort,
  type RepairVerificationVerdict,
} from "./contract.js";
import { buildNextStep, formatRepairReport, groupSignalsByFile } from "./telemetry-aggregator.js";
import {
  runVerificationGate,
  type AutoRepairLogger,
  type VerificationGateOptions,
} from "./verification-gate.js";

export interface AutoRepairLoopOptions {
  port: RepairVerificationPort;
  limits?: RepairLoopLimits;
  logger?: AutoRepairLogger;
  /** Какой набор проверок запускать; по умолчанию все доступные. */
  scope?: VerificationGateOptions["scope"];
  /** Источник времени для тестов (детерминированность). */
  now?: () => number;
}

export class AutoRepairLoop implements AutoRepairLoopContract {
  readonly #port: RepairVerificationPort;
  readonly #limits: Required<RepairLoopLimits>;
  readonly #logger: AutoRepairLogger | undefined;
  readonly #scope: VerificationGateOptions["scope"];
  readonly #now: () => number;
  /** Сигнатуры всех итераций в порядке выполнения (для отчёта и прогресса). */
  readonly #signatureHistory: string[] = [];
  /** Сколько раз подряд встречалась сигнатура (защита от осцилляции). */
  readonly #consecutiveCounts = new Map<string, number>();
  #startedAt: number | undefined;
  #iterations = 0;
  #status: RepairLoopStatus = "idle";
  #stopReason: RepairLoopStopReason | undefined;

  constructor(options: AutoRepairLoopOptions) {
    this.#port = options.port;
    this.#limits = {
      maxIterations: Math.max(1, options.limits?.maxIterations ?? AUTO_REPAIR_DEFAULTS.maxIterations),
      maxElapsedMs: Math.max(1, options.limits?.maxElapsedMs ?? AUTO_REPAIR_DEFAULTS.maxElapsedMs),
      repeatThreshold: Math.max(1, options.limits?.repeatThreshold ?? AUTO_REPAIR_DEFAULTS.repeatThreshold),
      maxSignalsPerIteration: Math.max(
        1,
        options.limits?.maxSignalsPerIteration ?? AUTO_REPAIR_DEFAULTS.maxSignalsPerIteration,
      ),
    };
    this.#logger = options.logger;
    this.#scope = options.scope;
    this.#now = options.now ?? (() => Date.now());
  }

  async runVerification(): Promise<RepairVerificationVerdict> {
    return await runVerificationGate({
      port: this.#port,
      ...(this.#scope ? { scope: this.#scope } : {}),
      maxSignals: this.#limits.maxSignalsPerIteration,
      ...(this.#logger ? { logger: this.#logger } : {}),
    });
  }

  async step(): Promise<RepairLoopObservation> {
    this.#startedAt ??= this.#now();
    const elapsedBefore = this.#now() - this.#startedAt;

    // Лимиты проверяются ДО запуска проверки: при исчерпанном бюджете тратить время
    // на новые проверки бессмысленно, а модель должна получить финальный статус.
    if (this.#iterations >= this.#limits.maxIterations) {
      return this.#stop("exhausted-iterations", {
        ok: false,
        signals: [],
        summary: `Лимит итераций исчерпан (${this.#limits.maxIterations})`,
        durationMs: 0,
        truncatedSources: [],
      }, "iterations-limit");
    }
    if (elapsedBefore >= this.#limits.maxElapsedMs) {
      return this.#stop("exhausted-budget", {
        ok: false,
        signals: [],
        summary: `Бюджет времени исчерпан (${this.#limits.maxElapsedMs} мс)`,
        durationMs: 0,
        truncatedSources: [],
      }, "time-budget");
    }

    this.#status = "verifying";
    this.#iterations += 1;
    const verdict = await this.runVerification();
    const signature = this.#signatureOf(verdict);
    this.#signatureHistory.push(signature);

    if (verdict.ok) {
      this.#status = "succeeded";
      return this.#observation(verdict, /* needsRepair */ false, signature);
    }

    // Осцилляция: та же сигнатура подряд N раз означает, что ремонт не продвигается.
    const repeatCount = (this.#consecutiveCounts.get(signature) ?? 0) + 1;
    for (const [existingSignature] of this.#consecutiveCounts) {
      // Счётчик хранится только для последней сигнатуры (сброс при смене набора).
      if (existingSignature !== signature) this.#consecutiveCounts.delete(existingSignature);
    }
    this.#consecutiveCounts.set(signature, repeatCount);

    if (repeatCount >= this.#limits.repeatThreshold) {
      return this.#stop(
        "repeated-error",
        verdict,
        "repeated-signature",
        signature,
        `Одна и та же ошибка повторилась ${repeatCount} раз(а) подряд без прогресса`,
      );
    }

    this.#status = "awaiting-repair";
    return this.#observation(verdict, /* needsRepair */ true, signature);
  }

  status(): { status: RepairLoopStatus; iterations: number; stopReason?: RepairLoopStopReason } {
    return {
      status: this.#status,
      iterations: this.#iterations,
      ...(this.#stopReason ? { stopReason: this.#stopReason } : {}),
    };
  }

  reset(): void {
    this.#signatureHistory.length = 0;
    this.#consecutiveCounts.clear();
    this.#startedAt = undefined;
    this.#iterations = 0;
    this.#status = "idle";
    this.#stopReason = undefined;
  }

  /** Детерминированная сигнатура набора сигналов. */
  #signatureOf(verdict: RepairVerificationVerdict): string {
    if (verdict.signals.length === 0) return "<clean>";
    return verdict.signals
      .map((signal) => signal.signature)
      .sort((left, right) => left.localeCompare(right))
      .join("\n");
  }

  #stop(
    status: RepairLoopStatus,
    verdict: RepairVerificationVerdict,
    stopReason: RepairLoopStopReason,
    signature?: string,
    detail?: string,
  ): RepairLoopObservation {
    this.#status = status;
    this.#stopReason = stopReason;
    this.#logger?.warn("auto-repair-loop", "[auto-repair] цикл остановлен", {
      status,
      stopReason,
      iterations: this.#iterations,
      ...(detail ? { detail } : {}),
    });
    return this.#observation(verdict, /* needsRepair */ false, signature ?? "<stopped>", detail);
  }

  #observation(
    verdict: RepairVerificationVerdict,
    needsRepair: boolean,
    signature: string,
    stopDetail?: string,
  ): RepairLoopObservation {
    const elapsedMs = this.#startedAt === undefined ? 0 : this.#now() - this.#startedAt;
    const { byFile, unattributed } = groupSignalsByFile(verdict.signals);
    const baseNextStep = buildNextStep(verdict.signals);
    const nextStep =
      this.#stopReason === "repeated-signature"
        ? `${stopDetail ?? "Повторяющаяся ошибка"}. Пересмотрите гипотезу через CodeIndex: возможно, правка вносит ту же ошибку. Текущий первичный дефект: ${baseNextStep}`
        : this.#stopReason === "iterations-limit" || this.#stopReason === "time-budget"
          ? `Цикл исчерпал лимит (${this.#stopReason}). Зафиксируйте текущее состояние и продолжите вручную. Последний дефект: ${baseNextStep}`
          : baseNextStep;

    const report = formatRepairReport({
      status: this.#status,
      iteration: this.#iterations,
      verdict,
      nextStep,
    });
    this.#logger?.info("auto-repair-loop", "[auto-repair] итерация", {
      iteration: this.#iterations,
      status: this.#status,
      signals: verdict.signals.length,
      needsRepair,
      ...(this.#stopReason ? { stopReason: this.#stopReason } : {}),
    });

    return {
      iteration: this.#iterations,
      status: this.#status,
      needsRepair,
      diagnosis: { byFile, unattributed, nextStep },
      signatureHistory: [...this.#signatureHistory],
      budget: {
        iterationsUsed: this.#iterations,
        maxIterations: this.#limits.maxIterations,
        elapsedMs,
        maxElapsedMs: this.#limits.maxElapsedMs,
      },
      ...(this.#stopReason ? { stopReason: this.#stopReason } : {}),
      report,
    };
  }
}

/** Фабрика цикла: скрывает конструктор от вызывающих. */
export function createAutoRepairLoop(options: AutoRepairLoopOptions): AutoRepairLoop {
  return new AutoRepairLoop(options);
}

/** Прогоняет цикл до успеха или остановки, возвращая все наблюдения. */
export async function runAutoRepairLoopToCompletion(
  loop: AutoRepairLoopContract,
  options: { repairStep?: (observation: RepairLoopObservation) => Promise<void> | void } = {},
): Promise<{ status: RepairLoopStatus; iterations: number; observations: RepairLoopObservation[]; stopReason?: RepairLoopStopReason }> {
  const observations: RepairLoopObservation[] = [];
  // Жёсткий верхний предел защищает от ошибки в самом цикле: даже если `step`
  // ошибочно всегда возвращает `needsRepair`, здесь конечное число итераций.
  const hardLimit = 32;
  for (let guard = 0; guard < hardLimit; guard += 1) {
    const observation = await loop.step();
    observations.push(observation);
    if (!observation.needsRepair) {
      return {
        status: observation.status,
        iterations: observation.iteration,
        observations,
        ...(observation.stopReason ? { stopReason: observation.stopReason } : {}),
      };
    }
    if (options.repairStep) await options.repairStep(observation);
  }
  const last = observations.at(-1)!;
  return {
    status: "exhausted-iterations",
    iterations: last.iteration,
    observations,
    stopReason: "iterations-limit",
  };
}
