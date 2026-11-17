// ============================================================
// fileTransaction.updated → UI-модель (Этап 6.1c)
// ============================================================
//
// Владелец факта — CLI `FileTransactionManager`: он присылает уже готовый
// payload в двух формах (`compact: false` — полный structuredPatch для
// desktop-continuous, `compact: true` — сводка ≤ 2 КБ для web-remote-replayable).
// Этот слой только нормализует форму, не достраивает диффы и не выводит
// состояние из дельт.
//
// Идемпотентность: у события нет версии, поэтому единица сравнения — пара
// «статус + timestamp + набор путей». Повторный кадр с тем же ключом не
// перезаписывает модель и не вызывает лишних ререндеров.

import type {
  ZCodeFileTransactionBackgroundTask,
  ZCodeFileTransactionEventPayload,
} from "@zcode/shared";

export type FileTransactionUiStatus = ZCodeFileTransactionEventPayload["status"];

export interface FileTransactionFileView {
  readonly path: string;
  readonly displayPath: string;
  readonly operation: "create" | "update" | "move" | "delete";
  readonly additions: number;
  readonly deletions: number;
  readonly syntaxValid?: boolean;
  readonly appliedTier?: string;
  /** Полный unified diff доступен только в desktop-continuous контуре. */
  readonly unifiedPatch?: string;
}

export interface FileTransactionView {
  readonly transactionId: string;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly status: FileTransactionUiStatus;
  readonly timestamp: number;
  /** true — сводка (web-remote-replayable), полного патча нет. */
  readonly compact: boolean;
  readonly affectedPaths: readonly string[];
  readonly files: readonly FileTransactionFileView[];
  readonly additions: number;
  readonly deletions: number;
  readonly backgroundTasks: readonly ZCodeFileTransactionBackgroundTask[];
  readonly errorDetails?: string;
  /** Ключ идемпотентности: одинаковый кадр не должен менять store. */
  readonly revisionKey: string;
}

export interface FileTransactionStreamPayload {
  readonly transaction: ZCodeFileTransactionEventPayload;
}

/** Статусы, при которых пользователь ещё видит «идёт изменение». */
export function isFileTransactionInFlight(status: FileTransactionUiStatus): boolean {
  return status !== "committed" && status !== "rolled_back";
}

/** Терминальные статусы закрывают транзакцию: повторный кадр её не «оживит». */
export function isFileTransactionTerminal(status: FileTransactionUiStatus): boolean {
  return status === "committed" || status === "rolled_back";
}

interface StructuredPatchHunk {
  header?: string;
  lines?: string[];
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
}

function readHunkHeader(hunk: StructuredPatchHunk): string | null {
  if (typeof hunk.header === "string" && hunk.header.length > 0) return hunk.header;
  if (
    typeof hunk.oldStart === "number" &&
    typeof hunk.oldLines === "number" &&
    typeof hunk.newStart === "number" &&
    typeof hunk.newLines === "number"
  ) {
    return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  }
  return null;
}

/**
 * Собирает unified diff из structuredPatch.
 *
 * Причина отдельной функции: `structuredPatch` в протоколе — массив «json object»
 * без фиксированных полей, а renderer (CodeViewer) принимает готовый текст.
 * Невалидный hunk просто пропускается: лучше показать неполный diff, чем уронить панель.
 */
export function buildUnifiedPatch(
  path: string,
  structuredPatch: readonly unknown[] | undefined,
): string | null {
  if (!structuredPatch || structuredPatch.length === 0) return null;
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let readable = false;
  for (const raw of structuredPatch) {
    if (typeof raw !== "object" || raw === null) continue;
    const hunk = raw as StructuredPatchHunk;
    const header = readHunkHeader(hunk);
    if (!header) continue;
    lines.push(header);
    const body = Array.isArray(hunk.lines) ? hunk.lines : [];
    if (body.length === 0) continue;
    for (const line of body) {
      if (typeof line !== "string") continue;
      lines.push(line);
    }
    readable = true;
  }
  return readable ? lines.join("\n") : null;
}

function buildRevisionKey(payload: ZCodeFileTransactionEventPayload): string {
  return [
    payload.status,
    String(payload.timestamp),
    payload.compact ? "compact" : "full",
    payload.affectedPaths.join("\u0001"),
    payload.backgroundTasks?.map((task) => `${task.taskId}:${task.status}:${task.percent ?? ""}`).join("\u0001") ?? "",
    payload.errorDetails ?? "",
  ].join("\u0002");
}

/** Нормализует дерево-факт в UI-модель. Чистая функция без IO. */
export function toFileTransactionView(
  payload: ZCodeFileTransactionEventPayload,
): FileTransactionView {
  const files: FileTransactionFileView[] = payload.files.map((file) => {
    const additions = typeof file.additions === "number" ? file.additions : 0;
    const deletions = typeof file.deletions === "number" ? file.deletions : 0;
    const isDiffFile = "structuredPatch" in file;
    const unifiedPatch =
      isDiffFile && !payload.compact
        ? buildUnifiedPatch(
            file.displayPath,
            (file as { structuredPatch?: readonly unknown[] }).structuredPatch,
          )
        : null;
    return {
      path: file.path,
      displayPath: file.displayPath,
      operation: file.operation,
      additions,
      deletions,
      ...(typeof file.syntaxValid === "boolean" ? { syntaxValid: file.syntaxValid } : {}),
      ...(typeof file.appliedTier === "string" ? { appliedTier: file.appliedTier } : {}),
      ...(unifiedPatch ? { unifiedPatch } : {}),
    };
  });
  return {
    transactionId: payload.transactionId,
    workspaceKey: payload.workspaceKey,
    sessionId: payload.sessionId,
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
    ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
    toolName: payload.toolName,
    status: payload.status,
    timestamp: payload.timestamp,
    compact: payload.compact,
    affectedPaths: [...payload.affectedPaths],
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    backgroundTasks: payload.backgroundTasks ? [...payload.backgroundTasks] : [],
    ...(payload.errorDetails ? { errorDetails: payload.errorDetails } : {}),
    revisionKey: buildRevisionKey(payload),
  };
}

/** Ключ изоляции — единственный допустимый способ сравнить workspace. */
export function fileTransactionWorkspaceKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return params.workspaceIdentity?.trim() || params.workspacePath;
}
