import { memo, useMemo } from "react";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { areTaskListItemPropsEqual } from "@/task-list-item/equality.js";
import { useTaskListItemHandlers } from "@/task-list-item/useTaskListItemHandlers.js";
import { useTaskListItemState } from "@/task-list-item/useTaskListItemState.js";
import { buildTaskListItemViewModel } from "@/task-list-item/viewModel.js";
import { TaskListItemDefaultRow } from "@/task-list-item/TaskListItemDefaultRow.js";
import { TaskListItemTimelineRow } from "@/task-list-item/TaskListItemTimelineRow.js";
import { TaskListItemLeadingSlot } from "@/task-list-item/TaskListItemLeadingSlot.js";
import { TaskRowActions } from "@/task-list-item/TaskRowActions.js";
import type { TaskListItemProps, TaskRowContentProps } from "@/task-list-item/types.js";

export const MemoTaskItem = memo(function TaskListItem({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  isArchived = false,
  isActive,
  isMobileActive = false,
  hoverEnabled = true,
  connectionOverlay,
  onSelectTask,
  onArchiveTaskInline,
  onCancelArchiveConfirm,
  isArchiveConfirming,
  onTogglePinTask,
  onOpenTaskContextMenu,
  onOpenFileTree,
  variant = "default",
  showPinAction = true,
  intl,
  actionsDisabled = false,
  actionsDisabledReason,
}: TaskListItemProps) {
  const state = useTaskListItemState({
    workspacePath,
    remoteSessionId,
    task,
    intl,
    isArchiveConfirming,
    onCancelArchiveConfirm,
    actionsDisabled,
    actionsDisabledReason,
  });
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const handlers = useTaskListItemHandlers({
    workspacePath,
    remoteSessionId,
    task,
    taskTitle,
    isPinned,
    onSelectTask,
    onArchiveTaskInline,
    onTogglePinTask,
    onOpenTaskContextMenu,
    setHoverActionsVisible: state.setHoverActionsVisible,
    canDragToWorkbench: state.canDragToWorkbench,
    workspaceActionsDisabled: state.workspaceActionsDisabled,
  });
  const taskActivity = getTaskListRowActivity(task);
  const leadingIndicator = useMemo(
    () => deriveTaskLeadingIndicator(task, taskActivity),
    [task, taskActivity],
  );
  const model = buildTaskListItemViewModel({
    task,
    intl,
    connectionOverlay,
    isPinned,
    isArchiveConfirming,
    isMobileActive,
    hoverEnabled,
    showPinAction,
    workspaceActionsDisabled: state.workspaceActionsDisabled,
    hoverActionsVisible: state.hoverActionsVisible,
    focusActionsVisible: state.focusActionsVisible,
    isHoverNone: state.isHoverNone,
    taskTitle,
    taskActivity,
    leadingIndicator,
    hasFileTreeHandler: Boolean(onOpenFileTree),
  });
  // 工作流运行行：标题下的第二条通道，
  // 与前置 16px 槽（error > unread > spinner）互不占位。只在会话带 run 摘要时挂组件。
  const workflowRunLines = model.hasWorkflowRunLines ? (
    <TaskWorkflowRunLines
      activity={taskActivity?.workflowActivity}
      isActive={isActive}
      intl={intl}
      session={{
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        sessionId: task.taskId,
      }}
    />
  ) : null;
  const taskActions = (
    <TaskRowActions
      task={task}
      intl={intl}
      isArchiveConfirming={isArchiveConfirming}
      isArchived={isArchived}
      isRemoteTask={model.isRemoteTask}
      showArchive={model.shouldRenderArchiveAction}
      showFileTree={model.shouldRenderFileTreeAction}
      onArchive={handlers.handleArchive}
      onOpenFileTree={onOpenFileTree}
    />
  );
  const rowContent: TaskRowContentProps = {
    task,
    intl,
    taskTitle,
    taskTitleWithChanges: model.taskTitleWithChanges,
    workspaceLabel: model.workspaceLabel,
    taskSourceLabel: model.taskSourceLabel,
    taskTimeLabel: model.taskTimeLabel,
    isMobileActive,
    shouldSuppressWorkspaceTaskMetadata: model.shouldSuppressWorkspaceTaskMetadata,
    hasPendingInteraction: model.hasPendingInteraction,
    taskAttentionDisplay: model.taskAttentionDisplay,
    changeSummary: model.changeSummary,
    isTaskCron: model.isTaskCron,
    isTaskOffPeak: model.isTaskOffPeak,
    isArchiveConfirming,
    remoteConnectionUnavailable: model.remoteConnectionUnavailable,
    taskActions,
    workflowRunLines,
    onSnoozeInteractionAutoResolution: state.snoozeInteractionAutoResolution,
  };

  return (
    <li
      ref={state.itemRef}
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={model.taskItemKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      data-archive-confirming-task-id={isArchiveConfirming ? task.taskId : undefined}
      onClick={handlers.handleSelect}
      onContextMenu={handlers.handleContextMenu}
      draggable={state.canDragToWorkbench}
      onDragStart={handlers.handleDragStart}
      onDragEnd={handlers.handleDragEnd}
      onMouseEnter={hoverEnabled ? handlers.handleMouseEnter : undefined}
      onMouseLeave={hoverEnabled ? handlers.handleMouseLeave : undefined}
      onFocusCapture={hoverEnabled ? () => state.setFocusActionsVisible(true) : undefined}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          state.setFocusActionsVisible(false);
        }
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handlers.handleSelect();
        }
      }}
      className={cn(
        "group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]",
        // 默认行 32px 时前置槽整行居中；长出工作流运行行后行体是两行的纵向列，槽改为对齐首行。
        variant === "timeline"
          ? "items-start py-1.5"
          : model.hasWorkflowRunLines
            ? "items-start"
            : "items-center",
        isActive ? "bg-selected" : hoverEnabled && "hover:bg-surface-hover",
      )}
    >
      {/* Bugfix: 之前任务列表依赖 divide-y 画分隔线，深色侧栏里每个 item 上下都会出现明显黑线，
              视觉上像被两条边框夹住。这里改成“列表留白 + item 自己带圆角态”，
              让 hover/active 的层级由卡片背景承担，不再依赖分隔线。 */}

      <TaskListItemLeadingSlot
        leadingIndicator={leadingIndicator}
        isMobileActive={isMobileActive}
        isPinned={isPinned}
        intl={intl}
        onTogglePin={handlers.handleTogglePin}
        shouldRenderPinAction={model.shouldRenderPinAction}
        variant={variant}
        hasWorkflowRunLines={model.hasWorkflowRunLines}
        workspaceActionsDisabled={state.workspaceActionsDisabled}
        workspaceActionsDisabledReason={state.workspaceActionsDisabledReason}
      />

      {variant === "timeline" ? (
        <TaskListItemTimelineRow {...rowContent} />
      ) : (
        <TaskListItemDefaultRow {...rowContent} />
      )}
    </li>
  );
}, areTaskListItemPropsEqual);

MemoTaskItem.displayName = "MemoTaskItem";
