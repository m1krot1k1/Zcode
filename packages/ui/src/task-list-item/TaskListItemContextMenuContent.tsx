import { useCallback } from "react";
import type { ReactNode } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { toast } from "@/components/ui/toast.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { TaskListItemContextMenu } from "@/TaskListItemContextMenu.js";
import type { TaskListItemIntl } from "@/task-list-item/types.js";

/** 列表级单例右键菜单内容：行内不再挂载，只有菜单真正打开时才渲染。 */
export function TaskListItemContextMenuContent({
  organizationActions,
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  isArchived = false,
  intl,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  disableTaskActions = false,
  disabledReason,
}: {
  organizationActions?: ReactNode;
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isArchived?: boolean;
  intl: TaskListItemIntl;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      disableTaskActions || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (disabledReason ?? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  } = useTaskListItemContextActions({
    workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    // row 级菜单已收敛为列表级单例，只有菜单真正打开时才挂载此组件。
    // 因此路径探测和 provider 配置探测可以直接随打开态运行，避免每个 idle row 订阅和计算。
    loadTaskPaths: true,
    loadProviderConfig: true,
  });
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });

  const handleOpenTaskFeedback = useCallback(async () => {
    // 任务右键菜单之前只能复制日志/路径，反馈时缺少任务上下文。
    // 这里复用反馈中心 draft，只预填脱敏后的任务线索，附件由用户主动选择。
    openFeedbackSubmit({
      title: intl
        .formatMessage(
          { id: "feedback.submit.template.section.taskFeedbackTitle" },
          { title: taskTitle },
        )
        .slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: true,
      description: buildTaskFeedbackDescription({
        taskTitle,
        taskId: task.taskId,
        workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  }, [
    intl,
    openFeedbackSubmit,
    task.taskId,
    taskNativeSessionLogFile.path,
    taskSessionFile.path,
    taskTitle,
    workspacePath,
  ]);

  return (
    <TaskListItemContextMenu
      organizationActions={organizationActions}
      intl={intl}
      isPinned={isPinned}
      isArchived={isArchived}
      fileManagerLabel={fileManagerLabel}
      taskSessionFile={taskSessionFile}
      activeSessionId={task.taskId}
      taskNativeSessionLogFile={taskNativeSessionLogFile}
      providerConfigFile={providerConfigFile}
      disableTaskActions={workspaceActionsDisabled}
      disabledReason={workspaceActionsDisabledReason}
      onTogglePinTask={() => {
        onTogglePinTask(task.taskId, !isPinned);
      }}
      onStartRenameTask={() => {
        onStartRenameTask(task.taskId, task.title);
      }}
      onArchiveTask={() => {
        onArchiveTask(task.taskId);
      }}
      onMarkTaskAsUnread={() => {
        onMarkTaskAsUnread(task.taskId);
      }}
      onOpenTaskFeedback={() => {
        void handleOpenTaskFeedback();
      }}
      onOpenTaskPathInFileManager={() => {
        void handleOpenTaskPathInFileManager();
      }}
      onCopyWorkspacePath={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), workspacePath);
      }}
      onCopyTaskPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyTaskPath" }),
          taskSessionFile.path,
        );
      }}
      onCopyTaskLogPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyLogPath" }),
          taskNativeSessionLogFile.path,
        );
      }}
      onCopySessionId={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId);
      }}
      onViewModelTrajectory={() => {
        // 通过单例 store 把“打开轨迹”请求交给所属 workspace 的侧边栏控制器（useAppPanels）。
        useModelTrajectoryStore.getState().requestOpen({
          taskId: task.taskId,
          workspaceKey: task.workspaceIdentity?.trim() || workspacePath,
          title: taskTitle,
        });
      }}
      onOpenProviderConfig={() => {
        void handleOpenProviderConfig();
      }}
    />
  );
}
