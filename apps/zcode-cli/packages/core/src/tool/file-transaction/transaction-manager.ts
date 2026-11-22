import { createHash } from "node:crypto";
import { isFileSystemPortError, type FileSystemPort } from "@zcode/contracts";
import type {
  FileMutationOp,
  FileStageMetadata,
  FileTransactionCommitResult,
  FileTransactionCommittedFile,
  FileTransactionExecuteParams,
  FileTransactionLifecycleEvent,
  IFileLockRegistry,
  IFileTransactionManager,
  ISyntaxValidator,
  SyntaxValidationDiagnostic,
  TransactionReadStateEntryLike,
} from "./contract.js";
import { createSyntaxValidator } from "./syntax-validator.js";

interface StagedFile {
  readonly operation: "create" | "update" | "move" | "delete";
  readonly targetPath: string;
  readonly displayPath: string;
  readonly moveFromPath?: string;
  readonly sourcePath?: string;
  readonly beforeContent: string | null;
  readonly afterContent: string;
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly encoding?: FileStageMetadata["encoding"];
  readonly lineEndings?: FileStageMetadata["lineEndings"];
  readonly revision?: FileStageMetadata["revision"];
  readonly appliedTier?: string;
  readonly syntaxDiagnostic?: SyntaxValidationDiagnostic;
}

interface AppliedStep {
  readonly staged: StagedFile;
  readonly createdParentPaths: readonly string[];
}

export interface FileTransactionManagerOptions {
  readonly lockRegistry: IFileLockRegistry;
  readonly syntaxValidator?: ISyntaxValidator;
  readonly defaultStrictSyntaxValidation?: boolean;
}

const UTF8 = "utf8" as const;

export class FileTransactionManager implements IFileTransactionManager {
  private readonly lockRegistry: IFileLockRegistry;
  private readonly syntaxValidator: ISyntaxValidator;
  private readonly defaultStrictSyntaxValidation: boolean;

  constructor(options: FileTransactionManagerOptions) {
    this.lockRegistry = options.lockRegistry;
    this.syntaxValidator = options.syntaxValidator ?? createSyntaxValidator();
    this.defaultStrictSyntaxValidation = options.defaultStrictSyntaxValidation ?? true;
  }

