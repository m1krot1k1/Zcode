// ============================================================
// Store транзакционных изменений файлов (Этап 6.1c)
// ============================================================
//
// Единственный владелец UI-состояния «активные диффы и фоновые файловые
// задачи» в renderer. Источник факта — потоковое событие
// `file_transaction_update`, спроецированное из `fileTransaction.updated`.
//
// Изоляция: записи разложены по `workspaceKey` (== workspaceIdentity?.trim()
// || workspacePath), затем по sessionId. Событие другого workspace не может
// попасть в панель текущего — селекторы всегда требуют оба ключа.
//
// Идемпотентность: каждый кадр несёт `revisionKey` (статус + timestamp + пути).
// Повтор с тем же ключом — no-op, поэтому поток кадров не вызывает мигания.
// Терминальный статус (`committed`/`rolled_back`) фиксируется навсегда: более
// поздний нетерминальный кадр той же транзакции его не «оживит».

import { create } from "zustand";
import {
  isFileTransactionInFlight,
  toFileTransactionView,
  type FileTransactionView,
} from "@/lib/fileTransactionProjection.js";
import type { ZCodeFileTransactionEventPayload } from "@zcode/shared";

/** Срез store: workspaceKey → sessionId → transactionId → view. */
type TransactionTable = Record<string, Record<string, Record<string, FileTransactionView>>>;

interface FileTransactionStoreState {
  readonly table: TransactionTable;
  /** Применяет уже спроецированный payload; возвращает true, если состояние изменилось. */
  applyPayload(payload: ZCodeFileTransactionEventPayload): boolean;
  /** Сброс сессии (закрытие панели/смена workspace): освобождает память. */
  clearSession(workspaceKey: string, sessionId: string): void;
  reset(): void;
}

function readExisting(
  table: TransactionTable,
  workspaceKey: string,
  sessionId: string,
  transactionId: string,
): FileTransactionView | undefined {
  return table[workspaceKey]?.[sessionId]?.[transactionId];
}

/**
 * Решает, надо ли применить кадр поверх уже сохранённого вида.
 *
 * Причина отдельной функции: правило «терминал не оживает» и правило
 * идемпотентности используются и в store, и в тестах — держать их в одном месте.
 */
export function shouldApplyFileTransactionUpdate(
  previous: FileTransactionView | undefined,
  next: FileTransactionView,
): boolean {
  if (!previous) return true;
  if (previous.revisionKey === next.revisionKey) return false;
  // Терминальный статус — окончательный факт владельца (CLI). Более поздний
  // in-flight кадр означает новую попытку той же транзакции, но UI уже показал
  // пользователю коммит/откат; второй раз «активно» рисовать нельзя.
  if (!isFileTransactionInFlight(previous.status)) return false;
  return true;
}

export const useFileTransactionStore = create<FileTransactionStoreState>()((set, get) => ({
  table: {},

  applyPayload: (payload) => {
    const next = toFileTransactionView(payload);
    const state = get();
    const previous = readExisting(state.table, next.workspaceKey, next.sessionId, next.transactionId);
    if (!shouldApplyFileTransactionUpdate(previous, next)) return false;
    const sessionTable = state.table[next.workspaceKey]?.[next.sessionId] ?? {};
    set({
      table: {
        ...state.table,
        [next.workspaceKey]: {
          ...state.table[next.workspaceKey],
          [next.sessionId]: { ...sessionTable, [next.transactionId]: next },
        },
      },
    });
    return true;
  },

  clearSession: (workspaceKey, sessionId) => {
    const state = get();
    const workspaceTable = state.table[workspaceKey];
    if (!workspaceTable || !(sessionId in workspaceTable)) return;
    const { [sessionId]: _removed, ...restSessions } = workspaceTable;
    const nextWorkspaceTable = { ...restSessions };
    const nextTable =
      Object.keys(nextWorkspaceTable).length === 0
        ? (() => {
            const { [workspaceKey]: _removedWorkspace, ...rest } = state.table;
            return rest;
          })()
        : { ...state.table, [workspaceKey]: nextWorkspaceTable };
    set({ table: nextTable });
  },

  reset: () => set({ table: {} }),
}));

/** Все транзакции сессии в порядке появления (для сводного индикатора). */
export function selectSessionFileTransactions(
  state: FileTransactionStoreState,
  workspaceKey: string,
  sessionId: string,
): FileTransactionView[] {
  const sessionTable = state.table[workspaceKey]?.[sessionId];
  if (!sessionTable) return [];
  return Object.values(sessionTable).sort((left, right) => left.timestamp - right.timestamp);
}

/**
 * Выбирает транзакцию, которая относится к конкретному tool-call.
 *
 * Ключ — `toolCallId`, а не путь: один MultiEdit может изменить несколько файлов,
 * и UI нужен именно тот блок, который его запустил. Фолбэк по `turnId` нужен для
 * кадров, где владелец не прислал toolCallId (Edit/Write без явного id).
 */
export function selectTransactionForToolCall(
  transactions: readonly FileTransactionView[],
  params: { toolCallId?: string; turnId?: string },
): FileTransactionView | undefined {
  const toolCallId = params.toolCallId?.trim();
  if (toolCallId) {
    const byToolCall = transactions.find((transaction) => transaction.toolCallId === toolCallId);
    if (byToolCall) return byToolCall;
  }
  const turnId = params.turnId?.trim();
  if (turnId) {
    const byTurn = transactions.find((transaction) => transaction.turnId === turnId);
    if (byTurn) return byTurn;
  }
  return undefined;
}
