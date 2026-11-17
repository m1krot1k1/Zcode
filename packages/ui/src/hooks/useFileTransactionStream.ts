// ============================================================
// Подписка renderer на поток транзакционных изменений файлов (Этап 6.1c)
// ============================================================
//
// Единственный путь записи в `useFileTransactionStore`: потоковое событие
// `file_transaction_update` из `IZCodeTaskService.onDynamicTaskEvent`.
// Компоненты читают store через селекторы — второго источника правды нет.
//
// Изоляция: подписка создаётся со своим `workspacePath`/`workspaceIdentity`
// и `taskId` (sessionId); store дополнительно раскладывает записи по ключу
// workspace, поэтому событие чужого workspace не попадёт в эту панель.

import { useEffect } from "react";
import type { ZCodeFileTransactionEventPayload, ZCodeStreamEvent } from "@zcode/shared";
import {
  zcodeFileTransactionEventPayloadSchema,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { shouldMirrorFileTransaction } from "@/lib/fileTransactionWorkspaceScope.js";
import { useFileTransactionStore } from "@/store/fileTransactionStore.js";
import { logger } from "@/logger.js";

interface UseFileTransactionStreamParams {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Remote shard id: только он переводит поток в replayable-контур. */
  workspaceRemoteSessionId?: string;
  sessionId: string | null;
  enabled?: boolean;
}

function readTransactionPayload(event: ZCodeStreamEvent): ZCodeFileTransactionEventPayload | null {
  if (event.type !== "file_transaction_update") return null;
  const parsed = zcodeFileTransactionEventPayloadSchema.safeParse(event.transaction);
  // Проекция уже отбрасывает невалидные кадры; здесь второй рубеж для тех хостов,
  // которые публикуют событие напрямую. Невалидный кадр не должен ронять UI.
  return parsed.success ? parsed.data : null;
}

export function useFileTransactionStream({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  sessionId,
  enabled = true,
}: UseFileTransactionStreamParams): void {
  const services = useOptionalServices();

  useEffect(() => {
    if (!enabled || !sessionId || !services) return undefined;
    const workspaceKey = workspaceIdentity?.trim() || workspacePath;
    // Контур доставки определяется удалённостью shard'а, а не наличием
    // workspaceIdentity: локальный workspace тоже имеет identity, но остаётся
    // desktop-continuous и должен получать полный structuredPatch.
    const isRemote = Boolean(workspaceRemoteSessionId?.trim());
    const subscription = services.zcodeTaskService.onDynamicTaskEvent({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      taskId: sessionId,
      deliveryKind: isRemote ? "replayable" : "continuous",
    })((event) => {
      const payload = readTransactionPayload(event);
      if (!payload) {
        // Диагностика: кадр пришёл, но не прошёл runtime-валидацию.
        if (event.type === "file_transaction_update") {
          logger.debug("[file-transaction] кадр отброшен схемой", {
            taskId: event.taskId,
          });
        }
        return;
      }
      if (
        !shouldMirrorFileTransaction({
          payloadWorkspaceKey: payload.workspaceKey,
          workspaceKey,
        })
      ) {
        // Диагностика изоляции: кадр другого workspace не должен попасть в панель.
        logger.debug("[file-transaction] кадр чужого workspace отброшен", {
          payloadWorkspaceKey: payload.workspaceKey,
          workspaceKey,
          transactionId: payload.transactionId,
        });
        return;
      }
      try {
        const applied = useFileTransactionStore.getState().applyPayload(payload);
        logger.debug("[file-transaction] кадр применён", {
          status: payload.status,
          compact: payload.compact,
          transactionId: payload.transactionId,
          applied,
        });
      } catch (error) {
        logger.warn("[file-transaction] применение кадра не удалось", {
          transactionId: payload.transactionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return () => subscription.dispose();
  }, [enabled, services, sessionId, workspacePath, workspaceIdentity, workspaceRemoteSessionId]);
}
