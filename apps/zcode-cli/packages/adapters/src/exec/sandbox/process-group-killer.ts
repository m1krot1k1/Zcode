/**
 * Уничтожение дерева процессов.
 *
 * Гарантии, которые проверяются тестами:
 * - Корень запускается лидером группы (`detached: true` на POSIX), поэтому
 *   `process.kill(-pgid)` накрывает и потомков, ушедших в другой pipeline/shell.
 * - Собственный PID вызывающего и PID 1 никогда не сигналятся.
 * - Уже завершённый корень — не ошибка: `alreadyExited: true`.
 * - После grace-периода уходит `SIGKILL`, затем проверяется живость группы.
 * - Windows идёт через `taskkill /T /F` — единственный способ снять дерево.
 */
import { spawn } from "node:child_process";

import type {
  ProcessTreeKillOptions,
  ProcessTreeKillResult,
} from "./contract.js";
import { SANDBOX_KILL_GRACE_MS } from "./contract.js";

const POSIX_TABLE_TIMEOUT_MS = 500;

/** Проверка живости: `EPERM` означает, что процесс есть, но сигнал не разрешён. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Жива ли группа целиком (хотя бы один участник). */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface ProcessTableRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** Читает таблицу процессов; при любой проблеме возвращает пустой массив. */
export async function readPosixProcessTable(
  timeoutMs = POSIX_TABLE_TIMEOUT_MS,
): Promise<ProcessTableRow[]> {
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="], {
          cwd: "/",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch (error) {
        reject(error);
        return;
      }
      let buffer = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Процесс мог завершиться раньше таймаута.
        }
        resolve(buffer);
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", () => {
        clearTimeout(timer);
        resolve(buffer);
      });
    });
  } catch {
    return [];
  }

  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return rows;
}

/** Собирает корень, его потомков по PPID и всех участников группы. */
export function collectTreePids(
  rows: readonly ProcessTableRow[],
  rootPid: number,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const collected = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      if (pid <= 1 || collected.has(pid)) continue;
      collected.add(pid);
      queue.push(pid);
    }
  }
  for (const row of rows) {
    if (row.pgid === rootPid && row.pid > 1) collected.add(row.pid);
  }
  return [...collected];
}

/** Безопасная отправка сигнала: чужие PID и PID 1 отфильтрованы. */
function signalPid(pid: number, signal: NodeJS.Signals, selfPid: number): boolean {
  if (pid <= 1 || pid === selfPid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // ESRCH/EPERM: процесс уже завершён или сигнал не разрешён — не ошибка.
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals, selfPid: number): boolean {
  if (pgid <= 1 || pgid === selfPid) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Windows-ветка: `taskkill /pid <pid> /T /F`, затем проверка живости. */
async function killWindowsTree(rootPid: number): Promise<ProcessTreeKillResult> {
  const alreadyExited = !isProcessAlive(rootPid);
  if (alreadyExited) {
    return { rootPid, escalated: true, signalled: 0, survivors: [], alreadyExited: true };
  }

  await new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("taskkill", ["/pid", String(rootPid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });

  const survivors = isProcessAlive(rootPid) ? [rootPid] : [];
  return {
    rootPid,
    escalated: true,
    signalled: survivors.length === 0 ? 1 : 0,
    survivors,
    alreadyExited: false,
  };
}

/**
 * Уничтожает дерево процессов. Идемпотентно: повторный вызов на мёртвом дереве
 * возвращает `alreadyExited: true` и ничего не сигналит.
 */
export async function killProcessTree(
  rootPid: number,
  options: ProcessTreeKillOptions = {},
): Promise<ProcessTreeKillResult> {
  const platform = options.platform ?? process.platform;
  const selfPid = process.pid;

  if (!Number.isInteger(rootPid) || rootPid <= 1 || rootPid === selfPid) {
    return {
      rootPid,
      escalated: false,
      signalled: 0,
      survivors: [],
      alreadyExited: true,
    };
  }

  if (platform === "win32") return killWindowsTree(rootPid);

  if (!isProcessGroupAlive(rootPid) && !isProcessAlive(rootPid)) {
    return { rootPid, escalated: false, signalled: 0, survivors: [], alreadyExited: true };
  }

  const softSignal = options.signal ?? "SIGTERM";
  const graceMs = options.graceMs ?? SANDBOX_KILL_GRACE_MS;
  const rows = await readPosixProcessTable(options.lookupTimeoutMs);
  const initialTargets = collectTreePids(rows, rootPid);

  let signalled = 0;
  if (signalGroup(rootPid, softSignal, selfPid)) signalled += 1;
  for (const pid of initialTargets) {
    if (signalPid(pid, softSignal, selfPid)) signalled += 1;
  }

  if (graceMs > 0) await delay(graceMs);

  const stillGroupAlive = isProcessGroupAlive(rootPid);
  const refreshedRows = stillGroupAlive ? await readPosixProcessTable(options.lookupTimeoutMs) : [];
  const survivors = stillGroupAlive
    ? collectTreePids(refreshedRows, rootPid).filter((pid) => isProcessAlive(pid))
    : [];

  let escalated = false;
  if (stillGroupAlive || survivors.length > 0) {
    escalated = true;
    if (signalGroup(rootPid, "SIGKILL", selfPid)) signalled += 1;
    for (const pid of survivors) {
      if (signalPid(pid, "SIGKILL", selfPid)) signalled += 1;
    }
    // Короткое ожидание, чтобы ядро успело снять процессы до отчёта.
    await delay(50);
  }

  const finalSurvivors = (stillGroupAlive || survivors.length > 0
    ? collectTreePids(await readPosixProcessTable(options.lookupTimeoutMs), rootPid)
    : []
  ).filter((pid) => isProcessAlive(pid));

  return {
    rootPid,
    escalated,
    signalled,
    survivors: finalSurvivors,
    alreadyExited: false,
  };
}

/**
 * Привязывает `AbortSignal` к уничтожению дерева. Возвращает `dispose`, который
 * снимает обработчик — иначе сигнал держит ссылку на процесс после завершения.
 */
export function attachAbortKill(
  signal: AbortSignal | undefined,
  getRootPid: () => number | undefined,
  options?: ProcessTreeKillOptions,
): { dispose: () => void; kill: () => Promise<ProcessTreeKillResult | undefined> } {
  let disposed = false;
  const kill = async () => {
    const pid = getRootPid();
    if (pid === undefined) return undefined;
    return killProcessTree(pid, options);
  };
  const onAbort = () => {
    if (disposed) return;
    void kill().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    dispose: () => {
      disposed = true;
      signal?.removeEventListener("abort", onAbort);
    },
    kill,
  };
}
