import {
  isCronTask,
  isOffPeakTask,
  type ZCodeTaskChangeSummary,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskTitleWithChanges, getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { resolveTaskSourceLabel } from "@/lib/taskSourceAttribution.js";
import { getTaskListAttention, type TaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { shouldShowRemoteConnectionOverlay } from "@/task-list-item/connectionOverlay.js";
import type { TaskListItemIntl } from "@/task-list-item/types.js";

export type TaskLeadingIndicator = ReturnType<typeof deriveTaskLeadingIndicator>;

export interface TaskListItemViewModel {
  taskAttentionDisplay: string | null;
  taskTitleWithChanges: string;
  taskSourceLabel: string | null;
  workspaceLabel: string;
  isTaskCron: boolean;
  isTaskOffPeak: boolean;
  shouldSuppressWorkspaceTaskMetadata: boolean;
  shouldMountWorkspaceTaskActions: boolean;
  taskTimeLabel: string;
  changeSummary: ZCodeTaskChangeSummary | null;
  isRemoteTask: boolean;
  remoteConnectionUnavailable: boolean;
  taskItemKey: string;
  hasPendingInteraction: boolean;
  hasWorkflowRunLines: boolean;
  shouldRenderPinAction: boolean;
  shouldRenderArchiveAction: boolean;
  shouldRenderFileTreeAction: boolean;
}

/**
 * 纯派生层：把任务元数据、hover 呈现与 leading 状态折算成行组件需要的展示值。
 * 不包含 hook，保证 render 内只调用一次相对时间与标题格式化（拆分前同样只算一次）。
 */
export function buildTaskListItemViewModel(input: {
  task: ZCodeTaskMeta;
  intl: TaskListItemIntl;
  connectionOverlay?: "disconnected" | "reconnecting";
  isPinned: boolean;
  isArchiveConfirming: boolean;
  isMobileActive: boolean;
  hoverEnabled: boolean;
  showPinAction: boolean;
  workspaceActionsDisabled: boolean;
  hoverActionsVisible: boolean;
  focusActionsVisible: boolean;
  isHoverNone: boolean;
  taskTitle: string;
  taskActivity: TaskListRowActivity | null;
  leadingIndicator: TaskLeadingIndicator;
  hasFileTreeHandler: boolean;
}): TaskListItemViewModel {
  const {
    connectionOverlay,
    focusActionsVisible,
    hasFileTreeHandler,
    hoverActionsVisible,
    hoverEnabled,
    intl,
    isArchiveConfirming,
    isHoverNone,
    isMobileActive,
    isPinned,
    leadingIndicator,
    showPinAction,
    task,
    taskActivity,
    taskTitle,
    workspaceActionsDisabled,
  } = input;
  const taskAttention = getTaskListAttention(task);
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
  const taskAttentionLabel = taskAttention
    ? intl.formatMessage({
        id: taskAttention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
      })
    : null;
  const taskAttentionDisplay =
    taskAttention && taskAttentionLabel && taskAttention.count > 1
      ? intl.formatMessage(
          { id: "taskList.attentionCount" },
          { label: taskAttentionLabel, count: String(taskAttention.count) },
        )
      : taskAttentionLabel;
  const taskSourceLabel = resolveTaskSourceLabel(task);
  const isTaskCron = isCronTask(task);
  // 月亮身份改为持久 meta 标记判断；off-peak store 反查在任务被删除后会丢失
  // 会话溯源，且让每一行多背一个全局 store 订阅。
  const isTaskOffPeak = isOffPeakTask(task);
  // Bugfix: 手机远控标记和置顶状态共用左侧 leading 槽。
  // 已置顶任务如果继续常显 Pin，会和绝对定位的手机图标重叠；手机激活态默认让手机图标优先，hover 时再显示 Pin 操作。
  const showPinnedState = isPinned && leadingIndicator === "none" && !isMobileActive;
  // 修复原因：手机会在 click 前合成 mouseenter/focus；此时切换内容会让首次点击只进入 hover。
  // 远控入口固定操作区和元信息，避免触摸引发 DOM 切换；桌面仍沿用 hover/focus 展示。
  const shouldSuppressWorkspaceTaskMetadata =
    hoverEnabled && (hoverActionsVisible || focusActionsVisible);
  const shouldMountWorkspaceTaskActions =
    !hoverEnabled || shouldSuppressWorkspaceTaskMetadata || isHoverNone;
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const taskChangeSummary = getTaskChangeSummary(task);
  const isRemoteTask = Boolean(task.workspaceIdentity?.trim());
  const remoteConnectionUnavailable = shouldShowRemoteConnectionOverlay({
    workspaceIdentity: task.workspaceIdentity,
    connectionOverlay,
  });
  const taskTitleWithChanges = formatTaskTitleWithChanges(taskTitle, taskChangeSummary, intl);
  const workspaceLabel = getPathLeaf(task.workspacePath);
  const taskItemKey = `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}`;
  // 工作流运行行：标题下的第二条通道，
  // 与前置 16px 槽（error > unread > spinner）互不占位。只在会话带 run 摘要时挂组件。
  const hasWorkflowRunLines = taskActivity?.workflowActivity !== undefined;
  // hover:none 只让右侧 task actions 常驻；如果也用它接管 leading 槽，
  // 触屏端的错误、未读和 loading 状态会被 Pin 永久替换。
  const shouldRenderPinAction =
    showPinAction && (showPinnedState || shouldSuppressWorkspaceTaskMetadata);
  const shouldRenderArchiveAction =
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isArchiveConfirming);
  // 原因：置顶任务常跨项目，查看文件必须保留独立入口；触屏常驻 action 时也保持可见。
  const shouldRenderFileTreeAction =
    hasFileTreeHandler &&
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isMobileActive);

  return {
    taskAttentionDisplay,
    taskTitleWithChanges,
    taskSourceLabel,
    workspaceLabel,
    isTaskCron,
    isTaskOffPeak,
    shouldSuppressWorkspaceTaskMetadata,
    shouldMountWorkspaceTaskActions,
    taskTimeLabel,
    changeSummary: hasPendingInteraction ? null : taskChangeSummary,
    isRemoteTask,
    remoteConnectionUnavailable,
    taskItemKey,
    hasPendingInteraction,
    hasWorkflowRunLines,
    shouldRenderPinAction,
    shouldRenderArchiveAction,
    shouldRenderFileTreeAction,
  };
}
