import { extname, resolve } from "node:path";
import { statSync, watch, type FSWatcher } from "node:fs";
import { INDEXED_EXTENSIONS } from "./ast/languageRegistry.js";
import type { CodeWorkspaceRef } from "./contract.js";

/**
 * Watcher изменений workspace на нативном рекурсивном `node:fs.watch`.
 *
 * Почему не `chokidar`: chokidar 4 ставит отдельный `fs.watch` на каждый файл. На macOS
 * kqueue открывает по одному дескриптору на каждый наблюдаемый файл, поэтому workspace
 * на 10k+ файлов выбивает `RLIMIT_NOFILE` процесса Host. После этого `spawn` любого
 * дочернего процесса (Agent CLI, git) падает с `EBADF`, а создание draft-сессии в UI
 * показывает «草稿会话创建失败». Рекурсивный `fs.watch` использует одну подписку
 * (FSEvents/ReadDirectoryChangesW, на Linux — каталоговый fallback Node), поэтому число
 * дескрипторов не зависит от количества файлов.
 *
 * События фильтруются по тем же статическим правилам, что и раньше: исключённые
 * каталоги, бинарники, `.env`, `.min.js` и карты не планируют индексацию. Неизвестный
 * путь или каталог помечают batch как `overflow` — сервис делает полный проход.
 */

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
  /**
   * Инъекция для тестов. Продакшен всегда использует `node:fs.watch` с `recursive: true`;
   * вызывающая сторона не может подменить его на per-file watcher.
   */
  watchFactory?: RecursiveWatchFactory;
}

type WatchEventType = "rename" | "change";
type WatchListener = (eventType: WatchEventType, filename: string | null) => void;
export type RecursiveWatchFactory = (
  path: string,
  options: { recursive: true; persistent: true },
  listener: WatchListener,
) => FSWatcher;

interface WatchEntry {
  root: string;
  watcher: FSWatcher;
  workspace: CodeWorkspaceRef;
  pendingChanged: Set<string>;
  pendingRemoved: Set<string>;
  overflow: boolean;
  timer?: ReturnType<typeof setTimeout>;
  failed: boolean;
  /** Резолвится сразу после установки подписки: рекурсивный watch не делает обход дерева. */
  ready: Promise<void>;
}

function normalizeEventPath(rawPath: string): string | null {
  const normalized = rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
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
 * Один рекурсивный watcher на workspace независимо от количества окон и сессий.
 */
export function createWorkspaceWatcherRegistry(options: WorkspaceWatcherOptions) {
  const entries = new Map<string, WatchEntry>();
  const debounceMs = options.debounceMs ?? 500;
  const watchFactory: RecursiveWatchFactory = options.watchFactory ?? watch;

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

  const queueOverflow = (entry: WatchEntry): void => {
    entry.overflow = true;
    schedule(entry);
  };

  const handleEvent = (
    entry: WatchEntry,
    eventType: WatchEventType,
    rawFilename: string | null,
  ): void => {
    if (entry.failed) return;
    if (rawFilename === null) {
      // Платформа не сообщила путь: точечный инкремент невозможен, только полный проход.
      queueOverflow(entry);
      return;
    }
    const relPath = normalizeEventPath(rawFilename);
    if (!relPath) {
      queueOverflow(entry);
      return;
    }
    // Исключённые каталоги и файлы не индексируются и не должны планировать работу.
    if (isIgnoredPath(relPath)) return;

    const absolutePath = resolve(entry.root, relPath);
    let stats: ReturnType<typeof statSync> | undefined;
    try {
      stats = statSync(absolutePath);
    } catch {
      stats = undefined;
    }

    if (stats?.isDirectory()) {
      // Новый/переименованный каталог может содержать готовые файлы (git checkout, распаковка).
      queueOverflow(entry);
      return;
    }

    if (eventType === "change") {
      if (!isIndexable(relPath)) return;
      if (!stats) {
        entry.pendingChanged.delete(relPath);
        entry.pendingRemoved.add(relPath);
      } else {
        entry.pendingRemoved.delete(relPath);
        entry.pendingChanged.add(relPath);
      }
      schedule(entry);
      return;
    }

    // rename: создание, замена на месте, удаление или перенос.
    if (stats) {
      if (!isIndexable(relPath)) return;
      entry.pendingRemoved.delete(relPath);
      entry.pendingChanged.add(relPath);
      schedule(entry);
      return;
    }

    if (isIndexable(relPath)) {
      entry.pendingChanged.delete(relPath);
      entry.pendingRemoved.add(relPath);
      schedule(entry);
      return;
    }
    // Путь исчез и не является индексируемым файлом: это может быть удалённый каталог
    // (в том числе с точкой в имени) или extensionless-файл. Надёжнее сделать полный проход,
    // но бинарники/карты и прочие явно неиндексируемые расширения не трогают индекс.
    if (extname(relPath) === "") queueOverflow(entry);
  };

  const stop = async (workspace: CodeWorkspaceRef | string): Promise<void> => {
    const identityKey = typeof workspace === "string" ? workspace : keyOf(workspace);
    const entry = entries.get(identityKey);
    if (!entry) return;
    entries.delete(identityKey);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    try {
      entry.watcher.close();
    } catch {
      // Закрытие уже упавшего watcher'а безопасно игнорировать.
    }
  };

  const ensure = async (workspace: CodeWorkspaceRef): Promise<boolean> => {
    const identityKey = keyOf(workspace);
    const root = resolve(workspace.workspacePath);
    const existing = entries.get(identityKey);
    if (existing && existing.root === root && !existing.failed) {
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
      ready: new Promise<void>((resolveReady) => {
        markReady = resolveReady;
      }),
    };

    try {
      entry.watcher = watchFactory(
        root,
        { recursive: true, persistent: true },
        (eventType, filename) => handleEvent(entry, eventType, filename),
      );
    } catch (error) {
      // Платформа не умеет рекурсивный watch: сообщаем явно и оставляем ручной Refresh,
      // не откатываясь на per-file/per-directory подписки (они и выбивают дескрипторы).
      entry.failed = true;
      entries.set(identityKey, entry);
      markReady();
      options.onError(workspace, error instanceof Error ? error : new Error(String(error)));
      return false;
    }

    entry.watcher.on("error", (error: unknown) => {
      const normalised = error instanceof Error ? error : new Error(String(error));
      if (!entry.failed) options.onError(workspace, normalised);
      entry.failed = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      try {
        entry.watcher.close();
      } catch {
        // Ошибка закрытия уже сломанного watcher'а не меняет диагностику.
      }
    });

    entries.set(identityKey, entry);
    markReady();
    options.onReady?.(workspace);
    return true;
  };

  /** Точный сигнал из `FileTransactionManager` — немедленный инкремент без ожидания дебаунса. */
  const notifyMutated = (workspace: CodeWorkspaceRef, paths: readonly string[]): void => {
    const identityKey = keyOf(workspace);
    const entry = entries.get(identityKey);
    if (!entry || entry.failed) return;
    let queued = false;
    for (const raw of paths) {
      const relPath = normalizeEventPath(raw);
      if (!relPath) continue;
      if (!isIndexable(relPath)) continue;
      entry.pendingRemoved.delete(relPath);
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
