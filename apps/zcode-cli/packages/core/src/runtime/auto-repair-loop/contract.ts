/**
 * cli-auto-repair-loop — контракт детерминированного замкнутого цикла самовосстановления.
 *
 * Зачем модуль: агент после мутации должен не «надеяться», а проверить инварианты и,
 * если они нарушены, получить компактный диагноз и следующий шаг. Решение о ремонте
 * остаётся за моделью; цикл отвечает за факты, лимиты и защиту от осцилляции.
 *
 * Инварианты:
 * - порядок сигналов детерминирован: сортировка по приоритету/файлу/коду, без случайности;
 * - каждая итерация имеет границы: число циклов, общий бюджет времени и повторы;
 * - повтор одной и той же сигнатуры `repeatThreshold` раз подряд останавливает цикл;
 * - агрегатор не «съедает» ошибки: всё, что не влезло в бюджет, помечается усечением.
 */

/** Источник сигнала: откуда пришла ошибка. */
export type RepairSignalSource =
  | "typecheck"
  | "lint"
  | "test"
  | "browser-console"
  | "browser-pageerror"
  | "browser-network"
  | "pty"
  | "tool-call"
  | "file-state";

/** Серьёзность: блокирует завершение хода или нет. */
export type RepairSignalSeverity = "blocking" | "warning";

/** Один первичный дефект, приведённый к общему виду. */
export interface RepairSignal {
  source: RepairSignalSource;
  severity: RepairSignalSeverity;
  /** Стабильная сигнатура для дедупликации: `source|file|line|code|нормализованный текст`. */
  signature: string;
  /** Сообщение в исходном виде (ограничено бюджетом). */
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** Код ошибки/правила: `TS2345`, `no-unused-vars`, `ERR_CONNECTION_REFUSED`. */
  code?: string;
}

/** Итог проверки инвариантов на одной итерации. */
export interface RepairVerificationVerdict {
  ok: boolean;
  /** Дефекты, требующие ремонта; пусто при `ok: true`. */
  signals: readonly RepairSignal[];
  /** Почему проверка признана проваленной, если причин несколько. */
  summary: string;
  /** Сколько времени заняла проверка. */
  durationMs: number;
  /** Флаги усечения по источникам: модель должна видеть, что данных было больше. */
  truncatedSources: readonly RepairSignalSource[];
}

/** Состояние цикла на текущий момент. */
export type RepairLoopStatus =
  | "idle"
  | "verifying"
  | "awaiting-repair"
  | "succeeded"
  | "exhausted-iterations"
  | "exhausted-budget"
  | "oscillation-detected"
  | "repeated-error"
  | "aborted";

/** Причина остановки цикла; `null` — цикл ещё может продолжаться. */
export type RepairLoopStopReason =
  | "iterations-limit"
  | "time-budget"
  | "oscillation"
  | "repeated-signature"
  | "aborted";

/** Наблюдение, которое уходит модели после каждой итерации. */
export interface RepairLoopObservation {
  iteration: number;
  status: RepairLoopStatus;
  /** `true`, если после этой итерации требуется действие модели. */
  needsRepair: boolean;
  /** Компактный диагноз: агрегированные первичные ошибки. */
  diagnosis: {
    /** Первичные дефекты, сгруппированные по файлу. */
    byFile: ReadonlyArray<{ file: string; signals: readonly RepairSignal[] }>;
    /** Дефекты без файла (сеть, консоль, PTY). */
    unattributed: readonly RepairSignal[];
    /** Что делать дальше — конкретно и без общих слов. */
    nextStep: string;
  };
  /** Сигнатуры предыдущих итераций, чтобы модель видела прогресс/застой. */
  signatureHistory: readonly string[];
  /** Бюджет, потраченный на цикл. */
  budget: { iterationsUsed: number; maxIterations: number; elapsedMs: number; maxElapsedMs: number };
  stopReason?: RepairLoopStopReason;
  /** Полный отчёт в формате, пригодном для лога/UI. */
  report: string;
}

export interface RepairLoopLimits {
  /** Максимум итераций цикла; по умолчанию 4. */
  maxIterations?: number;
  /** Максимум суммарного времени; по умолчанию 5 минут. */
  maxElapsedMs?: number;
  /** Сколько раз одна сигнатура может повториться подряд до остановки; по умолчанию 2. */
  repeatThreshold?: number;
  /** Сколько сигналов максимум отдавать модели за итерацию; по умолчанию 20. */
  maxSignalsPerIteration?: number;
}

/** Порт верификации: реальные проверки внедряются вызывающим. */
export interface RepairVerificationPort {
  /** Запускает typecheck и возвращает сигналы. */
  runTypecheck?(): Promise<RepairVerificationVerdict>;
  /** Запускает lint. */
  runLint?(): Promise<RepairVerificationVerdict>;
  /** Запускает целевые тесты. */
  runTests?(): Promise<RepairVerificationVerdict>;
  /** Собирает телеметрию браузера (из 4.5b stateful-контроллера). */
  collectBrowserSignals?(): Promise<RepairVerificationVerdict>;
  /** Собирает ошибки PTY-сессии (из 4.5a). */
  collectPtySignals?(): Promise<RepairVerificationVerdict>;
  /** Проверяет ожидаемое состояние файлов (транзакции 4.2). */
  checkFileState?(): Promise<RepairVerificationVerdict>;
}

/** Результат запуска цикла до остановки или успеха. */
export interface RepairLoopOutcome {
  status: RepairLoopStatus;
  iterations: number;
  /** История наблюдений по итерациям (в порядке выполнения). */
  observations: readonly RepairLoopObservation[];
  stopReason?: RepairLoopStopReason;
  /** Последнее наблюдение; `undefined`, если цикл не запускался. */
  last?: RepairLoopObservation;
}

/**
 * Публичный контракт цикла.
 *
 * `runVerification()` детерминированно вызывает все внедрённые порты и объединяет
 * результаты. `step()` выполняет одну итерацию и возвращает наблюдение.
 * `reset()` очищает историю (новая задача).
 */
export interface AutoRepairLoopContract {
  /** Полная верификация по всем доступным портам. */
  runVerification(): Promise<RepairVerificationVerdict>;
  /** Одна итерация: верификация + оценка лимитов + наблюдение. */
  step(): Promise<RepairLoopObservation>;
  /** Текущее состояние без побочных эффектов. */
  status(): { status: RepairLoopStatus; iterations: number; stopReason?: RepairLoopStopReason };
  /** Очищает историю сигнатур и счётчики. */
  reset(): void;
}

/** Лимиты по умолчанию. */
export const AUTO_REPAIR_DEFAULTS = {
  maxIterations: 4,
  maxElapsedMs: 5 * 60_000,
  repeatThreshold: 2,
  maxSignalsPerIteration: 20,
} as const;
