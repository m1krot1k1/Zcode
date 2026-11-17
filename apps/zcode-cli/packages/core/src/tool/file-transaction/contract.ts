import type {
  FileSystemPort,
  FileSystemRevision,
  FileSystemTextEncoding,
  TraceContext,
} from "@zcode/contracts";
import type { DiffMatchTier } from "../diff-engine/contract.js";

/**
 * cli-file-transaction публичный контракт: единый реестр канонических RW-блокировок (FileLockRegistry),
 * быстрый пре-коммитный AST/Syntax валидатор (SyntaxValidator) и двухфазный менеджер транзакций
 * с in-memory staging, атомарной записью и гарантированным 100% откатом (FileTransactionManager).
 */
export type CliFileTransactionId = string & { readonly __brand: "CliFileTransactionId" };

export type FileLockMode = "shared-read" | "exclusive-write";

export const DEFAULT_FILE_LOCK_TIMEOUT_MS = 15_000;
export const FILE_LOCK_TIMEOUT_CODE = "FILE_LOCK_TIMEOUT" as const;
export const SYNTAX_VALIDATION_FAILED_CODE = "SYNTAX_VALIDATION_FAILED" as const;

export interface FileLockRequestEntry {
  readonly path: string;
  readonly mode: FileLockMode;
}

export interface FileLockAcquireOptions {
  readonly workspaceIdentity?: string;
  readonly workspaceRoot: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly holderId?: string;
}

export interface FileLockGrant {
  readonly canonicalKeys: readonly string[];
  release(): void;
}

export interface ActiveFileLockStateSnapshot {
  readonly key: string;
  readonly readers: number;
  readonly writerHolderId?: string;
  readonly waiters: number;
}

export interface SyntaxErrorLocation {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly snippet: string;
}

export interface SyntaxValidationDiagnostic {
  readonly path: string;
  readonly language: string;
  readonly valid: boolean;
  readonly preExistingErrors: number;
  readonly introducedErrors: number;
  readonly message?: string;
  readonly line?: number;
  readonly column?: number;
  readonly firstError?: SyntaxErrorLocation;
}

export interface ISyntaxValidator {
  validateBuffer(params: {
    readonly filePath: string;
    readonly content: string;
    readonly beforeContent?: string | null;
  }): SyntaxValidationDiagnostic;
}

export interface FileStageMetadata {
  readonly encoding?: FileSystemTextEncoding;
  readonly lineEndings?: "LF" | "CRLF";
  readonly revision?: FileSystemRevision;
}

export type FileMutationOp =
  | {
      readonly kind: "create";
      readonly path: string;
      readonly displayPath?: string;
      readonly content: string;
      readonly overwrite?: boolean;
      readonly encoding?: FileSystemTextEncoding;
      readonly lineEndings?: "LF" | "CRLF";
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly displayPath?: string;
      readonly expectedRevisionId?: string;
      readonly computeNext: (
        current: string,
        meta: FileStageMetadata,
      ) => { content: string; appliedTier?: DiffMatchTier | string };
    }
  | {
      readonly kind: "move";
      readonly fromPath: string;
      readonly toPath: string;
      readonly displayPath?: string;
      readonly expectedRevisionId?: string;
      readonly computeNext?: (
        current: string,
        meta: FileStageMetadata,
      ) => { content: string; appliedTier?: DiffMatchTier | string };
    }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly displayPath?: string;
      readonly expectedRevisionId?: string;
    };

export interface FileTransactionCommittedFile {
  readonly path: string;
  readonly displayPath: string;
  readonly moveFromPath?: string;
  readonly operation: "create" | "update" | "move" | "delete";
  readonly appliedTier?: string;
  readonly beforeContent: string | null;
  readonly afterContent: string;
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly encoding?: FileSystemTextEncoding;
  readonly lineEndings?: "LF" | "CRLF";
  readonly revision?: FileSystemRevision;
  readonly syntaxDiagnostic?: SyntaxValidationDiagnostic;
}

