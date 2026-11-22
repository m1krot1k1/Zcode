import { useAppPanelsCore } from "./app-panels/useAppPanelsCore.js";
import { useAppPanelsFileManager } from "./app-panels/useAppPanelsFileManager.js";
import { useAppPanelsOpeners } from "./app-panels/useAppPanelsOpeners.js";
import { useAppPanelsSelectionSideChat } from "./app-panels/useAppPanelsSelectionSideChat.js";
import { useAppPanelsTabControls } from "./app-panels/useAppPanelsTabControls.js";
import { useAppPanelsToolPanels } from "./app-panels/useAppPanelsToolPanels.js";
import type { AppPanelsOptions } from "./app-panels/types.js";

export type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "./app-panels/types.js";

/**
 * App 级面板控制器：side pane 状态、文件管理、右侧预览/浏览器、工具面板、
 * 框选副屏与 tab 生命周期统一由这里组合。
 *
 * 实现按职责拆到 `./app-panels/`，每个子 hook 对应原实现里一段连续职责，
 * 调用顺序与原文件一致：canonical 状态与 commit 入口先建立，BrowserView 订阅
 * 随后接入，关闭/重开等 tab 生命周期最后挂载。
 */
export function useAppPanels(options: AppPanelsOptions) {
  const {
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
    defaultWhiteboardNamePrefix,
    platform,
  } = options;
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);

  const core = useAppPanelsCore({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
  });
  const fileManager = useAppPanelsFileManager({
    core,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const openers = useAppPanelsOpeners({
    core,
    workspaceAbsPath,
    supportsEmbeddedBrowser,
    isDesktop,
    platform,
  });
  const toolPanels = useAppPanelsToolPanels({
    core,
    workspaceAbsPath,
    workspaceIdentity,
    defaultWhiteboardNamePrefix,
    supportsEmbeddedBrowser,
  });
  const selectionSideChat = useAppPanelsSelectionSideChat({
    core,
    workspaceAbsPath,
    workspaceIdentity,
    handleOpenModelTrajectory: toolPanels.handleOpenModelTrajectory,
  });
  const tabControls = useAppPanelsTabControls({
    core,
    workspaceAbsPath,
    isDesktop,
    platform,
    closeSelectionSideChatRuntime: selectionSideChat.closeSelectionSideChatRuntime,
  });

  return {
    // 办公模式只隐藏新建入口；过滤面板状态会让已打开的终端和审查在切换时消失。
    isTerminalOpen: core.isTerminalOpen,
    setIsTerminalOpen: core.setIsTerminalOpen,
    sidePaneState: core.sidePaneState,
    recentClosedSidePaneTabs: tabControls.recentClosedSidePaneTabs,
    isSidePaneCollapsed: core.isSidePaneCollapsed,
    setIsSidePaneCollapsed: core.setIsSidePaneCollapsed,
    isSidebarVisible: core.isSidebarVisible,
    browserNavigationRequest: core.browserNavigationRequest,
    setBrowserNavigationRequest: core.setBrowserNavigationRequest,
    handleOpenFileManager: fileManager.handleOpenFileManager,
    handleNavigateFileManager: fileManager.handleNavigateFileManager,
    // 回调
    handleOpenCodeViewer: openers.handleOpenCodeViewer,
    handleOpenCodeViewers: openers.handleOpenCodeViewers,
    handleOpenBrowserUrl: openers.handleOpenBrowserUrl,
    handleToggleBrowser: openers.handleToggleBrowser,
    handleOpenBrowserTab: openers.handleOpenBrowserTab,
    handleOpenBrowserPermissionSettings: openers.handleOpenBrowserPermissionSettings,
    handleToggleGit: toolPanels.handleToggleGit,
    handleOpenGit: toolPanels.handleOpenGit,
    handleOpenTreemapping: toolPanels.handleOpenTreemapping,
    handleOpenWhiteboard: toolPanels.handleOpenWhiteboard,
    handleOpenDeveloperTools: toolPanels.handleOpenDeveloperTools,
    handleOpenAgentWorkbench: toolPanels.handleOpenAgentWorkbench,
    handleOpenPluginMarket: toolPanels.handleOpenPluginMarket,
    handleOpenNewSidePaneTab: toolPanels.handleOpenNewSidePaneTab,
    handleOpenTerminalTab: toolPanels.handleOpenTerminalTab,
    handleOpenModelTrajectory: toolPanels.handleOpenModelTrajectory,
    handleOpenSubagentSession: toolPanels.handleOpenSubagentSession,
    handleOpenBackgroundBash: toolPanels.handleOpenBackgroundBash,
    handleOpenSubagentDirectory: toolPanels.handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs: toolPanels.handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat: toolPanels.handleOpenSelectionSideChat,
    handleOpenPlanDetail: toolPanels.handleOpenPlanDetail,
    handleOpenPluginUi: toolPanels.handleOpenPluginUi,
    handleOpenWorkflowRun: toolPanels.handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory: toolPanels.handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession: toolPanels.handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace: toolPanels.handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact: toolPanels.handleOpenWorkflowArtifact,
    handleToggleTerminal: tabControls.handleToggleTerminal,
    handleToggleSidebar: tabControls.handleToggleSidebar,
    handleToggleSidePaneCollapse: tabControls.handleToggleSidePaneCollapse,
    handleCloseCodeViewer: tabControls.handleCloseCodeViewer,
    handleCloseGit: tabControls.handleCloseGit,
    handleActivateSidePaneTab: tabControls.handleActivateSidePaneTab,
    handleReorderSidePaneTab: tabControls.handleReorderSidePaneTab,
    handleCloseSidePaneTab: tabControls.handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs: tabControls.handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs: tabControls.handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab: tabControls.handleReopenClosedSidePaneTab,
    handleBrowserNavigationRequestHandled: tabControls.handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange: tabControls.handleBrowserPageMetadataChange,
  };
}
