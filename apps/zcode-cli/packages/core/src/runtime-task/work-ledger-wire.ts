import type { WorkClaim } from "./work-ledger.js";
import { WorkLedger } from "./work-ledger.js";

/** Сколько символов цели задачи попадает в intent claim'а. */
export const WORK_LEDGER_INTENT_MAX_CHARS = 200;
/** Жёсткий предел блока в конверте ребёнка: конверт должен оставаться компактным. */
export const WORK_LEDGER_ENVELOPE_MAX_LINES = 15;
/** Сколько чужих claim'ов перечислять; остальные схлопываются в строку «и ещё N». */
export const WORK_LEDGER_ENVELOPE_MAX_CLAIMS = 6;
/** Длина intent'а в строке конверта, чтобы 15 строк не превратились в простыню. */
export const WORK_LEDGER_ENVELOPE_INTENT_MAX_CHARS = 80;
/** Период heartbeat с шага ребёнка; TTL ядра — 10 минут. */
export const WORK_LEDGER_HEARTBEAT_INTERVAL_MS = 60_000;
/** Предохранитель от «пути» из случайных токенов в длинном промпте. */
export const WORK_LEDGER_MAX_EXTRACTED_PATHS = 20;

const INTENT_WHITESPACE = /\s+/gu;
const HAS_WHITESPACE = /\s/u;
const LINE_SUFFIX = /:\d+(?::\d+)?$/u;
const EXTENSION_SUFFIX = /\.[A-Za-z0-9]{1,10}$/u;
const SEGMENT = /^[\w@.+-]+$/u;
const BACKTICKED_SPAN = /`([^`\n]+)`/gu;
// Абсолютный путь ищем первым: иначе relative-ветка приняла бы его хвост за путь внутри
// workspace и приписала claim к чужому файлу.
const BARE_ABSOLUTE_PATH = /(?<![\w@.+-])\/(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/gu;
const BARE_RELATIVE_PATH =
  /(?<![\w/@.+-])(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/gu;

/**
 * Консервативно проверяет, что токен — явный путь: только сегменты из безопасных
 * символов, последний сегмент с расширением (или путь из трёх и более сегментов).
 * Всё остальное (`--flag`, `pnpm test`, `text/html`, URL) отбрасывается.
 */
function normalizeExplicitPath(raw: string): string | undefined {
  let candidate = raw.trim();
  if (candidate.length === 0 || candidate.length > 260) return undefined;
  // Обёртки, которые часто оказываются внутри backticks: (path), "path", <path>.
  candidate = candidate.replace(/^[("'<[]+/u, "").replace(/[)"'>\].,;]+$/u, "");
  if (candidate.length === 0 || candidate.startsWith("~") || candidate.startsWith("-")) {
    return undefined;
  }
  if (candidate.includes("://") || HAS_WHITESPACE.test(candidate)) return undefined;
  if (/[*?<>{}|$]/u.test(candidate)) return undefined;

  const withoutLine = candidate.replace(LINE_SUFFIX, "");
  if (!withoutLine.includes("/")) return undefined;
  const segments = withoutLine.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  if (!segments.every((segment) => SEGMENT.test(segment))) return undefined;
  const last = segments[segments.length - 1]!;
  const hasExtension = EXTENSION_SUFFIX.test(last);
  // Односегментные каталоги и «foo/bar» без расширения слишком похожи на обычный текст.
  if (!hasExtension && segments.length < 3) return undefined;
  return withoutLine;
}

function pushUnique(target: string[], seen: Set<string>, candidate: string | undefined): void {
  if (!candidate || seen.has(candidate)) return;
  seen.add(candidate);
  target.push(candidate);
}

/**
 * Извлекает пути из текста задачи: backtick-спаны и голые пути вида
 * `path/to/file.ts` / `path:line`. Ничего не находит — возвращает пустой массив.
 */
export function extractTaskPaths(text: string): string[] {
  if (text.trim().length === 0) return [];
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(BACKTICKED_SPAN)) {
    // В backticks часто лежит команда целиком (`pnpm test apps/...`), поэтому
    // проверяем каждый токен отдельно, а не всю строку.
    for (const token of match[1]!.split(INTENT_WHITESPACE)) {
      pushUnique(paths, seen, normalizeExplicitPath(token));
    }
  }
  for (const match of text.matchAll(BARE_ABSOLUTE_PATH)) {
    pushUnique(paths, seen, normalizeExplicitPath(match[0]));
  }
  for (const match of text.matchAll(BARE_RELATIVE_PATH)) {
    pushUnique(paths, seen, normalizeExplicitPath(match[0]));
  }
  return paths.slice(0, WORK_LEDGER_MAX_EXTRACTED_PATHS);
}

/** Цель задачи для claim'а: первые N символов, пробелы схлопнуты. */
export function summarizeWorkIntent(
  text: string,
  maxChars: number = WORK_LEDGER_INTENT_MAX_CHARS,
): string {
  return text.replace(INTENT_WHITESPACE, " ").trim().slice(0, maxChars);
}

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

function formatPaths(paths: readonly string[]): string {
  if (paths.length === 0) return "пути не заявлены";
  const shown = paths.slice(0, 3).map((path) => `\`${path}\``);
  if (paths.length > 3) shown.push(`ещё ${paths.length - 3}`);
  return shown.join(", ");
}

