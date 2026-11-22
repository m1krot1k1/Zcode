import { realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import {
  DEFAULT_FILE_LOCK_TIMEOUT_MS,
  FILE_LOCK_TIMEOUT_CODE,
  type ActiveFileLockStateSnapshot,
  type FileLockAcquireOptions,
  type FileLockGrant,
  type FileLockMode,
  type FileLockRequestEntry,
  type IFileLockRegistry,
} from "./contract.js";

interface WaiterNode {
  readonly mode: FileLockMode;
  readonly holderId?: string;
  granted: boolean;
  cancelled: boolean;
  grant: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface KeyLockSlot {
  activeReaders: number;
  writerActive: boolean;
  writerHolderId?: string;
  readonly queue: WaiterNode[];
}

export class FileLockRegistry implements IFileLockRegistry {
  private readonly slots = new Map<string, KeyLockSlot>();
  private readonly activeGrantsByHolder = new Map<string, Set<() => void>>();

  async resolveCanonicalLockKey(
    workspaceIdentity: string | undefined,
    workspaceRoot: string,
    targetPath: string,
  ): Promise<string> {
    const resolvedRoot = resolve(workspaceRoot);
    const canonicalRoot = await resolveExistingOrAncestorRealpath(resolvedRoot);
    const workspaceKey = workspaceIdentity?.trim() || canonicalRoot;
    const resolvedTarget = resolve(resolvedRoot, targetPath);
    const canonicalTarget = await resolveExistingOrAncestorRealpath(resolvedTarget);
    return `${workspaceKey}\u0000${canonicalTarget}`;
  }

  async acquire(
    entry: FileLockRequestEntry,
    options: FileLockAcquireOptions,
  ): Promise<FileLockGrant> {
    return this.acquireBatch([entry], options);
  }

  async acquireBatch(
    entries: readonly FileLockRequestEntry[],
    options: FileLockAcquireOptions,
  ): Promise<FileLockGrant> {
    throwIfAborted(options.signal);
    if (entries.length === 0) {
      return {
        canonicalKeys: [],
        release() {},
      };
    }

    // Дедупликация и повышение режима до exclusive-write, если один файл запрошен дважды.
    const modeByKey = new Map<string, FileLockMode>();
    for (const entry of entries) {
      const key = await this.resolveCanonicalLockKey(
        options.workspaceIdentity,
        options.workspaceRoot,
        entry.path,
      );
      const existing = modeByKey.get(key);
      if (!existing || entry.mode === "exclusive-write") {
        modeByKey.set(key, entry.mode);
      }
    }

    // Deadlock-Free инвариант: строгая глобальная лексикографическая сортировка UTF-16 code units.
    const ordered = [...modeByKey.entries()].sort(([keyA], [keyB]) =>
      keyA < keyB ? -1 : keyA > keyB ? 1 : 0,
    );

    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : DEFAULT_FILE_LOCK_TIMEOUT_MS;
    const deadlineMs = Date.now() + timeoutMs;

    const acquiredReleases: Array<() => void> = [];
    try {
      for (const [key, mode] of ordered) {
        const remainingMs = Math.max(1, deadlineMs - Date.now());
        const releaseOne = await this.acquireSingleCanonicalKey(key, mode, {
          holderId: options.holderId,
          signal: options.signal,
          timeoutMs: remainingMs,
        });
        acquiredReleases.push(releaseOne);
      }
    } catch (error) {
      // Атомарный откат уже захваченных 0..k-1 блокировок при таймауте или отмене.
      for (let i = acquiredReleases.length - 1; i >= 0; i -= 1) {
        acquiredReleases[i]?.();
      }
      throw error;
    }

    let released = false;
    const releaseGrant = () => {
      if (released) return;
      released = true;
      if (options.holderId) {
        const holderSet = this.activeGrantsByHolder.get(options.holderId);
        if (holderSet) {
          holderSet.delete(releaseGrant);
          if (holderSet.size === 0) {
            this.activeGrantsByHolder.delete(options.holderId);
          }
        }
      }
      for (let i = acquiredReleases.length - 1; i >= 0; i -= 1) {
        acquiredReleases[i]?.();
      }
    };

    if (options.holderId) {
      let holderSet = this.activeGrantsByHolder.get(options.holderId);
      if (!holderSet) {
        holderSet = new Set();
        this.activeGrantsByHolder.set(options.holderId, holderSet);
      }
      holderSet.add(releaseGrant);
    }

    return {
      canonicalKeys: ordered.map(([key]) => key),
      release: releaseGrant,
    };
  }

  async withLocks<T>(
    entries: readonly FileLockRequestEntry[],
    options: FileLockAcquireOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    const grant = await this.acquireBatch(entries, options);
    try {
      return await fn();
    } finally {
      grant.release();
    }
  }

  releaseByHolder(holderId: string): number {
    if (!holderId) return 0;
    const prefix = `${holderId}:`;
    let releasedCount = 0;

    // 1. Отменяем ожидающие запросы в очередях, принадлежащие holderId или его дочерним вызовам
    for (const [key, slot] of this.slots.entries()) {
      for (const waiter of slot.queue) {
        if (
          !waiter.granted &&
          !waiter.cancelled &&
          (waiter.holderId === holderId || waiter.holderId?.startsWith(prefix) === true)
        ) {
          removeFromQueue(slot.queue, waiter);
          waiter.reject(
            createCoreError(CoreErrorType.ToolCancelled, `Lock request cancelled for holder ${holderId}`, {
              recoverable: true,
            }),
          );
          releasedCount += 1;
        }
      }
      this.pumpWaiters(key, slot);
    }

    // 2. Освобождаем уже выданные активные гранты
    for (const [registeredHolder, grants] of this.activeGrantsByHolder.entries()) {
      if (registeredHolder === holderId || registeredHolder.startsWith(prefix)) {
        for (const releaseFn of Array.from(grants)) {
          releaseFn();
          releasedCount += 1;
        }
      }
    }

    return releasedCount;
  }

  getActiveLockSnapshot(): readonly ActiveFileLockStateSnapshot[] {
    const snapshots: ActiveFileLockStateSnapshot[] = [];
    for (const [key, slot] of this.slots.entries()) {
      if (slot.activeReaders === 0 && !slot.writerActive && slot.queue.length === 0) {
        continue;
      }
      snapshots.push({
        key,
        readers: slot.activeReaders,
        ...(slot.writerActive && slot.writerHolderId
          ? { writerHolderId: slot.writerHolderId }
          : {}),
        waiters: slot.queue.length,
      });
    }
    return snapshots;
  }

  private acquireSingleCanonicalKey(
    key: string,
    mode: FileLockMode,
    options: { holderId?: string; signal?: AbortSignal; timeoutMs: number },
  ): Promise<() => void> {
    throwIfAborted(options.signal);

    let slot = this.slots.get(key);
    if (!slot) {
      slot = {
        activeReaders: 0,
        writerActive: false,
        queue: [],
      };
      this.slots.set(key, slot);
    }

    // Немедленный захват возможен только если очередь пуста (writer-fairness против голодания записи).
    if (slot.queue.length === 0) {
      if (mode === "shared-read" && !slot.writerActive) {
        slot.activeReaders += 1;
        return Promise.resolve(() => this.releaseSingleCanonicalKey(key, "shared-read"));
      }
      if (mode === "exclusive-write" && !slot.writerActive && slot.activeReaders === 0) {
        slot.writerActive = true;
        slot.writerHolderId = options.holderId;
        return Promise.resolve(() => this.releaseSingleCanonicalKey(key, "exclusive-write"));
      }
    }

    const activeSlot = slot;
    return new Promise<() => void>((resolvePromise, rejectPromise) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (waiter.granted || waiter.cancelled) return;
        waiter.cancelled = true;
        waiter.cleanup();
        removeFromQueue(activeSlot.queue, waiter);
        this.pumpWaiters(key, activeSlot);
        rejectPromise(createAbortLockError(options.signal));
      };

      const waiter: WaiterNode = {
        mode,
        holderId: options.holderId,
        granted: false,
        cancelled: false,
        cleanup: () => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
          options.signal?.removeEventListener("abort", onAbort);
        },
        grant: () => {
          waiter.granted = true;
          waiter.cleanup();
          resolvePromise(() => this.releaseSingleCanonicalKey(key, mode));
        },
        reject: (err) => {
          waiter.cancelled = true;
          waiter.cleanup();
          rejectPromise(err);
        },
      };

      timeoutHandle = setTimeout(() => {
        if (waiter.granted || waiter.cancelled) return;
        removeFromQueue(activeSlot.queue, waiter);
        this.pumpWaiters(key, activeSlot);
        waiter.reject(
          createCoreError(
            CoreErrorType.ToolTimeout,
            `Timed out waiting ${options.timeoutMs}ms for ${mode} file lock on ${extractDisplayPathFromKey(key)}`,
            {
              context: {
                code: FILE_LOCK_TIMEOUT_CODE,
                failureKind: "lock_timeout",
                lockMode: mode,
                timeoutMs: options.timeoutMs,
              },
              recoverable: true,
            },
          ),
        );
      }, options.timeoutMs);

      options.signal?.addEventListener("abort", onAbort, { once: true });
      activeSlot.queue.push(waiter);
    });
  }

  private releaseSingleCanonicalKey(key: string, mode: FileLockMode): void {
    const slot = this.slots.get(key);
    if (!slot) return;

    if (mode === "exclusive-write") {
      slot.writerActive = false;
      slot.writerHolderId = undefined;
    } else {
      slot.activeReaders = Math.max(0, slot.activeReaders - 1);
    }

    this.pumpWaiters(key, slot);
  }

  private pumpWaiters(key: string, slot: KeyLockSlot): void {
    while (slot.queue.length > 0) {
      const head = slot.queue[0]!;
      if (head.cancelled) {
        slot.queue.shift();
        continue;
      }

      if (head.mode === "exclusive-write") {
        if (slot.writerActive || slot.activeReaders > 0) {
          break;
        }
        slot.queue.shift();
        slot.writerActive = true;
        slot.writerHolderId = head.holderId;
        head.grant();
        break;
      }

      // head.mode === "shared-read": можем пробудить пакет идущих подряд читателей, пока нет активного писателя
      if (slot.writerActive) {
        break;
      }
      slot.queue.shift();
      slot.activeReaders += 1;
      head.grant();
    }

    if (!slot.writerActive && slot.activeReaders === 0 && slot.queue.length === 0) {
      this.slots.delete(key);
    }
  }
}

export function createFileLockRegistry(): IFileLockRegistry {
  return new FileLockRegistry();
}

async function resolveExistingOrAncestorRealpath(absolutePath: string): Promise<string> {
  let probe = absolutePath;
  while (true) {
    try {
      const real = await realpath(probe);
      if (probe === absolutePath) {
        return real;
      }
      const rel = relative(probe, absolutePath);
      return join(real, rel);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        return absolutePath;
      }
      probe = parent;
    }
  }
}

function removeFromQueue(queue: WaiterNode[], target: WaiterNode): void {
  const index = queue.indexOf(target);
  if (index >= 0) {
    queue.splice(index, 1);
  }
}

function extractDisplayPathFromKey(key: string): string {
  const sep = key.indexOf("\u0000");
  return sep >= 0 ? key.slice(sep + 1) : key;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw createAbortLockError(signal);
}

function createAbortLockError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return createCoreError(CoreErrorType.ToolCancelled, "File lock acquisition cancelled", {
    recoverable: true,
  });
}
