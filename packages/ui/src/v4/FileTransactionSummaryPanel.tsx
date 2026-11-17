// ============================================================
// Сводка транзакционных изменений файлов в таймлайне (Этап 6.1c)
// ============================================================
//
// Место монтирования — хвост турна, рядом с `ConversationFileSummaryPanel`:
// это уже существующий паттерн «что эта турн оставила в workspace».
// Данные берутся из `fileTransactionStore` (реактивные события
// `fileTransaction.updated`), а не из локального состояния компонента.
//
// Режимы доставки:
//  - desktop-continuous: полный `structuredPatch`, строки файла открывают diff;
//  - web-remote-replayable: компактная сводка; патча нет, но панель показывает
//    пути и счётчики и не пустует.

import { useMemo, useState } from "react";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import {
  TID_CHAT_FILE_TRANSACTION_BACKGROUND_TASK,
  TID_CHAT_FILE_TRANSACTION_PANEL,
  testId,
} from "@zcode/shared/test-ids";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import {
  isFileTransactionInFlight,
  type FileTransactionView,
} from "@/lib/fileTransactionProjection.js";
import type { ZCodeFileTransactionBackgroundTask } from "@zcode/shared";

/** i18n-ключ для статуса фоновой задачи; владелец статуса — CLI registry. */
export function backgroundTaskStatusMessageId(
  status: ZCodeFileTransactionBackgroundTask["status"],
): string {
  switch (status) {
    case "queued":
      return "chat.fileTransaction.backgroundQueued";
    case "running":
      return "chat.fileTransaction.backgroundRunning";
    case "completed":
      return "chat.fileTransaction.backgroundCompleted";
    case "failed":
      return "chat.fileTransaction.backgroundFailed";
    case "cancelled":
      return "chat.fileTransaction.backgroundCancelled";
  }
}

interface FileTransactionSummaryPanelProps {
  transactions: readonly FileTransactionView[];
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  messageId?: string;
  compactForRemoteControl?: boolean;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

export function buildFileTransactionDiffSource(params: {
  transaction: FileTransactionView;
  filePath: string;
  patch: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): CodeViewerSource {
  const relativePath = toWorkspaceRelativePath(params.workspacePath, params.filePath);
  return {
    type: "patch",
    title: relativePath,
    path: params.filePath,
    patch: params.patch,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    ...(params.workspaceRemoteSessionId
      ? { workspaceRemoteSessionId: params.workspaceRemoteSessionId }
      : {}),
  };
}

export function FileTransactionSummaryPanel({
  transactions,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  messageId,
  compactForRemoteControl = false,
  onOpenCodeViewer,
}: FileTransactionSummaryPanelProps) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);

  const totals = useMemo(() => {
    const paths = new Set<string>();
    let added = 0;
    let removed = 0;
    for (const transaction of transactions) {
      for (const path of transaction.affectedPaths) paths.add(path);
      added += transaction.additions;
      removed += transaction.deletions;
    }
    return { fileCount: paths.size, added, removed };
  }, [transactions]);

  const inFlight = useMemo(
    () => transactions.some((transaction) => isFileTransactionInFlight(transaction.status)),
    [transactions],
  );
  const rolledBack = useMemo(
    () => transactions.some((transaction) => transaction.status === "rolled_back"),
    [transactions],
  );
  const isCompactPayload = useMemo(
    () => transactions.every((transaction) => transaction.compact),
    [transactions],
  );
  // Задача, отменённая/завершённая, не исчезает из списка мгновенно: реестр
  // присылает финальный кадр, и пользователь должен увидеть итог, а не мигание.
  const backgroundTaskRows = useMemo(() => {
    const byTaskId = new Map<string, ZCodeFileTransactionBackgroundTask>();
    for (const transaction of transactions) {
      for (const task of transaction.backgroundTasks) byTaskId.set(task.taskId, task);
    }
    return [...byTaskId.values()];
  }, [transactions]);

  if (transactions.length === 0 || totals.fileCount === 0) return null;

  const filesChangedLabel = intl.formatMessage(
    {
      id:
        totals.fileCount === 1
          ? "chat.changeSummary.filesChanged.one"
          : "chat.changeSummary.filesChanged.other",
    },
    { count: String(totals.fileCount) },
  );
  const toggleLabel = intl.formatMessage({
    id: open ? "chat.changeSummary.collapse" : "chat.changeSummary.expand",
  });

