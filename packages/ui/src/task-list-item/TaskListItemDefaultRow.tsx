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
 * 默认列表行布局：标题、变更摘要与动作按钮在同一行，时间元信息贴右侧。
 */
export function TaskListItemDefaultRow({
  task,
  intl,
  taskTitle,
  taskTitleWithChanges,
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
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative min-w-0 flex h-6 flex-1 flex-wrap items-center gap-1.5">
          {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
            <TaskMobileActiveIndicator
              intl={intl}
              triggerClassName="absolute -left-6 top-1/2 z-10 -translate-y-1/2"
            />
          ) : null}
          <TaskRemoteConnectionBadge visible={remoteConnectionUnavailable} intl={intl} />
          <TaskRowTitle taskTitle={taskTitle} taskTitleWithChanges={taskTitleWithChanges} />
          {changeSummary ? (
            <span
              className={cn(
                isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata ? "hidden" : undefined,
              )}
            >
              <TaskChangeSummaryText summary={changeSummary} />
            </span>
          ) : null}
          <TaskAttentionTag
            task={task}
            intl={intl}
            taskAttentionDisplay={taskAttentionDisplay}
            onSnoozeCountdown={onSnoozeInteractionAutoResolution}
            size="sm"
          />
        </div>

        {!hasPendingInteraction ? (
          // 交互胶囊已经占用右侧状态位；继续显示相对时间会和“等待确认”并排挤压标题。
          <span
            data-task-row-metadata="true"
            className={cn(
              "mr-0.5 flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle",
              isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata ? "hidden" : undefined,
            )}
          >
            <TaskScheduleIcons isTaskCron={isTaskCron} isTaskOffPeak={isTaskOffPeak} intl={intl} />
            {taskTimeLabel}
          </span>
        ) : null}

        {taskActions}
      </div>
      {workflowRunLines}
    </div>
  );
}
