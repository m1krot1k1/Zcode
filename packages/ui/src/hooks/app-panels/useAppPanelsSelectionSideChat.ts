import { useCallback, useEffect } from "react";
import { useModelTrajectoryOpenBridge } from "@/hooks/useModelTrajectoryOpenBridge.js";
import { clearConversationSelectionReferenceScope } from "@/lib/conversationSelectionReference.js";
import { clearSelectionSideChat } from "@/lib/selectionSideChatRuntime.js";
import { subscribeTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { closeSidePaneTabForScope, type WorkspaceSidePaneState } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import type { AppPanelsCore } from "./useAppPanelsCore.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

/**
 * 框选副屏会话：runtime 释放、父任务结束清理，以及模型轨迹入口桥接。
 */
export function useAppPanelsSelectionSideChat({
  core,
  workspaceAbsPath,
  workspaceIdentity,
  handleOpenModelTrajectory,
}: {
  core: AppPanelsCore;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  handleOpenModelTrajectory: (params: { taskId: string; title?: string | null }) => void;
}) {
  const {
    commitSidePaneState,
    currentSidePaneScope,
    latestSidePaneMemoryRef,
    zcodeSessionService,
  } = core;
  const closeSelectionSideChatRuntime = useCallback(
    (tab: Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }>) => {
      clearSelectionSideChat(tab.childSessionId);
      clearConversationSelectionReferenceScope(tab.childSessionId, tab.workspaceKey);
      void zcodeSessionService
        .closeSession({
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          sessionId: tab.childSessionId,
        })
        .catch((error) => {
          if (String(error).includes("sessionNotFound")) return;
          logger.warn("[App] 关闭框选副屏 runtime 失败", {
            childSessionId: tab.childSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [zcodeSessionService],
  );

  useEffect(() => {
    const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
    return subscribeTaskLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      clearConversationSelectionReferenceScope(event.taskId, event.workspaceKey);
      const closingTabs =
        latestSidePaneMemoryRef.current.sidePaneState?.tabs.filter(
          (tab): tab is Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }> =>
            tab.type === "selection-side-chat" && tab.parentSessionId === event.taskId,
        ) ?? [];
      if (closingTabs.length === 0) return;

      for (const tab of closingTabs) closeSelectionSideChatRuntime(tab);
      const closingIds = new Set(closingTabs.map((tab) => tab.id));
      commitSidePaneState((current) => {
        if (!current) return current;
        let next: WorkspaceSidePaneState | null = current;
        for (const tabId of closingIds) {
          next = closeSidePaneTabForScope(next, tabId, currentSidePaneScope());
        }
        return next;
      });
      logger.info("[App] 父任务结束，清理框选副屏会话", {
        event: event.type,
        parentSessionId: event.taskId,
        workspaceKey,
      });
    });
  }, [
    currentSidePaneScope,
    closeSelectionSideChatRuntime,
    commitSidePaneState,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  // 订阅“打开模型调用轨迹”请求：菜单深处通过单例 store 发起，这里按 workspaceKey 匹配后消费。
  useModelTrajectoryOpenBridge(
    workspaceIdentity?.trim() || workspaceAbsPath,
    handleOpenModelTrajectory,
  );
  return { closeSelectionSideChatRuntime };
}
