// ============================================================
// Workspace Facts Cache - единственный владелец персистентного снимка
// ============================================================
//
// Схема и правила: docs/specs/workspace-facts-cache.md
// Один путь записи: temp-file + rename в <cacheRoot>/<digest>.json.
// Один путь чтения: loadEntry. Конкурентные resolve дедуплицируются по файлу.

import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger, ProjectContext, WorkspaceFacts } from "@zcode/contracts";
import {
  fingerprintWorkspaceInputs,
  probeWorkspaceInputs,
  type WorkspaceFactsIo,
  type WorkspaceGitFacts,
  type WorkspaceInputFile,
  type WorkspaceInputProbe,
  type WorkspaceInputSnapshot,
  nodeWorkspaceFactsIo,
} from "./workspace-facts.js";

export const WORKSPACE_FACTS_CACHE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_WORKSPACE_FACTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_ENTRY_FILES = 128;
const MAX_ENTRY_SCRIPTS = 500;
const MAX_ENTRY_CLASSIFICATIONS = 500;
const MAX_ENTRY_VERIFIED_COMMANDS = 1000;
const MAX_ENTRY_STRING_LENGTH = 4096;
const RENAME_RETRY_DELAYS_MS = [50, 100, 200] as const;

const PROJECT_TYPES = new Set(["node", "python", "rust", "go", "java", "unknown"]);
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);
const SCRIPT_KINDS = ["test", "lint", "typecheck", "build", "dev"] as const;
const SCRIPT_KIND_SET = new Set<string>(SCRIPT_KINDS);
const SCRIPT_MATCHED_BY = new Set(["name", "command"]);
const VERIFIED_COMMAND_STATUS = new Set(["unavailable", "recorded"]);

export interface WorkspaceFactsCacheEntry {
  schemaVersion: typeof WORKSPACE_FACTS_CACHE_SCHEMA_VERSION;
  identityKey: string;
  createdAt: string;
  updatedAt: string;
  runtime: WorkspaceFactsCacheRuntime;
  git: WorkspaceGitFacts;
  files: WorkspaceInputFile[];
  projectContext: ProjectContext;
}

export interface WorkspaceFactsCacheRuntime {
  node: string;
  platform: string;
  arch: string;
}

export interface WorkspaceFactsCacheInput {
  projectRoot: string;
  /** workspaceIdentity?.trim() || workspacePath?.trim() || projectRoot */
  identityKey: string;
  git: Pick<WorkspaceGitFacts, "dirty" | "dirtySignature">;
  runtime: WorkspaceFactsCacheRuntime;
}

export interface WorkspaceFactsCacheHooks {
  compute: (snapshot: WorkspaceInputSnapshot) => ProjectContext | Promise<ProjectContext>;
  fallback: () => ProjectContext | Promise<ProjectContext>;
}

export interface WorkspaceFactsCacheOptions {
  cacheRoot: string;
  ttlMs?: number;
  now?: () => number;
  io?: WorkspaceFactsIo;
  logger?: Pick<Logger, "debug" | "warn">;
}

/**
 * Персистентный кеш workspace facts. Не бросает ошибки кеша наружу: при сбое
 * чтения/записи/разбора вызывается fallback (текущий detectProjectContext).
 */
export class WorkspaceFactsCache {
  private readonly cacheRoot: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly io: WorkspaceFactsIo;
  private readonly logger: Pick<Logger, "debug" | "warn"> | undefined;
  private readonly inflight = new Map<string, Promise<ProjectContext>>();

  constructor(options: WorkspaceFactsCacheOptions) {
    this.cacheRoot = options.cacheRoot;
    this.ttlMs = options.ttlMs ?? DEFAULT_WORKSPACE_FACTS_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.io = options.io ?? nodeWorkspaceFactsIo;
    this.logger = options.logger;
  }

  filePathForIdentity(identityKey: string): string {
    const digest = createHash("sha256").update(identityKey).digest("hex").slice(0, 32);
    return join(this.cacheRoot, `${digest}.json`);
  }

  resolve(
    input: WorkspaceFactsCacheInput,
    hooks: WorkspaceFactsCacheHooks,
  ): Promise<ProjectContext> {
    const filePath = this.filePathForIdentity(input.identityKey);
    const existing = this.inflight.get(filePath);
    if (existing) return existing;
    const task = this.resolveWithCache(input, filePath, hooks);
    this.inflight.set(filePath, task);
    const settle = () => {
      if (this.inflight.get(filePath) === task) this.inflight.delete(filePath);
    };
    task.then(settle, settle);
    return task;
  }

