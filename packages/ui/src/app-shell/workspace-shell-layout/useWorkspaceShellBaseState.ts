import { useCallback, useRef, useState } from "react";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { ResolvedWorkspaceShellLayoutProps } from "@/app-shell/workspace-shell-layout/helpers.js";
import {
  consumeWebRemoteControlCollapseIntent,
  getIsWebRemoteControlMobileViewport,
  getWebRemoteControlViewportHeight,
  readStoredWorkspaceSidebarWidthPx,
  WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  type WebRemoteNavigationDragSession,
  type WorkspaceSidebarResizeSession,
} from "@/app-shell/workspace-shell-layout/helpers.js";
import {
  getDefaultWebRemoteNavigationHeightPx,
  resolveWebRemoteNavigationDragState,
} from "@/app-shell/webRemoteNavigationLayout.js";
import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
} from "@/app-shell/workspaceShellWindowChrome.js";
import {
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  usePaneSessionPersistence,
  useRemotePaneSessionLookup,
} from "@/v4/usePaneSessionPersistence.js";
import type { SidebarFileTreeOpenRequest } from "@/WorkspaceSidebar.js";

/**
 * Shell 的外层状态所有者：界面上下文、窗口圆角/内边距、侧栏宽度、Web 远控导航、
 * 文件树打开请求、截图 surface 与 pane session 复用。渲染与派生只读这里的事实。
 */
