import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import type { WorkspaceShellContext } from "@/app-shell/workspace-shell-layout/context.js";
import { resolveWorkspaceShellWindowChromeClass } from "@/app-shell/workspaceShellWindowChrome.js";
import { resolveTopOverlayLeadingPaddingClass } from "@/WorkspaceHeader.js";

/**
 * 右侧共享面板（browser / code-viewer / git / 工作流）：桌面与手机浮层共用同一份
 * props 映射，只有面板引用与截图 surface 按 mobileOverlay 切换。
 */
export function buildWorkspaceSidePanePanel(
  { props, model }: WorkspaceShellContext,
  options: { mobileOverlay?: boolean } = {},
) {
  const {
    activeGitSourceId,
    activeTaskId,
    browserNavigationRequest,
    browserRestoreUrls,
    desktopWindowChromeState,
    fileChangeFindActiveIndex,
    fileChangeFindNavigationRequestId,
    fileChangeFindQuery,
    gitState,
    handleActivateSidePaneTab,
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
    handleBrowserUrlChange,
    handleCloseAllSidePaneTabs,
    handleCloseCodeViewer,
    handleCloseGit,
    handleCloseOtherSidePaneTabs,
    handleCloseSidePaneTab,
    handleNavigateFileManager,
    handleOpenAgentWorkbench,
    handleOpenBackgroundBash,
    handleOpenBrowserPermissionSettings,
    handleOpenBrowserTab,
    handleOpenBrowserUrl,
    handleOpenCodeViewer,
    handleOpenDeveloperTools,
    handleOpenFileManager,
    handleOpenNewSidePaneTab,
    handleOpenPluginMarket,
    handleOpenSubagentSession,
    handleOpenTerminalTab,
    handleOpenWhiteboard,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowArtifact,
    handleOpenWorkflowRun,
    handleOpenWorkflowWorkspace,
    handleRefreshGit,
    handleReorderSidePaneTab,
    handleReopenClosedSidePaneTab,
    handleToggleGit,
    handleToggleSidePane,
    isBrowserOpen,
    isDesktop,
    isMacDesktop,
    isMacFullscreen,
    isSidebarVisible,
    isSidePaneOpen,
    isWindowsDesktop,
    isWorkspaceVisible,
    onFileChangeFindMatchCountChange,
    recentClosedSidePaneTabs,
    services,
    setGitSelectedSourceId,
    sidePaneOwnerId,
    sidePaneState,
    supportsEmbeddedBrowser,
    toggleSidePaneFullViewShortcutLabel,
    toggleSidePaneShortcutLabel,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceMainView,
    workspaceRemoteSessionId,
  } = props;
  const {
    activeFullView,
    fullViewController,
    fullViewConversationTitle,
    handleOpenMarkdownFileLink,
    handleOpenSelectionSideConversationLauncher,
    handleRevealGitFileInTree,
    hasUpdateStatusButton,
    isFullView,
    isLinuxDesktop,
    isSidePaneVisible,
    isWebRemoteControlShell,
    mobileSidePanePanelElementRef,
    mobileSidePanePanelRef,
    screenshotSurfaceRequest,
    screenshotSurfaceTab,
    setFullViewSlotElement,
    sidePanePanelElementRef,
    sidePanePanelRef,
    usesInlineWindowControls,
    createTaskInChat: handleCreateTaskInChat,
  } = model;
  return (
    <AnimatedSidePanePanel
      services={services}
      isDesktop={isDesktop}
      isWindowsDesktop={isWindowsDesktop}
      frameClassName={resolveWorkspaceShellWindowChromeClass({
        isMacDesktop,
        isWindowsDesktop,
        isLinuxDesktop,
        macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
        isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
        supportsNativeRoundedCorners:
          desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
      })}
      showWindowControls={!options.mobileOverlay && usesInlineWindowControls}
      // 工作区保活与侧栏动画会保留 DOM；独立 guest 浮层必须同步服从当前页面的展示状态。
      isVisible={
        isWorkspaceVisible &&
        workspaceMainView === "chat" &&
        isSidePaneOpen &&
        (options.mobileOverlay || isSidePaneVisible)
      }
      onCloseSidePane={handleToggleSidePane}
      toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
      fullViewToggle={
        !options.mobileOverlay && fullViewController
          ? {
              active: isFullView,
              onToggle: fullViewController.toggle,
              shortcutLabel: toggleSidePaneFullViewShortcutLabel,
            }
          : undefined
      }
      fullView={
        !options.mobileOverlay && activeFullView && fullViewController
          ? {
              surface: activeFullView.surface,
              conversationTitle: fullViewConversationTitle,
              leadingInsetClassName: resolveTopOverlayLeadingPaddingClass({
                isSidebarVisible,
                isMacDesktop,
                isMacFullscreen,
                hasUpdateReady: hasUpdateStatusButton,
              }),
              onSelectSurface: fullViewController.setSurface,
            }
          : null
      }
      fullViewSlotRef={options.mobileOverlay ? undefined : setFullViewSlotElement}
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={recentClosedSidePaneTabs}
      isBrowserOpen={isBrowserOpen}
      supportsEmbeddedBrowser={supportsEmbeddedBrowser}
      workspaceAbsPath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      activeTaskId={activeTaskId}
      sidePaneOwnerId={sidePaneOwnerId}
      gitState={gitState}
      activeGitSourceId={activeGitSourceId}
      panelRef={options.mobileOverlay ? mobileSidePanePanelRef : sidePanePanelRef}
      panelElementRef={
        options.mobileOverlay ? mobileSidePanePanelElementRef : sidePanePanelElementRef
      }
      browserNavigationRequest={browserNavigationRequest}
      browserRestoreUrls={browserRestoreUrls}
      screenshotSurfaceRequest={options.mobileOverlay ? null : screenshotSurfaceRequest}
      screenshotSurfaceTabId={options.mobileOverlay ? null : (screenshotSurfaceTab?.id ?? null)}
      fileChangeFindActiveIndex={fileChangeFindActiveIndex}
      fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
      fileChangeFindQuery={fileChangeFindQuery}
      onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
      onCloseCodeViewer={handleCloseCodeViewer}
      onCloseGit={handleCloseGit}
      onActivateTab={handleActivateSidePaneTab}
      onOpenNewTab={handleOpenNewSidePaneTab}
      onReorderTab={handleReorderSidePaneTab}
      onCloseTab={handleCloseSidePaneTab}
      onCloseOtherTabs={handleCloseOtherSidePaneTabs}
      onCloseAllTabs={handleCloseAllSidePaneTabs}
      onReopenClosedTab={handleReopenClosedSidePaneTab}
      onOpenBrowserTab={handleOpenBrowserTab}
      onOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
      onOpenWhiteboard={handleOpenWhiteboard}
      onOpenDeveloperTools={handleOpenDeveloperTools}
      onOpenAgentWorkbench={handleOpenAgentWorkbench}
      onOpenFileManager={handleOpenFileManager}
      onNavigateFileManager={handleNavigateFileManager}
      onOpenPluginMarket={handleOpenPluginMarket}
      onCreateTask={handleCreateTaskInChat}
      isMacDesktop={isMacDesktop}
      onOpenTerminalTab={handleOpenTerminalTab}
      onOpenReviewTab={handleToggleGit}
      onOpenSelectionSideConversation={handleOpenSelectionSideConversationLauncher}
      onRevealGitFileInTree={handleRevealGitFileInTree}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      onOpenCodeViewer={handleOpenCodeViewer}
      onOpenFileLink={handleOpenMarkdownFileLink}
      onOpenBackgroundBash={handleOpenBackgroundBash}
      onOpenSubagentSession={handleOpenSubagentSession}
      onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
      onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
      onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
      onOpenWorkflowRun={handleOpenWorkflowRun}
      onRefreshGit={handleRefreshGit}
      onBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
      onBrowserUrlChange={handleBrowserUrlChange}
      onBrowserPageMetadataChange={handleBrowserPageMetadataChange}
      onSelectGitSource={setGitSelectedSourceId}
      mobileOverlay={options.mobileOverlay}
      mobileStacked={isWebRemoteControlShell}
    />
  );
}
