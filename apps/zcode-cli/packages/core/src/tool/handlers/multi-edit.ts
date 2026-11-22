// ============================================================
// MultiEdit Tool Handler — Atomic multi-file, multi-block transactions
// ============================================================

import {
  CoreErrorType,
  MULTI_EDIT_TOOL_NAME,
  MultiEditErrorCode,
  MultiEditInputJsonSchema,
  MultiEditInputSchema,
  MultiEditOutputJsonSchema,
  MultiEditOutputSchema,
  createCoreError,
  type DiffHunk,
  type MultiEditInput,
  type MultiEditOperation,
  type MultiEditOutput,
  type MultiEditToolOutputFile,
  type TraceContext,
} from "@zcode/contracts";
import { createMultiTierDiffEngine, type IMultiTierDiffEngine } from "../diff-engine/index.js";
import {
  createFileTransactionManager,
  type FileMutationOp,
  type FileTransactionCommittedFile,
  type IFileTransactionManager,
  type TransactionReadStateEntryLike,
} from "../file-transaction/index.js";
import { createStructuredPatch } from "../diff.js";
import { stampMemoryOriginSessionId } from "../../memory/origin-session.js";
import {
  assertPathWithinWriteScope,
  resolveWorkspacePath,
  workspaceBoundaryOptions,
} from "../path-policy.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import { attachToolExecutionTelemetry, elapsedMsSince, workspaceKind } from "./tool-perf.js";
import { createTransactionHooks } from "./transaction-hooks.js";

const diffEngine: IMultiTierDiffEngine = createMultiTierDiffEngine();

const MULTI_EDIT_PROVIDER_DESCRIPTION = [
  "Applies an atomic transaction of multiple file operations (create / edit / delete) across many files.",
  "",
  "All operations succeed together or none are applied — the workspace is never left half-written.",
  "Each `edit` operation takes an `edits` array of ordered, non-overlapping search/replace blocks inside that file.",
  "",
  "Use this instead of many sequential Edit/Write calls when changes span multiple files or a file has several blocks:",
  "- `file_path` may be absolute or workspace-relative.",
  "- Strip the Read line-number prefix before matching old_string.",
  "- Syntax is pre-validated before anything is written; broken TS/JS/JSON/Python is rejected with exact line/column.",
  "- Set `run_in_background: true` only for very large batches.",
].join("\n");

interface PreparedOperation {
  readonly op: FileMutationOp;
  readonly displayPath: string;
  readonly appliedTier?: string;
}

const NOOP_LOCK_REGISTRY: NonNullable<ToolExecutionContext["fileLockRegistry"]> = {
  resolveCanonicalLockKey: async (_identity: string | undefined, _root: string, target: string) => target,
  acquire: async () => ({ canonicalKeys: [], release() {} }),
  acquireBatch: async () => ({ canonicalKeys: [], release() {} }),
  withLocks: async <T>(_entries: unknown, _options: unknown, fn: () => Promise<T>) => fn(),
  releaseByHolder: () => 0,
  getActiveLockSnapshot: () => [],
};