  // Один tool-call = одна транзакция; файлы разных транзакций не сливаются в
  // один список, чтобы пути не дублировались при повторных правках одного файла.
  const rows = transactions.flatMap((transaction) =>
    transaction.files.map((file) => ({ transaction, file })),
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-zcode-stream-animate="true"
      data-testid={messageId ? testId(TID_CHAT_FILE_TRANSACTION_PANEL, messageId) : TID_CHAT_FILE_TRANSACTION_PANEL}
      data-transaction-count={transactions.length}
      data-transaction-status={rolledBack ? "rolled_back" : inFlight ? "active_diff" : "committed"}
      data-transaction-compact={isCompactPayload ? "true" : "false"}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
    >
      <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={toggleLabel}
            title={toggleLabel}
            className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-ui-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
                open ? "rotate-90" : "rotate-0",
              )}
            />
            <span className="min-w-0 truncate font-medium">{filesChangedLabel}</span>
            <span className="shrink-0 tabular-nums text-ui-base">
              <span className="text-diff-added">+{totals.added}</span>{" "}
              <span className="text-diff-removed">-{totals.removed}</span>
            </span>
            {inFlight ? (
              <span className="flex shrink-0 items-center gap-1 text-ui-xs text-foreground-subtle">
                <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
                {intl.formatMessage({ id: "chat.fileTransaction.inProgress" })}
              </span>
            ) : null}
            {rolledBack ? (
              <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "chat.fileTransaction.rolledBack" })}
              </span>
            ) : null}
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        {/* Фоновые файловые задачи приходят в том же кадре (`backgroundTasks`).
            Владелец статуса — CLI `FileTransactionTaskRegistry`; UI только показывает
            прогресс. Отмены из панели нет: v4 `cancelBackgroundWork{workId}` адресует
            runtime-задачи (bash/agent/workflow), а файловая транзакция отменяется
            abort'ом инструмента — поэтому здесь нет кнопки, которая бы «врала». */}
        {backgroundTaskRows.length > 0 ? (
          <div className="grid w-full border-t border-border">
            {backgroundTaskRows.map((task) => (
              <div
                key={`${task.taskId}:${task.status}`}
                data-testid={testId(TID_CHAT_FILE_TRANSACTION_BACKGROUND_TASK, task.taskId)}
                data-background-task-status={task.status}
                className="flex items-center gap-2 px-2 py-1.5 text-ui-base text-foreground-subtle"
              >
                {task.status === "running" || task.status === "queued" ? (
                  <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
                ) : null}
                <span className="min-w-0 flex-1 truncate">
                  {task.toolName ?? "MultiEdit"}
                  {typeof task.affectedPathCount === "number" ? ` · ${task.affectedPathCount}` : ""}
                </span>
                <span className="shrink-0 tabular-nums text-ui-xs">
                  {typeof task.percent === "number" ? `${Math.round(task.percent)}%` : ""}
                </span>
                <span className="shrink-0 text-ui-xs">
                  {intl.formatMessage({ id: backgroundTaskStatusMessageId(task.status) })}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="grid w-full border-t border-border">
          {rows.map(({ transaction, file }) => {
            const patch = file.unifiedPatch;
            const canReview = Boolean(patch && onOpenCodeViewer);
            const openDiff = () => {
              if (!patch || !onOpenCodeViewer) return;
              onOpenCodeViewer(
                buildFileTransactionDiffSource({
                  transaction,
                  filePath: file.path,
                  patch,
                  workspacePath,
                  workspaceIdentity,
                  workspaceRemoteSessionId,
                }),
              );
            };
            return (
              <div
                key={`${transaction.transactionId}:${file.path}`}
                className="w-full overflow-hidden bg-background/50"
              >
                <div
                  aria-disabled={!canReview}
                  className={cn(
                    "flex w-full items-center gap-1 px-2 py-2 text-left transition-colors",
                    canReview ? "cursor-pointer hover:bg-hover/30" : "cursor-default",
                  )}
                  onClick={openDiff}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openDiff();
                  }}
                  role="button"
                  tabIndex={canReview ? 0 : -1}
                  title={file.path}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="flex min-w-0 items-center">
                      <FileDisplayInline
                        path={file.path}
                        options={{
                          basePath: workspacePath,
                          showFilePath: true,
                          className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                          fileNameClassName: "truncate text-ui-base font-medium text-foreground",
                          filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                        }}
                      />
                    </div>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                      {file.additions > 0 ? (
                        <span className="text-diff-added">+{file.additions}</span>
                      ) : null}
                      {file.deletions > 0 ? (
                        <span className="text-diff-removed">-{file.deletions}</span>
                      ) : null}
                    </span>
                  </div>
                  {compactForRemoteControl ? null : (
                    <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                      {file.operation}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
