import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenUiStateStorage } from "./stateStorage.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe("desktop Gen UI state persistence", () => {
  it("keeps the latest 100 paths and serializes writes across service instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const a = createGenUiStateStorage(root),
      b = createGenUiStateStorage(root);
    cleanup.push(
      () => a.dispose(),
      () => b.dispose(),
    );
    const scope = { workspacePath: "/workspace", sessionId: "task" };
    for (let i = 0; i < 102; i++)
      await (i % 2 ? a : b).set(
        { ...scope, path: `/workspace/view-${i}.html` },
        { modelContent: i, privateContent: null },
      );
    const entries = await b.list(scope);
    expect(entries).toHaveLength(100);
    expect(entries.some((entry) => entry.path === "/workspace/view-101.html")).toBe(true);
    expect(await a.get({ ...scope, path: "/workspace/view-0.html" })).toBeNull();
  });
  it("restores across service instances and serializes complete snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const first = createGenUiStateStorage(root),
      second = createGenUiStateStorage(root);
    cleanup.push(
      () => first.dispose(),
      () => second.dispose(),
    );
    const target = {
      workspacePath: "/workspace",
      sessionId: "task",
      path: "/workspace/chart.html",
    };
    await Promise.all(
      [1, 2, 3].map((tab) => first.set(target, { modelContent: null, privateContent: { tab } })),
    );
    expect(await second.get(target)).toEqual({ modelContent: null, privateContent: { tab: 3 } });
    expect(await second.get({ ...target, workspaceIdentity: "remote-example" })).toBeNull();
    await second.set(target, { modelContent: { year: 2026 }, privateContent: null });
    expect(await first.get(target)).toEqual({ modelContent: { year: 2026 }, privateContent: null });
  });
  it(
    "delivers external writes through native filesystem watchers",
    { timeout: 120_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const a = createGenUiStateStorage(root),
        b = createGenUiStateStorage(root);
      cleanup.push(
        () => a.dispose(),
        () => b.dispose(),
      );
      const target = {
        workspacePath: "/workspace",
        sessionId: "task",
        path: "/workspace/chart.html",
      };
      await a.get(target);
      const received: unknown[] = [];
      const off = a.onChanged((event) => received.push(event.state));
      cleanup.push(() => off.dispose());
      // 根因：macOS 的 fs.watch 基于 FSEvents，watch() 返回、原生流真正生效之前存在启动空窗，
      // 空窗内的文件事件会永久丢失（同仓库 subagentRuntimeConfigWatcher 用例实测立即写入约 1/8 丢失）。
      // 原用例只写一次再等事件，命中空窗后只能等满 30s 全局超时，属真实竞态而非慢。
      // 改为 100ms 步长重发同一版快照直到 onChanged 送达（90s 截止，首个事件即成功）；
      // 断言强度不变：送达内容必须与写入内容完全一致，仍然验证外部写入经原生 watcher 送达。
      const expected = { modelContent: "selection", privateContent: null };
      await vi.waitFor(
        async () => {
          await b.set(target, expected);
          expect(received).toContainEqual(expected);
        },
        { timeout: 90_000, interval: 100 },
      );
    },
  );
});