export const multiEditHandler: ToolHandler = async (input, context) => {
  const parsed = MultiEditInputSchema.parse(input) as MultiEditInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for MultiEdit tool",
      { context: { toolCallId: context.toolCallId, toolName: MULTI_EDIT_TOOL_NAME }, recoverable: false },
    );
  }
  if (parsed.operations.length === 0) {
    throw multiEditError("MultiEdit requires at least one operation.", MultiEditErrorCode.EMPTY_OPERATIONS, context);
  }

  const prepared: PreparedOperation[] = [];
  const touchedPaths = new Set<string>();
  for (const operation of parsed.operations) {
    if (operation.kind === "edit" && operation.edits.length === 0) {
      throw multiEditError(
        `MultiEdit operation for ${operation.file_path} has an empty edits array.`,
        MultiEditErrorCode.EMPTY_EDITS,
        context,
      );
    }
    const resolved = prepareOperation(operation, context);
    for (const path of resolved.paths) {
      if (touchedPaths.has(path)) {
        throw multiEditError(
          `Duplicate target path in one transaction: ${path}. Combine its blocks into a single operation.`,
          MultiEditErrorCode.CONFLICT,
          context,
        );
      }
      touchedPaths.add(path);
    }
    prepared.push({ op: resolved.op, displayPath: resolved.displayPath });
  }

  const manager = createManager(context);
  const transactionStartedAt = Date.now();
  const taskRegistry = context.fileTransactionTaskRegistry;
  const backgroundTaskId =
    parsed.run_in_background === true && taskRegistry !== undefined
      ? startBackgroundTransaction({
          context,
          prepared,
          parsed,
          manager,
          fileSystemPort,
          taskRegistry,
        })
      : undefined;

  if (backgroundTaskId !== undefined) {
    return {
      transactionId: backgroundTaskId,
      status: "background_started",
      files: [],
      summary: `MultiEdit transaction started in background with ID: ${backgroundTaskId}. You will be notified when it completes.`,
      structuredPatch: [],
      backgroundTaskId,
    } satisfies MultiEditOutput;
  }

  const result = await manager.executeTransaction({
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspaceRoot,
    sessionId: context.sessionId,
    turnId: context.turnId,
    agentId: context.callerAgentType,
    toolCallId: context.toolCallId,
    toolName: MULTI_EDIT_TOOL_NAME,
    operations: prepared.map((item) => item.op),
    fileSystemPort,
    readFileState: context.readFileState as unknown as Map<string, TransactionReadStateEntryLike> | undefined,
    enforceStaleReadGuard: true,
    strictSyntaxValidation: parsed.strict_syntax_validation !== false,
    allowSyntaxDraft: parsed.allow_syntax_draft === true,
    abortSignal: context.abortSignal,
    trace: createMultiEditTrace(context),
    onTransactionEvent: createTransactionHooks(context),
  });

  if (result.status !== "committed") {
    throw buildTransactionError(result, prepared, context);
  }

  const files = toOutputFiles(result.files, prepared);
  applyReadFileState(context, files, result.files);

  const structuredPatch = files.flatMap((file) => file.structuredPatch);
  const summary = files.map(formatSummaryLine).join("\n");
  const output: MultiEditOutput = {
    transactionId: result.transactionId,
    status: "committed",
    files,
    summary,
    structuredPatch,
  };

  return attachToolExecutionTelemetry(output, {
    detail: {
      kind: "filesystem",
      filesystem: {
        readMs: result.readMs,
        writeMs: result.commitMs,
        fileCount: files.length,
        totalBytes: totalChangedBytes(result.files),
        maxFileBytes: maxChangedBytes(result.files),
        workspaceKind: workspaceKind(context),
      },
    },
    totalMs: elapsedMsSince(transactionStartedAt),
  });
};

function createManager(context: ToolExecutionContext): IFileTransactionManager {
  // Runtime всегда передаёт единый FileLockRegistry; NOOP-фолбэк держит handler
  // работоспособным в изолированных unit-тестах без реестра.
  return createFileTransactionManager({
    lockRegistry: context.fileLockRegistry ?? NOOP_LOCK_REGISTRY,
  });
}

interface PreparedTarget {
  readonly op: FileMutationOp;
  readonly displayPath: string;
  readonly paths: readonly string[];
  readonly appliedTier?: string;
}

