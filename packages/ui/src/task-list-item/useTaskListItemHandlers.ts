import { useCallback } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { createTaskWorkbenchDragPreview } from "@/lib/taskWorkbenchDragPreview.js";
import {
  WORKBENCH_SESSION_DRAG_MIME,
  clearActiveWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  setActiveWorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";

/**
 * 任务行交互入口：选择、拖拽到工作台、右键菜单、归档（含二次确认）、置顶和 hover 呈现。
 * 调用顺序与拆分前一致；行内容子组件只消费返回的回调，不另行创建 handler。
 */
export function useTaskListItemHandlers(input: {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  taskTitle: string;
  isPinned: boolean;
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (event: React.MouseEvent, taskId: string) => void;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onOpenTaskContextMenu?: (taskId: string) => void;
  setHoverActionsVisible: (visible: boolean) => void;
  canDragToWorkbench: boolean;
  workspaceActionsDisabled: boolean;
}) {
  const {
    canDragToWorkbench,
    isPinned,
    onArchiveTaskInline,
    onOpenTaskContextMenu,
    onSelectTask,
    onTogglePinTask,
    remoteSessionId,
    setHoverActionsVisible,
    task,
    taskTitle,
    workspaceActionsDisabled,
    workspacePath,
  } = input;
  const handleSelect = useCallback(() => {
    runUserAction({
      input: { featureId: "task.lifecycle", action: "open", trigger: "button" },
      operation: () => onSelectTask(task.taskId),
      completed: { resultSource: "optimistic_projection" },
      failureStage: "task_open",
    });
  }, [onSelectTask, task.taskId]);
  const handleDragStart = useCallback(
    (event: DragEvent<HTMLLIElement>) => {
      if (!canDragToWorkbench) {
        event.preventDefault();
        return;
      }
      // 原因：此行同时可复制到分屏、移动到项目；只允许 copy 会让浏览器拒绝项目的 move/drop。
      event.dataTransfer.effectAllowed = "copyMove";
      const payload = {
        kind: "zcode/session" as const,
        workspacePath,
        ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId: task.taskId,
      };
      setActiveWorkbenchSessionDragPayload(payload);
      event.dataTransfer.setData(
        WORKBENCH_SESSION_DRAG_MIME,
        serializeWorkbenchSessionDragPayload(payload),
      );
      event.dataTransfer.setData("text/plain", taskTitle);
      // Bugfix：浏览器默认 drag preview 背景透明、边界不清晰；保留原行内容，
      // 只补齐拖动 overlay 使用的背景、边框和阴影。
      const cleanupDragPreview = createTaskWorkbenchDragPreview({
        clientX: event.clientX,
        clientY: event.clientY,
        dataTransfer: event.dataTransfer,
        source: event.currentTarget,
      });
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      if (ownerWindow) {
        ownerWindow.requestAnimationFrame(cleanupDragPreview);
      } else {
        cleanupDragPreview();
      }
    },
    [
      canDragToWorkbench,
      remoteSessionId,
      task.taskId,
      task.workspaceIdentity,
      taskTitle,
      workspacePath,
    ],
  );
  const handleDragEnd = useCallback(() => {
    clearActiveWorkbenchSessionDragPayload();
  }, []);
  const handleContextMenu = useCallback(() => {
    onOpenTaskContextMenu?.(task.taskId);
  }, [onOpenTaskContextMenu, task.taskId]);
  const handleArchive = useCallback(
    (event: MouseEvent) => {
      if (workspaceActionsDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      runUserAction({
        input: { featureId: "task.lifecycle", action: "archive", trigger: "button" },
        operation: () => onArchiveTaskInline(event, task.taskId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "task_archive",
      });
    },
    [onArchiveTaskInline, task.taskId, workspaceActionsDisabled],
  );
  const handleTogglePin = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      onTogglePinTask(task.taskId, !isPinned);
    },
    [isPinned, onTogglePinTask, task.taskId, workspaceActionsDisabled],
  );
  const handleMouseEnter = useCallback(() => {
    setHoverActionsVisible(true);
  }, [setHoverActionsVisible]);
  const handleMouseLeave = useCallback(() => {
    setHoverActionsVisible(false);
    // 归档二次确认依赖用户第二次点击确认；鼠标离开 row 时清理 hover 展示即可。
    // 如果同步取消确认，用户移动鼠标稍微离开任务行后确认按钮会消失，导致二次确认无法稳定完成。
  }, [setHoverActionsVisible]);

  return {
    handleSelect,
    handleDragStart,
    handleDragEnd,
    handleContextMenu,
    handleArchive,
    handleTogglePin,
    handleMouseEnter,
    handleMouseLeave,
  };
}