  async executeTransaction(params: FileTransactionExecuteParams): Promise<FileTransactionCommitResult> {
    const startedAt = Date.now();
    const transactionId = createTransactionId(params.sessionId);
    const workspaceKey = resolveWorkspaceKey(params);
    const operations = mergeOperations(params.operations);
    const existsCache = new Map<string, boolean>();

    // Фоновая задача владеет сигналом отмены: `cancel()` в реестре освобождает локи
    // и абстрагирует транзакцию между шагами коммита, поэтому внешний abortSignal
    // остаётся вторым, независимым источником отмены.
    const taskSignal =
      params.taskId !== undefined && params.taskRegistry !== undefined
        ? params.taskRegistry.signalOf(params.taskId)
        : undefined;
    const effectiveAbortSignal = combineAbortSignals(params.abortSignal, taskSignal);
    if (params.taskId !== undefined && params.taskRegistry !== undefined) {
      params.taskRegistry.start(params.taskId, transactionId);
    }

    const emptyResult = (status: FileTransactionCommitResult["status"], errorDetails?: string): FileTransactionCommitResult => ({
      transactionId,
      workspaceKey,
      status,
      files: [],
      rolledBackSteps: 0,
      readMs: Date.now() - startedAt,
      validateMs: 0,
      commitMs: 0,
      ...(errorDetails ? { errorDetails } : {}),
    });

    if (operations.length === 0) {
      return emptyResult("committed");
    }
    if (effectiveAbortSignal?.aborted) {
      return emptyResult("cancelled", "Transaction cancelled before acquiring locks.");
    }

    const lockEntries = buildLockEntries(operations);
    const holderId =
      params.toolCallId !== undefined
        ? `${params.sessionId}:${params.toolCallId}`
        : `${params.sessionId}:${transactionId}`;

    const grant = await this.lockRegistry.acquireBatch(lockEntries, {
      workspaceIdentity: params.workspaceIdentity,
      workspaceRoot: params.workspacePath,
      holderId,
      signal: effectiveAbortSignal,
    });

    try {
      // ── Phase 1: Snapshot & staging ──
      const stageStartedAt = Date.now();
      const staged = await this.stageFiles(params, operations, existsCache, effectiveAbortSignal);
      const readMs = Date.now() - stageStartedAt;
      if (staged.status !== "staged") {
        return {
          ...emptyResult(staged.status, staged.errorDetails),
          readMs,
          files: staged.files ?? [],
        };
      }

      // Хук свежести вызывается по staged-снимку: чтение уже произошло под блокировками,
      // поэтому внешняя проверка не создаёт повторный Read и TOCTOU-окно.
      try {
        await params.onStagedFiles?.(
          staged.files.map((file) => ({
            path: file.targetPath,
            displayPath: file.displayPath,
            operation: file.operation,
            beforeContent: file.beforeContent,
            afterContent: file.afterContent,
            ...(file.revision ? { revision: file.revision } : {}),
            ...(file.encoding ? { encoding: file.encoding } : {}),
            ...(file.lineEndings ? { lineEndings: file.lineEndings } : {}),
          })),
        );
      } catch (error) {
        return {
          ...emptyResult("rejected_stale", describeError(error)),
          readMs,
        };
      }

      // ── Phase 2: Syntax / AST pre-validation ──
      const validateStartedAt = Date.now();
      const validated = this.validateStagedFiles(params, staged.files);
      const validateMs = Date.now() - validateStartedAt;
      if (validated.status !== "valid") {
        await this.emitLifecycle(params, transactionId, workspaceKey, "rolled_back", validated.files, validated.errorDetails);
        params.taskRegistry?.settle(params.taskId!, {
          status: "failed",
          transactionId,
          errorCode: "SYNTAX_VALIDATION_FAILED",
          ...(validated.errorDetails ? { errorDetails: validated.errorDetails } : {}),
        });
        return {
          transactionId,
          workspaceKey,
          status: "rejected_syntax",
          files: validated.files,
          rolledBackSteps: 0,
          readMs,
          validateMs,
          commitMs: 0,
          errorCode: "SYNTAX_VALIDATION_FAILED",
          errorDetails: validated.errorDetails,
        };
      }

      await this.emitLifecycle(params, transactionId, workspaceKey, "active_diff", validated.files);

      // ── Phase 3: Atomic commit & guaranteed rollback ──
      const commitStartedAt = Date.now();
      const applied: AppliedStep[] = [];
      try {
        for (let index = 0; index < staged.files.length; index += 1) {
          throwIfAborted(effectiveAbortSignal);
          const file = staged.files[index]!;
          await params.onBeforeCommitStep?.({
            stepIndex: index,
            totalSteps: staged.files.length,
            operation: file.operation,
            targetPath: file.targetPath,
          });
          const createdParents = await this.commitSingleFile(params, file, effectiveAbortSignal);
          applied.push({ staged: file, createdParentPaths: createdParents });
          this.reportTaskProgress(params, index + 1, staged.files.length, file);
        }
      } catch (error) {
        const rolledBackSteps = await this.rollback(params, applied);
        const commitMs = Date.now() - commitStartedAt;
        const cancelled = effectiveAbortSignal?.aborted === true;
        const reason = describeError(error);
        await this.emitLifecycle(
          params,
          transactionId,
          workspaceKey,
          "rolled_back",
          validated.files,
          `Commit failed at step #${applied.length + 1}: ${reason}`,
        );
        params.taskRegistry?.settle(params.taskId!, {
          status: cancelled ? "cancelled" : "failed",
          transactionId,
          errorCode: cancelled ? "ABORTED" : "COMMIT_FAILED",
          errorDetails: reason,
        });
        return {
          transactionId,
          workspaceKey,
          status: cancelled ? "cancelled" : "rolled_back_on_error",
          files: validated.files,
          rolledBackSteps,
          readMs,
          validateMs,
          commitMs,
          errorCode: cancelled ? "ABORTED" : "COMMIT_FAILED",
          errorDetails: reason,
        };
      }

      const commitMs = Date.now() - commitStartedAt;
      this.syncReadFileState(params, applied);
      await this.emitLifecycle(params, transactionId, workspaceKey, "committed", validated.files);
      params.taskRegistry?.settle(params.taskId!, { status: "completed", transactionId });

      return {
        transactionId,
        workspaceKey,
        status: "committed",
        files: validated.files,
        rolledBackSteps: 0,
        readMs,
        validateMs,
        commitMs,
      };
    } finally {
      grant.release();
    }
  }

