import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";

/**
 * Реестр работ агентов: кто что делает и какие пути держит.
 *
 * Владелец состояния — этот экземпляр в процессе CLI. Журнал `work-ledger.jsonl`
 * append-only и нужен только для восстановления после рестарта; он не является
 * вторым источником истины и не участвует в чтении во время работы.
 *
 * Спека: docs/specs/agent-work-ledger.md.
 */

export const WORK_LEDGER_TTL_MS = 10 * 60 * 1000;
export const WORK_LEDGER_JOURNAL_VERSION = 1;
export const MIN_SHARED_INTENT_TOKENS = 2;

const CASE_INSENSITIVE_PLATFORMS = new Set(["darwin", "win32"]);
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//u;
const TOKEN_SEPARATOR = /[^\p{L}\p{N}_]+/u;
const WHITESPACE = /\s+/gu;

/** Служебные слова, которые не делают два намерения похожими. */
const INTENT_STOP_WORDS = new Set([
  "add",
  "and",
  "are",
  "fix",
  "for",
  "implement",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "update",
  "with",
  "в",
  "во",
  "для",
  "до",
  "добавить",
  "за",
  "и",
  "из",
  "исправить",
  "к",
  "как",
  "на",
  "не",
  "обновить",
  "от",
  "по",
  "реализовать",
  "с",
  "сделать",
  "со",
  "что",
  "это",
]);

export type WorkClaimStatus = "active" | "released" | "stale";
export type WorkConflictKind = "same-file" | "directory-overlap";
export type WorkIntentSimilarity = "identical" | "overlapping";

export interface WorkClaim {
  id: string;
  /** Разрешённый ключ workspace: `workspaceIdentity?.trim() || workspacePath`. */
  workspaceIdentity: string;
  /** База нормализации путей и отображения. */
  workspacePath: string;
  agentId: string;
  parentAgentId: string | null;
  profile: string | null;
  intent: string;
  /** Нормализованные пути: relative к `workspacePath`, если внутри него. */
  paths: string[];
  startedAt: number;
  heartbeatAt: number;
  status: WorkClaimStatus;
}

export interface WorkLedgerScope {
  workspacePath: string;
  workspaceIdentity?: string | null;
}

export interface WorkClaimInput extends WorkLedgerScope {
  agentId: string;
  parentAgentId?: string | null;
  profile?: string | null;
  intent: string;
  paths?: readonly string[];
  now?: number;
}

