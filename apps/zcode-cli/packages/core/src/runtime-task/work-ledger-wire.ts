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
// Путь из backticks может содержать пробел (`/tmp/zcode workspace/repo/src/a.ts`):
// пробел допустим внутри сегмента, но не в начале/конце (проверяется отдельно).
const SEGMENT_WITH_SPACES = /^[\w@.+\- ]+$/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//u;
/**
 * Каталоги исходников: `src/runtime-task` — явный directory scope, а `text/html` — MIME.
 * Правило применяется только к двум сегментам без расширения; всё остальное требует >= 3.
 */
const KNOWN_SOURCE_DIRECTORIES = new Set([
  "src",
  "apps",
  "packages",
  "docs",
  "scripts",
  "tests",
  "test",
  "lib",
  "config",
  "public",
  "assets",
  "server",
  "client",
  "shared",
  "ui",
  "web",
  "desktop",
  "runtime",
  "core",
]);
const BACKTICKED_SPAN = /`([^`\n]+)`/gu;
// Абсолютный путь ищем первым: иначе relative-ветка приняла бы его хвост за путь внутри
// workspace и приписала claim к чужому файлу.
const BARE_ABSOLUTE_PATH = /(?<![\w@.+-])\/(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/gu;
const BARE_RELATIVE_PATH =
  /(?<![\w/@.+-])(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/gu;
// URL без схемы после матчинга выглядит как /github.com/...; refs/heads/dev проходит
// как «путь из трёх сегментов»; ~/.zcode/... теряет тильду. Вырезаем эти формы до матчинга.
const URL_SPAN = /\bhttps?:\/\/[^\s`]+/gu;
const GIT_REF_SPAN = /\brefs\/(?:heads|tags)\/[^\s`]+/gu;
const HOME_PATH_SPAN = /(?:^|\s)~\/[^\s`]+/gu;

/**
 * Консервативно проверяет, что токен — явный путь: только сегменты из безопасных
 * символов, последний сегмент с расширением (или путь из трёх и более сегментов).
 * Всё остальное (`--flag`, `pnpm test`, `text/html`, URL) отбрасывается.
 *
 * `allowSpaces` включается только для backtick-спана: внутри него пробел может быть
 * частью имени каталога (`/tmp/zcode workspace/repo/src/a.ts`). Спан с более чем одной
 * группой пробелов принимается, только если пробел есть в имени файла и оно с
 * расширением; иначе это текст или команда, и берутся отдельные токены.
 */
function normalizeExplicitPath(
  raw: string,
  options: { allowSpaces?: boolean; allowSourceDirectory?: boolean } = {},
): string | undefined {
  let candidate = raw.trim();
  if (candidate.length === 0 || candidate.length > 260) return undefined;
  // Обёртки, которые часто оказываются внутри backticks: (path), "path", <path>.
  candidate = candidate.replace(/^[("'<[]+/u, "").replace(/[)"'>\].,;]+$/u, "");
  if (
    candidate.length === 0 ||
    candidate.startsWith("~") ||
    candidate.startsWith("-") ||
    candidate.startsWith("refs/")
  ) {
    return undefined;
  }
  if (candidate.includes("://") || /[*?<>{}|$]/u.test(candidate)) return undefined;

  const hasWhitespace = HAS_WHITESPACE.test(candidate);
  const tokens = hasWhitespace ? candidate.split(INTENT_WHITESPACE) : [];
  if (hasWhitespace) {
    if (!options.allowSpaces) return undefined;
    // Флаг внутри спана (`... --run`) и первое слово без "/" (`pnpm test ...`) — команда.
    if (tokens.some((token) => token.startsWith("-"))) return undefined;
    const head = tokens[0] ?? "";
    if (!head.startsWith("/") && !WINDOWS_ABSOLUTE_PATH.test(head) && !head.includes("/")) {
      return undefined;
    }
  }

  const withoutLine = candidate.replace(LINE_SUFFIX, "");
  if (!withoutLine.includes("/")) return undefined;
  const segments = withoutLine.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  const segmentPattern = hasWhitespace ? SEGMENT_WITH_SPACES : SEGMENT;
  if (!segments.every((segment) => segment.trim() === segment && segmentPattern.test(segment))) {
    return undefined;
  }
  const last = segments[segments.length - 1]!;
  const hasExtension = EXTENSION_SUFFIX.test(last);
  // Спан с пробелами целиком — только при одной группе пробелов
  // (`/tmp/zcode workspace/repo/src/a.ts`) или когда пробел внутри имени файла
  // (`/tmp/my project/file name.ts`). Иначе это текст или команда:
  // `src/a.ts line 20` и `/usr/bin/pnpm test src/a.ts` должны распасться на токены,
  // иначе claim получает несуществующий путь и пропускает конфликт на файле.
  if (hasWhitespace && tokens.length > 2 && (!HAS_WHITESPACE.test(last) || !hasExtension)) {
    return undefined;
  }
  if (!hasExtension && segments.length < 3) {
    // Односегментные каталоги и «foo/bar» без расширения слишком похожи на обычный
    // текст. Исключение — весь backtick-спан без пробелов, который является известным
    // исходным каталогом (`src/runtime-task` — scope). Для токенов внутри команды
    // правило не действует, иначе `git checkout src/main` стал бы claim'ом на каталог.
    const knownSourceDirectory =
      !hasWhitespace &&
      options.allowSourceDirectory === true &&
      segments.length === 2 &&
      KNOWN_SOURCE_DIRECTORIES.has(segments[0]!.toLowerCase());
    if (!knownSourceDirectory) return undefined;
  }
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
  const sanitized = text
    .replace(URL_SPAN, " ")
    .replace(GIT_REF_SPAN, " ")
    .replace(HOME_PATH_SPAN, " ");

  // Backtick-спан — явная цитата пути. Сначала пробуем весь спан: в workspace с пробелом
  // (`/Users/x/Zcode Fork/repo`) разбиение по пробелам теряет полный путь и оставляет
  // ложный claim на родительский каталог. Принятый спан вырезаем из текста для голых
  // regexp'ов, чтобы их хвосты не добавили частичные пути.
  let bareText = "";
  let consumed = 0;
  for (const match of sanitized.matchAll(BACKTICKED_SPAN)) {
    const span = match[1]!;
    const whole = normalizeExplicitPath(span, {
      allowSpaces: true,
      allowSourceDirectory: true,
    });
    const start = match.index ?? 0;
    if (whole) {
      pushUnique(paths, seen, whole);
      bareText += `${sanitized.slice(consumed, start)} `;
    } else {
      bareText += sanitized.slice(consumed, start) + match[0];
      // В backticks часто лежит команда целиком (`pnpm test apps/...`), поэтому
      // проверяем каждый токен отдельно, а не всю строку.
      for (const token of span.split(INTENT_WHITESPACE)) {
        pushUnique(paths, seen, normalizeExplicitPath(token));
      }
    }
    consumed = start + match[0].length;
  }
  bareText += sanitized.slice(consumed);

  for (const match of bareText.matchAll(BARE_ABSOLUTE_PATH)) {
    pushUnique(paths, seen, normalizeExplicitPath(match[0]));
  }
  for (const match of bareText.matchAll(BARE_RELATIVE_PATH)) {
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