  private async stageFiles(
    params: FileTransactionExecuteParams,
    operations: readonly FileMutationOp[],
    existsCache: Map<string, boolean>,
    abortSignal: AbortSignal | undefined,
  ): Promise<
    | { readonly status: "staged"; readonly files: StagedFile[] }
    | {
        readonly status: "rejected_conflict" | "rejected_stale" | "cancelled";
        readonly errorDetails: string;
        readonly files?: FileTransactionCommittedFile[];
      }
  > {
    const staged: StagedFile[] = [];
    for (const op of operations) {
      throwIfAborted(abortSignal);
      if (op.kind === "create") {
        const exists = await this.fileExists(params.fileSystemPort, op.path, existsCache);
        if (exists && op.overwrite !== true) {
          return {
            status: "rejected_conflict",
            errorDetails: `File already exists: ${op.displayPath ?? op.path}`,
          };
        }
        const before = exists ? await this.readExisting(params.fileSystemPort, op.path) : undefined;
        if (before && params.enforceStaleReadGuard) {
          assertFreshSnapshot(op.path, before.content, before.revision, params.readFileState, true);
        }
        staged.push({
          operation: exists ? "update" : "create",
          targetPath: op.path,
          displayPath: op.displayPath ?? op.path,
          beforeContent: before?.content ?? null,
          afterContent: op.content,
          beforeSha256: before ? sha256(before.content) : undefined,
          afterSha256: sha256(op.content),
          encoding: op.encoding ?? before?.encoding,
          lineEndings: op.lineEndings ?? before?.lineEndings,
          revision: before?.revision,
        });
        continue;
      }

      if (op.kind === "update") {
        const before = await this.readRequired(params.fileSystemPort, op.path, op.displayPath);
        if (params.enforceStaleReadGuard) {
          assertFreshSnapshot(op.path, before.content, before.revision, params.readFileState, false);
        }
        if (op.expectedRevisionId !== undefined && before.revision?.id !== op.expectedRevisionId) {
          return {
            status: "rejected_stale",
            errorDetails: `Revision mismatch for ${op.displayPath ?? op.path}: expected ${op.expectedRevisionId}, found ${before.revision?.id ?? "none"}.`,
          };
        }
        const computed = op.computeNext(before.content, {
          encoding: before.encoding,
          lineEndings: before.lineEndings,
          revision: before.revision,
        });
        staged.push({
          operation: "update",
          targetPath: op.path,
          displayPath: op.displayPath ?? op.path,
          beforeContent: before.content,
          afterContent: computed.content,
          beforeSha256: sha256(before.content),
          afterSha256: sha256(computed.content),
          encoding: before.encoding,
          lineEndings: before.lineEndings,
          revision: before.revision,
          appliedTier: computed.appliedTier,
        });
        continue;
      }

      if (op.kind === "move") {
        const before = await this.readRequired(params.fileSystemPort, op.fromPath, op.displayPath);
        if (params.enforceStaleReadGuard) {
          assertFreshSnapshot(op.fromPath, before.content, before.revision, params.readFileState, false);
        }
        if (op.expectedRevisionId !== undefined && before.revision?.id !== op.expectedRevisionId) {
          return {
            status: "rejected_stale",
            errorDetails: `Revision mismatch for ${op.displayPath ?? op.fromPath}: expected ${op.expectedRevisionId}, found ${before.revision?.id ?? "none"}.`,
          };
        }
        const computed = op.computeNext
          ? op.computeNext(before.content, {
              encoding: before.encoding,
              lineEndings: before.lineEndings,
              revision: before.revision,
            })
          : undefined;
        const targetExists = await this.fileExists(params.fileSystemPort, op.toPath, existsCache);
        if (targetExists) {
          return {
            status: "rejected_conflict",
            errorDetails: `Move destination already exists: ${op.toPath}`,
          };
        }
        staged.push({
          operation: "move",
          targetPath: op.toPath,
          displayPath: op.displayPath ?? op.toPath,
          moveFromPath: op.fromPath,
          sourcePath: op.fromPath,
          beforeContent: before.content,
          afterContent: computed?.content ?? before.content,
          beforeSha256: sha256(before.content),
          afterSha256: sha256(computed?.content ?? before.content),
          encoding: before.encoding,
          lineEndings: before.lineEndings,
          revision: before.revision,
          appliedTier: computed?.appliedTier,
        });
        continue;
      }

      const before = await this.readRequired(params.fileSystemPort, op.path, op.displayPath);
      if (params.enforceStaleReadGuard) {
        assertFreshSnapshot(op.path, before.content, before.revision, params.readFileState, false);
      }
      if (op.expectedRevisionId !== undefined && before.revision?.id !== op.expectedRevisionId) {
        return {
          status: "rejected_stale",
          errorDetails: `Revision mismatch for ${op.displayPath ?? op.path}: expected ${op.expectedRevisionId}, found ${before.revision?.id ?? "none"}.`,
        };
      }
      staged.push({
        operation: "delete",
        targetPath: op.path,
        displayPath: op.displayPath ?? op.path,
        beforeContent: before.content,
        afterContent: "",
        beforeSha256: sha256(before.content),
        encoding: before.encoding,
        lineEndings: before.lineEndings,
        revision: before.revision,
      });
    }

    return { status: "staged", files: staged };
  }