export interface WorkClaimHolder {
  claimId: string;
  agentId: string;
  parentAgentId: string | null;
  profile: string | null;
  intent: string;
  /** Путь держателя, который пересекается с путём кандидата. */
  path: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface WorkConflict {
  /** Путь кандидата, из-за которого возник конфликт. */
  path: string;
  kind: WorkConflictKind;
  holders: WorkClaimHolder[];
}

export interface WorkIntentWarning {
  claim: WorkClaim;
  kind: WorkIntentSimilarity;
  sharedTokens: string[];
  /** Готовое к показу предупреждение: «Этим уже занимается агент X». */
  message: string;
}

export interface WorkClaimResult {
  claim: WorkClaim;
  conflicts: WorkConflict[];
  similarIntent: WorkIntentWarning[];
  /** true — claim уже существовал и был обновлён, а не создан заново. */
  reused: boolean;
}

export interface WorkLedgerFilter {
  workspaceIdentity?: string | null;
  workspacePath?: string;
  agentId?: string;
  parentAgentId?: string | null;
  status?: WorkClaimStatus | readonly WorkClaimStatus[];
  /** Пересечение с путями claim'а. */
  paths?: readonly string[];
  now?: number;
}

export interface FindConflictsInput extends WorkLedgerScope {
  paths: readonly string[];
  /** Исключает claim'ы этого агента («что будет, если я возьму эти файлы»). */
  agentId?: string;
  now?: number;
}

export interface FindSimilarIntentInput extends WorkLedgerScope {
  intent: string;
  /** Если передан, похожесть дополнительно требует пересечения путей. */
  paths?: readonly string[];
  agentId?: string;
  now?: number;
}

export interface WorkLedgerOptions {
  /** default: ~/.zcode/cli/work-ledger.jsonl; null — только память. */
  journalPath?: string | null;
  ttlMs?: number;
  now?: () => number;
  /** default: false на macOS/Windows, true на Linux. */
  caseSensitivePaths?: boolean;
}

export type WorkLedgerEvent =
  | { v: number; type: "claim"; at: number; claim: WorkClaim }
  | { v: number; type: "heartbeat"; at: number; claimId: string }
  | { v: number; type: "release"; at: number; claimId: string; status: "released" | "stale" };

/** Журнал реестра по умолчанию. */
export function resolveWorkLedgerJournalPath(homeDirectory: string = homedir()): string {
  return join(homeDirectory, ".zcode", "cli", "work-ledger.jsonl");
}

/** Правило репозитория: identity задаёт ключ, путь — fallback. */
export function resolveWorkspaceKey(scope: WorkLedgerScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

/**
 * Приводит путь к канонической форме: `/`, без `.`/`..` и хвостового `/`,
 * относительно workspace, если путь внутри него. Корень workspace — `"."`.
 */
export function normalizeWorkspacePath(rawPath: string, workspacePath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new TypeError("work ledger: path must be a non-empty string");
  }
  const root = toAbsolutePosix(workspacePath, toPosixPath(process.cwd()));
  const absolute = toAbsolutePosix(trimmed, root);
  if (absolute === root) return ".";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
}

/**
 * Пересечение путей: точное совпадение, общий префикс-каталог по границе сегмента
 * или корень workspace `"."`, который пересекается со всем.
 */
export function pathsOverlap(
  left: string,
  right: string,
  options: { caseSensitive?: boolean } = {},
): boolean {
  const caseSensitive = options.caseSensitive ?? !CASE_INSENSITIVE_PLATFORMS.has(process.platform);
  const a = caseSensitive ? left : left.toLowerCase();
  const b = caseSensitive ? right : right.toLowerCase();
  if (a === "." || b === ".") return true;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Нормализация намерения: trim → lower → один пробел. */
export function normalizeIntent(intent: string): string {
  return intent.toLowerCase().replace(WHITESPACE, " ").trim();
}

/** Значимые слова намерения без служебных. */
export function intentTokens(intent: string): string[] {
  const tokens = new Set<string>();
  for (const token of normalizeIntent(intent).split(TOKEN_SEPARATOR)) {
    if (token.length < 2) continue;
    if (INTENT_STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return [...tokens];
}

interface IntentLookup {
  intent: string;
  paths: readonly string[] | undefined;
  workspaceIdentity: string;
  excludeAgentId: string | undefined;
}

export class WorkLedger {
  readonly #claims = new Map<string, WorkClaim>();
  readonly #journalPath: string | null;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #caseSensitivePaths: boolean;
  #writeChain: Promise<void> = Promise.resolve();
  #lastWriteError: unknown = null;
  #lastLoadError: unknown = null;
  #skippedLines = 0;

  constructor(options: WorkLedgerOptions = {}) {
    this.#journalPath =
      options.journalPath === undefined ? resolveWorkLedgerJournalPath() : options.journalPath;
    this.#ttlMs = options.ttlMs ?? WORK_LEDGER_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#caseSensitivePaths =
      options.caseSensitivePaths ?? !CASE_INSENSITIVE_PLATFORMS.has(process.platform);
    if (!(this.#ttlMs > 0)) {
      throw new RangeError("work ledger: ttlMs must be positive");
    }
  }

  /** Создаёт реестр и восстанавливает состояние из журнала. */
  static async open(options: WorkLedgerOptions = {}): Promise<WorkLedger> {
    const ledger = new WorkLedger(options);
    await ledger.load();
    return ledger;
  }

  get journalPath(): string | null {
    return this.#journalPath;
  }

  /** Ошибка последней записи в журнал; состояние в памяти при этом остаётся валидным. */
  get lastWriteError(): unknown {
    return this.#lastWriteError;
  }

  get lastLoadError(): unknown {
    return this.#lastLoadError;
  }

  get skippedLines(): number {
    return this.#skippedLines;
  }

  /** Реплей append-only журнала. Битые строки пропускаются и считаются. */
  async load(): Promise<void> {
    const path = this.#journalPath;
    if (!path) return;
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#lastLoadError = error;
      }
      return;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const event = parseWorkLedgerEvent(trimmed);
      if (!event) {
        this.#skippedLines += 1;
        continue;
      }
      this.#applyEvent(event);
    }
    this.#expire(this.#now());
  }

  /**
   * Объявляет работу. Не блокирует: claim записывается всегда, а конфликты и
   * похожие намерения возвращаются вызывающему как предупреждения.
   */
  claim(input: WorkClaimInput): WorkClaimResult {
    const now = input.now ?? this.#now();
    this.#expire(now);
    const workspacePath = requireNonEmpty(input.workspacePath, "workspacePath");
    const agentId = requireNonEmpty(input.agentId, "agentId");
    const intent = requireNonEmpty(input.intent, "intent").replace(WHITESPACE, " ");
    const workspaceIdentity = resolveWorkspaceKey({ workspacePath, workspaceIdentity: input.workspaceIdentity });
    const paths = normalizeClaimPaths(input.paths ?? [], workspacePath);

    const existing = this.#findReusableClaim(workspaceIdentity, agentId);
    let claim: WorkClaim;
    if (existing) {
      existing.workspacePath = workspacePath;
      existing.parentAgentId = input.parentAgentId ?? existing.parentAgentId;
      existing.profile = input.profile ?? existing.profile;
      existing.intent = intent;
      existing.paths = paths;
      existing.heartbeatAt = now;
      existing.status = "active";
      claim = existing;
    } else {
      claim = {
        id: randomUUID(),
        workspaceIdentity,
        workspacePath,
        agentId,
        parentAgentId: input.parentAgentId ?? null,
        profile: input.profile ?? null,
        intent,
        paths,
        startedAt: now,
        heartbeatAt: now,
        status: "active",
      };
      this.#claims.set(claim.id, claim);
    }

    this.#append({ v: WORK_LEDGER_JOURNAL_VERSION, type: "claim", at: now, claim: snapshot(claim) });

    return {
      claim: snapshot(claim),
      conflicts: this.#collectConflicts(paths, workspaceIdentity, agentId),
      similarIntent: this.#collectSimilarIntents({
        intent,
        paths,
        workspaceIdentity,
        excludeAgentId: agentId,
      }),
      reused: existing !== undefined,
    };
  }

  /** Продлевает все активные claim'ы агента. */
  heartbeat(agentId: string, now: number = this.#now()): WorkClaim[] {
    const id = requireNonEmpty(agentId, "agentId");
    this.#expire(now);
    const updated: WorkClaim[] = [];
    for (const claim of this.#claims.values()) {
      if (claim.agentId !== id || claim.status !== "active") continue;
      claim.heartbeatAt = now;
      this.#append({ v: WORK_LEDGER_JOURNAL_VERSION, type: "heartbeat", at: now, claimId: claim.id });
      updated.push(claim);
    }
    return updated.map(snapshot);
  }

  /** Освобождает все активные claim'ы агента. */
  release(agentId: string, now: number = this.#now()): WorkClaim[] {
    const id = requireNonEmpty(agentId, "agentId");
    this.#expire(now);
    const released: WorkClaim[] = [];
    for (const claim of this.#claims.values()) {
      if (claim.agentId !== id || claim.status !== "active") continue;
      claim.status = "released";
      this.#append({
        v: WORK_LEDGER_JOURNAL_VERSION,
        type: "release",
        at: now,
        claimId: claim.id,
        status: "released",
      });
      released.push(claim);
    }
    return released.map(snapshot);
  }

  list(filter: WorkLedgerFilter = {}): WorkClaim[] {
    const now = filter.now ?? this.#now();
    this.#expire(now);
    let claims = [...this.#claims.values()];

    const workspaceKey = resolveWorkspaceKey({
      workspacePath: filter.workspacePath ?? "",
      workspaceIdentity: filter.workspaceIdentity,
    });
    if (workspaceKey.length > 0) {
      claims = claims.filter((claim) => claim.workspaceIdentity === workspaceKey);
    }
    if (filter.agentId !== undefined) {
      const agentId = filter.agentId.trim();
      claims = claims.filter((claim) => claim.agentId === agentId);
    }
    if (filter.parentAgentId !== undefined) {
      claims = claims.filter((claim) => claim.parentAgentId === filter.parentAgentId);
    }
    if (filter.status !== undefined) {
      const statuses: readonly WorkClaimStatus[] =
        typeof filter.status === "string" ? [filter.status] : filter.status;
      const allowed = new Set<WorkClaimStatus>(statuses);
      claims = claims.filter((claim) => allowed.has(claim.status));
    }
    if (filter.paths !== undefined && filter.paths.length > 0) {
      const workspacePath = requireNonEmpty(filter.workspacePath ?? "", "workspacePath");
      const paths = normalizeClaimPaths(filter.paths, workspacePath);
      claims = claims.filter((claim) =>
        claim.paths.some((claimPath) => paths.some((path) => this.#overlaps(path, claimPath))),
      );
    }

    return claims
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      .map(snapshot);
  }

  /**
   * Конфликты записи для набора путей. Чтение никогда не блокируется, а этот
   * метод только отвечает, кто уже держит пересекающиеся пути.
   */
  findConflicts(input: FindConflictsInput): WorkConflict[] {
    const now = input.now ?? this.#now();
    this.#expire(now);
    const workspacePath = requireNonEmpty(input.workspacePath, "workspacePath");
    const workspaceIdentity = resolveWorkspaceKey({ workspacePath, workspaceIdentity: input.workspaceIdentity });
    const paths = normalizeClaimPaths(input.paths, workspacePath);
    const excludeAgentId = input.agentId?.trim() || undefined;
    return this.#collectConflicts(paths, workspaceIdentity, excludeAgentId);
  }

  /** Предупреждения «этим уже занимается агент X». */
  findSimilarIntent(input: FindSimilarIntentInput): WorkIntentWarning[] {
    const now = input.now ?? this.#now();
    this.#expire(now);
    const workspacePath = requireNonEmpty(input.workspacePath, "workspacePath");
    const workspaceIdentity = resolveWorkspaceKey({ workspacePath, workspaceIdentity: input.workspaceIdentity });
    const intent = requireNonEmpty(input.intent, "intent");
    return this.#collectSimilarIntents({
      intent,
      paths: input.paths === undefined ? undefined : normalizeClaimPaths(input.paths, workspacePath),
      workspaceIdentity,
      excludeAgentId: input.agentId?.trim() || undefined,
    });
  }

  /** Материализует просроченные claim'ы в `stale` и пишет события в журнал. */
  sweepStale(now: number = this.#now()): WorkClaim[] {
    const expired = this.#expire(now);
    for (const claim of expired) {
      this.#append({
        v: WORK_LEDGER_JOURNAL_VERSION,
        type: "release",
        at: now,
        claimId: claim.id,
        status: "stale",
      });
    }
    return expired.map(snapshot);
  }

  /** Дожидается очереди записи в журнал. */
  flush(): Promise<void> {
    return this.#writeChain;
  }

  #applyEvent(event: WorkLedgerEvent): void {
    if (event.type === "claim") {
      const claim = event.claim;
      this.#claims.set(claim.id, { ...claim, paths: [...claim.paths] });
      return;
    }
    const claim = this.#claims.get(event.claimId);
    if (!claim) return;
    if (event.type === "heartbeat") {
      if (event.at < claim.heartbeatAt) return;
      claim.heartbeatAt = event.at;
      // Heartbeat после stale в журнале означает, что агент продолжил работу.
      if (claim.status === "stale") claim.status = "active";
      return;
    }
    claim.status = event.status;
  }

  /** Ленивое истечение TTL: протухшая работа не блокирует других навсегда. */
  #expire(now: number): WorkClaim[] {
    const expired: WorkClaim[] = [];
    for (const claim of this.#claims.values()) {
      if (claim.status !== "active") continue;
      if (now - claim.heartbeatAt < this.#ttlMs) continue;
      claim.status = "stale";
      expired.push(claim);
    }
    return expired;
  }

  #findReusableClaim(workspaceIdentity: string, agentId: string): WorkClaim | undefined {
    let found: WorkClaim | undefined;
    for (const claim of this.#claims.values()) {
      if (claim.workspaceIdentity !== workspaceIdentity) continue;
      if (claim.agentId !== agentId) continue;
      if (claim.status === "released") continue;
      if (found === undefined || claim.heartbeatAt >= found.heartbeatAt) found = claim;
    }
    return found;
  }

  #collectConflicts(
    candidatePaths: readonly string[],
    workspaceIdentity: string,
    excludeAgentId: string | undefined,
  ): WorkConflict[] {
    const conflicts: WorkConflict[] = [];
    for (const candidate of candidatePaths) {
      const holders: WorkClaimHolder[] = [];
      for (const other of this.#claims.values()) {
        if (other.status !== "active") continue;
        if (other.workspaceIdentity !== workspaceIdentity) continue;
        if (excludeAgentId !== undefined && other.agentId === excludeAgentId) continue;
        const overlapping = other.paths.find((path) => this.#overlaps(candidate, path));
        if (overlapping === undefined) continue;
        holders.push({
          claimId: other.id,
          agentId: other.agentId,
          parentAgentId: other.parentAgentId,
          profile: other.profile,
          intent: other.intent,
          path: overlapping,
          startedAt: other.startedAt,
          heartbeatAt: other.heartbeatAt,
        });
      }
      if (holders.length === 0) continue;
      conflicts.push({
        path: candidate,
        kind: holders.some((holder) => this.#isSamePath(candidate, holder.path))
          ? "same-file"
          : "directory-overlap",
        holders,
      });
    }
    return conflicts;
  }

  #collectSimilarIntents(lookup: IntentLookup): WorkIntentWarning[] {
    const normalized = normalizeIntent(lookup.intent);
    const tokens = intentTokens(lookup.intent);
    const warnings: WorkIntentWarning[] = [];
    for (const claim of this.#claims.values()) {
      if (claim.status !== "active") continue;
      if (claim.workspaceIdentity !== lookup.workspaceIdentity) continue;
      if (lookup.excludeAgentId !== undefined && claim.agentId === lookup.excludeAgentId) continue;
      if (lookup.paths !== undefined && lookup.paths.length > 0) {
        const overlaps = lookup.paths.some((path) =>
          claim.paths.some((claimPath) => this.#overlaps(path, claimPath)),
        );
        if (!overlaps) continue;
      }

      const claimNormalized = normalizeIntent(claim.intent);
      let kind: WorkIntentSimilarity | undefined;
      let sharedTokens: string[] = [];
      if (claimNormalized === normalized) {
        kind = "identical";
        sharedTokens = tokens;
      } else {
        const claimTokens = new Set(intentTokens(claim.intent));
        sharedTokens = tokens.filter((token) => claimTokens.has(token));
        if (sharedTokens.length >= MIN_SHARED_INTENT_TOKENS) kind = "overlapping";
      }
      if (kind === undefined) continue;

      warnings.push({
        claim: snapshot(claim),
        kind,
        sharedTokens,
        message: `Этим уже занимается агент ${claim.agentId}: ${claim.intent}`,
      });
    }
    return warnings.sort((left, right) => left.claim.startedAt - right.claim.startedAt);
  }

  #overlaps(left: string, right: string): boolean {
    return pathsOverlap(left, right, { caseSensitive: this.#caseSensitivePaths });
  }

  #isSamePath(left: string, right: string): boolean {
    return this.#caseSensitivePaths ? left === right : left.toLowerCase() === right.toLowerCase();
  }

  /** Не блокирует вызывающего: события выстраиваются в последовательную цепочку. */
  #append(event: WorkLedgerEvent): void {
    const path = this.#journalPath;
    if (path === null) return;
    const line = `${JSON.stringify(event)}\n`;
    this.#writeChain = this.#writeChain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, "utf8");
      })
      .catch((error: unknown) => {
        this.#lastWriteError = error;
      });
  }
}