  private async resolveWithCache(
    input: WorkspaceFactsCacheInput,
    filePath: string,
    hooks: WorkspaceFactsCacheHooks,
  ): Promise<ProjectContext> {
    const now = this.now();
    let entry: WorkspaceFactsCacheEntry | undefined;
    try {
      entry = await this.loadEntry(filePath, input.identityKey);
    } catch (error) {
      this.logger?.warn("workspace facts cache read failed; recomputing", {
        code: errorCode(error),
      });
    }

    try {
      const probe = await probeWorkspaceInputs(input.projectRoot, this.io);
      const git = mergeGitFacts(probe.git, input.git);
      const entryUsable =
        entry !== undefined &&
        entryMatches(entry, input.identityKey, input.runtime, git, now, this.ttlMs);

      // `entryUsable` — обычный boolean, поэтому TS не сужает `entry`;
      // явная проверка нужна и для доступа к полям, и для spread ниже.
      if (entry !== undefined && entryUsable && sameProbe(entry.files, probe.files)) {
        this.logger?.debug("workspace facts cache hit", { matchedBy: "stat" });
        return entry.projectContext;
      }

      const snapshot = await fingerprintWorkspaceInputs(input.projectRoot, probe, this.io);
      snapshot.git = git;

      if (entry !== undefined && entryUsable && sameFingerprint(entry.files, snapshot.files)) {
        const refreshed: WorkspaceFactsCacheEntry = {
          ...entry,
          files: snapshot.files,
          updatedAt: new Date(now).toISOString(),
        };
        await this.writeEntry(filePath, refreshed).catch((error: unknown) => {
          this.logger?.warn("workspace facts cache refresh failed", { code: errorCode(error) });
        });
        this.logger?.debug("workspace facts cache hit", { matchedBy: "hash" });
        return refreshed.projectContext;
      }

      const projectContext = await hooks.compute(snapshot);
      const nextEntry: WorkspaceFactsCacheEntry = {
        schemaVersion: WORKSPACE_FACTS_CACHE_SCHEMA_VERSION,
        identityKey: input.identityKey,
        createdAt: entry?.createdAt ?? new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        runtime: input.runtime,
        git,
        files: snapshot.files,
        projectContext,
      };
      await this.writeEntry(filePath, nextEntry).catch((error: unknown) => {
        this.logger?.warn("workspace facts cache write failed", { code: errorCode(error) });
      });
      this.logger?.debug("workspace facts cache miss", { matchedBy: "recompute" });
      return projectContext;
    } catch (error) {
      this.logger?.warn("workspace facts cache unavailable; using uncached detection", {
        code: errorCode(error),
      });
      return hooks.fallback();
    }
  }

