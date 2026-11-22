import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { RemoteProjectPresentationProvider } from "@/hooks/RemoteProjectPresentationContext.js";
import {
  RequestSecurityHost,
  RequestSecurityWorkspaceBridge,
} from "@/request-security-edition/index.js";
import { useCallback, useEffect } from "react";
import { LucideProvider } from "lucide-react";
import { DesktopCommandIds } from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useTokenRefresh } from "@/hooks/useTokenRefresh.js";
import { shouldShowRootStartupLoading } from "@/lib/rootStartupGate.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { RootShell } from "@/root/RootShell.js";
import { RootWorkspaceContent } from "@/root/RootWorkspaceContent.js";
import { RootDialogs } from "@/root/RootDialogs.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { useRemoteWorkspaceTabLifecycle } from "@/root/useRemoteWorkspaceTabLifecycle.js";
import { RemoteWorkspaceControllerProvider } from "@/remote/useRemoteWorkspaceController.js";
import { useRootProviderStateRefresh } from "@/root/useRootProviderStateRefresh.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootAppWiring } from "@/root/useRootAppWiring.js";
import { useRootDesktopChromeEffects } from "@/root/useRootDesktopChromeEffects.js";
import { useRootDeviceAdditionReturn } from "@/root/useRootDeviceAdditionReturn.js";
import { useRootEntryState } from "@/root/useRootEntryState.js";
import { useRootFallbackWorkspace } from "@/root/useRootFallbackWorkspace.js";
import { useRootLaunchToInputReport } from "@/root/useRootLaunchToInputReport.js";
import { useRootProviderFamilyDomainMigration } from "@/root/useRootProviderFamilyDomainMigration.js";
import { useRootRemoteProjectIntent } from "@/root/useRootRemoteProjectIntent.js";
import { useRootRuntimePreferencesSync } from "@/root/useRootRuntimePreferencesSync.js";
import { useRootStartupGate } from "@/root/useRootStartupGate.js";
import { useRootTabPersistence } from "@/root/useRootTabPersistence.js";
import { useRootTabState } from "@/root/useRootTabState.js";
import { useRootWelcomeScreenEntry } from "@/root/useRootWelcomeScreenEntry.js";
import { useRootWorkspaceShellController } from "@/root/useRootWorkspaceShellController.js";
import { useRootWorkspaceShellWiring } from "@/root/useRootWorkspaceShellWiring.js";
import { useBotBroadcastEffects } from "@/root/useBotBroadcastEffects.js";
import { registerBaseWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import type { RootProps } from "@/root/types.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import {
  WebRemoteControlFeatureProvider,
  useWebRemoteControlFeatureEnabled,
} from "@/WebRemoteControlFeatureProvider.js";
import { MarketingTouchProvider } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import { CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT } from "@/lib/closeActiveContext.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { RemoteConnectionProgressProvider } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { SettingsPage } from "@/SettingsPage.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RewardsProvider } from "@/rewards/RewardsProvider.js";
import { WelcomeScreen } from "@/WelcomeScreen.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;

/**
 * Root —— 应用根组件
 *
 * 外层挂载 StoreProvider（连接广播服务）+ TabStoreProvider，内层处理认证和路由。
 */