function prepareOperation(
  operation: MultiEditOperation,
  context: ToolExecutionContext,
): PreparedTarget {
  const filePath = resolveWorkspacePath({
    inputPath: operation.file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    ...workspaceBoundaryOptions(context),
  });
  assertPathWithinWriteScope({
    filePath,
    workspaceRoot: context.workspaceRoot,
    writeScope: context.writeScope,
  });

  if (operation.kind === "create") {
    const content = stampMemoryOriginSessionId({
      content: operation.content,
      filePath,
      memoryRoot: context.memoryRoot,
      sessionId: context.sessionId,
    });
    return {
      op: { kind: "create", path: filePath, displayPath: operation.file_path, content, overwrite: operation.overwrite === true },
      displayPath: operation.file_path,
      paths: [filePath],
    };
  }

  if (operation.kind === "delete") {
    return {
      op: { kind: "delete", path: filePath, displayPath: operation.file_path },
      displayPath: operation.file_path,
      paths: [filePath],
    };
  }

  const blocks = operation.edits;
  let appliedTier: string | undefined;
  const op: FileMutationOp = {
    kind: "update",
    path: filePath,
    displayPath: operation.file_path,
    computeNext: (current) => {
      const outcome = diffEngine.applyMultiHunkEdits(
        current,
        blocks.map((block) => ({ oldString: block.old_string, newString: block.new_string })),
      );
      if (outcome.status !== "applied") {
        throw createMultiEditMatchError(filePath, outcome, context);
      }
      appliedTier = outcome.appliedTier;
      return { content: outcome.content, appliedTier: outcome.appliedTier };
    },
  };
  return { op, displayPath: operation.file_path, paths: [filePath], appliedTier };
}

function createMultiEditMatchError(
  filePath: string,
  outcome: Exclude<ReturnType<IMultiTierDiffEngine["applyMultiHunkEdits"]>, { status: "applied" }>,
  context: ToolExecutionContext,
): Error {
  if (outcome.status === "conflict") {
    return multiEditError(
      `Cannot merge hunks in ${filePath}: ${outcome.conflict.message}`,
      MultiEditErrorCode.CONFLICT,
      context,
      { conflict: outcome.conflict },
    );
  }
  return multiEditError(
    `${outcome.status === "ambiguous" ? "Ambiguous patch" : "Patch did not match"} in ${filePath}:\n${outcome.diagnostic.formatted}`,
    MultiEditErrorCode.STALE_FILE,
    context,
    { matchStatus: outcome.status, failedHunkIndex: outcome.failedHunkIndex, similarity: outcome.diagnostic.similarity },
  );
}

