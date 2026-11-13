import { useEffect } from "react";
import {
  CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS,
  CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
  CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
  type ResolvedWorkspaceShellLayoutProps,
} from "@/app-shell/workspace-shell-layout/helpers.js";
import type { WorkspaceShellBaseState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellBaseState.js";
import type { WorkspaceShellPaneState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellPaneState.js";
import { logger } from "@/logger.js";

/**
 * conversation 过窄时的自动收起策略：只在窗口 resize idle 后读取对话列真实宽度，
 * 不改用户手动开关状态；完整视图下由宿主 fixed 定位，宽度不代表可见对话区。
 */
export function useConversationAutoCollapse(
  props: ResolvedWorkspaceShellLayoutProps,
  base: WorkspaceShellBaseState,
  panes: WorkspaceShellPaneState,
) {
  const {
    handleToggleSidePane,
    handleToggleSidebar,
    isSidePaneOpen,
    isSidebarVisible,
    reloadSessionDisabled,
    reloadSessionPending,
    workspaceMainView,
    workspaceReadOnlyReason,
  } = props;
  const {
    conversationAutoCollapseResizeTimerRef,
    conversationAutoCollapseStateRef,
    conversationPanelElementRef,
    intl,
    isWebRemoteControlMobileViewport,
    isWebRemoteControlShell,
    workspaceKey,
  } = base;
  const { isFullViewRef } = panes;
  const workspaceSessionActionDisabled =
    Boolean(workspaceReadOnlyReason) || reloadSessionDisabled || reloadSessionPending;
  const simplifyHeaderForNarrowRemote = isWebRemoteControlShell && isWebRemoteControlMobileViewport;
  const showTopOverlayNewTaskButton = !isSidebarVisible;
  const workspaceSidebarResizeLabel = intl.formatMessage({
    id: "workspaceSidebar.resizeSidebar",
  });

  useEffect(() => {
    conversationAutoCollapseStateRef.current = {
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      workspaceKey,
    };
  }, [handleToggleSidebar, handleToggleSidePane, isSidebarVisible, isSidePaneOpen, workspaceKey]);

  useEffect(() => {
    if (workspaceMainView !== "chat") {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const readConversationWidthPx = () =>
      conversationPanelElementRef.current?.getBoundingClientRect().width ?? null;

    const collapseSidebarIfStillNarrow = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidebar: collapseSidebar,
        isSidebarVisible: latestIsSidebarVisible,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      if (latestIsSidebarVisible && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起左侧栏", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidebar();
      }
    };

    const runAutoCollapseForWindowResize = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidePane: collapseSidePane,
        isSidePaneOpen: latestIsSidePaneOpen,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;
      // 完整视图中对话由宿主 fixed 定位，对话列宽度不代表可见对话区，不能据此收起面板或侧栏。
      if (isFullViewRef.current) {
        return;
      }

      // 功能说明：自动收起只响应用户改变窗口尺寸后的 conversation 实际宽度。
      // 不监听 conversation 自身 ResizeObserver，避免用户手动打开面板时又被策略关回去。
      if (latestIsSidePaneOpen && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起右侧面板", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidePane();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(collapseSidebarIfStillNarrow);
        });
        return;
      }

      collapseSidebarIfStillNarrow();
    };

    const handleWindowResize = () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
      }

      // Bugfix: 大会话 resize trace 显示自动收起侧栏会触发 WorkspaceSidebar
      // 和大量 tooltip/menu 子树重渲染；拖拽窗口过程中先等 resize idle，再保留原收起语义。
      conversationAutoCollapseResizeTimerRef.current = window.setTimeout(() => {
        conversationAutoCollapseResizeTimerRef.current = null;
        runAutoCollapseForWindowResize();
      }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };

    window.addEventListener("resize", handleWindowResize);

    return () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
        conversationAutoCollapseResizeTimerRef.current = null;
      }
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [workspaceMainView]);
  return {
    workspaceSessionActionDisabled,
    simplifyHeaderForNarrowRemote,
    showTopOverlayNewTaskButton,
    workspaceSidebarResizeLabel,
  };
}

export type ConversationAutoCollapseState = ReturnType<typeof useConversationAutoCollapse>;