function formatClaimLine(claim: WorkClaim): string {
  const profile = claim.profile ? ` (${claim.profile})` : "";
  return `- ${claim.agentId}${profile} — ${truncate(
    claim.intent,
    WORK_LEDGER_ENVELOPE_INTENT_MAX_CHARS,
  )} — ${formatPaths(claim.paths)}`;
}

export interface WorkLedgerEnvelopeInput {
  /** Отсутствующий реестр — wiring выключен: блок не добавляется. */
  ledger: WorkLedger | undefined;
  workspacePath: string;
  agentId: string;
  /** Запасной intent, если claim агента ещё не виден реестру. */
  intent?: string;
  paths?: readonly string[];
}

/**
 * Блок «чем заняты другие агенты» для конверта ребёнка. Возвращает undefined,
 * когда в том же workspace нет чужих активных claim'ов.
 */
export function buildWorkLedgerEnvelopeBlock(
  input: WorkLedgerEnvelopeInput,
): string | undefined {
  const workspacePath = input.workspacePath.trim();
  const agentId = input.agentId.trim();
  if (!input.ledger || workspacePath.length === 0 || agentId.length === 0) return undefined;

  const active = input.ledger.list({ workspacePath, status: "active" });
  const others = active.filter((claim) => claim.agentId !== agentId);
  if (others.length === 0) return undefined;
  const self = active.find((claim) => claim.agentId === agentId);

  const lines: string[] = ["Сейчас в работе у других агентов:"];
  for (const claim of others.slice(0, WORK_LEDGER_ENVELOPE_MAX_CLAIMS)) {
    lines.push(formatClaimLine(claim));
  }
  if (others.length > WORK_LEDGER_ENVELOPE_MAX_CLAIMS) {
    lines.push(`…и ещё ${others.length - WORK_LEDGER_ENVELOPE_MAX_CLAIMS}.`);
  }
  lines.push(
    "Не правь эти файлы без необходимости; если нужен тот же файл — сначала прочитай его.",
  );

  const intent = self?.intent ?? summarizeWorkIntent(input.intent ?? "");
  if (intent.length > 0) {
    const similar = input.ledger
      .findSimilarIntent({
        workspacePath,
        agentId,
        intent,
        ...(self?.paths.length || input.paths?.length
          ? { paths: self?.paths ?? input.paths }
          : {}),
      })
      .at(0);
    if (similar) {
      lines.push(
        `Похожее намерение уже есть у агента ${similar.claim.agentId}: «${truncate(
          similar.claim.intent,
          WORK_LEDGER_ENVELOPE_INTENT_MAX_CHARS,
        )}».`,
      );
    }
  }

  // Конверт компактный: даже при будущем росте лимитов блок не выходит за 15 строк.
  return lines.slice(0, WORK_LEDGER_ENVELOPE_MAX_LINES).join("\n");
}

const lastHeartbeatByLedger = new WeakMap<WorkLedger, Map<string, number>>();

/**
 * Heartbeat с шага ребёнка, не чаще intervalMs. Без throttle каждый streaming-событие
 * писало бы отдельную строку в append-only журнал.
 */
export function heartbeatWorkClaim(
  ledger: WorkLedger | undefined,
  agentId: string,
  options: { now?: number; intervalMs?: number } = {},
): boolean {
  const id = agentId.trim();
  if (!ledger || id.length === 0) return false;
  const now = options.now ?? Date.now();
  const intervalMs = options.intervalMs ?? WORK_LEDGER_HEARTBEAT_INTERVAL_MS;
  let lastByAgent = lastHeartbeatByLedger.get(ledger);
  if (!lastByAgent) {
    lastByAgent = new Map<string, number>();
    lastHeartbeatByLedger.set(ledger, lastByAgent);
  }
  const last = lastByAgent.get(id);
  if (last !== undefined && now - last < intervalMs) return false;
  lastByAgent.set(id, now);
  ledger.heartbeat(id, now);
  return true;
}

/** Снимает throttle-состояние после release, чтобы долгий процесс не копил agentId. */
export function forgetWorkClaimHeartbeat(ledger: WorkLedger, agentId: string): void {
  lastHeartbeatByLedger.get(ledger)?.delete(agentId.trim());
}

let processLedger: WorkLedger | undefined;
let processLedgerLoading: Promise<void> | undefined;

/**
 * Единственный владелец реестра работ в процессе CLI. Ленивый: тесты и встраиваемые
 * хосты получают его только когда явно просят.
 */
export function getProcessWorkLedger(): WorkLedger {
  if (!processLedger) {
    processLedger = new WorkLedger();
  }
  processLedgerLoading ??= processLedger.load().catch(() => undefined);
  return processLedger;
}

/** Дожидается реплея журнала процессного реестра (для bootstrap и тестов). */
export function whenProcessWorkLedgerLoaded(): Promise<void> {
  return processLedgerLoading ?? Promise.resolve();
}

/** Сброс процессного singleton'а; тесты передают свой ledger или undefined. */
export function setProcessWorkLedgerForTesting(ledger: WorkLedger | undefined): void {
  processLedger = ledger;
  processLedgerLoading = undefined;
}
