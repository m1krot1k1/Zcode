import { access, constants as fsConstants, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  SessionEventType,
  SESSION_ENTRY_RUNTIME_TASK_TERMINAL,
  TASK_OUTPUT_ALIASES,
  TASK_OUTPUT_PROVIDER_DESCRIPTION,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputInputSchema,
  TaskOutputResultSchema,
  TaskOutputResultJsonSchema,
  TaskOutputInputJsonSchema,
  type SessionId,
  type TaskOutputInput,
  type TaskOutputResult,
  type TaskOutputTask,
} from "@zcode/contracts";
import {
  readRuntimeTaskTerminalCatalogRecord,
  runtimeTaskSnapshotFromTerminalCatalog,
  type RuntimeTaskSnapshot,
} from "../../runtime-task/registry.js";
import { formatPersistedOutputEnvelope } from "../result-persistence-format.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputValidationContext,
  ToolInputValidationResult,
  ToolPersistedModelContentInput,
} from "../types.js";
import {
  formatCompactFileSize,
  projectTask,
  throwIfAborted,
} from "./task-output-projection.js";

const TASK_OUTPUT_DEFAULT_LENGTH = 32_000;
const TASK_OUTPUT_MAX_LENGTH = 160_000;
const TASK_OUTPUT_PERSIST_THRESHOLD_CHARS = 100_000;
const TASK_OUTPUT_RESULT_BUDGET_BYTES = 400_000;
const TASK_OUTPUT_PERSIST_PREVIEW_CHARS = 2_000;
const TASK_OUTPUT_POLL_INTERVAL_MS = 100;
const TASK_OUTPUT_ERROR_CODE = {
  TASK_ID_REQUIRED: 1,
  TASK_NOT_FOUND: 2,
  OUTPUT_UNAVAILABLE: 3,
} as const;

const taskOutputHandler: ToolHandler = async (input, context) => {
  const parsed = TaskOutputInputSchema.parse(input) as TaskOutputInput;
  const inputFailure = getTaskOutputInputFailure(parsed);
  if (inputFailure) return inputFailure;

  let initialTask = context.runtimeTaskRegistry?.get(parsed.task_id);
  if (!initialTask) initialTask = await resolveArchivedTask(parsed.task_id, context);
  if (!initialTask) {
    return taskOutputFailure(
      TASK_OUTPUT_ERROR_CODE.TASK_NOT_FOUND,
      `No task found with ID: ${parsed.task_id}`,
    );
  }

  const latestLiveTask = context.runtimeTaskRegistry?.get(parsed.task_id);
  // 修复原因：catalog 查询期间 task ID 可能被重新 admission；始终以当前 Registry attempt 为准。
  const isArchivedTask = !latestLiveTask;
  if (latestLiveTask) initialTask = latestLiveTask;

  if (!parsed.block) {
    if (isTaskActive(initialTask.status)) {
      return taskOutputResult("not_ready", await projectTask(initialTask, context));
    }
    if (isArchivedTask && !(await archivedOutputIsReadable(initialTask.outputFile, context))) {
      return taskOutputFailure(
        TASK_OUTPUT_ERROR_CODE.OUTPUT_UNAVAILABLE,
        "Saved task output is unavailable on this host",
      );
    }
    const projectedTask = await projectTask(initialTask, context);
    // notified 是完成结果已成功交付的 claim；投影前写入会在读取失败或
    // abort 时吞掉后续 completion notification。异步投影不会被外层取消竞态强制
    // 停止，因此 await 返回后必须再次检查 signal，再提交 claim。
    throwIfAborted(context.abortSignal);
    if (taskAttemptChanged(initialTask, context)) return retryTaskOutputFailure();
    if (!isArchivedTask) markTaskNotified(initialTask, context);
    return taskOutputResult("success", projectedTask);
  }

  if (isArchivedTask) {
    if (!(await archivedOutputIsReadable(initialTask.outputFile, context))) {
      return taskOutputFailure(
        TASK_OUTPUT_ERROR_CODE.OUTPUT_UNAVAILABLE,
        "Saved task output is unavailable on this host",
      );
    }
    const projectedTask = await projectTask(initialTask, context);
    throwIfAborted(context.abortSignal);
    if (taskAttemptChanged(initialTask, context)) return retryTaskOutputFailure();
    return taskOutputResult("success", projectedTask);
  }

  await emitWaitingProgress(context);
  const task = await waitForTask(parsed.task_id, parsed.timeout, context);
  if (!task) {
    return taskOutputResult("timeout", null);
  }
  if (isTaskActive(task.status)) {
    return taskOutputResult("timeout", await projectTask(task, context));
  }
  const projectedTask = await projectTask(task, context);
  throwIfAborted(context.abortSignal);
  if (taskAttemptChanged(task, context)) return retryTaskOutputFailure();
  markTaskNotified(task, context);
  return taskOutputResult("success", projectedTask);
};