  private async loadEntry(
    filePath: string,
    expectedIdentityKey: string,
  ): Promise<WorkspaceFactsCacheEntry | undefined> {
    let raw: Buffer;
    try {
      raw = await this.io.readFile(filePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      this.logger?.warn("workspace facts cache entry is not valid JSON; recomputing", {
        code: "ERR_INVALID_JSON",
      });
      return undefined;
    }
    return parseEntry(parsed, expectedIdentityKey);
  }

  private async writeEntry(filePath: string, entry: WorkspaceFactsCacheEntry): Promise<void> {
    const directory = dirname(filePath);
    await this.io.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      directory,
      `.${basename(filePath)}.${process.pid}.${this.now()}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await this.io.writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await this.renameWithRetry(temporaryPath, filePath);
    } catch (error) {
      await this.io.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.io.rename(from, to);
        return;
      } catch (error) {
        const retryable =
          isNodeError(error, "EPERM") ||
          isNodeError(error, "EACCES") ||
          isNodeError(error, "EBUSY");
        const retryDelay = RENAME_RETRY_DELAYS_MS[attempt];
        if (!retryable || retryDelay === undefined) throw error;
        await delay(retryDelay);
      }
    }
  }
}

function mergeGitFacts(
  probe: { head?: string; indexSignature?: string },
  hint: Pick<WorkspaceGitFacts, "dirty" | "dirtySignature">,
): WorkspaceGitFacts {
  // Bugfix: head обязан входить в ключ записи — иначе смена HEAD при неизменных
  // stat входов отдавала бы stale snapshot (и provenance терял gitHead).
  const dirtySignature = hint.dirtySignature ?? probe.indexSignature;
  return {
    ...(probe.head !== undefined ? { head: probe.head } : {}),
    ...(hint.dirty !== undefined ? { dirty: hint.dirty } : {}),
    ...(dirtySignature !== undefined ? { dirtySignature } : {}),
  };
}

function entryMatches(
  entry: WorkspaceFactsCacheEntry,
  identityKey: string,
  runtime: WorkspaceFactsCacheRuntime,
  git: WorkspaceGitFacts,
  now: number,
  ttlMs: number,
): boolean {
  if (entry.identityKey !== identityKey) return false;
  if (
    entry.runtime.node !== runtime.node ||
    entry.runtime.platform !== runtime.platform ||
    entry.runtime.arch !== runtime.arch
  ) {
    return false;
  }
  const updatedAt = Date.parse(entry.updatedAt);
  if (!Number.isFinite(updatedAt) || now - updatedAt > ttlMs) return false;
  if (entry.git.head !== git.head) return false;
  if (entry.git.dirty !== git.dirty) return false;
  return entry.git.dirtySignature === git.dirtySignature;
}

function sameProbe(
  stored: readonly WorkspaceInputFile[],
  current: readonly WorkspaceInputProbe[],
): boolean {
  if (stored.length !== current.length) return false;
  for (let index = 0; index < stored.length; index += 1) {
    const left = stored[index];
    const right = current[index];
    if (!left || !right) return false;
    if (
      left.path !== right.path ||
      left.exists !== right.exists ||
      left.mtimeMs !== right.mtimeMs ||
      left.size !== right.size
    ) {
      return false;
    }
  }
  return true;
}

function sameFingerprint(
  stored: readonly WorkspaceInputFile[],
  current: readonly WorkspaceInputFile[],
): boolean {
  if (stored.length !== current.length) return false;
  for (let index = 0; index < stored.length; index += 1) {
    const left = stored[index];
    const right = current[index];
    if (!left || !right) return false;
    if (left.path !== right.path || left.exists !== right.exists || left.sha256 !== right.sha256) {
      return false;
    }
  }
  return true;
}

function parseEntry(
  value: unknown,
  expectedIdentityKey: string,
): WorkspaceFactsCacheEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== WORKSPACE_FACTS_CACHE_SCHEMA_VERSION) return undefined;
  if (value.identityKey !== expectedIdentityKey) return undefined;
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) return undefined;
  if (!isCacheRuntime(value.runtime)) return undefined;
  const git = parseGitFacts(value.git);
  if (!git) return undefined;
  const files = parseInputFiles(value.files);
  if (!files) return undefined;
  if (!isProjectContext(value.projectContext)) return undefined;
  return {
    schemaVersion: WORKSPACE_FACTS_CACHE_SCHEMA_VERSION,
    identityKey: expectedIdentityKey,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    runtime: value.runtime,
    git,
    files,
    projectContext: value.projectContext,
  };
}

function isCacheRuntime(value: unknown): value is WorkspaceFactsCacheRuntime {
  return (
    isRecord(value) &&
    isShortString(value.node) &&
    isShortString(value.platform) &&
    isShortString(value.arch)
  );
}

function parseGitFacts(value: unknown): WorkspaceGitFacts | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  if (value.head !== undefined && !isShortString(value.head)) return undefined;
  if (value.dirty !== undefined && typeof value.dirty !== "boolean") return undefined;
  if (value.dirtySignature !== undefined && !isShortString(value.dirtySignature)) return undefined;
  return {
    ...(value.head !== undefined ? { head: value.head } : {}),
    ...(value.dirty !== undefined ? { dirty: value.dirty } : {}),
    ...(value.dirtySignature !== undefined ? { dirtySignature: value.dirtySignature } : {}),
  };
}

function parseInputFiles(value: unknown): WorkspaceInputFile[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ENTRY_FILES) return undefined;
  const files: WorkspaceInputFile[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    if (!isShortString(item.path) || item.path.includes("..")) return undefined;
    if (typeof item.exists !== "boolean") return undefined;
    if (typeof item.mtimeMs !== "number" || !Number.isFinite(item.mtimeMs)) return undefined;
    if (typeof item.size !== "number" || !Number.isFinite(item.size)) return undefined;
    if (item.sha256 !== null && !isShortString(item.sha256)) return undefined;
    files.push({
      path: item.path,
      exists: item.exists,
      mtimeMs: item.mtimeMs,
      size: item.size,
      sha256: item.sha256,
    });
  }
  return files;
}

function isProjectContext(value: unknown): value is ProjectContext {
  if (!isRecord(value)) return false;
  if (typeof value.type !== "string" || !PROJECT_TYPES.has(value.type)) return false;
  if (
    value.packageManager !== undefined &&
    (typeof value.packageManager !== "string" || !PACKAGE_MANAGERS.has(value.packageManager))
  ) {
    return false;
  }
  if (value.scripts !== undefined && !isStringRecord(value.scripts, MAX_ENTRY_SCRIPTS))
    return false;
  if (value.buildFiles !== undefined && !isStringArray(value.buildFiles)) return false;
  if (value.workspaceFacts !== undefined && !isWorkspaceFacts(value.workspaceFacts)) return false;
  return true;
}

function isWorkspaceFacts(value: unknown): value is WorkspaceFacts {
  if (!isRecord(value)) return false;
  if (!isClassifiedScripts(value.classifiedScripts)) return false;
  if (!isMonorepoFacts(value.monorepo)) return false;
  if (!isToolchainFacts(value.toolchain)) return false;
  if (
    !Array.isArray(value.verifiedCommands) ||
    value.verifiedCommands.length > MAX_ENTRY_VERIFIED_COMMANDS
  ) {
    return false;
  }
  if (!value.verifiedCommands.every(isVerifiedCommand)) return false;
  if (typeof value.verifiedCommandsStatus !== "string") return false;
  if (!VERIFIED_COMMAND_STATUS.has(value.verifiedCommandsStatus)) return false;
  if (!isProvenance(value.provenance)) return false;
  return true;
}

function isClassifiedScripts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const kind of SCRIPT_KINDS) {
    const list = value[kind];
    if (!Array.isArray(list) || list.length > MAX_ENTRY_CLASSIFICATIONS) return false;
    for (const item of list) {
      if (!isRecord(item)) return false;
      if (!isShortString(item.name) || !isShortString(item.command)) return false;
      if (typeof item.kind !== "string" || !SCRIPT_KIND_SET.has(item.kind)) return false;
      if (typeof item.matchedBy !== "string" || !SCRIPT_MATCHED_BY.has(item.matchedBy))
        return false;
    }
  }
  return true;
}

function isMonorepoFacts(value: unknown): boolean {
  if (!isRecord(value) || typeof value.isMonorepo !== "boolean") return false;
  return value.workspaces === undefined || isStringArray(value.workspaces);
}

function isToolchainFacts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of ["node", "nodeRuntime", "packageManager"]) {
    if (value[key] !== undefined && !isShortString(value[key])) return false;
  }
  if (value.mise !== undefined && !isStringRecord(value.mise, 64)) return false;
  if (value.engines !== undefined && !isStringRecord(value.engines, 16)) return false;
  return true;
}

function isVerifiedCommand(value: unknown): boolean {
  return (
    isRecord(value) &&
    isShortString(value.command) &&
    isShortString(value.source) &&
    isIsoTimestamp(value.verifiedAt) &&
    (value.exitCode === undefined || typeof value.exitCode === "number")
  );
}

function isProvenance(value: unknown): boolean {
  if (!isRecord(value) || !isIsoTimestamp(value.computedAt)) return false;
  if (value.gitHead !== undefined && !isShortString(value.gitHead)) return false;
  if (value.gitDirty !== undefined && typeof value.gitDirty !== "boolean") return false;
  if (!Array.isArray(value.inputs) || value.inputs.length > MAX_ENTRY_FILES) return false;
  for (const input of value.inputs) {
    if (!isRecord(input) || !isShortString(input.path)) return false;
    if (input.sha256 !== undefined && !isShortString(input.sha256)) return false;
  }
  return true;
}

function isStringRecord(value: unknown, maxEntries: number): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > maxEntries) return false;
  return entries.every(([key, entry]) => isShortString(key) && isShortString(entry));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ENTRY_FILES && value.every(isShortString);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ENTRY_STRING_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown";
}