export function Root(props: RootProps) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      {/*
       * 之前通过 lucide.tsx 包装每个图标，把默认 strokeWidth 固定成 1.5。
       * 现在移除包装文件后，如果不在根层统一注入，按钮、列表和工具栏里的 Lucide 图标会回退到 2，
       * 导致同一套 size class 下视觉显得更粗、更挤。这里改用官方 LucideProvider 保持默认值，
       * 同时保留个别图标显式传入 strokeWidth 时的覆盖能力。
       */}
      <TooltipProvider>
        {/*
         * 大会话消息动作里会出现大量 tooltip。Provider 如果跟随每个 tooltip 实例创建，
         * React 点击切换任务时会同步构造数量级相同的 Radix 上下文树；根层共享一次即可保留零延迟配置。
         */}
        <ServiceProvider
          services={props.services}
          composerClientNamespace={props.composerClientNamespace}
        >
          <PlatformProvider platform={props.platform}>
            <StoreProvider
              broadcastService={props.services.broadcastService}
              initialIsRestoringOAuthSession
            >
              <TabStoreProvider>
                <ProjectDirectoryProvider isDesktop={props.isDesktop}>
                  <DiffsWorkerPoolProvider>
                    <WebRemoteControlFeatureProvider enabled={props.webRemoteControlFeatureEnabled}>
                      <AssistantCodeCommentFeatureProvider
                        enabled={props.assistantCodeCommentCardsEnabled}
                      >
                        <CodingPlanUpgradeDialogProvider>
                          <RewardsProvider desktop={props.isDesktop === true}>
                            <RequestSecurityHost />
                            <MarketingTouchProvider desktop={props.isDesktop === true}>
                              <RemoteConnectionProgressProvider>
                                <RootInner {...props} />
                              </RemoteConnectionProgressProvider>
                            </MarketingTouchProvider>
                          </RewardsProvider>
                        </CodingPlanUpgradeDialogProvider>
                      </AssistantCodeCommentFeatureProvider>
                    </WebRemoteControlFeatureProvider>
                  </DiffsWorkerPoolProvider>
                </ProjectDirectoryProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function RootInner({
  services,
  platform,
  initialWorkspaceAbsPath,
  unavailableWorkspacePath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  initialTaskDraft,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  restoreSession = true,
  supportsSettings = true,
  allowOpenWorkspace = true,
  preferDirectoryBrowser,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
  allowRemoteWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  initialWorkspaceLoadingFallback,
}: RootProps) {
  const {
    intl,
    locale,
    handleRemoteConnectionTargetChange,
    theme,
    user,
    isRestoringOAuthSession,
    setUser,
    setIsRestoringOAuthSession,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    appSettings,
    refreshAppSettings,
    updateAppSettings,
  } = useRootAppWiring({ services, platform, isDesktop });

  const {
    welcomeScreenOpenReason,
    setWelcomeScreenOpenReason,
    loginEntryRequest,
    rootModelSelectionRead,
    rootModelSelectionView,
    rootModelSelectionErrorNode,
    readRootModelSelectionView,
    remoteConnectionDialogOpen,
    setRemoteConnectionDialogOpen,
    remoteConnectionOpenPreference,
    setRemoteConnectionOpenPreference,
    remoteConnectionOpenIntentId,
    setRemoteConnectionOpenIntentId,
    directoryBrowserOpen,
    setDirectoryBrowserOpen,
    remoteConnectionInProgress,
    setRemoteConnectionInProgress,
    setRemoteConnectionRequestId,
    remoteConnectionLogs,
    isBootstrappingInitialWorkspace,
    setIsBootstrappingInitialWorkspace,
    isCreatingFallbackWorkspace,
    setIsCreatingFallbackWorkspace,
  } = useRootEntryState({ services, intl, initialWorkspaceAbsPath });

  useRootRuntimePreferencesSync({ services, refreshAppSettings, appSettings });

  const {
    tabs,
    windowWorkspaceTabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    activeWorkspaceTab,
    isSettingsTabActive,
    workspaceShellPath,
    workspaceShellIdentity,
    workspaceShellRemoteSessionId,
    workspaceScopedServices,
    localWorkspacePathForRemoteConnection,
    addTab,
    activateTabByPath,
    tabStoreApi,
  } = useRootTabState();

  const {
    deviceAdditionReturn: _deviceAdditionReturn,
    finishDeviceAddition,
    handleOpenRemoteConnection,
  } = useRootDeviceAdditionReturn({
    tabStoreApi,
    remoteConnectionInProgress,
    setRemoteConnectionDialogOpen,
    setRemoteConnectionOpenPreference,
    setRemoteConnectionOpenIntentId,
  });

  const webRemoteControlFeatureEnabled = useWebRemoteControlFeatureEnabled();
  const refreshProviderState = useRootProviderStateRefresh(services);
  useRootProviderSettingsSnapshot(services);
  const providerFamilyDomainMigrationComplete = useRootProviderFamilyDomainMigration({
    services,
    refreshAppSettings,
    refreshProviderState,
  });

  const isWebRemoteControlRoot = Boolean(webRemoteControlWorkspaceSwitcher);
  const {
    shouldPreferDirectoryBrowser,
    supportsEmbeddedBrowser,
    isResolvingStartupAuthState,
    providerStartupSyncPending,
    isResolvingProviderStartupState,
    isStartupProviderLoginEntryOpen,
    canRestoreWorkspaceSession,
    workspacePersistenceGate,
  } = useRootStartupGate({
    preferDirectoryBrowser,
    explicitSupportsEmbeddedBrowser,
    isDesktop,
    isRestoringOAuthSession,
    rootModelSelectionRead,
    rootModelSelectionView,
    providerFamilyDomainMigrationComplete,
    isWebRemoteControlRoot,
    welcomeScreenOpenReason,
    setWelcomeScreenOpenReason,
    user,
    providerFamilyDomain: appSettings?.providerFamilyDomain,
    refreshProviderState,
    readModelSelectionView: readRootModelSelectionView,
  });

  useEffect(() => {
    // 跨 workspace 任务列表需要一个稳定的“本地/root services”入口。
    // 桌面端 renderer 启动时会注册一次，但 Web 和测试入口也会直接挂 Root；
    // 这里再以 Root props 兜底注册，避免当前激活远端 workspace 时本地列表误用远端 host。
    registerBaseWorkspaceServices(services);
  }, [services]);

  useBotBroadcastEffects(services, tabStoreApi);

  const handleOpenDirectoryBrowser = useCallback(() => {
    setDirectoryBrowserOpen(true);
  }, [setDirectoryBrowserOpen]);
  const handleReauthenticationRequired = useCallback(() => {
    setWelcomeScreenOpenReason("session-expired");
  }, [setWelcomeScreenOpenReason]);

  const {
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateTask,
    handleBackFromSettings,
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,
    buildPersistedTabPatch,
    restoreWorkspaceTabs,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    remoteWorkspaceController,
  } = useRootWorkspaceShellController({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    allowOpenWorkspace,
    preferDirectoryBrowser: shouldPreferDirectoryBrowser,
    openDirectoryBrowser: handleOpenDirectoryBrowser,
    refreshProviderState,
    updateAppSettings,
    setOAuthError,
    setUser,
    setWelcomeScreenOpenReason,
    user,
    allowRemoteWorkspace,
    handleOpenRemoteConnection,
    webRemoteControlWorkspaceSwitcher,
    isWebRemoteControlRoot,
    isDesktop,
    restoreSession,
    initialWorkspaceIdentity,
    unavailableWorkspacePath,
    activateTabByPath,
    workspacePersistenceGate,
    remoteConnectionDialogOpen,
    remoteConnectionInProgress,
    remoteConnectionOpenPreference,
  });

  const { handleResolveConversationWorkspaceForShell, restorePersistedSession } =
    useRootWorkspaceShellWiring({
      platform,
      tabStoreApi,
      activeWorkspacePath,
      activeWorkspaceIdentity,
      handleResolveConversationWorkspace,
      handleReconnectRemoteWorkspace,
      restoreWorkspaceTabs,
      setWorkspaceActionError,
    });

  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } =
    useRootTabPersistence({
      services,
      supportsSettings,
      restoreSession,
      canRestoreWorkspaceSession,
      workspacePersistenceGate,
      restorePersistedSession,
      buildPersistedTabPatch,
      isDesktop,
      windowWorkspaceTabs,
    });

  // Bug 原因（2026-08-16 web 远控卡死）：官方版本请求安全校验应答方曾只随桌面正在展示的
  // session pane 挂载，web 远控新建会话时桌面没有对应 pane、web 端无应答方，
  // headers 请求永远滞留 pending，任务永久「工作中」。应答方必须常驻桌面窗口、
  // 覆盖每个打开的 workspace tab，与展示状态解耦；Web 端保持零订阅，桌面仍是唯一权威。
  const requestSecurityBridgeNode = isDesktop ? (
    <RequestSecurityWorkspaceBridge workspaceTabs={windowWorkspaceTabs} />
  ) : null;

  const { tryRefresh, clearCredentials } = useTokenRefresh();
  void tryRefresh;
  void clearCredentials;
  // 启动阻塞是桌面窗口保护期，手机 Web 远控在进入 Root 前已有配对/加载页。
  // Web 端继续使用该 gate 会在 workspace tab 注入前渲染空 RootShell，露出浏览器白底。
  const isStartupRenderBlocked = shouldShowRootStartupLoading({
    isDesktop,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
    isResolvingStartupAuthState,
    isResolvingProviderStartupState,
    isRestoring,
    isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace || isCreatingFallbackWorkspace,
  });

  useRootLaunchToInputReport({
    isStartupRenderBlocked,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
  });

  useRootPlatformEffects({
    clientMode: isWebRemoteControlRoot ? "web-remote-replayable" : "desktop-continuous",
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    initialTaskId,
    initialTaskDraft,
    // Bugfix: 系统右键/Service 冷启动传入 initialWorkspacePath 时，必须先恢复历史 tabs，
    // 再把目标 workspace 合并并激活。否则先 addTab 会被 restoreTabs 整体替换掉；
    // 直接禁用 restoreSession 又会让其他 workspace 全部消失。
    canBootstrapInitialWorkspace: canRestoreWorkspaceSession && hasCompletedInitialRestore,
    addTab,
    setIsBootstrappingInitialWorkspace,
    platform,
    activateTabByPath,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    openWorkspace: handleOpenWorkspace,
    openWorkspacePath: (path) => {
      void handleSelectProject(path);
    },
    setWorkspaceActionError,
    allowOpenWorkspace,
    isDesktop,
    locale,
    tabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    webRemoteControlFeatureEnabled,
    hasCompletedFullTabRestore: hasCompletedFullRestore,
    intl,
    isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
  });

  useEffect(() => {
    if (!platform.onCloseActiveContextRequest) {
      return;
    }

    return platform.onCloseActiveContextRequest(() => {
      const event = new Event(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, {
        cancelable: true,
      });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        return;
      }

      // 关闭请求先广播给 workspace 层判断 side pane active tab。
      // 没有可见 workspace 或没有可关闭的 side pane tab 时，才回落到关窗口语义。
      void platform.executeDesktopCommand(DesktopCommandIds.CloseWindow);
    });
  }, [platform]);

  useRootOAuthEffects({
    accountIntentKey: JSON.stringify([
      user?.id,
      appSettings?.providerFamilyDomain,
      appSettings?.providerFamilyConnectionSelections,
    ]),
    platform,
    services,
    refreshProviderState,
    refreshAppSettings,
    setUser,
    setIsRestoringOAuthSession,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    onReauthenticationRequired: handleReauthenticationRequired,
  });

  useRootDesktopChromeEffects({
    platform,
    isDesktop,
    theme,
    isStartupRenderBlocked,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
    workspaceShellPath,
    isSettingsTabActive,
  });

  const handleRemoteWorkspaceUserClose = useCallback(
    (workspaceKeys: string[]) => {
      for (const workspaceKey of workspaceKeys) {
        void remoteWorkspaceController.dispatch({
          type: "close-workspace",
          workspaceKey,
          origin: "user-close",
        });
      }
    },
    [remoteWorkspaceController],
  );

  useRemoteWorkspaceTabLifecycle({
    tabs,
    activeWorkspaceTab,
    platform,
    tabStoreApi,
    onRemoteWorkspaceTabsClosed: handleRemoteWorkspaceUserClose,
  });

  useRootFallbackWorkspace({
    services,
    tabStoreApi,
    isResolvingStartupAuthState,
    isResolvingProviderStartupState,
    isRestoring,
    isBootstrappingInitialWorkspace,
    isStartupProviderLoginEntryOpen,
    workspaceShellPath,
    isSettingsTabActive,
    allowOpenWorkspace,
    handleSelectConversationWorkspace,
    setWorkspaceActionError,
    setIsCreatingFallbackWorkspace,
  });

  const { handleOpenLoginEntry, handleWelcomeScreenComplete } = useRootWelcomeScreenEntry({
    workspaceShellPath,
    isSettingsTabActive,
    loginEntryRequest,
    welcomeScreenOpenReason,
    setWelcomeScreenOpenReason,
    refreshAppSettings,
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
  });

  const {
    remoteProjectIntentEpoch,
    remoteProjectSelection,
    setRemoteProjectSelection,
    selectDirectoryForRemoteProject,
    handleRemoteConnectionDialogOpenChange,
    handleRemoteProjectIntentCleared,
  } = useRootRemoteProjectIntent({
    services,
    remoteConnectionOpenPreference,
    remoteWorkspaceController,
    deviceAdditionReturn: _deviceAdditionReturn,
    setRemoteConnectionDialogOpen,
    setRemoteConnectionOpenPreference,
  });

  const settingsLayerProps = {
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    isWebRemoteControl: Boolean(webRemoteControlWorkspaceSwitcher),
    captionWorkspacePath: activeWorkspacePath,
    onBack: activeWorkspacePath ? handleBackFromSettings : undefined,
    onCreateTask: handleCreateTask,
    onOpenWorkspace: handleOpenWorkspace,
    allowOpenWorkspace,
    onLogin: !user ? handleOpenLoginEntry : undefined,
    onLogout: user ? handleLogout : undefined,
    user,
  };

  const dialogsProps = {
    services,
    allowRemoteWorkspace,
    remoteConnectionOpenPreference,
    remoteWorkspaceSessions,
    remoteConnectionDialogOpen,
    remoteConnectionOpenIntentId,
    localWorkspacePathForRemoteConnection,
    isWindowsDesktop,
    remoteProjectSelection,
    remoteProjectIntentEpoch,
    setRemoteProjectSelection,
    selectDirectoryForRemoteProject,
    handleCancelRemoteProject,
    handleConnectRemote,
    finishDeviceAddition,
    handleRemoteConnectionDialogOpenChange,
    handleRemoteProjectIntentCleared,
    handleRemoteConnectionTargetChange,
    setRemoteConnectionInProgress,
    setRemoteConnectionRequestId,
    directoryBrowserOpen,
    setDirectoryBrowserOpen,
    handleSelectProject,
    tabStoreApi,
  };

  if (isStartupRenderBlocked) {
    const loadingLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        <RootDialogs {...dialogsProps} />
        {/* 修复原因：HTML 启动壳已经展示 ZCode SVG，但 React 接管 root 后旧壳会被整棵替换。
            之前阻塞恢复 tab / 初始 workspace 注入时重新渲染纯文字“加载中...”，所以启动被拆成两套 loading。
            这里复用同一套 SVG 启动画面，只把文案保留到 aria-label，保证视觉始终连续且不牺牲可访问性。 */}
        <RootStartupLoading label={loadingLabel} />
      </RootShell>
    );
  }

  if (welcomeScreenOpenReason) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        <RootDialogs {...dialogsProps} />
        <WelcomeScreen onComplete={handleWelcomeScreenComplete} />
      </RootShell>
    );
  }

  if (!workspaceShellPath && isSettingsTabActive) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        <RootDialogs {...dialogsProps} />
        <ScopedErrorBoundary
          scope="settings-page"
          resetKeys={["settings-root"]}
          variant="panel"
          className="h-full"
        >
          <SettingsPage {...settingsLayerProps} />
        </ScopedErrorBoundary>
      </RootShell>
    );
  }

  if (
    !workspaceShellPath &&
    !isDesktop &&
    initialWorkspaceAbsPath &&
    initialWorkspaceLoadingFallback
  ) {
    // 非桌面入口的 workspace tab 由 effect 注入，首帧不能返回 null。
    // 这里延续入口 loading，等任务列表有 workspaceShellPath 后再切换，避免露出浏览器白底。
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {initialWorkspaceLoadingFallback}
        <RootDialogs {...dialogsProps} allowRemoteWorkspace={false} />
      </RootShell>
    );
  }

  if (!workspaceShellPath) {
    return remoteConnectionDialogOpen || directoryBrowserOpen || rootModelSelectionErrorNode ? (
      <RootShell>
        {rootModelSelectionErrorNode}
        <RootDialogs
          {...dialogsProps}
          allowRemoteWorkspace={allowRemoteWorkspace && remoteConnectionDialogOpen}
        />
      </RootShell>
    ) : null;
  }

  return (
    <RootShell>
      {rootModelSelectionErrorNode}
      {requestSecurityBridgeNode}
      <RootDialogs {...dialogsProps} />
      <OccupationOnboarding
        showWindowControls={Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))}
        showChildrenWhileLoading={!workspaceShellPath && isSettingsTabActive}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        {/* 新引导属于应用级偏好；无项目时也要挂载，才能响应设置页的手动打开请求。 */}
        {!workspaceShellPath ? (
          isSettingsTabActive ? (
            <ScopedErrorBoundary
              scope="settings-page"
              resetKeys={["settings-root"]}
              variant="panel"
              className="h-full"
            >
              <SettingsPage {...settingsLayerProps} />
            </ScopedErrorBoundary>
          ) : null
        ) : (
          <RemoteWorkspaceControllerProvider controller={remoteWorkspaceController}>
            <RemoteProjectPresentationProvider
              reconnectingKeys={reconnectingRemoteWorkspaceKeys}
              errors={remoteWorkspaceErrorByWorkspaceKey}
              recovery={remoteWorkspaceRecoveryByWorkspaceKey}
              onReconnect={
                webRemoteControlWorkspaceSwitcher?.reconnectWorkspace ??
                handleReconnectRemoteWorkspace
              }
            >
              <RootWorkspaceContent
                workspaceScopedServices={workspaceScopedServices}
                baseFeedbackService={services.feedbackService}
                workspaceShellPath={workspaceShellPath}
                workspaceIdentity={workspaceShellIdentity}
                workspaceRemoteSessionId={workspaceShellRemoteSessionId}
                activeWorkspacePath={activeWorkspacePath}
                isSettingsTabActive={isSettingsTabActive}
                handleConnectRemote={handleConnectRemote}
                handleSelectRemoteProject={handleSelectRemoteProject}
                handleCancelRemoteProject={handleCancelRemoteProject}
                handleReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                handleCreateTask={handleCreateTask}
                handleCreateConversationTask={handleCreateConversationTask}
                handleResolveConversationWorkspace={handleResolveConversationWorkspaceForShell}
                handleOpenWorkspace={handleOpenWorkspace}
                handleOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                handleOpenRemoteWorkspace={
                  allowRemoteWorkspace ? handleOpenRemoteConnection : undefined
                }
                remoteConnectionInProgress={remoteConnectionInProgress}
                remoteWorkspaceSessions={remoteWorkspaceSessions}
                allowRemoteWorkspace={allowRemoteWorkspace}
                handleBackFromSettings={handleBackFromSettings}
                handleLogout={user ? handleLogout : undefined}
                onLogin={!user ? handleOpenLoginEntry : undefined}
                user={user}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                remoteConnectionLogs={remoteConnectionLogs}
                allowOpenWorkspace={allowOpenWorkspace}
                webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
                initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
                initialWebRemoteControlMobileNavigationIntent={
                  initialWebRemoteControlMobileNavigationIntent
                }
                webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                supportsEmbeddedBrowser={supportsEmbeddedBrowser}
              />
            </RemoteProjectPresentationProvider>
          </RemoteWorkspaceControllerProvider>
        )}
        <ScopedErrorBoundary
          scope="onboarding-dialog"
          resetKeys={[workspaceShellIdentity?.trim() || workspaceShellPath]}
          variant="silent"
        >
          <OnboardingDialog
            workspacePath={workspaceShellPath || undefined}
            workspaceIdentity={workspaceShellIdentity}
            isDesktop={isDesktop}
          />
        </ScopedErrorBoundary>
      </OccupationOnboarding>
    </RootShell>
  );
}
