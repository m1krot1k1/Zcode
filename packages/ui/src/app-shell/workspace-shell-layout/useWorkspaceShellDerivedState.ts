import { useCallback, useEffect, useMemo } from "react";
import type { CSSProperties } from "react";
import type { ResolvedWorkspaceShellLayoutProps } from "@/app-shell/workspace-shell-layout/helpers.js";
import type { WorkspaceShellBaseState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellBaseState.js";
import type { WorkspaceShellPaneState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellPaneState.js";
import type { WorkspaceSidebarResizeState } from "@/app-shell/workspace-shell-layout/useWorkspaceSidebarResize.js";
import { getGitDirtyFileCount } from "@/git-branch-switcher/display.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { isWorkspaceFilePathInside } from "@/workspace-file-tree/model.js";
import type { SidebarFileTreeOpenRequest } from "@/WorkspaceSidebar.js";

/**
 * Shell 的只读派生：搜索高亮归属、Git 未提交文件数、活动 workspace 的远端目标、
 * split 样式变量、文件链接归属与文件树请求入口。全部只从 props/base/panes 计算。
 */
export function useWorkspaceShellDerivedState(
  props: ResolvedWorkspaceShellLayoutProps,
  base: WorkspaceShellBaseState,
  panes: WorkspaceShellPaneState,
  sidebarResize: WorkspaceSidebarResizeState,
) {
  const {
    activeTaskId,
    canTaskNavBack,
    gitState,
    handleTaskNavBack,
    onWorkspaceMainViewChange,
    searchResultHighlightRequest,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceMainView,
    workspaceTabs,
  } = props;
  const {
    collapsedSidebarWidthPx,
    fileTreeOpenRequestIdRef,
    isWebRemoteControlShell,
    setFileTreeOpenRequest,
    webRemoteControlNavigationHeightPx,
    workspacePanelRadiusPx,
    workspaceResizeHandleInsetPx,
  } = base;
  const { isSidebarPanelVisible } = panes;
  const { workspaceSidebarPanelWidthPx } = sidebarResize;
  const activeSearchResultHighlightRequest = useMemo(() => {
    if (!searchResultHighlightRequest || searchResultHighlightRequest.taskId !== activeTaskId) {
      return null;
    }

    const activeWorkspaceKey = buildTaskWorkspaceKey(workspaceAbsPath, workspaceIdentity);
    const requestWorkspaceKey = buildTaskWorkspaceKey(
      searchResultHighlightRequest.workspacePath,
      searchResultHighlightRequest.workspaceIdentity,
    );
    return activeWorkspaceKey === requestWorkspaceKey ? searchResultHighlightRequest : null;
  }, [activeTaskId, searchResultHighlightRequest, workspaceAbsPath, workspaceIdentity]);
  const gitDirtyFileCount = useMemo(() => {
    // 关键业务逻辑：同一个文件可能同时出现在 staged / unstaged。
    // 这里按 path 去重后再统计，避免入口里“未提交更改文件数”被重复计算。
    return getGitDirtyFileCount(gitState.datasets);
  }, [gitState.datasets.staged, gitState.datasets.unstaged]);
  const workspaceRemoteTarget = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.remoteTarget,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const workspaceLocalPathForRemoteMcpSync = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.localWorkspacePath,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const webRemoteNavigationPanelStyle = useMemo<CSSProperties | undefined>(
    () =>
      isWebRemoteControlShell
        ? ({
            "--web-remote-navigation-height": `${webRemoteControlNavigationHeightPx}px`,
          } as CSSProperties)
        : undefined,
    [isWebRemoteControlShell, webRemoteControlNavigationHeightPx],
  );
  const workspaceShellSplitStyle = useMemo(
    () =>
      ({
        ...webRemoteNavigationPanelStyle,
        "--workspace-sidebar-panel-width": `${
          isSidebarPanelVisible ? workspaceSidebarPanelWidthPx : collapsedSidebarWidthPx
        }px`,
        "--workspace-sidebar-width": `${workspaceSidebarPanelWidthPx}px`,
        "--workspace-panel-radius": `${workspacePanelRadiusPx}px`,
        "--workspace-resize-handle-inset": `${workspaceResizeHandleInsetPx}px`,
      }) as CSSProperties,
    [
      collapsedSidebarWidthPx,
      isSidebarPanelVisible,
      workspacePanelRadiusPx,
      workspaceResizeHandleInsetPx,
      workspaceSidebarPanelWidthPx,
      webRemoteNavigationPanelStyle,
    ],
  );
  const findFileLinkOwnerWorkspace = useCallback(
    (
      targetPath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspaceRemoteSessionId?: string,
    ) => {
      const matches = workspaceTabs.filter(
        (tab) =>
          isWorkspaceFilePathInside(tab.workspacePath, targetPath) &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity) &&
          (!targetWorkspaceRemoteSessionId ||
            tab.remoteSessionId === targetWorkspaceRemoteSessionId),
      );
      if (matches.length === 0) {
        return null;
      }
      return (
        matches.sort((left, right) => {
          const leftActive = left.workspaceIdentity === workspaceIdentity ? 1 : 0;
          const rightActive = right.workspaceIdentity === workspaceIdentity ? 1 : 0;
          if (leftActive !== rightActive) {
            return rightActive - leftActive;
          }
          return right.workspacePath.length - left.workspacePath.length;
        })[0] ?? null
      );
    },
    [workspaceIdentity, workspaceTabs],
  );
  const openFileTreeRequest = useCallback((request: Omit<SidebarFileTreeOpenRequest, "id">) => {
    fileTreeOpenRequestIdRef.current += 1;
    setFileTreeOpenRequest({
      id: fileTreeOpenRequestIdRef.current,
      ...request,
    });
  }, []);
  const showChatMainView = useCallback(() => {
    onWorkspaceMainViewChange("chat");
  }, [onWorkspaceMainViewChange]);
  const primaryNavigationBack =
    workspaceMainView === "plugin-store" ? showChatMainView : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  useEffect(() => {
    if (
      isWebRemoteControlShell &&
      (workspaceMainView === "automations" || workspaceMainView === "plugin-store")
    ) {
      // 修复原因：手机远控复用桌面 shell 时可能保留上一次主视图状态；
      // 远控不承载 Automations，必须立即回落到 continuous/replayable 边界之外的聊天页。
      onWorkspaceMainViewChange("chat");
    }
  }, [isWebRemoteControlShell, onWorkspaceMainViewChange, workspaceMainView]);
  return {
    activeSearchResultHighlightRequest,
    gitDirtyFileCount,
    workspaceRemoteTarget,
    workspaceLocalPathForRemoteMcpSync,
    webRemoteNavigationPanelStyle,
    workspaceShellSplitStyle,
    findFileLinkOwnerWorkspace,
    openFileTreeRequest,
    showChatMainView,
    primaryNavigationBack,
    canPrimaryNavigationBack,
  };
}

export type WorkspaceShellDerivedState = ReturnType<typeof useWorkspaceShellDerivedState>;
