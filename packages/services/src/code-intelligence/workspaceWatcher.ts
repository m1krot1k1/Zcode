import { extname, relative, resolve, sep } from "node:path";
import type { FSWatcher } from "node:fs";
import chokidar from "chokidar";
import { INDEXED_EXTENSIONS } from "./ast/languageRegistry.js";
import type { CodeWorkspaceRef } from "./contract.js";

/**
 * Watcher изменений workspace на `chokidar@4.0.3`.
 *
 * Решаемые проблемы v1 (`fs.watch({ recursive: true })`):
 *  - на Linux `recursive` не поддерживается ядром одинаково: часть событий терялась, а
 *    дерево `node_modules` давало поток бесполезных событий;
 *  - не было пре-фильтрации до постановки watch, поэтому inotify-лимит выбивался на больших
 *    проектах (`ENOSPC`);
 *  - не различались create/modify/delete/rename, из-за чего инкрементальное обновление
 *    сводилось к полному rescану.
 *
 * Здесь: `ignored` пре-фильтрует директории до подписки, события коалесцируются дебаунсом
 * `500 мс`, а переполнение (переименование/массовые git-операции) поднимает флаг
 * `overflow`, по которому Host делает полный проход.
 */

/** Верхняя граница ожидания первичного обхода: большой workspace не должен вешать подписку. */
const READY_TIMEOUT_MS = 10_000;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".zcode",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "generated",
]);

const IGNORED_FILE_PATTERNS = [
  /\.min\.js$/u,
  /\.map$/u,
  /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|mp4|webm|woff2?|ttf|otf)$/iu,
  /(?:^|\/)\.env(?:\..*)?$/u,
  /(?:^|\/)[^/]*secret[^/]*$/iu,
];

export interface WatcherChangeBatch {
  changed: string[];
  removed: string[];
  /** Переполнение: нужен полный проход, точечных путей недостаточно. */
  overflow: boolean;
}

export interface WorkspaceWatcherOptions {
  debounceMs?: number;
  onChange: (workspace: CodeWorkspaceRef, batch: WatcherChangeBatch) => void;
  onError: (workspace: CodeWorkspaceRef, error: Error) => void;
  onReady?: (workspace: CodeWorkspaceRef) => void;
}

interface WatchEntry {
  root: string;
  watcher: FSWatcher | ReturnType<typeof chokidar.watch>;
  workspace: CodeWorkspaceRef;
  pendingChanged: Set<string>;
  pendingRemoved: Set<string>;
  overflow: boolean;
  timer?: ReturnType<typeof setTimeout>;
  failed: boolean;
  /** Резолвится по событию `ready` — первичный обход дерева завершён. */
  ready: Promise<void>;
}

function relativePathOf(root: string, absolutePath: string): string | null {
  const local = relative(root, absolutePath).split(sep).join("/");
  if (!local || local.startsWith("../") || local === "..") return null;
  return local;
}

function isIgnoredPath(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return true;
  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(relPath));
}

function isIndexable(relPath: string): boolean {
  if (isIgnoredPath(relPath)) return false;
  const extension = extname(relPath).toLowerCase();
  return INDEXED_EXTENSIONS.includes(extension);
}

/**
 * Реестр watcher'ов, ключ — `workspaceIdentity?.trim() || workspacePath`.
 * Один watcher на workspace независимо от количества окон и сессий.
 */
