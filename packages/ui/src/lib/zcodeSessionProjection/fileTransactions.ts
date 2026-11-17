// ============================================================
// fileTransaction.updated → потоковое событие UI (Инкремент 4.2)
// ============================================================
//
// Одна точка проекции для desktop-continuous и web-remote-replayable.
// Форму payload уже определил владелец факта (CLI FileTransactionManager):
// полный structuredPatch либо компактную сводку. UI не выводит состояние
// из дельт и не достраивает диффы — он только публикует факт.

import {
  generateTraceId,
  zcodeFileTransactionEventPayloadSchema,
  type ZCodeFileTransactionUpdate,
  type ZCodeSessionEvent,
  type ZCodeStreamEvent,
} from "@zcode/shared";

export function mapFileTransactionUpdated(
  taskId: string,
  event: ZCodeSessionEvent,
): ZCodeStreamEvent[] {
  const parsed = zcodeFileTransactionEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    // Невалидный кадр не должен ломать проекцию остальной сессии.
    return [];
  }
  const update: ZCodeFileTransactionUpdate = {
    type: "file_transaction_update",
    taskId,
    traceId: event.traceId ?? generateTraceId(taskId),
    transaction: parsed.data,
  };
  return [update];
}