export function useWorkspaceShellBaseState(props: ResolvedWorkspaceShellLayoutProps) {
  const {
    activeTaskId,
    desktopWindowChromeState,
    handleOpenFileManager,
    handleSelectTask,
    handleStartDraftInWorkspace,
    handleToggleSidePane,
    handleToggleSidebar,
    initialSidebarFileTreeOpen,
    isDesktop,
    isMacDesktop,
    isSidePaneOpen,
    isSidebarVisible,
    isWindowsDesktop,
    sidePaneState,
    webRemoteControlWorkspaceSwitcher,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    workspaceShellZCodeState,
  } = props;
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const isWebRemoteControlShell = Boolean(webRemoteControlWorkspaceSwitcher);
  // Windows/Linux 原先遗漏外层留白，导致独立面板贴住窗口边缘；桌面统一使用 4px 间距。
  const hasDesktopPanelInset = isMacDesktop || isWindowsDesktop || isLinuxDesktop;
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const workspaceShellRadiusOptions = {
    isMacDesktop,
    isWindowsDesktop,
    isLinuxDesktop,
    macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
  };
  const workspacePanelRadiusPx = resolveWorkspaceShellPanelRadiusPx(workspaceShellRadiusOptions);
  const workspaceResizeHandleInsetPx = resolveWorkspaceShellResizeHandleInsetPx(
    workspaceShellRadiusOptions,
  );
  const collapsedSidebarWidthPx = hasDesktopPanelInset ? (isWindowsDesktop ? 6 : 4) : 0;
  const [isWebRemoteControlNavigationCollapsed, setIsWebRemoteControlNavigationCollapsed] =
    useState(() => (isWebRemoteControlShell ? consumeWebRemoteControlCollapseIntent() : false));
  const [webRemoteControlNavigationHeightPx, setWebRemoteControlNavigationHeightPx] = useState(
    () => {
      const viewportHeight = getWebRemoteControlViewportHeight();
      return resolveWebRemoteNavigationDragState({
        heightPx: getDefaultWebRemoteNavigationHeightPx(viewportHeight),
        viewportHeight,
      }).heightPx;
    },
  );
  const [isWebRemoteControlTaskSwitching, setIsWebRemoteControlTaskSwitching] = useState(false);
  const [draftHeaderDropTargetController, setDraftHeaderDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const fileTreeOpenRequestIdRef = useRef(0);
  const [fileTreeOpenRequest, setFileTreeOpenRequest] = useState<SidebarFileTreeOpenRequest | null>(
    () =>
      initialSidebarFileTreeOpen
        ? {
            id: 0,
            target: {
              workspacePath: workspaceAbsPath,
              workspaceName: getPathLeaf(workspaceAbsPath),
              workspaceIdentity,
              workspaceRemoteSessionId,
            },
          }
        : null,
  );
  const handleOpenSidebarFiles = useCallback(
    (target: SidebarFileTreeOpenRequest["target"]) => {
      // 文件入口由右侧标签页承接，消费后清除请求，避免侧栏重新挂载时重复打开。
      setFileTreeOpenRequest(null);
      handleOpenFileManager(target);
    },
    [handleOpenFileManager],
  );
  const [isWebRemoteControlMobileViewport, setIsWebRemoteControlMobileViewport] = useState(
    getIsWebRemoteControlMobileViewport,
  );
  const [isWebRemoteControlNavigationDragging, setIsWebRemoteControlNavigationDragging] =
    useState(false);
  const webRemoteControlNavigationHeightRef = useRef(webRemoteControlNavigationHeightPx);
  const webRemoteControlNavigationCollapsedRef = useRef(isWebRemoteControlNavigationCollapsed);
  const webRemoteControlNavigationDragRef = useRef<WebRemoteNavigationDragSession | null>(null);
  const suppressWebRemoteControlNavigationClickRef = useRef(false);
  const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(sidePaneState?.tabs ?? []);
  const screenshotSurfaceTab = screenshotSurfaceRequest
    ? findScreenshotSurfaceTabForRender(sidePaneState?.tabs ?? [], screenshotSurfaceRequest)
    : undefined;
  const restorePaneSession = useTabStore((state) =>
    state.tabs.some(
      (tab) =>
        isWorkspaceTab(tab) &&
        tab.restorePaneSession &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
    ),
  );
  const lookupPaneSession = useRemotePaneSessionLookup(
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  );
  // 页签决定启动位置，pane 复用既有选择持久化；services ready 前不查询远端。
  usePaneSessionPersistence({
    workspaceKey,
    activeSessionId: activeTaskId,
    draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
    enabled: !isWebRemoteControlShell,
    restoreOnStartup: Boolean(isDesktop && restorePaneSession),
    selectSession: (sessionId) => handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity),
    lookupSession: isDesktop ? lookupPaneSession : undefined,
    onSessionMissing: () => handleStartDraftInWorkspace(workspaceAbsPath, workspaceIdentity),
  });
  const workspaceShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceSidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationAutoCollapseStateRef = useRef({
    handleToggleSidebar,
    handleToggleSidePane,
    isSidebarVisible,
    isSidePaneOpen,
    workspaceKey,
  });
  const conversationAutoCollapseResizeTimerRef = useRef<number | null>(null);
  const workspaceSidebarResizeSessionRef = useRef<WorkspaceSidebarResizeSession | null>(null);
  const [workspaceSidebarPanelWidthPx, setWorkspaceSidebarPanelWidthPx] = useState(
    () => readStoredWorkspaceSidebarWidthPx() ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  );
  const workspaceSidebarPanelWidthPxRef = useRef(workspaceSidebarPanelWidthPx);
  return {
    intl,
    isOfficeMode,
    baseServices,
    tabStoreApi,
    isLinuxDesktop,
    isWebRemoteControlShell,
    hasDesktopPanelInset,
    usesInlineWindowControls,
    workspacePanelRadiusPx,
    workspaceResizeHandleInsetPx,
    collapsedSidebarWidthPx,
    isWebRemoteControlNavigationCollapsed,
    setIsWebRemoteControlNavigationCollapsed,
    webRemoteControlNavigationHeightPx,
    setWebRemoteControlNavigationHeightPx,
    isWebRemoteControlTaskSwitching,
    setIsWebRemoteControlTaskSwitching,
    draftHeaderDropTargetController,
    setDraftHeaderDropTargetController,
    workspaceKey,
    fileTreeOpenRequestIdRef,
    fileTreeOpenRequest,
    setFileTreeOpenRequest,
    handleOpenSidebarFiles,
    isWebRemoteControlMobileViewport,
    setIsWebRemoteControlMobileViewport,
    isWebRemoteControlNavigationDragging,
    setIsWebRemoteControlNavigationDragging,
    webRemoteControlNavigationHeightRef,
    webRemoteControlNavigationCollapsedRef,
    webRemoteControlNavigationDragRef,
    suppressWebRemoteControlNavigationClickRef,
    screenshotSurfaceRequest,
    screenshotSurfaceTab,
    workspaceShellRef,
    workspaceSidebarPanelElementRef,
    conversationPanelElementRef,
    conversationAutoCollapseStateRef,
    conversationAutoCollapseResizeTimerRef,
    workspaceSidebarResizeSessionRef,
    workspaceSidebarPanelWidthPx,
    setWorkspaceSidebarPanelWidthPx,
    workspaceSidebarPanelWidthPxRef,
  };
}

export type WorkspaceShellBaseState = ReturnType<typeof useWorkspaceShellBaseState>;
