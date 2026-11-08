import { extname, relative, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "node:fs";
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

  const shouldRefresh = (root: string, event: string, filename: string | Buffer | null) => {
    // 修复依据：部分平台不会返回变更路径；保守刷新可以避免漏掉修改，现有防抖和索引合并会限制重复工作。
    if (filename === null) return true;
    const filePath = resolve(root, filename.toString());
    if (isIndexInput(root, filePath)) return true;
    if (event !== "rename") return false;

    const localPath = relative(root, filePath).split(sep).join("/");
    if (!localPath || localPath.startsWith("../") || localPath === "..") return false;
    const segments = localPath.split("/");
    if (segments.some((segment) => WATCH_IGNORED_DIRECTORIES.has(segment))) return false;
    // 目录重命名可能新增或删除其中的索引文件，因此需要刷新。
    return extname(segments.at(-1) ?? "") === "";
  };

  const ensure = async (identityKey: string, root: string, workspace: CodeWorkspaceRef) => {
    const existing = entries.get(identityKey);
    if (existing && existing.root === root && !existing.failed) {
      return false;
    }
    if (existing) await stop(identityKey);

    let watcher: FSWatcher;
    try {
      // 根因：Chokidar 会遍历目录树并为每个目录打开 watcher；大型 workspace 因此触发 EMFILE 并阻塞 Host RPC。
      // 修复：使用单个原生递归 watcher，不在注册前遍历整个目录树。
      watcher = watch(root, { recursive: true, persistent: true }, (event, filename) => {
        if (entry.failed || !shouldRefresh(root, event, filename)) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          options.onChange(workspace);
        }, options.debounceMs ?? 300);
      });
    } catch {
      options.onError(workspace);
      return false;
    }
    const entry: WatchEntry = { root, watcher, failed: false };
    entries.set(identityKey, entry);
    watcher.on("error", () => {
      if (!entry.failed) options.onError(workspace);
      entry.failed = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.watcher.close();
    });
    options.onReady?.(workspace);
    return true;
  };

  const stop = async (identityKey: string) => {
    const entry = entries.get(identityKey);
    if (!entry) return;
    entries.delete(identityKey);
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
