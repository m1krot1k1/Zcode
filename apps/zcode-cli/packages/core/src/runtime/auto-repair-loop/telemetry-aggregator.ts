/**
 * Агрегатор сигналов: приводит разнородные ошибки (TS, lint, тесты, браузер, PTY)
 * к единому виду, дедуплицирует и группирует по файлам.
 *
 * Детерминизм: сортировка идёт по (severity, source, file, line, code, message).
 * Никаких `Set`-итераций в порядке вставки и никакой случайности — одинаковый набор
 * сигналов всегда даёт одинаковый порядок и одинаковый `report`.
 */
import {
  AUTO_REPAIR_DEFAULTS,
  type RepairSignal,
  type RepairSignalSeverity,
  type RepairSignalSource,
  type RepairVerificationVerdict,
} from "./contract.js";

/** Приоритет источника при сортировке: блокирующие и «близкие к коду» — выше. */
const SOURCE_ORDER: Readonly<Record<RepairSignalSource, number>> = {
  typecheck: 0,
  lint: 1,
  test: 2,
  "browser-pageerror": 3,
  "browser-network": 4,
  "browser-console": 5,
  pty: 6,
  "file-state": 7,
  "tool-call": 8,
};

const SEVERITY_ORDER: Readonly<Record<RepairSignalSeverity, number>> = {
  blocking: 0,
  warning: 1,
};

/** Строит стабильную сигнатуру сигнала. */
export function signalSignature(
  signal: Omit<RepairSignal, "signature"> | RepairSignal,
): string {
  const normalizedMessage = signal.message
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
  return [
    signal.source,
    signal.file ?? "",
    signal.line ?? "",
    signal.code ?? "",
    normalizedMessage,
  ].join("|");
}

/** Дедупликация с сохранением детерминированного порядка. */
export function dedupeSignals(signals: readonly RepairSignal[]): RepairSignal[] {
  const seen = new Map<string, RepairSignal>();
  for (const signal of signals) {
    const existing = seen.get(signal.signature);
    if (!existing) {
      seen.set(signal.signature, signal);
      continue;
    }
    // Блокирующая серьёзность «побеждает»: один и тот же дефект не должен
    // понижаться до warning только потому, что предупреждение пришло раньше.
    if (existing.severity === "warning" && signal.severity === "blocking") {
      seen.set(signal.signature, signal);
    }
  }
  return [...seen.values()];
}

/** Детерминированная сортировка. */
export function sortSignals(signals: readonly RepairSignal[]): RepairSignal[] {
  return [...signals].sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (bySeverity !== 0) return bySeverity;
    const bySource = SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source];
    if (bySource !== 0) return bySource;
    const byFile = (left.file ?? "").localeCompare(right.file ?? "");
    if (byFile !== 0) return byFile;
    const byLine = (left.line ?? 0) - (right.line ?? 0);
    if (byLine !== 0) return byLine;
    const byCode = (left.code ?? "").localeCompare(right.code ?? "");
    if (byCode !== 0) return byCode;
    return left.message.localeCompare(right.message);
  });
}

/** Объединяет вердикты нескольких портов в один детерминированный. */
export function mergeVerdicts(
  verdicts: ReadonlyArray<RepairVerificationVerdict | undefined>,
  options: { maxSignals?: number } = {},
): RepairVerificationVerdict {
  const maxSignals = options.maxSignals ?? AUTO_REPAIR_DEFAULTS.maxSignalsPerIteration;
  const present = verdicts.filter(
    (verdict): verdict is RepairVerificationVerdict => verdict !== undefined,
  );
  const deduped = sortSignals(dedupeSignals(present.flatMap((verdict) => verdict.signals)));
  const truncatedSources = [
    ...new Set(present.flatMap((verdict) => verdict.truncatedSources)),
  ].sort((left, right) => SOURCE_ORDER[left] - SOURCE_ORDER[right]);

  const limited = deduped.slice(0, maxSignals);
  const overBudget = deduped.length > maxSignals;
  const blocking = limited.filter((signal) => signal.severity === "blocking");
  const summary = buildSummary(limited, blocking.length, deduped.length > limited.length);
  return {
    ok: blocking.length === 0 && !overBudget,
    signals: limited,
    summary,
    durationMs: present.reduce((total, verdict) => total + verdict.durationMs, 0),
    truncatedSources: overBudget
      ? [...new Set([...truncatedSources, ...limited.map((signal) => signal.source)])].sort(
          (left, right) => SOURCE_ORDER[left] - SOURCE_ORDER[right],
        )
      : truncatedSources,
  };
}

