import type { ToolEntry, ToolHandler } from "../types.js";
import {
  ApplyPatchErrorCode,
  ApplyPatchInputJsonSchema,
  ApplyPatchInputSchema,
  ApplyPatchOutputJsonSchema,
  ApplyPatchOutputSchema,
  CoreErrorType,
  createCoreError,
  type ApplyPatchFileChange,
  type ApplyPatchInput,
  type ApplyPatchOutput,
  type TraceContext,
} from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import { createMultiTierDiffEngine, type IMultiTierDiffEngine } from "../diff-engine/index.js";
import {
  createFileTransactionManager,
  type FileMutationOp,
  type FileTransactionCommittedFile,
  type IFileTransactionManager,
  type TransactionReadStateEntryLike,
} from "../file-transaction/index.js";
import { parseStructuredPatch, type ParsedPatch } from "../patch-parser.js";
import { createTransactionHooks } from "./transaction-hooks.js";
import {
  assertPathWithinWriteScope,
  resolveWorkspacePath,
  workspaceBoundaryOptions,
} from "../path-policy.js";

const diffEngine: IMultiTierDiffEngine = createMultiTierDiffEngine();

export const applyPatchHandler: ToolHandler = async (input, context) => {
  const { patch_text } = ApplyPatchInputSchema.parse(input) as ApplyPatchInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for ApplyPatch tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "ApplyPatch",
        },
        recoverable: false,
      },
    );
  }

  const sections = parsePatchOrThrow(patch_text, context.toolCallId);
  if (sections.length === 0) {
    throw createPatchError("patch rejected: empty patch", ApplyPatchErrorCode.EMPTY_PATCH, {
      toolCallId: context.toolCallId,
    });
  }

  const operations = buildTransactionOperations(sections, context);
  const manager: IFileTransactionManager = createFileTransactionManager({
    lockRegistry: context.fileLockRegistry ?? {
      resolveCanonicalLockKey: async (_identity, _root, target) => target,
      acquire: async () => ({ canonicalKeys: [], release() {} }),
      acquireBatch: async () => ({ canonicalKeys: [], release() {} }),
      withLocks: async (_entries, _options, fn) => fn(),
      releaseByHolder: () => 0,
      getActiveLockSnapshot: () => [],
    },
  });

  // 两个阶段的事务：内存 staging + AST 预验证 -> 原子提交 + 100% 回滚（F-03/F-07）。
  const result = await manager.executeTransaction({
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspaceRoot,
    sessionId: context.sessionId,
    turnId: context.turnId,
    agentId: context.callerAgentType,
    toolCallId: context.toolCallId,
    toolName: "ApplyPatch",
    operations,
    fileSystemPort,
    readFileState: context.readFileState as unknown as Map<
      string,
      TransactionReadStateEntryLike
    > | undefined,
    enforceStaleReadGuard: false,
    strictSyntaxValidation: true,
    abortSignal: context.abortSignal,
    trace: traceFor(context),
    onTransactionEvent: createTransactionHooks(context),
  });

  if (result.status !== "committed") {
    throw createPatchError(
      result.errorDetails ?? `ApplyPatch transaction ended with status ${result.status}.`,
      result.status === "rejected_syntax"
        ? ApplyPatchErrorCode.INVALID_PATCH
        : result.status === "rejected_conflict"
          ? ApplyPatchErrorCode.FILE_EXISTS
          : ApplyPatchErrorCode.IO_ERROR,
      {
        toolCallId: context.toolCallId,
        transactionId: result.transactionId,
        transactionStatus: result.status,
        rolledBackSteps: result.rolledBackSteps,
      },
    );
  }

  const files = result.files.map(toOutputFileChangeFromCommitted);
  return {
    files,
    structuredPatch: files.flatMap((file) => file.structuredPatch),
    summary: files.map(formatSummaryLine).join("\n"),
  } satisfies ApplyPatchOutput;
};

function buildTransactionOperations(
  sections: readonly ParsedPatch[],
  context: Parameters<typeof applyPatchHandler>[1],
): FileMutationOp[] {
  return sections.map((section): FileMutationOp => {
    const filePath = resolvePatchPath(section.path, context);
    if (section.type === "add") {
      return { kind: "create", path: filePath, displayPath: section.path, content: section.contents };
    }
    if (section.type === "delete") {
      return { kind: "delete", path: filePath, displayPath: section.path };
    }
    if (section.chunks.length === 0) {
      throw createPatchError("Update file section has no hunks", ApplyPatchErrorCode.INVALID_PATCH, {
        filePath: section.path,
        toolCallId: context.toolCallId,
      });
    }
    const movePath = section.movePath ? resolvePatchPath(section.movePath, context) : undefined;
    const applyChunks = (current: string) => {
      const outcome = diffEngine.applyStructuredPatchHunks(
        current,
        section.chunks.map((chunk) => ({
          changeContext: chunk.changeContext,
          oldLines: chunk.oldLines,
          newLines: chunk.newLines,
          endOfFile: chunk.endOfFile,
        })),
      );
      if (outcome.status !== "applied") {
        throw createPatchError(
          outcome.status === "conflict"
            ? outcome.conflict.message
            : outcome.status === "ambiguous"
              ? outcome.diagnostic.formatted
              : `Failed to find expected lines:\n${section.chunks.map((chunk) => chunk.oldLines.join("\n")).join("\n---\n")}`,
          ApplyPatchErrorCode.HUNK_NOT_FOUND,
          { filePath: section.path, toolCallId: context.toolCallId },
        );
      }
      return { content: outcome.content, appliedTier: outcome.appliedTier };
    };
    return movePath
      ? {
          kind: "move",
          fromPath: filePath,
          toPath: movePath,
          displayPath: section.path,
          computeNext: (current) => applyChunks(current),
        }
      : {
          kind: "update",
          path: filePath,
          displayPath: section.path,
          computeNext: (current) => applyChunks(current),
        };
  });
}

