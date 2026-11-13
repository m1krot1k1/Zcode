import { RemoteTaskDeviceLabel } from "@/remote-connection/RemoteTaskDeviceLabel.js";
import { cn } from "@/components/lib/utils.js";
import {
  TaskAttentionTag,
  TaskChangeSummaryText,
  TaskMobileActiveIndicator,
  TaskRowTitle,
  TaskScheduleIcons,
  TaskRemoteConnectionBadge,
} from "@/task-list-item/rowNodes.js";
import type { TaskRowContentProps } from "@/task-list-item/types.js";

/**
 * timeline 行布局：第一行标题与状态，第二行 workspace / 来源 / 变更摘要与时间。
 * 工作流运行行作为标题下的第二条通道追加，不占用前置状态槽。
 */
export function TaskListItemTimelineRow({
  task,
  intl,
  taskTitle,
  taskTitleWithChanges,
  workspaceLabel,
  taskSourceLabel,
  taskTimeLabel,
  isMobileActive,
  shouldSuppressWorkspaceTaskMetadata,
  hasPendingInteraction,
  taskAttentionDisplay,
  changeSummary,
  isTaskCron,
  isTaskOffPeak,
  isArchiveConfirming,
  remoteConnectionUnavailable,
  taskActions,
  workflowRunLines,
  onSnoozeInteractionAutoResolution,
}: TaskRowContentProps) {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
          <TaskMobileActiveIndicator
            intl={intl}
            triggerClassName="absolute -left-6 top-2 z-10 -translate-y-1/2"
          />
        ) : null}
        <TaskRemoteConnectionBadge visible={remoteConnectionUnavailable} intl={intl} />
        <TaskRowTitle taskTitle={taskTitle} taskTitleWithChanges={taskTitleWithChanges} />
        <TaskAttentionTag
          task={task}
          intl={intl}
          taskAttentionDisplay={taskAttentionDisplay}
          onSnoozeCountdown={onSnoozeInteractionAutoResolution}
          size="base"
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 text-ui-base text-foreground-subtle h-6">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" data-task-workspace-label="true">
            {workspaceLabel}
          </span>
          {taskSourceLabel ? (
            <>
              <span aria-hidden="true" className="text-foreground-subtlest">
                ·
              </span>
              <RemoteTaskDeviceLabel task={task} className="truncate" />
            </>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
          {!hasPendingInteraction ? (
            <span
              data-task-row-metadata="true"
              className={cn(
                "flex items-center gap-1.5",
                isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata ? "hidden" : undefined,
              )}
            >
              {changeSummary ? <TaskChangeSummaryText summary={changeSummary} /> : null}
              {changeSummary ? (
                <span aria-hidden="true" className="shrink-0 text-foreground-subtlest">
                  ·
                </span>
              ) : null}
              <TaskScheduleIcons
                isTaskCron={isTaskCron}
                isTaskOffPeak={isTaskOffPeak}
                intl={intl}
              />
              <span className="mr-1">{taskTimeLabel}</span>
            </span>
          ) : null}
          {taskActions}
        </div>
      </div>
      {workflowRunLines}
    </div>
  );
}
