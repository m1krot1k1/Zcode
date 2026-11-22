// ============================================================
// Workspace facts wiring - кеш и резолв project context
// ============================================================
//
// Связка NodeContextSourceAdapter с персистентным кешем workspace facts:
// создание кеша, derivation identity key, git-подпись и fail-open fallback.
// Модуль зависит только вниз: wiring -> workspace-facts-cache/workspace-facts.
// `context/index.ts` реэкспортирует адаптер и передаёт fallback явно,
// поэтому обратного импорта (wiring -> index) нет.

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { ContextSourceRequest, EnvInfo, Logger, ProjectContext } from "@zcode/contracts";
import { WorkspaceFactsCache, type WorkspaceFactsCacheRuntime } from "./workspace-facts-cache.js";
import { buildWorkspaceProjectContext, type WorkspaceFactsIo } from "./workspace-facts.js";

export interface WorkspaceFactsWiringOptions {
  env: NodeJS.ProcessEnv;
  /** `false` отключает персистентный кеш; undefined — дефолт из env. */
  workspaceFactsCacheRoot?: string | false;
  workspaceFactsTtlMs?: number;
  workspaceFactsIo?: WorkspaceFactsIo;
  now?: () => number;
  logger?: Pick<Logger, "debug" | "warn">;
}

export interface ResolveWorkspaceProjectContextOptions {
  cache: WorkspaceFactsCache | undefined;
  projectRoot: string;
  request: ContextSourceRequest;
  envInfo: EnvInfo;
  now: () => number;
  /** Текущее detectProjectContext: вызывается при отключённом кеше и как fail-open. */
  fallback: (projectRoot: string) => Promise<ProjectContext>;
}

/**
 * Создаёт кеш только когда cache root резолвится. Без него адаптер работает
 * напрямую через fallback (fail-open без записи в чужой home).
 */
export function createWorkspaceFactsCache(
  options: WorkspaceFactsWiringOptions,
): WorkspaceFactsCache | undefined {
  const cacheRoot = resolveWorkspaceFactsCacheRoot(options.env, options.workspaceFactsCacheRoot);
  if (!cacheRoot) return undefined;
  return new WorkspaceFactsCache({
    cacheRoot,
    now: options.now ?? Date.now,
    ...(options.workspaceFactsTtlMs !== undefined ? { ttlMs: options.workspaceFactsTtlMs } : {}),
    ...(options.workspaceFactsIo ? { io: options.workspaceFactsIo } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

/**
 * Единственная точка входа workspace facts: cache-hit не перечитывает
 * файлы-источники, miss считает и пишет одну запись. Ошибки кеша
 * fail-open к текущему detectProjectContext (передан как `fallback`).
 */
export async function resolveWorkspaceProjectContext(
  options: ResolveWorkspaceProjectContextOptions,
): Promise<ProjectContext> {
  const { cache, projectRoot, request, envInfo, fallback } = options;
  if (!cache) return fallback(projectRoot);

  const identityKey =
    request.workspaceIdentity?.trim() || request.workspacePath?.trim() || projectRoot;
  const git: { dirty?: boolean; dirtySignature?: string } = {};
  if (envInfo.gitStatus === "clean" || envInfo.gitStatus === "dirty") {
    git.dirty = envInfo.gitStatus === "dirty";
  }
  if (envInfo.gitStatus !== undefined) {
    const statusSource =
      envInfo.gitStatusLines && envInfo.gitStatusLines.length > 0
        ? envInfo.gitStatusLines.join("\n")
        : envInfo.gitStatus;
    git.dirtySignature = createHash("sha256").update(statusSource).digest("hex");
  }

  return cache.resolve(
    {
      projectRoot,
      identityKey,
      git,
      runtime: workspaceFactsRuntime(),
    },
    {
      compute: (snapshot) => buildWorkspaceProjectContext({ snapshot, now: options.now() }),
      fallback: () => fallback(projectRoot),
    },
  );
}

/**
 * Кеш пишется только когда домашняя директория явно есть в env адаптера.
 * Это исключает запись в реальный ~ из тестов/CLI без HOME и сохраняет fail-open.
 */
function resolveWorkspaceFactsCacheRoot(
  env: NodeJS.ProcessEnv,
  override: string | false | undefined,
): string | undefined {
  if (override === false) return undefined;
  if (typeof override === "string" && override.trim().length > 0) return resolve(override);
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!envHome) return undefined;
  return join(envHome, ".zcode", "v2", "cache", "workspace-facts");
}

function workspaceFactsRuntime(): WorkspaceFactsCacheRuntime {
  return { node: process.version, platform: process.platform, arch: process.arch };
}