  private validateStagedFiles(
    params: FileTransactionExecuteParams,
    files: readonly StagedFile[],
  ):
    | { readonly status: "valid"; readonly files: FileTransactionCommittedFile[] }
    | { readonly status: "invalid"; readonly files: FileTransactionCommittedFile[]; readonly errorDetails: string } {
    const strict = params.strictSyntaxValidation ?? this.defaultStrictSyntaxValidation;
    const shouldRejectOnSyntax = strict && params.allowSyntaxDraft !== true;
    const committed: FileTransactionCommittedFile[] = [];

    for (const file of files) {
      if (file.operation === "delete") {
        committed.push(toCommittedFile(file));
        continue;
      }
      const diagnostic = this.syntaxValidator.validateBuffer({
        filePath: file.targetPath,
        content: file.afterContent,
        beforeContent: file.beforeContent ?? (file.operation === "create" ? null : undefined),
      });
      committed.push(toCommittedFile(file, diagnostic));

      // Дельта-правило: блокируем транзакцию только на новых синтаксических ошибках.
      if (shouldRejectOnSyntax && diagnostic.introducedErrors > 0) {
        const location = diagnostic.firstError;
        const where = location ? ` at line ${location.line}, column ${location.column}` : "";
        return {
          status: "invalid",
          files: committed,
          errorDetails: [
            `Syntax validation failed for ${file.displayPath}${where}: ${diagnostic.message ?? "invalid syntax"}`,
            location?.snippet ? `Offending code:\n${location.snippet}` : "",
            "No files were modified. Fix the syntax error before retrying.",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
    }

    return { status: "valid", files: committed };
  }

  private async commitSingleFile(
    params: FileTransactionExecuteParams,
    file: StagedFile,
    abortSignal: AbortSignal | undefined,
  ): Promise<readonly string[]> {
    const port = params.fileSystemPort;
    const createdParents: string[] = [];

    if (file.operation === "delete") {
      await port.removeFile({ path: file.targetPath, missingOk: true, trace: params.trace }, { signal: abortSignal });
      return createdParents;
    }

    const writeOptions = { signal: abortSignal };
    const writeAtomic = async (targetPath: string, content: string, expectedRevision?: StagedFile["revision"]) => {
      await port.writeTextFile(
        {
          path: targetPath,
          content,
          encoding: file.encoding ?? UTF8,
          lineEndings: file.lineEndings,
          createParents: true,
          atomic: true,
          expectedRevision,
          trace: params.trace,
        },
        writeOptions,
      );
    };

    // Двухфазная запись: FileSystemPort.atomic=true реализует temp+datasync+rename
    // в целевой директории (см. NodeFileSystemAdapter.atomicWrite).
    if (file.operation === "move" && file.sourcePath) {
      await writeAtomic(file.targetPath, file.afterContent);
      await port.removeFile({ path: file.sourcePath, missingOk: true, trace: params.trace }, writeOptions);
      return createdParents;
    }

    await writeAtomic(file.targetPath, file.afterContent, file.operation === "update" ? file.revision : undefined);
    return createdParents;
  }

  private async rollback(params: FileTransactionExecuteParams, applied: readonly AppliedStep[]): Promise<number> {
    let restored = 0;
    const port = params.fileSystemPort;
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      const { staged } = applied[index]!;
      try {
        if (staged.beforeContent === null) {
          await port.removeFile({ path: staged.targetPath, missingOk: true, trace: params.trace });
        } else {
          await port.writeTextFile({
            path: staged.targetPath,
            content: staged.beforeContent,
            encoding: staged.encoding ?? UTF8,
            lineEndings: staged.lineEndings,
            createParents: true,
            atomic: true,
            trace: params.trace,
          });
        }
        if (staged.operation === "move" && staged.sourcePath) {
          await port.writeTextFile({
            path: staged.sourcePath,
            content: staged.beforeContent ?? "",
            encoding: staged.encoding ?? UTF8,
            lineEndings: staged.lineEndings,
            createParents: true,
            atomic: true,
            trace: params.trace,
          });
        }
        restored += 1;
      } catch {
        // Откат best-effort: продолжаем восстанавливать остальные файлы пакета.
      }
    }
    return restored;
  }

  private syncReadFileState(params: FileTransactionExecuteParams, applied: readonly AppliedStep[]): void {
    const state = params.readFileState;
    if (!state) return;
    for (const { staged } of applied) {
      if (staged.operation === "delete") {
        for (const key of Array.from(state.keys())) {
          if (state.get(key)?.path === staged.targetPath) state.delete(key);
        }
        continue;
      }
      const entry: TransactionReadStateEntryLike = {
        path: staged.targetPath,
        content: staged.afterContent,
        isPartialView: false,
        readAt: new Date(),
        sourceTool: params.toolName ?? "MultiEdit",
        sizeBytes: Buffer.byteLength(staged.afterContent, "utf8"),
      };
      state.set(`${staged.targetPath}\u0000${1}\u0000`, entry);
    }
  }

  private async emitLifecycle(
    params: FileTransactionExecuteParams,
    transactionId: string,
    workspaceKey: string,
    status: FileTransactionLifecycleEvent["status"],
    files: readonly FileTransactionCommittedFile[],
    errorDetails?: string,
  ): Promise<void> {
    if (!params.onTransactionEvent) return;
    try {
      await params.onTransactionEvent({
        transactionId,
        workspacePath: params.workspacePath,
        workspaceIdentity: normalizeIdentity(params.workspaceIdentity),
        workspaceKey,
        sessionId: params.sessionId,
        turnId: params.turnId,
        agentId: params.agentId,
        toolCallId: params.toolCallId,
        toolName: params.toolName ?? "MultiEdit",
        status,
        timestamp: Date.now(),
        files,
        ...(errorDetails ? { errorDetails } : {}),
      });
    } catch {
      // Событие транзакции — уведомление; его ошибка не должна ломать уже завершённый коммит.
    }
  }

  private reportTaskProgress(
    params: FileTransactionExecuteParams,
    stepIndex: number,
    totalSteps: number,
    file: StagedFile,
  ): void {
    if (params.taskId === undefined || params.taskRegistry === undefined) return;
    params.taskRegistry.reportProgress(params.taskId, {
      stepIndex,
      totalSteps,
      path: file.displayPath,
      operation: file.operation,
      percent: totalSteps === 0 ? 100 : (stepIndex / totalSteps) * 100,
    });
  }

  private async fileExists(
    port: FileSystemPort,
    path: string,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    try {
      const info = await port.stat({ path });
      const exists = info.kind === "file" || info.kind === "symlink";
      cache.set(path, exists);
      return exists;
    } catch (error) {
      if (isFileSystemPortError(error) && error.code === "not_found") {
        cache.set(path, false);
        return false;
      }
      throw error;
    }
  }

  private async readExisting(port: FileSystemPort, path: string) {
    return port.readTextFile({ path });
  }

  private async readRequired(port: FileSystemPort, path: string, displayPath?: string) {
    try {
      return await port.readTextFile({ path });
    } catch (error) {
      if (isFileSystemPortError(error) && error.code === "not_found") {
        throw new TransactionStageError(`File not found: ${displayPath ?? path}`);
      }
      throw error;
    }
  }
}

export class TransactionStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionStageError";
  }
}