function snapshot(claim: WorkClaim): WorkClaim {
  return Object.freeze({ ...claim, paths: Object.freeze([...claim.paths]) }) as WorkClaim;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    throw new TypeError(`work ledger: ${field} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeClaimPaths(paths: readonly string[], workspacePath: string): string[] {
  const normalized = new Set<string>();
  for (const path of paths) {
    normalized.add(normalizeWorkspacePath(path, workspacePath));
  }
  return [...normalized].sort();
}

function toPosixPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function toAbsolutePosix(value: string, base: string): string {
  const posixish = toPosixPath(value);
  const absolute =
    posix.isAbsolute(posixish) || WINDOWS_ABSOLUTE_PATH.test(posixish)
      ? posixish
      : posix.join(base, posixish);
  return stripTrailingSlash(posix.normalize(absolute));
}

function stripTrailingSlash(value: string): string {
  if (/^[A-Za-z]:$/u.test(value)) return `${value}/`;
  if (value === "/" || /^[A-Za-z]:\/$/u.test(value)) return value;
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWorkLedgerEvent(line: string): WorkLedgerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.v !== WORK_LEDGER_JOURNAL_VERSION) return null;
  if (!isFiniteNumber(value.at)) return null;

  if (value.type === "claim") {
    const claim = parseWorkClaim(value.claim);
    if (claim === null) return null;
    return { v: WORK_LEDGER_JOURNAL_VERSION, type: "claim", at: value.at, claim };
  }
  if (typeof value.claimId !== "string" || value.claimId.length === 0) return null;
  if (value.type === "heartbeat") {
    return { v: WORK_LEDGER_JOURNAL_VERSION, type: "heartbeat", at: value.at, claimId: value.claimId };
  }
  if (value.type === "release") {
    if (value.status !== "released" && value.status !== "stale") return null;
    return {
      v: WORK_LEDGER_JOURNAL_VERSION,
      type: "release",
      at: value.at,
      claimId: value.claimId,
      status: value.status,
    };
  }
  return null;
}

function parseWorkClaim(value: unknown): WorkClaim | null {
  if (!isRecord(value)) return null;
  const { id, workspaceIdentity, workspacePath, agentId, intent, status } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof workspaceIdentity !== "string" || workspaceIdentity.length === 0) return null;
  if (typeof workspacePath !== "string" || workspacePath.length === 0) return null;
  if (typeof agentId !== "string" || agentId.length === 0) return null;
  if (typeof intent !== "string" || intent.length === 0) return null;
  if (status !== "active" && status !== "released" && status !== "stale") return null;
  if (!isFiniteNumber(value.startedAt) || !isFiniteNumber(value.heartbeatAt)) return null;
  if (!Array.isArray(value.paths) || !value.paths.every((path) => typeof path === "string")) {
    return null;
  }
  const parentAgentId = typeof value.parentAgentId === "string" ? value.parentAgentId : null;
  const profile = typeof value.profile === "string" ? value.profile : null;
  return {
    id,
    workspaceIdentity,
    workspacePath,
    agentId,
    parentAgentId,
    profile,
    intent,
    paths: [...value.paths],
    startedAt: value.startedAt,
    heartbeatAt: value.heartbeatAt,
    status,
  };
}