export const taskOutputToolEntry: ToolEntry = {
  aliases: TASK_OUTPUT_ALIASES,
  capability: "read output/logs from a background task",
  maxModelChars: TASK_OUTPUT_PERSIST_THRESHOLD_CHARS,
  metadata: {
    shouldDefer: true,
    name: TASK_OUTPUT_TOOL_NAME,
    searchHint: "read output/logs from a background task",
    description: TASK_OUTPUT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskOutputHandler,
  validateInput: validateTaskOutputInput,
  formatModelContent: formatTaskOutputModelContent,
  formatPersistedModelContent: formatPersistedTaskOutputModelContent,
  inputSchema: TaskOutputInputJsonSchema,
  outputSchema: TaskOutputResultJsonSchema,
  runtimeInputSchema: TaskOutputInputSchema,
  runtimeOutputSchema: TaskOutputResultSchema,
  permission: {
    permission: "taskOutput",
    reason: "TaskOutput reads a background task from the current runtime",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    maxModelBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  resultArtifactContentType: "text/plain",
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TaskOutput was cancelled while waiting for the task",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function taskOutputFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function retryTaskOutputFailure(): ToolHandlerFailure {
  return taskOutputFailure(
    TASK_OUTPUT_ERROR_CODE.OUTPUT_UNAVAILABLE,
    "Task attempt changed while reading output; retry TaskOutput",
  );
}

function taskAttemptChanged(task: RuntimeTaskSnapshot, context: ToolExecutionContext): boolean {
  const current = context.runtimeTaskRegistry?.get(task.taskId);
  return Boolean(
    current &&
      task.attemptId &&
      current.attemptId &&
      current.attemptId !== task.attemptId,
  );
}

function validateTaskOutputInput(
  input: unknown,
  _context: ToolInputValidationContext,
): ToolInputValidationResult {
  const parsed = TaskOutputInputSchema.parse(input) as TaskOutputInput;
  return getTaskOutputInputFailure(parsed) ?? { result: true };
}

function getTaskOutputInputFailure(
  input: TaskOutputInput,
): ToolHandlerFailure | undefined {
  if (!input.task_id) {
    return taskOutputFailure(TASK_OUTPUT_ERROR_CODE.TASK_ID_REQUIRED, "Task ID is required");
  }
  return undefined;
}

async function resolveArchivedTask(
  taskId: string,
  context: ToolExecutionContext,
): Promise<RuntimeTaskSnapshot | undefined> {
  if (!context.sessionStore?.sessionEntries || !context.sessionId) return undefined;
  const rootSessionId =
    context.runtimeTaskRegistry?.getRootSessionIdForSession(context.sessionId) ??
    context.sessionId;
  const entries = await context.sessionStore.sessionEntries({
    sessionID: rootSessionId,
    type: SESSION_ENTRY_RUNTIME_TASK_TERMINAL,
    idPrefix: `runtime-task-terminal:${rootSessionId}:${taskId}:`,
  });
  const ownedEntries = entries.filter((entry) => entry.sessionID === rootSessionId);
  const records = ownedEntries
    .map(readRuntimeTaskTerminalCatalogRecord)
    .filter((record): record is NonNullable<typeof record> => record?.taskId === taskId);
  const newestCompletion = Math.max(...records.map((record) => record.completedAt));
  const latestCandidates = records.filter((record) => record.completedAt === newestCompletion);
  if (latestCandidates.length > 1) {
    throw new Error(`Saved task has ambiguous terminal attempts: ${taskId}`);
  }
  const latest = latestCandidates[0];
  const malformedMatch = ownedEntries.some((entry) => {
    const terminal = (entry.data as { terminal?: { taskId?: unknown } } | null)?.terminal;
    return terminal?.taskId === taskId && !readRuntimeTaskTerminalCatalogRecord(entry);
  });
  if (malformedMatch) throw new Error(`Saved task catalog entry is invalid: ${taskId}`);
  if (!latest) return undefined;
  return runtimeTaskSnapshotFromTerminalCatalog(
    latest,
    rootSessionId as SessionId,
    context.runtimeTaskOutputRootDir ?? join(tmpdir(), "zcode-agents"),
  );
}

async function archivedOutputIsReadable(
  outputFile: string | undefined,
  context: ToolExecutionContext,
): Promise<boolean> {
  if (!outputFile) return false;
  try {
    const root = await realpath(
      context.runtimeTaskOutputRootDir ?? join(tmpdir(), "zcode-agents"),
    );
    const directory = await realpath(join(outputFile, ".."));
    const contained = relative(root, directory);
    if (contained === ".." || contained.startsWith(`..${sep}`) || resolve(root) === resolve(directory)) {
      return false;
    }
    const metadata = await lstat(outputFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    await access(outputFile, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function formatTaskOutputModelContent(output: unknown): string {
  const parsed = TaskOutputResultSchema.parse(output);
  const blocks = [`<retrieval_status>${parsed.retrieval_status}</retrieval_status>`];
  const task = parsed.task;
  if (task) {
    blocks.push(`<task_id>${task.task_id}</task_id>`);
    blocks.push(`<task_type>${task.task_type}</task_type>`);
    blocks.push(`<status>${task.status}</status>`);
    if (task.exitCode !== undefined && task.exitCode !== null) {
      blocks.push(`<exit_code>${task.exitCode}</exit_code>`);
    }
    if (task.output.trim()) {
      // 没有真实完整文件时，task_id 不是可读取路径，不能把它伪装成
      // “Full output”；此时保留原文，由外层的大结果 artifact 机制继续处理。
      const content = (
        task.outputFile ? truncateTaskOutput(task.output, task.outputFile) : task.output
      ).trimEnd();
      blocks.push(`<output>\n${content}\n</output>`);
    }
    if (task.error) {
      blocks.push(`<error>${task.error}</error>`);
    }
  }
  return blocks.join("\n\n");
}

export function truncateTaskOutput(
  output: string,
  outputPath: string,
  configuredValue = process.env.TASK_MAX_OUTPUT_LENGTH,
): string {
  const maxLength = resolveTaskOutputLength(configuredValue);
  if (output.length <= maxLength) return output;

  const prefix = `[Truncated. Full output: ${outputPath}]\n\n`;
  const tailLength = maxLength - prefix.length;
  return prefix + output.slice(-tailLength);
}

export function resolveTaskOutputLength(
  configuredValue = process.env.TASK_MAX_OUTPUT_LENGTH,
): number {
  if (!configuredValue) return TASK_OUTPUT_DEFAULT_LENGTH;
  const parsed = Number.parseInt(configuredValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return TASK_OUTPUT_DEFAULT_LENGTH;
  return Math.min(parsed, TASK_OUTPUT_MAX_LENGTH);
}

function formatPersistedTaskOutputModelContent(input: ToolPersistedModelContentInput): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatCompactFileSize,
    originalBytes: input.content.length,
    persistedPath: input.persistedPath,
    previewChars: TASK_OUTPUT_PERSIST_PREVIEW_CHARS,
  });
}

async function waitForTask(
  taskId: string,
  timeoutMs: number,
  context: ToolExecutionContext,
): Promise<RuntimeTaskSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(context.abortSignal);
    const task = context.runtimeTaskRegistry?.get(taskId);
    if (!task) return undefined;
    if (!isTaskActive(task.status)) return task;
    await delay(TASK_OUTPUT_POLL_INTERVAL_MS);
  }
  return context.runtimeTaskRegistry?.get(taskId);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const isTaskActive = (status: string): boolean => status === "running" || status === "pending";

function markTaskNotified(task: RuntimeTaskSnapshot, context: ToolExecutionContext): void {
  context.runtimeTaskRegistry?.update(task.taskId, (current) =>
    current.notified ? current : { ...current, notified: true },
  );
}

async function emitWaitingProgress(context: ToolExecutionContext): Promise<void> {
  if (!context.emitEvent) return;

  await context.emitEvent({
    id: crypto.randomUUID() as never,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId as never,
      toolName: TASK_OUTPUT_TOOL_NAME,
      elapsedMs: 0,
    },
  });
}

function taskOutputResult(
  retrievalStatus: TaskOutputResult["retrieval_status"],
  task: TaskOutputTask | null,
): TaskOutputResult {
  return {
    retrieval_status: retrievalStatus,
    task,
  };
}
