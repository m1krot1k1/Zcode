/**
 * Мост между флагом `enableAutoRepairLoop` и реальными проверками агентного хода.
 *
 * Причина появления: флаг уже доезжал из настроек до `runtimeConfig`, но
 * потребителя в рантайме не было — цикл собирался только в тестах. Здесь флаг
 * превращается в фактические проверки (tsc/oxlint через порт исполнения) и в
 * диагноз, который модель обязана увидеть.
 *
 * Модуль не знает про `AgentRuntime`: вызывающий передаёт только порт,
 * рабочую директорию и логгер. Так `cli-auto-repair-loop` остаётся
 * самодостаточным app-модулем с `requires: []`.
 *
 * Инварианты:
 * - при выключенном флаге не выделяется ни один ресурс и не запускается ни одна команда;
 * - отсутствие исполнителя проверки — это `warning`, а не «проверка пройдена»;
 * - число запусков ограничено лимитом из настроек, решение о ремонте — за моделью.
 */
import type { RepairSignal } from "./contract.js";
import { makeSignal } from "./telemetry-aggregator.js";

/**
 * Минимальный структурный контракт исполнителя команд.
 *
 * Не импортируем `@zcode/contracts`: модуль объявлен с `requires: []`, и он
 * обязан оставаться самодостаточным. Совместимость с `ExecutionPort`
 * проверяется на месте вызова (там передаётся настоящий порт).
 */
