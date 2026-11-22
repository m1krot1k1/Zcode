import { useCallback, useEffect } from "react";
import { logger } from "@/logger.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import {
  navigateFileManagerSidePane,
  openFileManagerSidePane,
  type FileManagerTarget,
} from "@/lib/workspaceSidePane.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import type { AppPanelsCore } from "./useAppPanelsCore.js";

/**
 * 文件管理面板：本地打开、跨 workspace 的 pending 请求中转与导航。
 */
export function useAppPanelsFileManager({
  core,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
}: {
  core: AppPanelsCore;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
}) {
  const {
    activeWorkspaceKey,
    activeWorkspaceKeyRef,
    commitOpenedSidePaneState,
    commitSidePaneState,
    revealSidePaneForCurrentOwner,
    sidePaneOwnerIdRef,
  } = core;
  const pendingFileManagerTarget = useOptionalTabStore((state) => state.pendingFileManagerTarget);
  const requestFileManager = useOptionalTabStore((state) => state.requestFileManager);
  const consumeFileManager = useOptionalTabStore((state) => state.consumeFileManager);
  const handleOpenFileManager = useCallback(
    (target?: FileManagerTarget) => {
      if (
        target &&
        !target.temporaryExternalDirectory &&
        (target.workspaceIdentity?.trim() || target.workspacePath) !== activeWorkspaceKeyRef.current
      ) {
        requestFileManager(target);
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openFileManagerSidePane(
          current,
          target ?? {
            workspacePath: workspaceAbsPath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
          },
        ),
      );
    },
    [
      requestFileManager,
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    ],
  );

  useEffect(() => {
    if (!pendingFileManagerTarget) return;
    const targetKey =
      pendingFileManagerTarget.workspaceIdentity?.trim() || pendingFileManagerTarget.workspacePath;
    if (targetKey !== activeWorkspaceKey) return;
    // 必须在本 hook 恢复目标 workspace 的 pane memory 和 owner 之后消费，不能由子 Shell effect 抢先写入旧桶。
    if (!consumeFileManager(pendingFileManagerTarget)) return;
    logger.debug("[FileManager] 在目标工作区打开目录", {
      workspaceKey: targetKey,
      ownerTaskId: sidePaneOwnerIdRef.current,
    });
    handleOpenFileManager(pendingFileManagerTarget);
  }, [pendingFileManagerTarget, activeWorkspaceKey, consumeFileManager, handleOpenFileManager]);

  const handleNavigateFileManager = useCallback(
    (tabId: string, source: CodeViewerSource) => {
      commitSidePaneState((current) => navigateFileManagerSidePane(current, tabId, source));
    },
    [commitSidePaneState],
  );
  return { handleNavigateFileManager, handleOpenFileManager };
}