export function createFileTransactionManager(options: FileTransactionManagerOptions): IFileTransactionManager {
  return new FileTransactionManager(options);
}

function mergeOperations(operations: readonly FileMutationOp[]): FileMutationOp[] {
  const byTarget = new Map<string, FileMutationOp>();
  for (const op of operations) {
    const key = op.kind === "move" ? `move:${op.toPath}` : op.kind === "delete" ? `delete:${op.path}` : `${op.kind === "create" ? "create" : "update"}:${op.path}`;
    byTarget.set(key, op);
  }
  return [...byTarget.values()];
}

function buildLockEntries(operations: readonly FileMutationOp[]) {
  const entries: Array<{ path: string; mode: "exclusive-write" }> = [];
  for (const op of operations) {
    if (op.kind === "move") {
      entries.push({ path: op.fromPath, mode: "exclusive-write" });
      entries.push({ path: op.toPath, mode: "exclusive-write" });
      continue;
    }
    entries.push({ path: op.path, mode: "exclusive-write" });
  }
  return entries;
}

function toCommittedFile(file: StagedFile, syntaxDiagnostic?: SyntaxValidationDiagnostic): FileTransactionCommittedFile {
  return {
    path: file.targetPath,
    displayPath: file.displayPath,
    ...(file.moveFromPath ? { moveFromPath: file.moveFromPath } : {}),
    operation: file.operation,
    ...(file.appliedTier ? { appliedTier: file.appliedTier } : {}),
    beforeContent: file.beforeContent,
    afterContent: file.afterContent,
    ...(file.beforeSha256 ? { beforeSha256: file.beforeSha256 } : {}),
    ...(file.afterSha256 ? { afterSha256: file.afterSha256 } : {}),
    ...(file.encoding ? { encoding: file.encoding } : {}),
    ...(file.lineEndings ? { lineEndings: file.lineEndings } : {}),
    ...(file.revision ? { revision: file.revision } : {}),
    ...(syntaxDiagnostic ? { syntaxDiagnostic } : {}),
  };
}