export function createWorkspaceWatcherRegistry(options: WorkspaceWatcherOptions) {
  const entries = new Map<string, WatchEntry>();
  const debounceMs = options.debounceMs ?? 500;

  const keyOf = (workspace: CodeWorkspaceRef): string =>
    workspace.workspaceIdentity?.trim() || workspace.workspacePath;

  const flush = (identityKey: string): void => {
    const entry = entries.get(identityKey);
    if (!entry || entry.failed) return;
    const changed = [...entry.pendingChanged];
    const removed = [...entry.pendingRemoved];
    const overflow = entry.overflow;
    entry.pendingChanged.clear();
    entry.pendingRemoved.clear();
    entry.overflow = false;
    if (!overflow && changed.length === 0 && removed.length === 0) return;
    options.onChange(entry.workspace, { changed, removed, overflow });
  };

  const schedule = (entry: WatchEntry): void => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      flush(keyOf(entry.workspace));
    }, debounceMs);
    // Дебаунс не должен удерживать процесс Host'а при выходе.
    if (typeof entry.timer.unref === "function") entry.timer.unref();
  };

  const stop = async (workspace: CodeWorkspaceRef | string): Promise<void> => {
    const identityKey = typeof workspace === "string" ? workspace : keyOf(workspace);
    const entry = entries.get(identityKey);
    if (!entry) return;
    entries.delete(identityKey);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    try {
      await entry.watcher.close();
    } catch {
      // Закрытие уже упавшего watcher'а безопасно игнорировать.
    }
  };

  const ensure = async (workspace: CodeWorkspaceRef): Promise<boolean> => {
    const identityKey = keyOf(workspace);
    const root = resolve(workspace.workspacePath);
    const existing = entries.get(identityKey);
    if (existing && existing.root === root && !existing.failed) {
      // Повторная подписка должна дождаться готовности, а не сообщать о ней раньше времени.
      await existing.ready;
      return false;
    }
    if (existing) await stop(identityKey);

    let markReady: () => void = () => undefined;
    const entry: WatchEntry = {
      root,
      workspace,
      watcher: undefined as unknown as FSWatcher,
      pendingChanged: new Set(),
      pendingRemoved: new Set(),
      overflow: false,
      failed: false,
      // Причина отдельного промиса: `chokidar.watch` синхронен, но первичный обход дерева
      // асинхронен. Пока он идёт, `ignoreInitial` глушит события, и файлы, созданные сразу
      // после `watchWorkspace`, терялись — индекс расходился с диском до следующего события.
      ready: new Promise<void>((resolveReady) => {
        markReady = resolveReady;
      }),
    };

    if (typeof chokidar.watch !== "function") {
      // chokidar отсутствует в рантайме: сообщаем явно, а не имитируем наблюдение.
      entry.failed = true;
      entries.set(identityKey, entry);
      options.onError(workspace, new Error("chokidar is unavailable in this runtime."));
      return false;
    }

    const watcher = chokidar.watch(root, {
      // Пре-фильтрация до постановки inotify-watch: исключённые каталоги не обходятся.
      ignored: (candidatePath: string) => {
        const relPath = relativePathOf(root, candidatePath);
        if (relPath === null) return false;
        if (relPath === "") return false;
        return (
          isIgnoredPath(relPath) && !INDEXED_EXTENSIONS.includes(extname(relPath).toLowerCase())
        );
      },
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      // Замена на месте и атомарные переименования (git checkout) приходят как change.
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 60 },
    });

    watcher.on("add", (path: string) => {
      const relPath = relativePathOf(root, path);
      if (!relPath || !isIndexable(relPath)) return;
      entry.pendingRemoved.delete(relPath);
      entry.pendingChanged.add(relPath);
      schedule(entry);
    });
    watcher.on("change", (path: string) => {
      const relPath = relativePathOf(root, path);
      if (!relPath || !isIndexable(relPath)) return;
      entry.pendingChanged.add(relPath);
      schedule(entry);
    });
    watcher.on("unlink", (path: string) => {
      const relPath = relativePathOf(root, path);
      if (!relPath) {
        entry.overflow = true;
        schedule(entry);
        return;
      }
      // Удалённый путь нельзя проверить по расширению через fs — опираемся на имя.
      if (!isIndexable(relPath) && extname(relPath) !== "") return;
      entry.pendingChanged.delete(relPath);
      entry.pendingRemoved.add(relPath);
      schedule(entry);
    });
    watcher.on("addDir", () => {
      // Новый каталог может содержать готовые файлы (git checkout, распаковка архива).
      entry.overflow = true;
      schedule(entry);
    });
    watcher.on("raw", (event: string, path: string) => {
      // Причина: `rename(2)` на Linux не всегда даёт `unlink` для старого пути, особенно при
      // атомарной замене. Без этого переименованный файл оставался в индексе как «фантом».
      // Поэтому `rename` трактуется как переполнение: полный проход точечно вычистит исчезнувшие.
      if (event !== "rename") return;
      const relPath = relativePathOf(root, path);
      if (!relPath || !isIgnoredPath(relPath)) return;
      entry.overflow = true;
      schedule(entry);
    });
    watcher.on("unlinkDir", () => {
      entry.overflow = true;
      schedule(entry);
    });
    watcher.on("error", (error: unknown) => {
      const normalised = error instanceof Error ? error : new Error(String(error));
      if (!entry.failed) options.onError(workspace, normalised);
      entry.failed = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      void watcher.close().catch(() => undefined);
    });
    watcher.on("ready", () => {
      markReady();
      options.onReady?.(workspace);
    });

    entry.watcher = watcher;
    entries.set(identityKey, entry);
    // Ожидание ограничено: при ошибке watcher помечается `failed` и промис всё равно закроется,
    // иначе подписка зависла бы навсегда на недоступном каталоге.
    await Promise.race([
      entry.ready,
      new Promise<void>((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, READY_TIMEOUT_MS);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    if (entry.failed) return false;
    return true;
  };

  /** Точный сигнал из `FileTransactionManager` — немедленный инкремент без ожидания дебаунса. */
  const notifyMutated = (workspace: CodeWorkspaceRef, paths: readonly string[]): void => {
    const identityKey = keyOf(workspace);
    const entry = entries.get(identityKey);
    if (!entry || entry.failed) return;
    let queued = false;
    for (const raw of paths) {
      const relPath = raw.replaceAll("\\", "/").replace(/^\.\//u, "");
      if (!relPath || relPath.startsWith("../")) continue;
      if (!isIndexable(relPath)) continue;
      entry.pendingChanged.add(relPath);
      queued = true;
    }
    if (queued) schedule(entry);
  };

  const disposeAllAndWait = async (): Promise<void> => {
    await Promise.all([...entries.keys()].map((identityKey) => stop(identityKey)));
  };

  return {
    ensure,
    stop,
    notifyMutated,
    has: (workspace: CodeWorkspaceRef): boolean => entries.has(keyOf(workspace)),
    disposeAll() {
      for (const identityKey of entries.keys()) void stop(identityKey).catch(() => undefined);
    },
    disposeAllAndWait,
  };
}

/** Экспорт для тестов: правила фильтрации должны проверяться напрямую. */
export { isIgnoredPath, isIndexable };
