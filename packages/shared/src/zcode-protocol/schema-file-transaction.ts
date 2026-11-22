// ============================================================
// FileTransactionEvent — реактивная синхронизация транзакций ФС
// ============================================================
//
// Один факт, два представления:
//  - `desktop-continuous` (Electron): полный `structuredPatch` по каждому файлу,
//    чтобы renderer сразу отрисовал дифф без повторного запроса снапшота.
//  - `web-remote-replayable` (Web/Mobile): компактная сводка `<= 2 КБ`,
//    из которой восстанавливаются только пути, счётчики и индикаторы
//    параллельных сессий; полный патч добирается снапшотом при открытии диффа.
//
// Владелец факта — CLI (`FileTransactionManager`). Проекции ниже — чистые
// функции без IO, пригодные и на сервере, и в renderer.

import { z } from "zod";
import { jsonObjectSchema, nonEmptyString, timestampMsSchema } from "./schema-core.js";

export const FILE_TRANSACTION_COMPACT_BUDGET_BYTES = 2_048;

export const zcodeFileTransactionStatusSchema = z.enum(["active_diff", "committed", "rolled_back"]);

export const zcodeFileTransactionOperationSchema = z.enum(["create", "update", "move", "delete"]);

export const zcodeFileTransactionFileSummarySchema = z
  .object({
    path: nonEmptyString,
    displayPath: nonEmptyString,
    operation: zcodeFileTransactionOperationSchema,
    moveFromPath: nonEmptyString.optional(),
    appliedTier: nonEmptyString.optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    syntaxValid: z.boolean().optional(),
    beforeSha256: nonEmptyString.optional(),
    afterSha256: nonEmptyString.optional(),
    lineEndings: z.enum(["LF", "CRLF"]).optional(),
  })
  .strict();

export const zcodeFileTransactionDiffFileSchema = z
  .object({
    path: nonEmptyString,
    displayPath: nonEmptyString,
    operation: zcodeFileTransactionOperationSchema,
    moveFromPath: nonEmptyString.optional(),
    appliedTier: nonEmptyString.optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    syntaxValid: z.boolean().optional(),
    beforeSha256: nonEmptyString.optional(),
    afterSha256: nonEmptyString.optional(),
    lineEndings: z.enum(["LF", "CRLF"]).optional(),
    beforeContent: z.string().nullable().optional(),
    afterContent: z.string().optional(),
    structuredPatch: z.array(jsonObjectSchema).optional(),
  })
  .strict();

export const zcodeFileTransactionBackgroundTaskSchema = z
  .object({
    taskId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    percent: z.number().min(0).max(100).optional(),
    affectedPathCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const zcodeFileTransactionEventBaseSchema = z
  .object({
    transactionId: nonEmptyString,
    workspaceKey: nonEmptyString,
    workspacePath: nonEmptyString.optional(),
    workspaceIdentity: nonEmptyString.optional(),
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    agentId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString,
    status: zcodeFileTransactionStatusSchema,
    timestamp: timestampMsSchema,
    affectedPaths: z.array(nonEmptyString),
    backgroundTasks: z.array(zcodeFileTransactionBackgroundTaskSchema).optional(),
    errorDetails: z.string().optional(),
  })
  .strict();

export const zcodeFileTransactionEventPayloadSchema = z.union([
  zcodeFileTransactionEventBaseSchema
    .extend({ compact: z.literal(false), files: z.array(zcodeFileTransactionDiffFileSchema) })
    .strict(),
  zcodeFileTransactionEventBaseSchema
    .extend({ compact: z.literal(true), files: z.array(zcodeFileTransactionFileSummarySchema) })
    .strict(),
]);

export type ZCodeFileTransactionEventPayload = z.infer<typeof zcodeFileTransactionEventPayloadSchema>;
export type ZCodeFileTransactionDiffFile = z.infer<typeof zcodeFileTransactionDiffFileSchema>;
export type ZCodeFileTransactionFileSummary = z.infer<typeof zcodeFileTransactionFileSummarySchema>;
export type ZCodeFileTransactionBackgroundTask = z.infer<typeof zcodeFileTransactionBackgroundTaskSchema>;

const utf8Encoder = new TextEncoder();

/**
 * Байты JSON-представления — та же метрика, что и бюджет снапшота.
 * `TextEncoder` работает и в Node, и в браузере: пакет общий для обеих сторон.
 */
export function estimateFileTransactionPayloadBytes(payload: unknown): number {
  return utf8Encoder.encode(JSON.stringify(payload) ?? "").byteLength;
}

/**
 * Проекция полного события в сводку `<= budgetBytes` для `web-remote-replayable`.
 * Порядок усечения фиксирован: сначала патчи, потом содержимое файлов,
 * затем хвост списка путей. `affectedPaths` не усекается ниже 1 элемента,
 * иначе UI потеряет индикатор «в каких файлах идёт транзакция».
 */
export function toCompactFileTransactionPayload(
  payload: ZCodeFileTransactionEventPayload,
  budgetBytes: number = FILE_TRANSACTION_COMPACT_BUDGET_BYTES,
): ZCodeFileTransactionEventPayload {
  const summaries: ZCodeFileTransactionFileSummary[] = payload.files.map((file) => ({
    path: file.path,
    displayPath: file.displayPath,
    operation: file.operation,
    ...(file.moveFromPath ? { moveFromPath: file.moveFromPath } : {}),
    ...(file.appliedTier ? { appliedTier: file.appliedTier } : {}),
    ...(file.additions !== undefined ? { additions: file.additions } : {}),
    ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    ...(file.syntaxValid !== undefined ? { syntaxValid: file.syntaxValid } : {}),
    ...(file.beforeSha256 ? { beforeSha256: file.beforeSha256 } : {}),
    ...(file.afterSha256 ? { afterSha256: file.afterSha256 } : {}),
    ...(file.lineEndings ? { lineEndings: file.lineEndings } : {}),
  }));

  const base = {
    transactionId: payload.transactionId,
    workspaceKey: payload.workspaceKey,
    ...(payload.workspacePath ? { workspacePath: payload.workspacePath } : {}),
    ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
    sessionId: payload.sessionId,
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
    toolName: payload.toolName,
    status: payload.status,
    timestamp: payload.timestamp,
    ...(payload.backgroundTasks ? { backgroundTasks: payload.backgroundTasks } : {}),
    ...(payload.errorDetails ? { errorDetails: payload.errorDetails } : {}),
  };

  let files = summaries;
  const affectedPaths = [...payload.affectedPaths];

  const candidate = (): ZCodeFileTransactionEventPayload =>
    ({ ...base, compact: true, files, affectedPaths }) as ZCodeFileTransactionEventPayload;

  let compact = candidate();
  while (estimateFileTransactionPayloadBytes(compact) > budgetBytes && files.length > 0) {
    files = files.slice(0, files.length - 1);
    compact = candidate();
  }
  while (estimateFileTransactionPayloadBytes(compact) > budgetBytes && affectedPaths.length > 1) {
    affectedPaths.pop();
    compact = candidate();
  }
  return compact;
}