export interface AgentVerificationExecPort {
  run(request: {
    command: { mode: "argv"; file: string; args?: string[] };
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{
    status: string;
    stdout: { text: string };
    stderr: { text: string };
  }>;
}

/** Сколько раз за turn допускается запускать гейт (защита от бесконечного цикла). */
export const AUTO_REPAIR_GATE_MAX_RUNS = 2;

export interface AutoRepairGateOutcome {
  /** `repair` — модель получает диагноз и продолжает; `clean` — нарушений нет. */
  kind: "repair" | "clean" | "skipped";
  /** Готовый отчёт для модели; пустая строка при `clean`/`skipped`. */
  report: string;
  signals: readonly RepairSignal[];
}

export interface AgentAutoRepairGateOptions {
  executionPort: AgentVerificationExecPort | undefined;
  workingDirectory: string | undefined;
  enabled: boolean;
  maxIterations?: number;
  logger?: {
    info(message: string, payload?: Record<string, unknown>): void;
    warn(message: string, payload?: Record<string, unknown>): void;
  } | undefined;
}

/**
 * Разбирает вывод `tsc --noEmit --pretty false`.
 *
 * Формат строки: `path/to/file.ts(12,34): error TS2345: сообщение`.
 * Всё, что не совпало, игнорируется: гейт не должен выдумывать дефекты.
 */
export function parseTypecheckOutput(stdout: string): RepairSignal[] {
  const signals: RepairSignal[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/u;
  for (const line of stdout.split(/\r?\n/u)) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    const [, file, lineNumber, column, severity, code, message] = match;
    signals.push(
      makeSignal({
        source: "typecheck",
        severity: severity === "error" ? "blocking" : "warning",
        message: (message ?? "").trim(),
        file: file ?? "",
        line: Number(lineNumber),
        column: Number(column),
        code: code ?? "",
      }),
    );
  }
  return signals;
}

/**
 * Разбирает вывод линтера в формате `path:line:col: message  rule-name`,
 * который печатают oxlint и eslint в unix-подобном формате.
 */
export function parseLintOutput(stdout: string): RepairSignal[] {
  const signals: RepairSignal[] = [];
  const pattern = /^(.+?):(\d+):(\d+):\s+(.+?)(?:\s{2,}([\w@/.-]+))?$/u;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Found ") || trimmed.startsWith("Finished")) continue;
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const [, file, lineNumber, column, message, rule] = match;
    signals.push(
      makeSignal({
        source: "lint",
        severity: "warning",
        message: (message ?? "").trim(),
        file: file ?? "",
        line: Number(lineNumber),
        column: Number(column),
        ...(rule ? { code: rule } : {}),
      }),
    );
  }
  return signals;
}

interface CommandOutcome {
  status: "ok" | "unavailable";
  stdout: string;
}

/**
 * Запускает argv-команду через порт исполнения.
 *
 * `spawn_error` означает «исполнитель отсутствует», а не «нет ошибок»: вызывающий
 * превращает это в предупреждение, чтобы модель не считала проверку выполненной.
 */
async function runVerificationCommand(
  options: AgentAutoRepairGateOptions,
  file: string,
  args: readonly string[],
): Promise<CommandOutcome> {
  const port = options.executionPort;
  if (!port) return { status: "unavailable", stdout: "" };
  let status: string;
  let stdoutText: string;
  let stderrText: string;
  try {
    const result = await port.run({
      command: { mode: "argv", file, args: [...args] },
      ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
      timeoutMs: 120_000,
    });
    status = result.status;
    stdoutText = result.stdout.text;
    stderrText = result.stderr.text;
  } catch {
    return { status: "unavailable", stdout: "" };
  }
  if (status === "spawn_error") return { status: "unavailable", stdout: "" };
  return { status: "ok", stdout: `${stdoutText}\n${stderrText}` };
}

/**
 * Собирает сигналы реальных проверок. Каждая недоступная проверка возвращает
 * предупреждение, а не тишину — иначе «нет вывода» читалось бы как «всё чисто».
 */
export async function collectAgentAutoRepairSignals(
  options: AgentAutoRepairGateOptions,
): Promise<RepairSignal[]> {
  const signals: RepairSignal[] = [];
  const unavailable: string[] = [];

  const typecheck = await runVerificationCommand(options, "node_modules/.bin/tsc", [
    "--noEmit",
    "--pretty",
    "false",
  ]);
  if (typecheck.status === "unavailable") unavailable.push("tsc");
  else signals.push(...parseTypecheckOutput(typecheck.stdout));

  const lint = await runVerificationCommand(options, "node_modules/.bin/oxlint", [
    "--format",
    "unix",
  ]);
  if (lint.status === "unavailable") unavailable.push("oxlint");
  else signals.push(...parseLintOutput(lint.stdout));

  if (unavailable.length > 0) {
    signals.push(
      makeSignal({
        source: "tool-call",
        severity: "warning",
        message: `Проверка не выполнена: недоступны ${unavailable.join(", ")}. Не считайте это отсутствием ошибок.`,
      }),
    );
  }
  return signals;
}

/**
 * Один шаг гейта после того, как модель завершила ход без tool calls.
 *
 * Возвращает `repair`, если найдены блокирующие дефекты и лимит запусков не
 * исчерпан: вызывающий обязан показать `report` модели и продолжить turn.
 */
export async function runAgentAutoRepairGate(
  options: AgentAutoRepairGateOptions & { runsSoFar: number },
): Promise<AutoRepairGateOutcome & { runsUsed: number }> {
  if (!options.enabled) return { kind: "skipped", report: "", signals: [], runsUsed: options.runsSoFar };
  const maxRuns = Math.max(
    1,
    Math.min(
      AUTO_REPAIR_GATE_MAX_RUNS,
      options.maxIterations && options.maxIterations > 0
        ? options.maxIterations
        : AUTO_REPAIR_GATE_MAX_RUNS,
    ),
  );
  if (options.runsSoFar >= maxRuns) {
    options.logger?.info("Auto-repair gate limit reached", {
      runs: options.runsSoFar,
      maxRuns,
    });
    return { kind: "skipped", report: "", signals: [], runsUsed: options.runsSoFar };
  }
  const runsUsed = options.runsSoFar + 1;

  const signals = await collectAgentAutoRepairSignals(options);
  const blocking = signals.filter((signal) => signal.severity === "blocking");
  options.logger?.info("Auto-repair gate verified", {
    run: runsUsed,
    signals: signals.length,
    blocking: blocking.length,
  });
  if (blocking.length === 0) return { kind: "clean", report: "", signals, runsUsed };

  const report = [
    "[auto-repair] Проверки после правки нашли блокирующие дефекты.",
    ...blocking.slice(0, 20).map((signal) => {
      const location = signal.file
        ? `${signal.file}${signal.line ? `:${signal.line}` : ""}`
        : "—";
      return `  - [${signal.source}] ${location}${signal.code ? ` ${signal.code}` : ""}: ${signal.message}`;
    }),
    "[auto-repair] Исправьте эти дефекты и завершите ход только после успешной проверки.",
  ].join("\n");
  return { kind: "repair", report, signals, runsUsed };
}