export interface FileTransactionLifecycleEvent {
  readonly transactionId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly status: "active_diff" | "committed" | "rolled_back";
  readonly timestamp: number;
  readonly files: readonly FileTransactionCommittedFile[];
  readonly errorDetails?: string;
}

export interface FileTransactionCommitHookStep {
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly operation: "create" | "update" | "move" | "delete";
  readonly targetPath: string;
}

export interface TransactionReadStateEntryLike {
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAt: Date;
  sourceTool?: string;
  revisionId?: string;
  mtimeMs?: number;
  sizeBytes?: number;
}

export interface FileTransactionExecuteParams {
  readonly workspaceIdentity?: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly operations: readonly FileMutationOp[];
  readonly fileSystemPort: FileSystemPort;
  readonly readFileState?: Map<string, TransactionReadStateEntryLike>;
  readonly enforceStaleReadGuard?: boolean;
  readonly strictSyntaxValidation?: boolean;
  readonly allowSyntaxDraft?: boolean;
  readonly abortSignal?: AbortSignal;
  /**
   * Идентификатор фоновой задачи в `IFileTransactionTaskRegistry`. Когда задан вместе
   * с `taskRegistry`, менеджер сам публикует `running`/`progress`/терминальный статус
   * и берёт сигнал отмены из реестра (каскадная отмена субагентной сессии).
   */
  readonly taskId?: string;
  readonly taskRegistry?: import("./task-contract.js").IFileTransactionTaskRegistry;
  readonly trace?: TraceContext;
  readonly onTransactionEvent?: (event: FileTransactionLifecycleEvent) => Promise<void> | void;
  readonly onBeforeCommitStep?: (step: FileTransactionCommitHookStep) => Promise<void> | void;
  /**
   * Вызывается один раз после чтения всех целевых файлов в память и до валидации/записи.
   * Бросание исключения переводит транзакцию в `rejected_stale` без единой записи на диск.
   * Позволяет инструментам проверять freshness, не делая повторный Read.
   */
  readonly onStagedFiles?: (
    files: readonly FileStagedSnapshot[],
  ) => Promise<void> | void;
}

export interface FileStagedSnapshot {
  readonly path: string;
  readonly displayPath: string;
  readonly operation: "create" | "update" | "move" | "delete";
  readonly beforeContent: string | null;
  readonly afterContent: string;
  readonly revision?: FileSystemRevision;
  readonly encoding?: FileSystemTextEncoding;
  readonly lineEndings?: "LF" | "CRLF";
}

export interface FileTransactionCommitResult {
  readonly transactionId: string;
  readonly workspaceKey: string;
  readonly status:
    | "committed"
    | "rejected_conflict"
    | "rejected_stale"
    | "rejected_syntax"
    | "rolled_back_on_error"
    | "cancelled";
  readonly files: readonly FileTransactionCommittedFile[];
  readonly rolledBackSteps: number;
  readonly readMs: number;
  readonly validateMs: number;
  readonly commitMs: number;
  readonly errorCode?: string;
  readonly errorDetails?: string;
}

export interface IFileLockRegistry {
  resolveCanonicalLockKey(
    workspaceIdentity: string | undefined,
    workspaceRoot: string,
    targetPath: string,
  ): Promise<string>;

  acquire(entry: FileLockRequestEntry, options: FileLockAcquireOptions): Promise<FileLockGrant>;

  acquireBatch(
    entries: readonly FileLockRequestEntry[],
    options: FileLockAcquireOptions,
  ): Promise<FileLockGrant>;

  withLocks<T>(
    entries: readonly FileLockRequestEntry[],
    options: FileLockAcquireOptions,
    fn: () => Promise<T>,
  ): Promise<T>;

  releaseByHolder(holderId: string): number;

  getActiveLockSnapshot(): readonly ActiveFileLockStateSnapshot[];
}

export interface IFileTransactionManager {
  executeTransaction(params: FileTransactionExecuteParams): Promise<FileTransactionCommitResult>;
}

export interface CliFileTransactionContract extends IFileLockRegistry, IFileTransactionManager {}
