import { join } from "node:path";
import {
  SESSION_ENTRY_RUNTIME_TASK_TERMINAL,
  type RuntimeTaskTerminalCatalogRecord,
  type SessionEntryInfo,
  type SessionId,
} from "@zcode/contracts";
import {
  TERMINAL_STATUSES,
  isRecord,
  isTerminalRuntimeTask,
  type RuntimeTaskSnapshot,
} from "./registry-types.js";

/**
 * Terminal catalog record + additive `runId`. Контракт `RuntimeTaskTerminalCatalogRecord`
 * не расширяется в shared: поле optional и читается старыми парсерами как отсутствующее.
 */
type RuntimeTaskTerminalCatalogRecordWithRun = RuntimeTaskTerminalCatalogRecord & {
  runId?: string;
};

export function createRuntimeTaskTerminalCatalogEntry(
  task: RuntimeTaskSnapshot,
): SessionEntryInfo | undefined {
  if (
    task.type !== "local_agent" ||
    !task.rootSessionId ||
    !task.attemptId ||
    !isTerminalRuntimeTask(task) ||
    !task.completedAt
  ) {
    return undefined;
  }
  const record: RuntimeTaskTerminalCatalogRecordWithRun = {
    schema: "zcode.runtime.task-terminal.v1",
    taskId: task.taskId,
    attemptId: task.attemptId,
    taskType: "local_agent",
    agentId: task.agentId,
    agentType: task.agentType,
    ...(task.childSessionId ? { childSessionId: task.childSessionId } : {}),
    ...(task.parentToolCallId ? { parentToolCallId: String(task.parentToolCallId) } : {}),
    ...(task.pid === undefined ? {} : { pid: task.pid }),
    status: task.status,
    description: task.description.slice(0, 4096),
    ...(task.error ? { error: task.error.slice(0, 4096) } : {}),
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    ...(task.rootRunId ? { runId: task.rootRunId } : {}),
    startedAt: task.startedAt.getTime(),
    completedAt: task.completedAt.getTime(),
  };
  return {
    id: `runtime-task-terminal:${task.rootSessionId}:${task.taskId}:${task.attemptId}`,
    sessionID: task.rootSessionId,
    type: SESSION_ENTRY_RUNTIME_TASK_TERMINAL,
    touchSession: false,
    time: { created: record.completedAt, updated: record.completedAt },
    data: { terminal: record },
  };
}

export function readRuntimeTaskTerminalCatalogRecord(
  entry: SessionEntryInfo,
): RuntimeTaskTerminalCatalogRecord | undefined {
  if (entry.type !== SESSION_ENTRY_RUNTIME_TASK_TERMINAL || !isRecord(entry.data)) return;
  const record = entry.data.terminal;
  if (!isRecord(record)) return;
  if (
    record.schema !== "zcode.runtime.task-terminal.v1" ||
    typeof record.taskId !== "string" ||
    record.taskId.length === 0 ||
    typeof record.attemptId !== "string" ||
    record.attemptId.length === 0 ||
    record.taskType !== "local_agent" ||
    typeof record.agentId !== "string" ||
    typeof record.agentType !== "string" ||
    record.agentId !== record.taskId ||
    typeof record.description !== "string" ||
    typeof record.status !== "string" ||
    !TERMINAL_STATUSES.has(record.status as RuntimeTaskSnapshot["status"]) ||
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt) ||
    typeof record.completedAt !== "number" ||
    !Number.isFinite(record.completedAt) ||
    (record.error !== undefined && typeof record.error !== "string") ||
    (record.exitCode !== undefined && typeof record.exitCode !== "number") ||
    (record.childSessionId !== undefined && typeof record.childSessionId !== "string") ||
    (record.parentToolCallId !== undefined && typeof record.parentToolCallId !== "string") ||
    (record.runId !== undefined && typeof record.runId !== "string") ||
    (record.pid !== undefined && typeof record.pid !== "number")
  ) {
    return;
  }
  if (
    entry.id !== `runtime-task-terminal:${entry.sessionID}:${record.taskId}:${record.attemptId}`
  ) {
    return;
  }
  return record as unknown as RuntimeTaskTerminalCatalogRecord;
}

export function runtimeTaskSnapshotFromTerminalCatalog(
  record: RuntimeTaskTerminalCatalogRecord,
  rootSessionId: SessionId,
  outputRootDir: string,
): RuntimeTaskSnapshot {
  const instant = record as RuntimeTaskTerminalCatalogRecordWithRun;
  return {
    taskId: record.taskId,
    agentId: record.agentId,
    agentType: record.agentType,
    description: record.description,
    status: record.status,
    startedAt: new Date(record.startedAt),
    completedAt: new Date(record.completedAt),
    attemptId: record.attemptId,
    ...(record.childSessionId ? { childSessionId: record.childSessionId } : {}),
    ...(record.parentToolCallId ? { parentToolCallId: record.parentToolCallId } : {}),
    ...(record.pid === undefined ? {} : { pid: record.pid }),
    ...(record.error ? { error: record.error } : {}),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(instant.runId ? { rootRunId: instant.runId } : {}),
    outputFile: runtimeTaskOutputFile(outputRootDir, rootSessionId, record.taskId),
    rootSessionId,
    type: "local_agent",
  };
}

export function runtimeTaskOutputFile(
  outputRootDir: string,
  rootSessionId: SessionId,
  taskId: string,
): string {
  // 修复依据：catalog 是持久化输入；路径只能由可信 root session 和 task ID 决定，不能由记录内的 owner/path 选文件。
  if (
    rootSessionId.length === 0 ||
    rootSessionId === "." ||
    rootSessionId === ".." ||
    /[\\/]/u.test(rootSessionId) ||
    taskId.length === 0 ||
    taskId === "." ||
    taskId === ".." ||
    /[\\/]/u.test(taskId)
  ) {
    throw new Error("Runtime task catalog contains an invalid task ID");
  }
  return join(outputRootDir, rootSessionId, taskId, "output.txt");
}

export function compactTerminalSubagentSnapshot(task: RuntimeTaskSnapshot): RuntimeTaskSnapshot {
  if (task.type !== "local_agent") return task;
  const compactedOutput =
    task.output?.status === "completed" ? { ...task.output, content: [], prompt: "" } : task.output;
  // Full result text and prompts are available through the durable output file and the
  // just-completed Agent tool result. Keep only compact terminal metadata in the long-lived root registry.
  return {
    ...task,
    prompt: "",
    ...(compactedOutput === undefined ? {} : { output: compactedOutput }),
  };
}
