import { PluginUiWorkspaceProvider } from "@/plugin-ui/index.js";
import { useEffect, useMemo, useState } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import { FeedbackHost } from "@/feedback/FeedbackHost.js";
import appLogoUrl from "@/assets/provider-icons/logo-zai.svg";
import { WorkspaceShellLayout } from "@/app-shell/WorkspaceShellLayout.js";
import type { AppProps } from "@/app-shell/types.js";
import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";
import { startMemoryDiagnosticsLogger } from "@/lib/memoryDiagnostics.js";
import { useAppRootWorkspaceScope } from "@/app-root/useAppRootWorkspaceScope.js";
import { useAppRootSidePane } from "@/app-root/useAppRootSidePane.js";
import { useAppRootNotifications } from "@/app-root/useAppRootNotifications.js";
import { useAppRootChrome } from "@/app-root/useAppRootChrome.js";
import { useAppRootSidePaneMemory } from "@/app-root/useAppRootSidePaneMemory.js";
import { useAppRootGit } from "@/app-root/useAppRootGit.js";
import { useAppRootWorkspaceData } from "@/app-root/useAppRootWorkspaceData.js";
import { useAppRootSessionLifecycle } from "@/app-root/useAppRootSessionLifecycle.js";
import { useAppRootShellActions } from "@/app-root/useAppRootShellActions.js";
import { useAppRootStartDraft } from "@/app-root/useAppRootStartDraft.js";
import { useAppRootTestActions } from "@/app-root/useAppRootTestActions.js";
import { useAppRootDialogs } from "@/app-root/useAppRootDialogs.js";
import { useAppRootFeedback } from "@/app-root/useAppRootFeedback.js";
import { useAppRootQuickPickCommands } from "@/app-root/useAppRootQuickPickCommands.js";
import { useAppRootNavigation } from "@/app-root/useAppRootNavigation.js";
import { useAppRootKeyboard } from "@/app-root/useAppRootKeyboard.js";

const EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY: NonNullable<
  AppProps["remoteWorkspaceRecoveryByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_CONNECTION_LOGS: NonNullable<AppProps["remoteConnectionLogs"]> = [];

export function App({
  services,
  baseFeedbackService,
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceRecoveryByWorkspaceKey = EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY,
  remoteWorkspaceErrorByWorkspaceKey,

  remoteConnectionLogs = EMPTY_REMOTE_CONNECTION_LOGS,
  onCreateTask,
  onCreateConversationTask,
  onCreateConversationTaskOnSource,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  remoteConnectionInProgress = false,
  onReturnToWorkspace,
  allowOpenWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  allowRemoteWorkspace = true,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity: explicitWorkspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
}: AppProps) {
  // 展示 label 统一从快捷键生效表取（用户改键后 tooltip 同步更新），不再硬编码键位。
  const toggleSidebarShortcutLabel = useShortcutCommandLabel("toggleSidebar");
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  const goBackShortcutLabel = useShortcutCommandLabel("navigateBack");
  const goForwardShortcutLabel = useShortcutCommandLabel("navigateForward");
  const toggleTerminalShortcutLabel = useShortcutCommandLabel("toggleTerminal");
  const toggleSidePaneShortcutLabel = useShortcutCommandLabel("toggleSidePane");
  const toggleSidePaneFullViewShortcutLabel = useShortcutCommandLabel("toggleSidePaneFullView");
  const openWorkspaceShortcutLabel = useShortcutCommandLabel("openWorkspace");
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const platform = usePlatform();
  // 进程内存本地诊断日志：每窗口一个 60s 采样器，
  // 经门控后写桌面主日志；Web 端无日志桥时为 no-op。同一次读数还经 preload 桥把 heap 送 main 的
  // renderer_main 资源事件，无桥时同样 no-op。
  const reportRendererHeapSample = platform.reportRendererHeapSample;
  useEffect(() => {
    const memoryDiagnosticsLogger = startMemoryDiagnosticsLogger({
      reportHeapSample: reportRendererHeapSample,
    });
    return () => memoryDiagnosticsLogger.stop();
  }, [reportRendererHeapSample]);

  const workspaceScope = useAppRootWorkspaceScope({
    workspaceAbsPath,
    explicitWorkspaceIdentity,
    workspaceRemoteSessionId,
  });
  const {
    workspaceIdentity,
    workspaceRpcTarget,
    workspaceRpcReady,
    workspaceReadOnlyReason,
    workspaceShellZCodeState,
    reloadSessionDisabled,
    activeTaskId,
    sidePaneOwnerId,
  } = workspaceScope;
  const [summaryPanelVariantOverride, setSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const sidePane = useAppRootSidePane({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
    isDesktop,
    isWorkspaceVisible,
    supportsEmbeddedBrowser,
    webRemoteControlWorkspaceSwitcher,
    platform,
  });
  const panels = sidePane.panels;

  useAppRootNotifications({
    services,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    workspaceRpcReady,
    isDesktop,
    platform,
  });
  const sidePaneMemory = useAppRootSidePaneMemory({
    activeTaskId,
    workspaceAbsPath,
    workspaceIdentity,
  });
  const chrome = useAppRootChrome({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    workspaceAbsPath,
  });
  const workspaceData = useAppRootWorkspaceData({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    selectedProvider: workspaceShellZCodeState.selectedProvider,
  });
  const git = useAppRootGit({
    workspaceAbsPath,
    workspaceIdentity,
    activeTaskId,
    remoteSessionId: workspaceRpcTarget.remoteSessionId,
    remoteTarget: workspaceRpcTarget.remoteTarget,
    hasGitTab: sidePane.hasGitTab,
    isWorkspaceVisible,
    workspaceReadOnlyReason,
    handleOpenGit: panels.handleOpenGit,
    gitSelectedSourceId: sidePaneMemory.gitSelectedSourceId,
    setGitSelectedSourceId: sidePaneMemory.setGitSelectedSourceId,
  });
  const shellActions = useAppRootShellActions({
    isWorkspaceVisible,
    onReturnToWorkspace,
    workspaceReadOnlyReason,
    onCreateTask,
    handleToggleTerminal: panels.handleToggleTerminal,
    handleOpenTerminalTab: panels.handleOpenTerminalTab,
    handleOpenGit: panels.handleOpenGit,
    handleToggleGit: panels.handleToggleGit,
    handleOpenCodeViewer: panels.handleOpenCodeViewer,
    handleOpenCodeViewers: panels.handleOpenCodeViewers,
    isDesktop,
    webRemoteControlWorkspaceSwitcher,
  });
  const handleStartDraftInWorkspace = useAppRootStartDraft({
    tabs: workspaceData.tabs,
    addTab: workspaceData.addTab,
    activateTabByPath: workspaceData.activateTabByPath,
    selectedProvider: workspaceShellZCodeState.selectedProvider,
    webRemoteControlWorkspaceSwitcher,
  });
  const sessionLifecycle = useAppRootSessionLifecycle({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRpcReady,
    reloadSessionDisabled,
    services,
    setBrowserNavigationRequest: panels.setBrowserNavigationRequest,
  });
  useAppRootTestActions({
    services,
    testMessages: sessionLifecycle.testMessages,
    setTestMessages: sessionLifecycle.setTestMessages,
  });
  const dialogs = useAppRootDialogs({
    runVisibleWorkspaceCommand: shellActions.runVisibleWorkspaceCommand,
    handleOpenGitIfWritable: shellActions.handleOpenGitIfWritable,
    isMacDesktop,
    isWindowsDesktop,
    isLinuxDesktop,
  });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const feedback = useAppRootFeedback({ isLoggedIn: Boolean(user) });
  const quickPickCommands = useAppRootQuickPickCommands({
    allowOpenWorkspace,
    isSidebarVisible: panels.isSidebarVisible,
    supportsEmbeddedBrowser,
    isLoggedIn: feedback.isLoggedIn,
    canOpenCommunity: dialogs.canOpenCommunityFromQuickPick,
    themeTarget: chrome.themeTarget,
    newTaskShortcutLabel,
    openWorkspaceShortcutLabel,
    toggleSidebarShortcutLabel,
    toggleTerminalShortcutLabel,
    runVisibleWorkspaceCommand: shellActions.runVisibleWorkspaceCommand,
    handleCreateTaskIfWritable: shellActions.handleCreateTaskIfWritable,
    onOpenWorkspace,
    openSettingsTab,
    handleSwitchTheme: chrome.handleSwitchTheme,
    handleOpenFeedback: feedback.handleOpenFeedback,
    handleOpenCommunity: feedback.handleOpenCommunity,
    handleOpenProductDocs: feedback.handleOpenProductDocs,
    onLogin,
    onLogout,
    handleToggleSidebar: panels.handleToggleSidebar,
    handleToggleTerminalIfWritable: shellActions.handleToggleTerminalIfWritable,
    handleToggleBrowser: panels.handleToggleBrowser,
    handleOpenTerminalTabIfWritable: shellActions.handleOpenTerminalTabIfWritable,
    handleOpenBrowserTab: panels.handleOpenBrowserTab,
    handleOpenGitIfWritable: shellActions.handleOpenGitIfWritable,
  });
  const navigation = useAppRootNavigation({
    workspaceAbsPath,
    workspaceIdentity,
    activeTaskId,
    activateTabByPath: workspaceData.activateTabByPath,
    isWorkspaceVisible,
    runVisibleWorkspaceCommand: shellActions.runVisibleWorkspaceCommand,
  });
  const handlePrimaryNavigationBack =
    navigation.workspaceMainView === "plugin-store"
      ? navigation.handleNavigateToTaskMain
      : navigation.handleTaskNavBack;
  const canPrimaryNavigationBack =
    navigation.workspaceMainView === "plugin-store" || navigation.canTaskNavBack;
  const shellPanelIds = useMemo(() => ["sidebar", "content"], []);

  useAppRootKeyboard({
    handleOpenQuickPick: dialogs.handleOpenQuickPick,
    openSettingsTab,
    handleOpenTaskFind: dialogs.handleOpenTaskFind,
    handleSwitchTheme: chrome.handleSwitchTheme,
    runVisibleWorkspaceCommand: shellActions.runVisibleWorkspaceCommand,
    handleToggleSidebar: panels.handleToggleSidebar,
    handleToggleTerminalIfWritable: shellActions.handleToggleTerminalIfWritable,
    handleToggleSidePane: sidePane.handleToggleSidePane,
    supportsSidePaneFullView: sidePane.supportsSidePaneFullView,
    handleToggleSidePaneFullView: sidePane.handleToggleSidePaneFullView,
    handleSelectPreviousConversation: navigation.handleSelectPreviousConversation,
    handleSelectNextConversation: navigation.handleSelectNextConversation,
    canPrimaryNavigationBack,
    handlePrimaryNavigationBack,
    canTaskNavForward: navigation.canTaskNavForward,
    handleTaskNavForward: navigation.handleTaskNavForward,
  });

  return (
    <>
      <CommandCenterDialog
        open={dialogs.isQuickPickOpen}
        commands={quickPickCommands}
        workspaceAbsPath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        activeTaskId={activeTaskId}
        activeTaskChangeSummary={workspaceData.activeTaskChangeSummary}
        workspaceTabs={workspaceData.commandCenterWorkspaceTabs}
        onOpenChange={dialogs.setIsQuickPickOpen}
        onSelectTask={navigation.handleSelectTask}
        onSearchResultHighlightRequest={dialogs.handleSearchResultHighlightRequest}
        onOpenCodeViewer={shellActions.handleOpenCodeViewerIfWritable}
      />
      {/* Bugfix: 反馈是应用级能力，必须固定走本机 base host；SSH session 连接中或断开时，
          workspace-scoped services 会切成断连代理，不能让反馈提交跟随远程 session 失效。 */}
      <FeedbackHost feedbackService={baseFeedbackService} platform={platform} />
      <PluginUiWorkspaceProvider onOpenSidePane={panels.handleOpenPluginUi}>
        <WorkspaceShellLayout
          services={services}
          workspaceReadOnlyReason={workspaceReadOnlyReason}
          workspaceMainView={navigation.workspaceMainView}
          pluginStoreOpenVersion={navigation.pluginStoreOpenVersion}
          openAutomationId={navigation.openAutomationId}
          openAutomationTab={navigation.openAutomationTab}
          openWorkflow={navigation.openWorkflow}
          onOpenWorkflowConsumed={navigation.handleOpenWorkflowConsumed}
          onOpenSavedWorkflowInHub={navigation.handleOpenSavedWorkflowInHub}
          onWorkspaceMainViewChange={navigation.setWorkspaceMainView}
          onOpenAutomationConsumed={navigation.handleOpenAutomationConsumed}
          handleOpenAutomations={navigation.handleOpenAutomations}
          handleOpenPluginStore={navigation.handleOpenPluginStoreForScope}
          onConnectRemote={onConnectRemote}
          onSelectRemoteProject={onSelectRemoteProject}
          onCancelRemoteProject={onCancelRemoteProject}
          onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
          onLogout={onLogout}
          onLogin={onLogin}
          user={user}
          reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
          remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
          remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
          remoteConnectionLogs={remoteConnectionLogs}
          onCreateTask={shellActions.handleCreateTaskIfWritable}
          onCreateConversationTask={onCreateConversationTask}
          onCreateConversationTaskOnSource={onCreateConversationTaskOnSource}
          onResolveConversationWorkspace={onResolveConversationWorkspace}
          onOpenWorkspace={onOpenWorkspace}
          onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
          remoteConnectionInProgress={remoteConnectionInProgress}
          allowOpenWorkspace={allowOpenWorkspace}
          webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
          initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
          initialWebRemoteControlMobileNavigationIntent={
            initialWebRemoteControlMobileNavigationIntent
          }
          webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
          allowRemoteWorkspace={allowRemoteWorkspace}
          workspaceAbsPath={workspaceAbsPath}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          workspaceIdentity={workspaceIdentity}
          isWorkspaceVisible={isWorkspaceVisible}
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          workspaceShellZCodeState={workspaceShellZCodeState}
          theme={chrome.theme}
          isMacFullscreen={chrome.isMacFullscreen}
          desktopWindowChromeState={chrome.desktopWindowChromeState}
          macWindowControlsLeftPaddingPx={chrome.macWindowControlsLeftPaddingPx}
          windowsWindowControlsRightPaddingPx={chrome.windowsWindowControlsRightPaddingPx}
          updateReadyVersion={chrome.updateReadyVersion}
          updateState={chrome.updateState}
          sidebarContainerRef={chrome.sidebarContainerRef}
          toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
          newTaskShortcutLabel={newTaskShortcutLabel}
          goBackShortcutLabel={goBackShortcutLabel}
          goForwardShortcutLabel={goForwardShortcutLabel}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          toggleSidePaneFullViewShortcutLabel={toggleSidePaneFullViewShortcutLabel}
          canGoBack={navigation.canGoBack}
          canGoForward={navigation.canGoForward}
          canTaskNavBack={navigation.canTaskNavBack}
          canTaskNavForward={navigation.canTaskNavForward}
          isTerminalOpen={panels.isTerminalOpen}
          isSidebarVisible={panels.isSidebarVisible}
          isBrowserOpen={sidePane.isBrowserOpen}
          supportsEmbeddedBrowser={supportsEmbeddedBrowser}
          isGitOpen={sidePane.isGitOpen}
          isSidePaneOpen={sidePane.isSidePaneOpen}
          sidePaneFullView={sidePane.supportsSidePaneFullView ? sidePane.sidePaneFullView : undefined}
          summaryPanelVariantOverride={summaryPanelVariantOverride}
          onSummaryPanelVariantOverrideChange={setSummaryPanelVariantOverride}
          sidePaneState={panels.sidePaneState}
          recentClosedSidePaneTabs={panels.recentClosedSidePaneTabs}
          shellPanelIds={shellPanelIds}
          projectName={workspaceData.projectName}
          workspaceTabs={workspaceData.workspaceTabs}
          activeTaskId={activeTaskId}
          sidePaneOwnerId={sidePaneOwnerId}
          activeTraceId={workspaceData.activeTraceId}
          activeSessionId={workspaceData.activeSessionId}
          activeTaskProvider={workspaceData.activeTaskProvider}
          resolvedActiveTaskMeta={workspaceData.resolvedActiveTaskMeta}
          activeTaskTitle={workspaceData.activeTaskTitle}
          activeTaskChangeSummary={workspaceData.activeTaskChangeSummary}
          gitWorktreeReviewSourceId={git.gitWorktreeReviewSourceId}
          gitWorktreeChangeSummary={git.gitWorktreeChangeSummary}
          activeGitSourceId={git.activeGitSourceId}
          gitState={git.gitState}
          browserNavigationRequest={panels.browserNavigationRequest}
          browserRestoreUrls={sidePaneMemory.browserRestoreUrls}
          providerConfigFile={workspaceData.providerConfigFile}
          taskNativeSessionLogFile={workspaceData.taskNativeSessionLogFile}
          taskSessionFile={workspaceData.taskSessionFile}
          conversationFindActiveIndex={dialogs.conversationFindState.activeIndex}
          conversationFindNavigationRequestId={dialogs.conversationFindState.navigationRequestId}
          conversationFindQuery={dialogs.conversationFindState.query}
          onConversationFindMatchStateChange={dialogs.handleConversationFindMatchStateChange}
          searchResultHighlightRequest={dialogs.searchResultHighlightRequest}
          onSearchResultHighlightDone={dialogs.handleSearchResultHighlightDone}
          fileChangeFindActiveIndex={dialogs.fileChangeFindState.activeIndex}
          fileChangeFindNavigationRequestId={dialogs.fileChangeFindState.navigationRequestId}
          fileChangeFindQuery={dialogs.fileChangeFindState.query}
          onFileChangeFindMatchCountChange={dialogs.setFileChangeFindMatchCount}
          appLogoUrl={appLogoUrl}
          platform={platform}
          reloadSessionDisabled={reloadSessionDisabled}
          reloadSessionPending={sessionLifecycle.reloadSessionPending}
          handleReloadSession={sessionLifecycle.handleReloadSession}
          handleSelectTask={navigation.handleSelectTask}
          handleTaskNavBack={navigation.handleTaskNavBack}
          handleTaskNavForward={navigation.handleTaskNavForward}
          handleStartDraftInWorkspace={handleStartDraftInWorkspace}
          handleOpenCommandCenter={dialogs.handleOpenQuickPick}
          handleRefreshGit={git.handleRefreshGit}
          handleOpenGitReview={git.handleOpenGitReview}
          handleBrowserUrlChange={sidePaneMemory.handleBrowserUrlChange}
          handleBrowserPageMetadataChange={panels.handleBrowserPageMetadataChange}
          handleToggleSidebar={panels.handleToggleSidebar}
          handleToggleTerminal={shellActions.handleToggleTerminalIfWritable}
          handleToggleBrowser={panels.handleToggleBrowser}
          handleOpenBrowserTab={panels.handleOpenBrowserTab}
          handleOpenBrowserPermissionSettings={panels.handleOpenBrowserPermissionSettings}
          handleOpenWhiteboard={panels.handleOpenWhiteboard}
          handleOpenDeveloperTools={panels.handleOpenDeveloperTools}
          handleOpenAgentWorkbench={panels.handleOpenAgentWorkbench}
          handleOpenFileManager={panels.handleOpenFileManager}
          handleNavigateFileManager={panels.handleNavigateFileManager}
          handleOpenPluginMarket={panels.handleOpenPluginMarket}
          handleOpenTerminalTab={shellActions.handleOpenTerminalTabIfWritable}
          handleToggleGit={shellActions.handleToggleGitIfWritable}
          handleToggleSidePane={sidePane.handleToggleSidePane}
          handleOpenBrowserUrl={panels.handleOpenBrowserUrl}
          handleOpenCodeViewer={shellActions.handleOpenCodeViewerIfWritable}
          handleAutoOpenAssistantPptx={shellActions.handleAutoOpenAssistantPptx}
          handleOpenSubagentSession={panels.handleOpenSubagentSession}
          handleOpenBackgroundBash={panels.handleOpenBackgroundBash}
          handleOpenSubagentDirectory={panels.handleOpenSubagentDirectory}
          handleSyncSubagentSessionTabs={panels.handleSyncSubagentSessionTabs}
          handleOpenSelectionSideChat={panels.handleOpenSelectionSideChat}
          handleOpenPlanDetail={panels.handleOpenPlanDetail}
          handleOpenWorkflowRun={panels.handleOpenWorkflowRun}
          handleOpenWorkflowRunDirectory={panels.handleOpenWorkflowRunDirectory}
          handleOpenWorkflowActorSession={panels.handleOpenWorkflowActorSession}
          handleOpenWorkflowWorkspace={panels.handleOpenWorkflowWorkspace}
          handleOpenWorkflowArtifact={panels.handleOpenWorkflowArtifact}
          handleCloseCodeViewer={panels.handleCloseCodeViewer}
          handleCloseGit={panels.handleCloseGit}
          handleActivateSidePaneTab={panels.handleActivateSidePaneTab}
          handleOpenNewSidePaneTab={panels.handleOpenNewSidePaneTab}
          handleReorderSidePaneTab={panels.handleReorderSidePaneTab}
          handleCloseSidePaneTab={panels.handleCloseSidePaneTab}
          handleCloseOtherSidePaneTabs={panels.handleCloseOtherSidePaneTabs}
          handleCloseAllSidePaneTabs={panels.handleCloseAllSidePaneTabs}
          handleReopenClosedSidePaneTab={panels.handleReopenClosedSidePaneTab}
          handleBrowserNavigationRequestHandled={panels.handleBrowserNavigationRequestHandled}
          setIsTerminalOpen={panels.setIsTerminalOpen}
          setGitSelectedSourceId={sidePaneMemory.setGitSelectedSourceId}
          // taskFindDialogProps 是对象 prop，内联创建会让 shell 在流式刷新中每轮都看到新引用。
          taskFindDialogProps={dialogs.taskFindDialogProps}
        />
      </PluginUiWorkspaceProvider>
    </>
  );
}
