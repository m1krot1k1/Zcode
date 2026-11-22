/**
 * Гарантии уничтожения дерева процессов.
 *
 * Проверяется реальными процессами: `sh -c 'sleep 300 & sleep 300'` порождает
 * потомков; после `killTree` группа обязана быть мертва, а повторный вызов —
 * не ошибка. Отдельно проверяются границы: PID 1, собственный PID и мёртвый PID.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  attachAbortKill,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessTree,
} from "../../src/exec/sandbox/process-group-killer.js";

/** Запускает отсоединённую группу с фоновым потомком. */
async function spawnDetachedTree(): Promise<ChildProcess> {
  const child = spawn("/bin/sh", ["-c", "sleep 300 & sleep 300"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 300);
    timer.unref?.();
  });
  return child;
}

describe("process tree killer", () => {
  it("kills the whole detached tree and reports survivors", async () => {
    const child = await spawnDetachedTree();
    const pid = child.pid!;
    expect(isProcessGroupAlive(pid)).toBe(true);

    const result = await killProcessTree(pid, { graceMs: 400 });

    expect(result.rootPid).toBe(pid);
    expect(result.alreadyExited).toBe(false);
    expect(result.survivors).toEqual([]);
    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);
    child.kill("SIGKILL");
  }, 20_000);

  it("is idempotent for an already finished process", async () => {
    const child = spawn("/bin/sh", ["-c", "true"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const pid = child.pid!;

    const result = await killProcessTree(pid, { graceMs: 0 });
    expect(result.alreadyExited).toBe(true);
    expect(result.signalled).toBe(0);
    expect(result.survivors).toEqual([]);
  });

  it("never signals pid 1 or its own process", async () => {
    for (const pid of [1, process.pid, 0, -5]) {
      const result = await killProcessTree(pid, { graceMs: 0 });
      expect(result.signalled).toBe(0);
      expect(result.alreadyExited).toBe(true);
    }
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("kills the tree when the abort signal fires", async () => {
    const child = await spawnDetachedTree();
    const pid = child.pid!;
    const controller = new AbortController();
    const handle = attachAbortKill(controller.signal, () => pid, { graceMs: 300 });

    controller.abort();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 900);
      timer.unref?.();
    });

    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);
    handle.dispose();
    child.kill("SIGKILL");
  }, 20_000);

  it("reports structured result on the win32 branch", async () => {
    // Windows-ветка не должна уходить в POSIX-путь: мёртвый PID даёт структурный
    // отчёт, а не исключение.
    const result = await killProcessTree(999_999, { platform: "win32", graceMs: 0 });
    expect(result.alreadyExited).toBe(true);
    expect(result.survivors).toEqual([]);
  });
});
