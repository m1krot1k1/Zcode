import type { ZCodeTaskMeta } from "@zcode/shared";
import { resolveTaskSourceLabel } from "@/lib/taskSourceAttribution.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import type { TaskListItemProps } from "@/task-list-item/types.js";

function areJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function getTaskAutomationIdentity(task: ZCodeTaskMeta): string | undefined {
  return task.cronAutomationId ?? (task as ZCodeTaskMeta & { automationId?: string }).automationId;
}

function areTaskListItemTaskFieldsEqual(left: ZCodeTaskMeta, right: ZCodeTaskMeta) {
  if (left === right) {
    return true;
  }

  return (
    left.taskId === right.taskId &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.updatedAt === right.updatedAt &&
    left.unreadAt === right.unreadAt &&
    getTaskAutomationIdentity(left) === getTaskAutomationIdentity(right) &&
    left.status === right.status &&
    resolveTaskSourceLabel(left) === resolveTaskSourceLabel(right) &&
    areJsonFieldsEqual(left.pendingInteraction, right.pendingInteraction) &&
    areJsonFieldsEqual(getTaskListRowActivity(left), getTaskListRowActivity(right)) &&
    areJsonFieldsEqual(left.changeSummary, right.changeSummary)
  );
}

/** memo 比较键：保持拆分前的字段集合与顺序，避免任务行出现额外重渲染。 */
export function areTaskListItemPropsEqual(left: TaskListItemProps, right: TaskListItemProps) {
  return (
    left.workspacePath === right.workspacePath &&
    left.remoteSessionId === right.remoteSessionId &&
    areTaskListItemTaskFieldsEqual(left.task, right.task) &&
    left.isPinned === right.isPinned &&
    left.isArchived === right.isArchived &&
    left.isActive === right.isActive &&
    left.isMobileActive === right.isMobileActive &&
    left.hoverEnabled === right.hoverEnabled &&
    left.connectionOverlay === right.connectionOverlay &&
    left.isArchiveConfirming === right.isArchiveConfirming &&
    left.variant === right.variant &&
    left.showPinAction === right.showPinAction &&
    left.intl === right.intl &&
    left.actionsDisabled === right.actionsDisabled &&
    left.actionsDisabledReason === right.actionsDisabledReason &&
    left.onSelectTask === right.onSelectTask &&
    left.onArchiveTaskInline === right.onArchiveTaskInline &&
    left.onCancelArchiveConfirm === right.onCancelArchiveConfirm &&
    left.onTogglePinTask === right.onTogglePinTask &&
    left.onStartRenameTask === right.onStartRenameTask &&
    left.onArchiveTask === right.onArchiveTask &&
    left.onMarkTaskAsUnread === right.onMarkTaskAsUnread &&
    left.onOpenTaskContextMenu === right.onOpenTaskContextMenu &&
    left.onOpenFileTree === right.onOpenFileTree
  );
}
