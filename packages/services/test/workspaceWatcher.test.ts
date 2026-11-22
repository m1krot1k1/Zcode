import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceWatcherRegistry,
  type RecursiveWatchFactory,
  type WatcherChangeBatch,
} from "../src/code-intelligence/workspaceWatcher.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-workspace-watcher-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

interface FakeWatch {
  factory: RecursiveWatchFactory;
  calls: Array<{
    path: string;
    options: { recursive: true; persistent: true };
    listener: (eventType: "rename" | "change", filename: string | null) => void;
  }>;
  watchers: FakeWatcher[];
}

function createFakeWatch(): FakeWatch {
  const calls: FakeWatch["calls"] = [];
  const watchers: FakeWatcher[] = [];
  const factory: RecursiveWatchFactory = (path, options, listener) => {
    const watcher = new FakeWatcher();
    calls.push({ path, options, listener });
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  };
  return { factory, calls, watchers };
}

function waitForDebounce(debounceMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, debounceMs + 25));
}

describe("code-intelligence workspace watcher", () => {
  it("arms one native recursive watcher and does not crawl or wait for readiness", async () => {
    const root = makeTempDir();
    writeFileSync(join(root, "a.ts"), "export const a = 1;");
    const watch = createFakeWatch();
    const onChange = vi.fn();
    const onReady = vi.fn();
    const registry = createWorkspaceWatcherRegistry({
      watchFactory: watch.factory,
      onChange,
      onError: vi.fn(),
      onReady,
    });
    const workspace = { workspacePath: root };

    await expect(registry.ensure(workspace)).resolves.toBe(true);
    await expect(registry.ensure(workspace)).resolves.toBe(false);

    expect(watch.calls).toHaveLength(1);
    expect(watch.calls[0]?.path).toBe(resolve(root));
    expect(watch.calls[0]?.options).toEqual({ recursive: true, persistent: true });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports a changed indexed file after the debounce window", async () => {
    const root = makeTempDir();
    writeFileSync(join(root, "src.ts"), "export const a = 1;");
    const watch = createFakeWatch();
    const batches: WatcherChangeBatch[] = [];
    const registry = createWorkspaceWatcherRegistry({
      watchFactory: watch.factory,
      debounceMs: 5,
      onChange: (_workspace, batch) => batches.push(batch),
      onError: vi.fn(),
    });
    await registry.ensure({ workspacePath: root });

    watch.calls[0]?.listener("change", "src.ts");
    await waitForDebounce(5);

    expect(batches).toEqual([{ changed: ["src.ts"], removed: [], overflow: false }]);
  });

  it("resolves rename into changed when the file exists and removed when it is gone", async () => {
    const root = makeTempDir();
    const file = join(root, "old.ts");
    writeFileSync(file, "export const old = 1;");
    const watch = createFakeWatch();
    const batches: WatcherChangeBatch[] = [];
    const registry = createWorkspaceWatcherRegistry({
      watchFactory: watch.factory,
      debounceMs: 5,
      onChange: (_workspace, batch) => batches.push(batch),
      onError: vi.fn(),
    });
    await registry.ensure({ workspacePath: root });

    watch.calls[0]?.listener("rename", "old.ts");
    await waitForDebounce(5);
    expect(batches).toEqual([{ changed: ["old.ts"], removed: [], overflow: false }]);

    unlinkSync(file);
    watch.calls[0]?.listener("rename", "old.ts");
    await waitForDebounce(5);
    expect(batches.at(-1)).toEqual({ changed: [], removed: ["old.ts"], overflow: false });
  });

  it("marks a created or removed directory as overflow so nested changes are not missed", async () => {
    const root = makeTempDir();
    const watch = createFakeWatch();
    const batches: WatcherChangeBatch[] = [];
    const registry = createWorkspaceWatcherRegistry({
      watchFactory: watch.factory,
      debounceMs: 5,
      onChange: (_workspace, batch) => batches.push(batch),
      onError: vi.fn(),
    });
    await registry.ensure({ workspacePath: root });

    mkdirSync(join(root, "packages"));
    watch.calls[0]?.listener("rename", "packages");
    await waitForDebounce(5);
    expect(batches.at(-1)).toEqual({ changed: [], removed: [], overflow: true });

    // Удалённый каталог без расширения нельзя отличить от extensionless-файла запросом к fs.
    watch.calls[0]?.listener("rename", "gone");
    await waitForDebounce(5);
    expect(batches.at(-1)).toEqual({ changed: [], removed: [], overflow: true });
  });

  it("ignores excluded directories, binary files and unknown paths stay conservative", async () => {
    const root = makeTempDir();
    const watch = createFakeWatch();
    const onChange = vi.fn();
    const registry = createWorkspaceWatcherRegistry({
      watchFactory: watch.factory,
      debounceMs: 5,
      onChange,
      onError: vi.fn(),
    });
    await registry.ensure({ workspacePath: root });

    for (const ignored of ["node_modules/pkg/index.ts", "dist/out.ts", "logo.png", ".env"]) {
      watch.calls[0]?.listener("change", ignored);
    }
    await waitForDebounce(5);
    expect(onChange).not.toHaveBeenCalled();

    watch.calls[0]?.listener("rename", null);
    await waitForDebounce(5);
    expect(onChange).toHaveBeenCalledWith(
      { workspacePath: root },
      { changed: [], removed: [], overflow: true },
    );
  });

  it("queues notifyMutated paths and filters non-indexable ones", async () => {
    const root = makeTempDir();
    const watch = createFakeWatch();
    const batches: WatcherChangeBatch[] = [];
    const registry = createWorkspaceWatcherRegistry({
      watchFactory: watch.factory,
      debounceMs: 5,
      onChange: (_workspace, batch) => batches.push(batch),
      onError: vi.fn(),
    });
    const workspace = { workspacePath: root };
    await registry.ensure(workspace);

    registry.notifyMutated(workspace, ["src/a.ts", "logo.png"]);
    await waitForDebounce(5);

    expect(batches).toEqual([{ changed: ["src/a.ts"], removed: [], overflow: false }]);
  });

  it("reports watcher creation failures instead of falling back to per-file watches", async () => {
    const root = makeTempDir();
    const onError = vi.fn();
    const watchFactory = vi.fn<RecursiveWatchFactory>(() => {
      throw new Error("fs.watch recursive is unavailable");
    });
    const registry = createWorkspaceWatcherRegistry({
      watchFactory,
      onChange: vi.fn(),
      onError,
    });

    await expect(registry.ensure({ workspacePath: root })).resolves.toBe(false);
    expect(watchFactory).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(registry.has({ workspacePath: root })).toBe(true);
  });

  it("closes the watcher on stop and starts a fresh subscription afterwards", async () => {
    const root = makeTempDir();
    const watch = createFakeWatch();
    const registry = createWorkspaceWatcherRegistry({
      watchFactory: watch.factory,
      onChange: vi.fn(),
      onError: vi.fn(),
    });
    const workspace = { workspacePath: root };

    await registry.ensure(workspace);
    await registry.stop(workspace);
    expect(watch.watchers[0]?.closed).toBe(true);
    expect(registry.has(workspace)).toBe(false);

    await registry.ensure(workspace);
    expect(watch.calls).toHaveLength(2);
  });

  it.runIf(process.platform === "darwin")(
    "keeps descriptor usage independent of workspace file count",
    async () => {
      const root = makeTempDir();
      for (let index = 0; index < 400; index += 1) {
        writeFileSync(join(root, `file-${index}.ts`), `export const value${index} = ${index};`);
      }
      const before = readdirSync("/dev/fd").length;
      const registry = createWorkspaceWatcherRegistry({
        onChange: vi.fn(),
        onError: vi.fn(),
      });

      await registry.ensure({ workspacePath: root });
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const after = readdirSync("/dev/fd").length;
      await registry.disposeAllAndWait();

      // Один рекурсивный subscription: 400 файлов не должны добавить 400 kqueue-дескрипторов.
      expect(after - before).toBeLessThan(10);
    },
  );
});
