/**
 * Проверочный гейт: запускает все доступные порты и объединяет вердикты.
 *
 * Инварианты:
 * - порты вызываются в фиксированном порядке (типы → линтер → тесты → браузер → PTY → файлы);
 * - падение порта не маскируется: ошибка превращается в блокирующий сигнал `tool-call`
 *   с исходным сообщением, чтобы модель знала, что проверка не выполнена;
 * - суммарное время ограничено `timeoutMs`; превышение даёт сигнал-предупреждение,
 *   а не бесконечное ожидание.
 */
import type {
  RepairVerificationPort,
  RepairVerificationVerdict,
  RepairSignal,
} from "./contract.js";
import { makeSignal, mergeVerdicts } from "./telemetry-aggregator.js";

/**
 * Минимальный логгер модуля.
 *
 * `core` не зависит от `packages/services` (слой adapters выше): вызывающий
 * передаёт сюда свой логгер (Desktop/CLI используют `createServiceLogger`).
 * Без логгера модуль работает молча — это не влияет на результат.
 */
export interface AutoRepairLogger {
  debug(scope: string, message: string, payload?: Record<string, unknown>): void;
  info(scope: string, message: string, payload?: Record<string, unknown>): void;
  warn(scope: string, message: string, payload?: Record<string, unknown>): void;
  error(scope: string, message: string, payload?: Record<string, unknown>): void;
}

export interface VerificationGateOptions {
  port: RepairVerificationPort;
  /** Бюджет одного запуска гейта; по умолчанию 3 минуты. */
  timeoutMs?: number;
  /** Сколько сигналов максимум возвращать. */
  maxSignals?: number;
  /** Какой набор проверок запускать (по умолчанию все доступные). */
  scope?: ReadonlyArray<keyof RepairVerificationPort>;
  logger?: AutoRepairLogger;
}

const DEFAULT_SCOPE: ReadonlyArray<keyof RepairVerificationPort> = [
  "runTypecheck",
  "runLint",
  "runTests",
  "collectBrowserSignals",
  "collectPtySignals",
  "checkFileState",
];

const SOURCE_FOR_PORT: Readonly<Record<keyof RepairVerificationPort, RepairSignal["source"]>> = {
  runTypecheck: "typecheck",
  runLint: "lint",
  runTests: "test",
  collectBrowserSignals: "browser-console",
  collectPtySignals: "pty",
  checkFileState: "file-state",
};

/** Запускает гейт: все порты детерминированно, с бюджетом времени. */
export async function runVerificationGate(
  options: VerificationGateOptions,
): Promise<RepairVerificationVerdict> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 3 * 60_000;
  const scope = options.scope ?? DEFAULT_SCOPE;
  const verdicts: RepairVerificationVerdict[] = [];

  for (const portName of scope) {
    const runner = options.port[portName];
    if (!runner) continue;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      verdicts.push({
        ok: false,
        signals: [
          makeSignal({
            source: SOURCE_FOR_PORT[portName],
            severity: "warning",
            message: `Проверка не запущена: исчерпан бюджет гейта (${timeoutMs} мс).`,
          }),
        ],
        summary: `Бюджет гейта исчерпан на шаге ${portName}`,
        durationMs: 0,
        truncatedSources: [],
      });
      break;
    }
    try {
      verdicts.push(await runner.call(options.port));
    } catch (error) {
      // Падение самого порта — это факт, который модель обязана увидеть: иначе
      // «проверка не выполнена» выглядело бы как «проверка прошла».
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn("auto-repair-loop", "[auto-repair] порт проверки упал", {
        port: portName,
        message,
      });
      verdicts.push({
        ok: false,
        signals: [
          makeSignal({
            source: "tool-call",
            severity: "blocking",
            message: `Порт проверки '${portName}' завершился ошибкой: ${message}`,
          }),
        ],
        summary: `Проверка '${portName}' не выполнена`,
        durationMs: 0,
        truncatedSources: [],
      });
    }
  }

  const merged = mergeVerdicts(verdicts, {
    ...(options.maxSignals !== undefined ? { maxSignals: options.maxSignals } : {}),
  });
  options.logger?.debug("auto-repair-loop", "[auto-repair] гейт завершён", {
    ok: merged.ok,
    signals: merged.signals.length,
    sources: scope.length,
    durationMs: Date.now() - startedAt,
  });
  return { ...merged, durationMs: Date.now() - startedAt };
}
