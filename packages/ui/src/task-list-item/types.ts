import type { ReactNode } from "react";
import type { ZCodeTaskChangeSummary, ZCodeTaskMeta } from "@zcode/shared";

export type TaskListItemIntl = {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
};

export interface TaskListItemProps {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isArchived?: boolean;
  isActive: boolean;
  isMobileActive?: boolean;
  hoverEnabled?: boolean;
  connectionOverlay?: "disconnected" | "reconnecting";
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (e: React.MouseEvent, taskId: string) => void;
  onCancelArchiveConfirm: () => void;
  isArchiveConfirming: boolean;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu?: (taskId: string) => void;
  onOpenFileTree?: () => void | Promise<void>;
  variant?: "default" | "timeline";
  showPinAction?: boolean;
  intl: TaskListItemIntl;
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
}

/**
 * 默认列表行与 timeline 行共享的行内容契约。
 * 派生值（标题、可见变更摘要、动作节点）由 TaskListItem 计算后传入，
 * 行组件只负责各自的排版，不再重复调用 presentation helper。
 */
export interface TaskRowContentProps {
  task: ZCodeTaskMeta;
  intl: TaskListItemIntl;
  taskTitle: string;
  taskTitleWithChanges: string;
  workspaceLabel: string;
  taskSourceLabel: string | null;
  taskTimeLabel: string;
  isMobileActive: boolean;
  shouldSuppressWorkspaceTaskMetadata: boolean;
  hasPendingInteraction: boolean;
  taskAttentionDisplay: string | null;
  changeSummary: ZCodeTaskChangeSummary | null;
  isTaskCron: boolean;
  isTaskOffPeak: boolean;
  isArchiveConfirming: boolean;
  remoteConnectionUnavailable: boolean;
  taskActions: ReactNode;
  workflowRunLines: ReactNode;
  onSnoozeInteractionAutoResolution: (interactionId: string) => boolean | Promise<boolean>;
}
