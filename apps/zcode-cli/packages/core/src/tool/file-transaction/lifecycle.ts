// ============================================================
// cli-file-transaction: реестр жизненных циклов фоновых операций
// ============================================================
//
// Назначение: единая точка владения состоянием фоновой файловой транзакции
// (queued -> running -> completed | failed | cancelled) с потоковыми
// уведомлениями о прогрессе и каскадной отменой.
//
// Инварианты:
//  1. Ни одна фоновая операция не покидает реестр без терминального статуса.
//  2. Отмена освобождает блокировки через `IFileLockRegistry.releaseByHolder`,
//     поэтому ожидающие чужие транзакции не ждут истечения таймаута.
//  3. `AbortController` принадлежит реестру: он отдаёт сигнал транзакции,
//     а не принимает его снаружи, чтобы отмена была ровно один раз идемпотентной.

import type { IFileLockRegistry } from "./contract.js";
import type {
  FileTransactionTaskEvent,
  FileTransactionTaskProgress,
  FileTransactionTaskRegistration,
  FileTransactionTaskSnapshot,
  FileTransactionTaskStatus,
  IFileTransactionTaskRegistry,
} from "./task-contract.js";

const TERMINAL_STATUSES: ReadonlySet<FileTransactionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalFileTransactionTask(status: FileTransactionTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface FileTransactionTaskRegistryOptions {
  readonly lockRegistry: IFileLockRegistry;
  /** Максимум удерживаемых терминальных записей; по умолчанию 64. */
  readonly maxRetainedTerminal?: number;
}

interface TaskEntry {
  snapshot: FileTransactionTaskSnapshot;
  controller: AbortController;
}

export class FileTransactionTaskRegistry implements IFileTransactionTaskRegistry {
  private readonly lockRegistry: IFileLockRegistry;
  private readonly maxRetainedTerminal: number;
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly listeners = new Set<(event: FileTransactionTaskEvent) => void>();

  constructor(options: FileTransactionTaskRegistryOptions) {
    this.lockRegistry = options.lockRegistry;
    this.maxRetainedTerminal = Math.max(1, options.maxRetainedTerminal ?? 64);
  }

  register(registration: FileTransactionTaskRegistration): FileTransactionTaskSnapshot {
    const existing = this.tasks.get(registration.taskId);
    if (existing) return existing.snapshot;

    const entry: TaskEntry = {
      controller: new AbortController(),
      snapshot: {
        taskId: registration.taskId,
        workspaceKey: registration.workspaceKey,
        sessionId: registration.sessionId,
        ...(registration.turnId ? { turnId: registration.turnId } : {}),
        toolName: registration.toolName,
        holderId: registration.holderId,
        status: "queued",
        createdAt: Date.now(),
        progress: { stepIndex: 0, totalSteps: 0, percent: 0 },
        affectedPaths: [...registration.affectedPaths],
      },
    };
    this.tasks.set(registration.taskId, entry);
    this.emit(entry.snapshot, null);
    return entry.snapshot;
  }

  start(taskId: string, transactionId?: string): FileTransactionTaskSnapshot | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry || isTerminalFileTransactionTask(entry.snapshot.status)) return entry?.snapshot;
    const previous = entry.snapshot.status;
    entry.snapshot = {
      ...entry.snapshot,
      ...(transactionId ? { transactionId } : {}),
      startedAt: entry.snapshot.startedAt ?? Date.now(),
      status: "running",
    };
    this.emit(entry.snapshot, previous);
    return entry.snapshot;
  }

  reportProgress(
    taskId: string,
    progress: FileTransactionTaskProgress,
  ): FileTransactionTaskSnapshot | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry || isTerminalFileTransactionTask(entry.snapshot.status)) return entry?.snapshot;
    entry.snapshot = {
      ...entry.snapshot,
      progress: {
        ...progress,
        percent: Math.min(100, Math.max(0, Math.round(progress.percent))),
      },
    };
    this.emit(entry.snapshot, entry.snapshot.status);
    return entry.snapshot;
  }

  settle(
    taskId: string,
    outcome: {
      readonly status: Extract<FileTransactionTaskStatus, "completed" | "failed" | "cancelled">;
      readonly transactionId?: string;
      readonly errorCode?: string;
      readonly errorDetails?: string;
    },
  ): FileTransactionTaskSnapshot | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    if (isTerminalFileTransactionTask(entry.snapshot.status)) return entry.snapshot;

    const previous = entry.snapshot.status;
    entry.snapshot = {
      ...entry.snapshot,
      ...(outcome.transactionId ? { transactionId: outcome.transactionId } : {}),
      status: outcome.status,
      settledAt: Date.now(),
      progress: {
        ...entry.snapshot.progress,
        percent: outcome.status === "completed" ? 100 : entry.snapshot.progress.percent,
      },
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorDetails ? { errorDetails: outcome.errorDetails } : {}),
    };
    this.releaseHolder(entry.snapshot.holderId);
    this.emit(entry.snapshot, previous);
    this.pruneTerminal();
    return entry.snapshot;
  }

  cancel(taskId: string, details?: string): FileTransactionTaskSnapshot | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    if (isTerminalFileTransactionTask(entry.snapshot.status)) return entry.snapshot;
    // 1. Сигнал отмены: транзакция увидит его между шагами коммита и откатит применённое.
    entry.controller.abort(new Error(details ?? "File transaction cancelled"));
    // 2. Локи снимаются сразу: ожидающие писатели не должны ждать завершения отката.
    this.releaseHolder(entry.snapshot.holderId);
    return this.settle(taskId, { status: "cancelled", errorCode: "ABORTED", ...(details ? { errorDetails: details } : {}) });
  }

  cancelByHolder(holderId: string, details?: string): number {
    if (!holderId) return 0;
    const prefix = `${holderId}:`;
    let cancelled = 0;
    for (const entry of this.tasks.values()) {
      const current = entry.snapshot.holderId;
      if (current !== holderId && !current.startsWith(prefix)) continue;
      if (isTerminalFileTransactionTask(entry.snapshot.status)) continue;
      if (this.cancel(entry.snapshot.taskId, details)) cancelled += 1;
    }
    return cancelled;
  }

  get(taskId: string): FileTransactionTaskSnapshot | undefined {
    return this.tasks.get(taskId)?.snapshot;
  }

  list(): readonly FileTransactionTaskSnapshot[] {
    return [...this.tasks.values()].map((entry) => entry.snapshot);
  }

  signalOf(taskId: string): AbortSignal | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry || isTerminalFileTransactionTask(entry.snapshot.status)) return undefined;
    return entry.controller.signal;
  }

  subscribe(listener: (event: FileTransactionTaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private releaseHolder(holderId: string): void {
    try {
      this.lockRegistry.releaseByHolder(holderId);
    } catch {
      // Реестр локов не должен ломать жизненный цикл: лок всё равно освободится
      // по release() в finally самой транзакции.
    }
  }

  private emit(snapshot: FileTransactionTaskSnapshot, previousStatus: FileTransactionTaskStatus | null): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener({ snapshot, previousStatus });
      } catch {
        // Наблюдатели изолированы: сбой подписчика не отменяет операцию.
      }
    }
  }

  private pruneTerminal(): void {
    const terminal = [...this.tasks.values()].filter(
      (entry) => isTerminalFileTransactionTask(entry.snapshot.status) && entry.snapshot.settledAt !== undefined,
    );
    if (terminal.length <= this.maxRetainedTerminal) return;
    terminal
      .sort((a, b) => (a.snapshot.settledAt ?? 0) - (b.snapshot.settledAt ?? 0))
      .slice(0, terminal.length - this.maxRetainedTerminal)
      .forEach((entry) => this.tasks.delete(entry.snapshot.taskId));
  }
}

export function createFileTransactionTaskRegistry(
  options: FileTransactionTaskRegistryOptions,
): IFileTransactionTaskRegistry {
  return new FileTransactionTaskRegistry(options);
}
