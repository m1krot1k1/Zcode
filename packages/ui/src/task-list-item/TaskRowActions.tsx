import { Archive, CloudUpload, ListTree } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_ARCHIVE, testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { logger } from "@/logger.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { toast } from "@/components/ui/toast.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import type { TaskListItemIntl } from "@/task-list-item/types.js";

/**
 * 任务行右侧动作组：查看文件 + 归档。
 * 可见性由 view model 统一判断，这里只负责按钮外观和点击后的 user-action 遥测。
 */
export function TaskRowActions({
  task,
  intl,
  isArchiveConfirming,
  isArchived,
  isRemoteTask,
  showArchive,
  showFileTree,
  onArchive,
  onOpenFileTree,
}: {
  task: ZCodeTaskMeta;
  intl: TaskListItemIntl;
  isArchiveConfirming: boolean;
  isArchived: boolean;
  isRemoteTask: boolean;
  showArchive: boolean;
  showFileTree: boolean;
  onArchive: (event: React.MouseEvent) => void;
  onOpenFileTree?: () => void | Promise<void>;
}) {
  const archiveLabel = intl.formatMessage({
    id: isArchiveConfirming
      ? "common.confirm"
      : isArchived
        ? "taskList.unarchive"
        : "taskList.archive",
  });
  const archiveActionVisibilityClassName = isArchiveConfirming ? "flex" : "flex";
  const archiveActionNode = showArchive ? (
    /* 交互调整：任务进入“等待归档确认”后，右侧 hover 区不再显示归档按钮。
       否则一个 item 同时出现“待确认状态”和“可归档操作”，视觉重心会互相打架。 */
    <div className={cn("items-center gap-0.5", archiveActionVisibilityClassName)}>
      {isArchiveConfirming ? (
        <ControlHintTooltip title={archiveLabel} side="top" align="center">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={onArchive}
            data-testid={testId(TID_TASK_ARCHIVE, task.taskId)}
            // Bugfix: 归档确认态是显式等待用户决策的状态，必须持续显示 destructive 按钮。
            className={cn("shrink-0 border-destructive/20 px-2", archiveActionVisibilityClassName)}
            aria-label={archiveLabel}
          >
            <span>{intl.formatMessage({ id: "common.confirm" })}</span>
          </Button>
        </ControlHintTooltip>
      ) : (
        // 普通归档态复用共享 action 的 hover 背景、尺寸和提示。
        <TaskRowActionButton
          label={archiveLabel}
          onClick={onArchive}
          showTooltip
          testId={testId(TID_TASK_ARCHIVE, task.taskId)}
        >
          {isRemoteTask ? (
            // 本地和远端 task 混排时，统一 archive 图标无法提示操作会落在哪个 sqlite。
            // 远端任务使用 cloud 语义图标，避免用户误把远端归档当成本地归档。
            <CloudUpload className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
        </TaskRowActionButton>
      )}
    </div>
  ) : null;
  // 原因：置顶任务常跨项目，查看文件必须保留独立入口；复用共享 action，避免点击选择任务。
  const fileTreeActionNode = showFileTree ? (
    <TaskRowActionButton
      label={intl.formatMessage({ id: "git.action.showTree" })}
      showTooltip
      testId={`task-files-${task.taskId}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void runUserActionAsync({
          input: { featureId: "workbench.file", action: "open_tree", trigger: "button" },
          operation: async () => onOpenFileTree?.(),
          completed: { resultSource: "local_commit" },
          failureStage: "file_tree_open",
        }).catch((cause) => {
          logger.error("[task-list] 查看文件失败", cause);
          toast(String(cause));
        });
      }}
    >
      <ListTree className="size-3.5" />
    </TaskRowActionButton>
  ) : null;

  if (!fileTreeActionNode && !archiveActionNode) {
    return null;
  }

  return (
    <span data-task-row-actions="true" className="flex shrink-0 items-center gap-0.5">
      {fileTreeActionNode}
      {archiveActionNode}
    </span>
  );
}
