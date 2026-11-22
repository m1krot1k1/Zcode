import { useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import { useV4SplitPaneEntry } from "@/v4/splitPaneEntryContext.js";
import { buildWorkbenchSessionKey, useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { TaskListItemIntl } from "@/task-list-item/types.js";

/**
 * 任务行自身状态：hover/focus 呈现、归档二次确认的全局监听、拖拽到工作台的能力。
 * hook 调用顺序与拆分前逐项一致（包括 useMemo 的依赖），仅把实现集中到一个 owner。
 */
export function useTaskListItemState(input: {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  intl: TaskListItemIntl;
  isArchiveConfirming: boolean;
  onCancelArchiveConfirm: () => void;
  actionsDisabled: boolean;
  actionsDisabledReason?: string;
}) {
  const {
    actionsDisabled,
    actionsDisabledReason,
    intl,
    isArchiveConfirming,
    onCancelArchiveConfirm,
    remoteSessionId,
    task,
    workspacePath,
  } = input;
  const [hoverActionsVisible, setHoverActionsVisible] = useState(false);
  const [focusActionsVisible, setFocusActionsVisible] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const itemRef = useRef<HTMLLIElement | null>(null);
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      actionsDisabled || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (actionsDisabledReason ??
      intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });

  useEffect(() => {
    if (!isArchiveConfirming) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancelArchiveConfirm();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && itemRef.current?.contains(target)) {
        return;
      }
      onCancelArchiveConfirm();
    }

    // 全局时间线和置顶列表的确认 key 含 workspacePath，Windows
    // 反斜杠拼进 CSS selector 后会被当作转义，确认按钮因此被误判为条目外点击。
    // 确认项直接使用自身 ref 判断事件边界，避免业务 key 与 CSS 语法耦合。
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isArchiveConfirming, onCancelArchiveConfirm]);

  const splitPaneEntryEnabled = useV4SplitPaneEntry().enabled;
  const taskWorkspaceScope = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, task.workspaceIdentity, workspacePath],
  );
  const taskWorkbenchSessionKey = useMemo(
    () => buildWorkbenchSessionKey(taskWorkspaceScope, task.taskId),
    [task.taskId, taskWorkspaceScope],
  );
  const isSessionInWorkbenchGroup = useWorkbenchGroupStore((state) =>
    Boolean(state.sessionIndex[taskWorkbenchSessionKey]),
  );
  const canDragToWorkbench =
    !workspaceActionsDisabled && splitPaneEntryEnabled && !isSessionInWorkbenchGroup;

  return {
    hoverActionsVisible,
    setHoverActionsVisible,
    focusActionsVisible,
    setFocusActionsVisible,
    isHoverNone,
    itemRef,
    workspaceActionsDisabled,
    workspaceActionsDisabledReason,
    snoozeInteractionAutoResolution,
    canDragToWorkbench,
  };
}
