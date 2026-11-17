// ============================================================
// Write Tool Handler
// ============================================================

import type { ToolHandler, ToolEntry } from "../types.js";
import {
  CoreErrorType,
  WriteInputJsonSchema,
  WriteInputSchema,
  WriteOutputJsonSchema,
  WriteOutputSchema,
  createCoreError,
  type FileSystemReadTextResult,
  type WriteInput,
  type TraceContext,
} from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import { createTransactionHooks } from "./transaction-hooks.js";
import {
  createFileTransactionManager,
  type FileStagedSnapshot,
  type IFileLockRegistry,
  type TransactionReadStateEntryLike,
} from "../file-transaction/index.js";
import { stampMemoryOriginSessionId } from "../../memory/origin-session.js";
import {
  assertPathWithinWriteScope,
  resolveWorkspacePath,
  workspaceBoundaryOptions,
} from "../path-policy.js";
import {
  createReadFileStateKey,
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import type { ReadFileStateEntry, ReadFileStateMap, ToolExecutionContext } from "../types.js";
import {
  attachToolExecutionTelemetry,
  elapsedMsSince,
  fileByteCount,
  workspaceKind,
} from "./tool-perf.js";

const WRITE_PROVIDER_DESCRIPTION = [
  "Writes a file to the local filesystem, overwriting if one exists.",
  "",
  "When to use: creating a new file, or fully replacing one you've already Read. Overwriting an existing file you haven't Read will fail. For partial changes, use Edit instead.",
].join("\n");

const WRITE_STORAGE_SUFFIX =
  " (file state is current in your context \u2014 no need to Read it back)";
const WRITE_USER_MODIFIED_NOTE = " The user modified your proposed content before accepting it.";
const WRITE_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
const WRITE_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

/** Fallback для unit-тестов без runtime-реестра; в проде всегда приходит единый FileLockRegistry. */
const NOOP_LOCK_REGISTRY: IFileLockRegistry = {
  resolveCanonicalLockKey: async (_identity, _root, target) => target,
  acquire: async () => ({ canonicalKeys: [], release() {} }),
  acquireBatch: async () => ({ canonicalKeys: [], release() {} }),
  withLocks: async (_entries, _options, fn) => fn(),
  releaseByHolder: () => 0,
  getActiveLockSnapshot: () => [],
};

function formatWriteModelContent(output: unknown): string {
  if (!isRecord(output)) {
    return "The file has been written successfully.";
  }

  const filePath = typeof output.filePath === "string" ? output.filePath : "the file";
  const userModified = output.userModified === true;
  const userModifiedNote = userModified ? WRITE_USER_MODIFIED_NOTE : "";
  const storageSuffixNote = userModified ? "" : WRITE_STORAGE_SUFFIX;

  if (output.type === "create") {
    return `File created successfully at: ${filePath}${userModifiedNote}${storageSuffixNote}`;
  }

  return `The file ${filePath} has been updated successfully.${userModifiedNote}${storageSuffixNote}`;
}

export const writeHandler: ToolHandler = async (input, context) => {
  const { file_path, content } = WriteInputSchema.parse(input) as WriteInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Write tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Write",
        },
        recoverable: false,
      },
    );
  }

  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    ...workspaceBoundaryOptions(context),
  });
  // 原因: write_paths был только подсказкой для ledger; фактическая запись не ограничивалась.
  assertPathWithinWriteScope({
    filePath,
    workspaceRoot: context.workspaceRoot,
    writeScope: context.writeScope,
  });

  // 原因 (F-07): Write раньше писал буфер на диск без AST/синтаксической проверки.
  // Теперь файл проходит через общий FileTransactionManager: staging -> SyntaxValidator ->
  // атомарный commit с 100% откатом; readFileState обновляется только после успешного commit.
  const contentToWrite = stampMemoryOriginSessionId({
    content,
    filePath,
    memoryRoot: context.memoryRoot,
    sessionId: context.sessionId,
  });
  let stagedBefore: string | null = null;
  let stagedRevision: FileSystemReadTextResult["revision"];

  // Freshness-проверка выполняется по уже снятому в памяти staged-снимку,
  // поэтому файл читается ровно один раз (staging транзакции) и нет TOCTOU-окна между read и commit.
  const onStagedFiles = (files: readonly FileStagedSnapshot[]): void => {
    const staged = files[0];
    if (!staged) return;
    stagedBefore = staged.beforeContent;
    stagedRevision = staged.revision;
    if (staged.beforeContent === null) return;
    assertWritableExistingFileIsFresh(
      filePath,
      {
        path: filePath,
        content: staged.beforeContent,
        encoding: staged.encoding ?? "utf8",
        lineEndings: staged.lineEndings,
        bytesRead: Buffer.byteLength(staged.beforeContent, "utf8"),
        sizeBytes: staged.revision?.sizeBytes ?? Buffer.byteLength(staged.beforeContent, "utf8"),
        truncated: false,
        revision: staged.revision,
      },
      context.readFileState,
    );
  };

  const manager = createFileTransactionManager({
    lockRegistry: context.fileLockRegistry ?? NOOP_LOCK_REGISTRY,
  });
  const writeStartedAt = Date.now();
  const result = await manager.executeTransaction({
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspaceRoot,
    sessionId: context.sessionId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
    toolName: "Write",
    operations: [
      {
        kind: "create",
        path: filePath,
        displayPath: file_path,
        content: contentToWrite,
        overwrite: true,
      },
    ],
    fileSystemPort,
    readFileState: context.readFileState as unknown as Map<
      string,
      TransactionReadStateEntryLike
    > | undefined,
    enforceStaleReadGuard: false,
    strictSyntaxValidation: true,
    abortSignal: context.abortSignal,
    trace: createWriteTrace(context),
    onStagedFiles,
    // Реактивная синхронизация: полный патч для Electron, сводка для Web/Mobile.
    onTransactionEvent: createTransactionHooks(context),
  });
  const fsWriteMs = elapsedMsSince(writeStartedAt);
  const fsReadMs = result.readMs;

  if (result.status !== "committed") {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      result.errorDetails ?? `Write transaction ended with status ${result.status}.`,
      {
        context: {
          code: result.status === "rejected_syntax" ? "write_syntax_validation_failed" : "write_failed",
          filePath,
          toolCallId: context.toolCallId,
          toolName: "Write",
          transactionStatus: result.status,
        },
        recoverable: true,
      },
    );
  }

  // Pipeline сам обновляет readFileState; revision берём из результата транзакции.
  const committed = result.files[0];
  const readFileStateEntry = updateReadFileStateAfterWrite(
    context.readFileState,
    filePath,
    contentToWrite,
    committed?.revision ?? stagedRevision,
  );
  recordReadFileStateMetadata(context, readFileStateEntry);

  const originalFile = stagedBefore;
  if (originalFile !== null) {
    return attachToolExecutionTelemetry(
      {
        type: "update",
        filePath: file_path,
        content: contentToWrite,
        structuredPatch: createStructuredPatch({
          filePath: file_path,
          oldContent: originalFile,
          newContent: contentToWrite,
        }),
        originalFile,
        userModified: false,
      },
      createWritePerformanceTelemetry({
        content: contentToWrite,
        fsReadMs,
        fsWriteMs,
        context,
      }),
    );
  }

  return attachToolExecutionTelemetry(
    {
      type: "create",
      filePath: file_path,
      content: contentToWrite,
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    },
    createWritePerformanceTelemetry({
      content: contentToWrite,
      fsReadMs,
      fsWriteMs,
      context,
    }),
  );
};