function buildSummary(signals: readonly RepairSignal[], blockingCount: number, truncated: boolean): string {
  if (signals.length === 0) return "Все инварианты выполнены.";
  const bySource = new Map<RepairSignalSource, number>();
  for (const signal of signals) {
    bySource.set(signal.source, (bySource.get(signal.source) ?? 0) + 1);
  }
  const parts = [...bySource.entries()]
    .sort((left, right) => SOURCE_ORDER[left[0]] - SOURCE_ORDER[right[0]])
    .map(([source, count]) => `${source}: ${count}`);
  return `${blockingCount} блокирующих из ${signals.length} (${parts.join(", ")})${
    truncated ? "; список усечён бюджетом" : ""
  }`;
}

/** Группировка по файлам для диагноза модели. */
export function groupSignalsByFile(signals: readonly RepairSignal[]): {
  byFile: Array<{ file: string; signals: RepairSignal[] }>;
  unattributed: RepairSignal[];
} {
  const byFile = new Map<string, RepairSignal[]>();
  const unattributed: RepairSignal[] = [];
  for (const signal of signals) {
    if (!signal.file) {
      unattributed.push(signal);
      continue;
    }
    const list = byFile.get(signal.file);
    if (list) list.push(signal);
    else byFile.set(signal.file, [signal]);
  }
  return {
    // Сортировка ключей: одинаковая группировка при одинаковом входе.
    byFile: [...byFile.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([file, list]) => ({ file, signals: list })),
    unattributed,
  };
}

/**
 * Формирует конкретный следующий шаг.
 *
 * Приоритет: типы → тесты → линтер → рантайм браузера → PTY → состояние файлов.
 * Типы идут первыми, потому что остальные проверки часто следуют из них.
 */
export function buildNextStep(signals: readonly RepairSignal[]): string {
  if (signals.length === 0) return "Ничего не требуется: инварианты выполнены.";
  const blocking = signals.filter((signal) => signal.severity === "blocking");
  const pool = blocking.length > 0 ? blocking : signals;
  const primary = pool[0]!;
  const firstLocation = primary.file
    ? `${primary.file}${primary.line ? `:${primary.line}` : ""}`
    : "без файла";
  switch (primary.source) {
    case "typecheck":
      return `Исправьте ошибку типов ${primary.code ?? ""} в ${firstLocation}: ${primary.message}. Сначала устраните типы — остальные проверки могут быть их следствием.`;
    case "lint":
      return `Исправьте нарушение правила ${primary.code ?? ""} в ${firstLocation}: ${primary.message}.`;
    case "test":
      return `Восстановите падающий тест (${firstLocation}): ${primary.message}. Затем перезапустите затронутые тесты.`;
    case "browser-pageerror":
      return `Устройте причину необработанного исключения на странице (${firstLocation}): ${primary.message}. Проверьте верхнюю строку стека.`;
    case "browser-network":
      return `Восстановите сетевой вызов ${firstLocation}: ${primary.message}. Проверьте адрес, CORS и обработку ошибок.`;
    case "browser-console":
      return `Устраните console.error на странице (${firstLocation}): ${primary.message}.`;
    case "pty":
      return `Исправьте ошибку процесса в PTY (${firstLocation}): ${primary.message}. Проверьте лог сервера в PtySession.`;
    case "file-state":
      return `Приведите файлы в ожидаемое состояние (${firstLocation}): ${primary.message}. Проверьте результат транзакции.`;
    case "tool-call":
      return `Повторите вызов инструмента корректно (${firstLocation}): ${primary.message}.`;
  }
}

/** Компактный текстовый отчёт для лога/UI. */
export function formatRepairReport(input: {
  status: string;
  iteration: number;
  verdict: RepairVerificationVerdict;
  nextStep: string;
}): string {
  const lines = [
    `[auto-repair] status=${input.status} iteration=${input.iteration}`,
    `[auto-repair] summary: ${input.verdict.summary}`,
  ];
  if (input.verdict.truncatedSources.length > 0) {
    lines.push(`[auto-repair] усечено: ${input.verdict.truncatedSources.join(", ")}`);
  }
  for (const signal of input.verdict.signals.slice(0, AUTO_REPAIR_DEFAULTS.maxSignalsPerIteration)) {
    const location = signal.file
      ? `${signal.file}${signal.line ? `:${signal.line}` : ""}`
      : "—";
    lines.push(
      `  - [${signal.severity}/${signal.source}] ${location}${signal.code ? ` ${signal.code}` : ""}: ${signal.message}`,
    );
  }
  lines.push(`[auto-repair] next: ${input.nextStep}`);
  return lines.join("\n");
}

/** Создаёт сигнал с автоматической сигнатурой. */
export function makeSignal(input: Omit<RepairSignal, "signature">): RepairSignal {
  return { ...input, signature: signalSignature(input) };
}