function buildTransactionError(
  result: Awaited<ReturnType<IFileTransactionManager["executeTransaction"]>>,
  prepared: readonly PreparedOperation[],
  context: ToolExecutionContext,
): Error {
  const codeByStatus: Record<string, MultiEditErrorCode> = {
    rejected_syntax: MultiEditErrorCode.SYNTAX_VALIDATION_FAILED,
    rejected_stale: MultiEditErrorCode.STALE_FILE,
    rejected_conflict: MultiEditErrorCode.CONFLICT,
    rolled_back_on_error: MultiEditErrorCode.COMMIT_FAILED,
    cancelled: MultiEditErrorCode.CANCELLED,
    committed: MultiEditErrorCode.COMMIT_FAILED,
  };
  const files = toOutputFiles(result.files, prepared);
  const diagnostics = result.files
    .map((file) => file.syntaxDiagnostic)
    .filter((item): item is NonNullable<typeof item> => item !== undefined && item.introducedErrors > 0)
    .map((item) => ({
      filePath: item.path,
      language: item.language,
      ...(item.firstError ? { line: item.firstError.line, column: item.firstError.column, snippet: item.firstError.snippet } : {}),
      ...(item.message ? { message: item.message } : {}),
    }));

  return multiEditError(
    [
      result.errorDetails ?? `MultiEdit transaction ended with status ${result.status}.`,
      diagnostics.length > 0 ? `Syntax diagnostics: ${diagnostics.length} file(s) rejected.` : "",
      files.length > 0 ? `Files in transaction: ${files.map((file) => file.filePath).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    codeByStatus[result.status] ?? MultiEditErrorCode.COMMIT_FAILED,
    context,
    {
      transactionStatus: result.status,
      transactionId: result.transactionId,
      rolledBackSteps: result.rolledBackSteps,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    },
  );
}

function toOutputFiles(
  committed: readonly FileTransactionCommittedFile[],
  prepared: readonly PreparedOperation[],
): MultiEditToolOutputFile[] {
  const tierByPath = new Map(prepared.map((item) => [item.displayPath, item.appliedTier] as const));
  return committed.map((file) => {
    const structuredPatch = createStructuredPatch({
      filePath: file.displayPath,
      oldContent: file.beforeContent ?? "",
      newContent: file.afterContent,
    });
    const { additions, deletions } = countPatchLines(structuredPatch);
    const appliedTier = file.appliedTier ?? tierByPath.get(file.displayPath);
    return {
      filePath: file.displayPath,
      operation: file.operation,
      ...(appliedTier ? { appliedTier } : {}),
      additions,
      deletions,
      structuredPatch,
      syntaxValid: file.syntaxDiagnostic?.valid ?? true,
    };
  });
}

function applyReadFileState(
  context: ToolExecutionContext,
  files: readonly MultiEditToolOutputFile[],
  committed: readonly FileTransactionCommittedFile[],
): void {
  const state = context.readFileState;
  if (!state) return;
  const commitByDisplayPath = new Map(committed.map((file) => [file.displayPath, file] as const));
  for (const file of files) {
    const record = commitByDisplayPath.get(file.filePath);
    if (!record) continue;
    const entry = {
      path: record.path,
      content: record.afterContent,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
      readAt: new Date(),
      sourceTool: "Edit" as const,
      revisionId: record.revision?.id,
      mtimeMs: normalizeReadFileStateMtimeMs(record.revision?.mtimeMs),
      sizeBytes: record.revision?.sizeBytes ?? Buffer.byteLength(record.afterContent, "utf8"),
    };
    state.set(createReadFileStateKey(record.path, 1, undefined), entry);
    if (context.recordReadFileStateMetadata) {
      const metadata = createReadFileStateMetadataFromEntry({
        completedAt: entry.readAt,
        entry,
        toolName: "Edit",
      });
      if (metadata) context.recordReadFileStateMetadata(metadata);
    }
  }
}

export const multiEditToolEntry: ToolEntry = {
  capability: "Apply an atomic multi-file, multi-block edit transaction",
  metadata: {
    name: MULTI_EDIT_TOOL_NAME,
    description: MULTI_EDIT_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 120000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  resolveWorkspaceBoundaryPaths: (input) => {
    const parsed = MultiEditInputSchema.safeParse(input);
    if (!parsed.success) return [];
    return parsed.data.operations.map((operation) => ({
      path: operation.file_path,
      operation: "write" as const,
    }));
  },
  handler: multiEditHandler,
  formatModelContent: formatMultiEditModelContent,
  inputSchema: MultiEditInputJsonSchema,
  outputSchema: MultiEditOutputJsonSchema,
  runtimeInputSchema: MultiEditInputSchema,
  runtimeOutputSchema: MultiEditOutputSchema,
  permission: {
    permission: "edit",
    reason: "MultiEdit applies an atomic group of file mutations",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 1_000_000,
    maxModelBytes: 100_000,
    strategy: "truncate",
    preview: { maxBytes: 100_000, direction: "head" },
  },
  timeout: { defaultMs: 120000, maxMs: 120000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "MultiEdit was cancelled and all files were restored",
  },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

function formatMultiEditModelContent(output: unknown): string {
  const parsed = MultiEditOutputSchema.safeParse(output);
  if (!parsed.success) return "MultiEdit transaction completed.";
  const { files, summary } = parsed.data;
  const header = `MultiEdit committed ${files.length} file(s) atomically.`;
  return summary ? `${header}\n${summary}` : header;
}

function formatSummaryLine(file: MultiEditToolOutputFile): string {
  const marker =
    file.operation === "create" ? "A" : file.operation === "delete" ? "D" : file.operation === "update" ? "M" : "?";
  return `${marker} ${file.filePath} (+${file.additions}/-${file.deletions})`;
}

function countPatchLines(hunks: readonly DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function totalChangedBytes(files: readonly FileTransactionCommittedFile[]): number {
  return files.reduce((total, file) => total + Buffer.byteLength(file.afterContent, "utf8"), 0);
}

function maxChangedBytes(files: readonly FileTransactionCommittedFile[]): number {
  return files.reduce((max, file) => Math.max(max, Buffer.byteLength(file.afterContent, "utf8")), 0);
}

function createMultiEditTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

function multiEditError(
  message: string,
  code: MultiEditErrorCode,
  context: ToolExecutionContext,
  extra: Record<string, unknown> = {},
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    context: {
      ...extra,
      code,
      toolCallId: context.toolCallId,
      toolName: MULTI_EDIT_TOOL_NAME,
    },
    recoverable: true,
  });
}

/**
 * Запускает транзакцию как фоновую задачу.
 *
 * Владелец жизненного цикла — `FileTransactionTaskRegistry`: он выдаёт
 * `AbortController`, публикует `queued → running → completed|failed|cancelled`
 * и снимает локи при отмене. Транзакция получает `taskId`, поэтому сама
 * сообщает прогресс по шагам коммита и не требует отдельного поллера.
 */
function startBackgroundTransaction(params: {
  readonly context: ToolExecutionContext;
  readonly prepared: readonly PreparedOperation[];
  readonly parsed: MultiEditInput;
  readonly manager: IFileTransactionManager;
  readonly fileSystemPort: NonNullable<ToolExecutionContext["fileSystemPort"]>;
  readonly taskRegistry: NonNullable<ToolExecutionContext["fileTransactionTaskRegistry"]>;
}): string {
  const { context, prepared, parsed, manager, fileSystemPort, taskRegistry } = params;
  const taskId = `multi-edit:${context.sessionId}:${context.toolCallId}`;
  const holderId = `${context.sessionId}:${context.toolCallId}`;
  taskRegistry.register({
    taskId,
    workspaceKey: context.workspaceIdentity?.trim() || context.workspaceRoot,
    sessionId: context.sessionId,
    ...(context.turnId ? { turnId: context.turnId } : {}),
    toolName: MULTI_EDIT_TOOL_NAME,
    holderId,
    affectedPaths: prepared.map((item) => item.displayPath),
  });

  // Отмена инструмента (AbortSignal) должна освобождать и локи, и статус задачи.
  const abortListener = () => taskRegistry.cancel(taskId, "MultiEdit cancelled by tool abort");
  context.abortSignal.addEventListener("abort", abortListener, { once: true });

  void manager
    .executeTransaction({
      workspaceIdentity: context.workspaceIdentity,
      workspacePath: context.workspaceRoot,
      sessionId: context.sessionId,
      turnId: context.turnId,
      agentId: context.callerAgentType,
      toolCallId: context.toolCallId,
      toolName: MULTI_EDIT_TOOL_NAME,
      operations: prepared.map((item) => item.op),
      fileSystemPort,
      readFileState: context.readFileState as unknown as Map<string, TransactionReadStateEntryLike> | undefined,
      enforceStaleReadGuard: true,
      strictSyntaxValidation: parsed.strict_syntax_validation !== false,
      allowSyntaxDraft: parsed.allow_syntax_draft === true,
      abortSignal: context.abortSignal,
      trace: createMultiEditTrace(context),
      onTransactionEvent: createTransactionHooks(context),
      taskId,
      taskRegistry,
    })
    .catch(() => {
      // Терминальный статус уже выставлен реестром; здесь только гасим unhandled rejection.
    })
    .finally(() => {
      context.abortSignal.removeEventListener("abort", abortListener);
    });

  return taskId;
}