function createWritePerformanceTelemetry(input: {
  content: string;
  context: ToolExecutionContext;
  fsReadMs: number;
  fsWriteMs: number;
}) {
  const totalBytes = fileByteCount(input.content);
  return {
    detail: {
      kind: "filesystem" as const,
      filesystem: {
        readMs: input.fsReadMs,
        writeMs: input.fsWriteMs,
        fileCount: 1,
        totalBytes,
        maxFileBytes: totalBytes,
        workspaceKind: workspaceKind(input.context),
      },
    },
  };
}

export const writeToolEntry: ToolEntry = {
  capability: "Create or overwrite a file through the file-system adapter",
  metadata: {
    name: "Write",
    description: WRITE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  resolveWorkspaceBoundaryPaths: (input) => {
    const parsed = WriteInputSchema.safeParse(input);
    return parsed.success ? [{ path: parsed.data.file_path, operation: "write" }] : [];
  },
  handler: writeHandler,
  formatModelContent: formatWriteModelContent,
  inputSchema: WriteInputJsonSchema,
  outputSchema: WriteOutputJsonSchema,
  runtimeInputSchema: WriteInputSchema,
  runtimeOutputSchema: WriteOutputSchema,
  permission: {
    permission: "edit",
    reason: "Write creates or overwrites files through the file-system adapter",
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
    preview: {
      maxBytes: 100_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Write was cancelled before the file operation completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function createWriteTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

function assertWritableExistingFileIsFresh(
  filePath: string,
  currentRead: FileSystemReadTextResult,
  readFileState: ReadFileStateMap | undefined,
): void {
  const lastRead = findLatestReadFileState(readFileState, filePath);
  if (!lastRead || lastRead.isPartialView) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_NOT_READ_MESSAGE, {
      context: {
        code: "write_file_not_read",
        filePath,
      },
      recoverable: true,
    });
  }

  if (!hasReadStateChanged(lastRead, currentRead)) return;
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return;

  throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_STALE_MESSAGE, {
    context: {
      code: "write_file_stale",
      filePath,
    },
    recoverable: true,
  });
}

function hasReadStateChanged(
  lastRead: ReadFileStateEntry,
  currentRead: FileSystemReadTextResult,
): boolean {
  const currentRevisionId = currentRead.revision?.id;
  if (lastRead.revisionId && currentRevisionId && lastRead.revisionId !== currentRevisionId) {
    return true;
  }

  const currentMtimeMs = currentRead.revision?.mtimeMs;
  if (lastRead.mtimeMs !== undefined && currentMtimeMs !== undefined) {
    // 让已确认内容未变的 Write 被误判为 stale。
    const normalizedCurrentMtimeMs = normalizeReadFileStateMtimeMs(currentMtimeMs);
    const normalizedLastReadMtimeMs = normalizeReadFileStateMtimeMs(lastRead.mtimeMs);
    const mtimeAdvanced =
      normalizedCurrentMtimeMs !== undefined &&
      normalizedLastReadMtimeMs !== undefined &&
      normalizedCurrentMtimeMs > normalizedLastReadMtimeMs;
    return mtimeAdvanced || lastRead.sizeBytes !== currentRead.sizeBytes;
  }

  if (lastRead.sizeBytes !== undefined && lastRead.sizeBytes !== currentRead.sizeBytes) {
    return true;
  }

  return isStrictFullRead(lastRead) && lastRead.content !== currentRead.content;
}

function isStrictFullRead(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}

function updateReadFileStateAfterWrite(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  content: string,
  revision: FileSystemReadTextResult["revision"] | undefined,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;
  const entry: ReadFileStateEntry = {
    path: filePath,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Write",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs),
    sizeBytes: revision?.sizeBytes ?? Buffer.byteLength(content, "utf8"),
  };
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), entry);
  return entry;
}

function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: "Write",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
