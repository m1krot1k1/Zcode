// ============================================================
// Транзакционные изменения файлов для конкретного tool-call (Этап 6.1c)
// ============================================================
//
// Где монтируется: под tool-блоком правки (MultiEdit/Edit/Write/ApplyPatch) в
// `ToolCallRowView`. Это существующий паттерн «инструмент + его результат»:
// панель привязана к `toolCallId`, поэтому один MultiEdit на несколько файлов
// даёт ровно одну секцию и не дублирует сводку турна.
//
// Данные — срез `useFileTransactionStore` по (workspaceKey, sessionId), который
// наполняется потоковыми `fileTransaction.updated` (см. `useFileTransactionStream`).

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import {
  selectSessionFileTransactions,
  selectTransactionForToolCall,
  useFileTransactionStore,
} from "@/store/fileTransactionStore.js";
import { FileTransactionSummaryPanel } from "@/v4/FileTransactionSummaryPanel.js";

interface ToolFileTransactionSummaryProps {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  sessionId: string;
  toolCallId: string;
  turnId?: string;
  messageId?: string;
  compactForRemoteControl?: boolean;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

export function ToolFileTransactionSummary({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  sessionId,
  toolCallId,
  turnId,
  messageId,
  compactForRemoteControl,
  onOpenCodeViewer,
}: ToolFileTransactionSummaryProps) {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const transactions = useFileTransactionStore(
    useShallow((state) => selectSessionFileTransactions(state, workspaceKey, sessionId)),
  );
  const transaction = useMemo(
    () =>
      selectTransactionForToolCall(transactions, {
        toolCallId,
        ...(turnId ? { turnId } : {}),
      }),
    [transactions, toolCallId, turnId],
  );
  if (!transaction) return null;
  return (
    <FileTransactionSummaryPanel
      transactions={[transaction]}
      workspacePath={workspacePath}
      {...(workspaceIdentity ? { workspaceIdentity } : {})}
      {...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {})}
      {...(messageId ? { messageId } : {})}
      compactForRemoteControl={compactForRemoteControl === true}
      {...(onOpenCodeViewer ? { onOpenCodeViewer } : {})}
    />
  );
}