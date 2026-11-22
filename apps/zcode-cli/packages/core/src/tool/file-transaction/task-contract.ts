// ============================================================
// cli-file-transaction: контракт жизненного цикла фоновых операций
// ============================================================
//
// Вынесен из contract.ts, чтобы держать основной контракт в пределах
// maxContractLines/maxPublicMethods архитектурной политики.
// Владелец статуса — FileTransactionTaskRegistry (см. lifecycle.ts).

/**
 * Жизненный цикл фоновой файловой операции. Единый владелец статуса —
 * `FileTransactionTaskRegistry`; инструменты и UI только наблюдают события.
 */
export type FileTransactionTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface FileTransactionTaskProgress {
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly path?: string;
  readonly operation?: string;
  readonly percent: number;
}

export interface FileTransactionTaskSnapshot {
  readonly taskId: string;
  readonly transactionId?: string;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolName: string;
  readonly holderId: string;
  readonly status: FileTransactionTaskStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly progress: FileTransactionTaskProgress;
  readonly affectedPaths: readonly string[];
  readonly errorCode?: string;
  readonly errorDetails?: string;
}

export interface FileTransactionTaskEvent {
  readonly snapshot: FileTransactionTaskSnapshot;
  readonly previousStatus: FileTransactionTaskStatus | null;
}

export interface FileTransactionTaskRegistration {
  readonly taskId: string;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolName: string;
  readonly holderId: string;
  readonly affectedPaths: readonly string[];
}

export interface IFileTransactionTaskRegistry {
  register(registration: FileTransactionTaskRegistration): FileTransactionTaskSnapshot;
  start(taskId: string, transactionId?: string): FileTransactionTaskSnapshot | undefined;
  reportProgress(taskId: string, progress: FileTransactionTaskProgress): FileTransactionTaskSnapshot | undefined;
  settle(
    taskId: string,
    outcome: {
      readonly status: Extract<FileTransactionTaskStatus, "completed" | "failed" | "cancelled">;
      readonly transactionId?: string;
      readonly errorCode?: string;
      readonly errorDetails?: string;
    },
  ): FileTransactionTaskSnapshot | undefined;
  cancel(taskId: string, details?: string): FileTransactionTaskSnapshot | undefined;
  cancelByHolder(holderId: string, details?: string): number;
  get(taskId: string): FileTransactionTaskSnapshot | undefined;
  list(): readonly FileTransactionTaskSnapshot[];
  signalOf(taskId: string): AbortSignal | undefined;
  subscribe(listener: (event: FileTransactionTaskEvent) => void): () => void;
}