function assertFreshSnapshot(
  path: string,
  currentContent: string,
  revision: StagedFile["revision"],
  readFileState: Map<string, TransactionReadStateEntryLike> | undefined,
  allowMissingReadState: boolean,
): void {
  if (!readFileState) return;
  const lastRead = findLatestReadState(readFileState, path);
  if (!lastRead) {
    if (allowMissingReadState) return;
    throw new TransactionStageError(
      `File has not been read yet: ${path}. Read it first before writing to it.`,
    );
  }
  if (lastRead.isPartialView) {
    throw new TransactionStageError(
      `Only a partial view of ${path} was read; read the full file before editing it.`,
    );
  }
  const revisionChanged =
    lastRead.revisionId !== undefined &&
    revision?.id !== undefined &&
    lastRead.revisionId !== revision.id;
  const contentChanged =
    revisionChanged &&
    lastRead.content !== currentContent &&
    (lastRead.offset ?? 1) <= 1 &&
    lastRead.limit === undefined;
  if (contentChanged) {
    throw new TransactionStageError(
      `File has been modified since read: ${path}. Read it again before writing to it.`,
    );
  }
}

function findLatestReadState(
  readFileState: Map<string, TransactionReadStateEntryLike>,
  path: string,
): TransactionReadStateEntryLike | undefined {
  let latest: TransactionReadStateEntryLike | undefined;
  for (const entry of readFileState.values()) {
    if (entry.path !== path) continue;
    if (!latest || entry.readAt.getTime() >= latest.readAt.getTime()) latest = entry;
  }
  return latest;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function createTransactionId(sessionId: string): string {
  return `tx_${sessionId.replace(/[^a-zA-Z0-9_-]/gu, "_")}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveWorkspaceKey(params: { workspaceIdentity?: string; workspacePath: string }): string {
  return normalizeIdentity(params.workspaceIdentity) || params.workspacePath;
}

function normalizeIdentity(identity: string | undefined): string | undefined {
  const trimmed = identity?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Объединяет внешний сигнал отмены с сигналом фоновой задачи.
 * `AbortSignal.any` доступен с Node 20; проект требует Node >= 22 (см. mise.toml),
 * поэтому отдельная реализация не нужна.
 */
function combineAbortSignals(
  external: AbortSignal | undefined,
  taskSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!external) return taskSignal;
  if (!taskSignal) return external;
  if (external === taskSignal) return external;
  return AbortSignal.any([external, taskSignal]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error("Transaction cancelled");
  error.name = "AbortError";
  throw error;
}