function toOutputFileChangeFromCommitted(
  file: FileTransactionCommittedFile,
): ApplyPatchFileChange {
  const displayPath = resolveDisplayForCommitted(file);
  const structuredPatch = createStructuredPatch({
    filePath: displayPath,
    oldContent: file.beforeContent ?? "",
    newContent: file.afterContent,
  });
  const { additions, deletions } = countPatchLines(structuredPatch);
  const type: ApplyPatchFileChange["type"] =
    file.operation === "create"
      ? "add"
      : file.operation === "delete"
        ? "delete"
        : file.operation === "move"
          ? "move"
          : "update";
  return {
    filePath: displayPath,
    type,
    ...(file.moveFromPath ? { movePath: file.path } : {}),
    structuredPatch,
    additions,
    deletions,
  };
}

function resolveDisplayForCommitted(file: FileTransactionCommittedFile): string {
  return file.displayPath || file.path;
}

export const applyPatchToolEntry: ToolEntry = {
  capability: "Apply structured multi-file patches atomically",
  metadata: {
    name: "ApplyPatch",
    description: [
      "Applies structured file patches atomically across one or more files.",
      "",
      "Patch format (OpenAI Codex apply_patch grammar):",
      "*** Begin Patch",
      "*** Add File: path/to/new.ts",
      "+content line",
      "*** Update File: path/to/existing.ts",
      "@@ context",
      "-old line",
      "+new line",
      "*** Delete File: path/to/old.ts",
      "*** End Patch",
      "",
      "All files are staged in memory, syntax-validated, and committed atomically:",
      "if any file fails, every file is restored to its exact original content.",
      "Prefer this over Write for surgical changes to existing files; do not switch to Python or shell to edit files.",
      "For legacy GB2312/GBK encoded files, the original encoding is preserved automatically.",
    ].join("\n"),
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
    const parsed = ApplyPatchInputSchema.safeParse(input);
    if (!parsed.success) return [];
    return [{ path: "__apply_patch__", operation: "write" as const }];
  },
  handler: applyPatchHandler,
  formatModelContent: formatApplyPatchModelContent,
  inputSchema: ApplyPatchInputJsonSchema,
  outputSchema: ApplyPatchOutputJsonSchema,
  runtimeInputSchema: ApplyPatchInputSchema,
  runtimeOutputSchema: ApplyPatchOutputSchema,
  permission: {
    permission: "edit",
    reason: "ApplyPatch mutates workspace files through a structured patch",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
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
    userVisibleMessage: "ApplyPatch was cancelled and all files were restored",
  },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

function formatApplyPatchModelContent(output: unknown): string {
  const parsed = ApplyPatchOutputSchema.safeParse(output);
  if (!parsed.success) return "Patch applied successfully.";
  return parsed.data.summary;
}

function countPatchLines(hunks: ApplyPatchFileChange["structuredPatch"]) {
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

function formatSummaryLine(change: ApplyPatchFileChange): string {
  const marker = change.type === "add" ? "A" : change.type === "delete" ? "D" : "M";
  return `${marker} ${change.movePath ?? change.filePath}`;
}

function parsePatchOrThrow(patchText: string, toolCallId: string): ParsedPatch[] {
  try {
    return parseStructuredPatch(patchText);
  } catch (error) {
    throw createPatchError(
      error instanceof Error ? error.message : String(error),
      ApplyPatchErrorCode.INVALID_PATCH,
      { toolCallId },
      error,
    );
  }
}

function resolvePatchPath(
  inputPath: string,
  context: Parameters<typeof applyPatchHandler>[1],
): string {
  const resolvedPath = resolveWorkspacePath({
    inputPath,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    ...workspaceBoundaryOptions(context),
  });
  // Причина та же, что в Write/Edit: объявленный write_paths — граница, а не пожелание.
  assertPathWithinWriteScope({
    filePath: resolvedPath,
    workspaceRoot: context.workspaceRoot,
    writeScope: context.writeScope,
  });
  return resolvedPath;
}

function createPatchError(
  message: string,
  code: (typeof ApplyPatchErrorCode)[keyof typeof ApplyPatchErrorCode],
  extra: Record<string, unknown>,
  cause?: unknown,
) {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    cause: cause instanceof Error ? cause : undefined,
    context: {
      code,
      toolName: "ApplyPatch",
      ...extra,
    },
    recoverable: true,
  });
}

function traceFor(context: Parameters<typeof applyPatchHandler>[1]): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
