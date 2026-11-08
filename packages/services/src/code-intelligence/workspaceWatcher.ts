import { extname, relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { CodeWorkspaceRef } from "./contract.js";

const INDEXED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const WATCH_IGNORED_DIRECTORIES = new Set([
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
  "target",
  "generated",
]);

interface WatchEntry {
  root: string;
  watcher: FSWatcher;
  ready: Promise<void>;
  resolveReady: () => void;
  failed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Host-only watcher registry; callbacks receive identity-scoped workspace refs, never file text. */
export function createWorkspaceWatcherRegistry(options: {
  onChange: (workspace: CodeWorkspaceRef) => void;
  onError: (workspace: CodeWorkspaceRef) => void;
  onReady?: (workspace: CodeWorkspaceRef) => void;
  debounceMs?: number;
}) {
  const entries = new Map<string, WatchEntry>();

  const isIndexInput = (root: string, filePath: string): boolean => {
    const localPath = relative(root, filePath).split(sep).join("/");
    if (!localPath || localPath.startsWith("../") || localPath === "..") return false;
    const segments = localPath.split("/");
    if (segments.some((segment) => WATCH_IGNORED_DIRECTORIES.has(segment))) return false;
    const baseName = segments.at(-1) ?? "";
    return (
      INDEXED_EXTENSIONS.has(extname(baseName).toLowerCase()) ||
      baseName === ".gitignore" ||
      baseName === ".zcodeignore" ||
      baseName === "package.json"
    );
  };

  const ensure = async (identityKey: string, root: string, workspace: CodeWorkspaceRef) => {
    const existing = entries.get(identityKey);
    if (existing && existing.root === root && !existing.failed) {
      await existing.ready;
      return false;
    }
    if (existing) await stop(identityKey);

    const watcher = watch(root, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      ignored: (path) => {
        const localPath = relative(root, path).split(sep).join("/");
        return localPath
          .split("/")
          .some((segment) => WATCH_IGNORED_DIRECTORIES.has(segment));
      },
    });
    let resolveReady!: () => void;
    const entry: WatchEntry = {
      root,
      watcher,
      ready: new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
      resolveReady: () => resolveReady(),
      failed: false,
    };
    entries.set(identityKey, entry);
    watcher.on("all", (event, filePath) => {
      if (event === "addDir" || event === "unlinkDir" || !isIndexInput(root, filePath)) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        options.onChange(workspace);
      }, options.debounceMs ?? 300);
    });
    watcher.once("ready", () => {
      if (!entry.failed) options.onReady?.(workspace);
      resolveReady();
    });
    watcher.on("error", () => {
      if (!entry.failed) options.onError(workspace);
      entry.failed = true;
      resolveReady();
    });
    await entry.ready;
    return true;
  };

  const stop = async (identityKey: string) => {
    const entry = entries.get(identityKey);
    if (!entry) return;
    entries.delete(identityKey);
    entry.resolveReady();
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    await entry.watcher.close();
  };

  const disposeAllAndWait = async () => {
    await Promise.all([...entries.keys()].map((identityKey) => stop(identityKey)));
  };

  return {
    ensure,
    stop,
    disposeAll() {
      for (const identityKey of entries.keys()) void stop(identityKey).catch(() => {});
    },
    disposeAllAndWait,
  };
}
