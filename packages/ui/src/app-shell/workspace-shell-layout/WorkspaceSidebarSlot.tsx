import type { WorkspaceShellContext } from "@/app-shell/workspace-shell-layout/context.js";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";

/**
 * 手机 home 与桌面 sidebar 共用同一个项目入口；Shell 只接收导航完成事件，
 * 桌面没有 mobile 导航动作，远控包装只补 navigateToChat/setSwitching。
 */
export function buildWorkspaceSidebar(
  { props, model }: WorkspaceShellContext,
  mobile?: {
    navigateToChat(): void;
    setSwitching(switching: boolean): void;
  },
) {
  const {
    canTaskNavForward,
    goBackShortcutLabel,
    goForwardShortcutLabel,
    handleOpenAutomations,
    handleOpenBrowserUrl,
    handleOpenCodeViewer,
    handleOpenCommandCenter,
    handleOpenPluginStore,
    handleTaskNavForward,
    handleToggleSidebar,
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    isSidebarVisible,
    onCancelRemoteProject,
    onOpenFolderFromWorkspaceMenu,
    onConnectRemote,
    onCreateConversationTask,
    onCreateConversationTaskOnSource,
    onLogin,
    onLogout,
    onOpenRemoteWorkspace,
    onReconnectRemoteWorkspace,
    onSelectRemoteProject,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    remoteWorkspaceRecoveryByWorkspaceKey,
    theme,
    toggleSidebarShortcutLabel,
    user,
    webRemoteControlWorkspaceSwitcher,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceMainView,
    workspaceRemoteSessionId,
  } = props;
  const {
    canPrimaryNavigationBack,
    fileTreeOpenRequest,
    handleOpenSidebarFiles,
    handleStartDraftInWorkspaceInChat,
    handleWebRemoteTaskOpen,
    handleWebRemoteTaskSwitchingChange,
    isWebRemoteControlShell,
    primaryNavigationBack,
    createTaskInChat: handleCreateTaskInChat,
    selectTaskInChat: handleSelectTaskInChat,
  } = model;
  return (
    <WorkspaceSidebar
      workspacePath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      onOpenFileManager={
        mobile
          ? (target) => {
              handleOpenSidebarFiles(target);
              // 手机 Home 不挂载 side pane，文件入口必须同时进入 Chat。
              mobile.navigateToChat();
            }
          : handleOpenSidebarFiles
      }
      onSelectTask={handleSelectTaskInChat}
      onStartDraftInWorkspace={handleStartDraftInWorkspaceInChat}
      onOpenCodeViewer={handleOpenCodeViewer}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      fileTreeOpenRequest={fileTreeOpenRequest}
      onCreateTask={handleCreateTaskInChat}
      onCreateConversationTask={onCreateConversationTask ?? handleCreateTaskInChat}
      onCreateConversationTaskOnSource={onCreateConversationTaskOnSource}
      onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
      onOpenRemoteWorkspace={onOpenRemoteWorkspace}
      webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
      theme={theme}
      onConnectRemote={onConnectRemote}
      onSelectRemoteProject={onSelectRemoteProject}
      onCancelRemoteProject={onCancelRemoteProject}
      onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
      reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
      remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
      remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
      onLogout={onLogout}
      onLogin={onLogin}
      user={user}
      isDesktop={isDesktop}
      isWebRemoteControl={isWebRemoteControlShell}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
      isSidebarVisible={isSidebarVisible}
      onToggleSidebar={handleToggleSidebar}
      toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
      canGoBack={canPrimaryNavigationBack}
      canGoForward={canTaskNavForward}
      onGoBack={primaryNavigationBack}
      onGoForward={handleTaskNavForward}
      goBackShortcutLabel={goBackShortcutLabel}
      goForwardShortcutLabel={goForwardShortcutLabel}
      onOpenCommandCenter={handleOpenCommandCenter}
      onOpenAutomations={handleOpenAutomations}
      automationsActive={workspaceMainView === "automations"}
      onOpenPluginStore={handleOpenPluginStore}
      pluginStoreActive={workspaceMainView === "plugin-store"}
      // 桌面没有 mobile 导航动作；内联包装曾让右侧开关穿透侧栏 memo，重复渲染全部项目。
      onWebRemoteTaskOpen={
        mobile
          ? (event) => {
              handleWebRemoteTaskOpen(event);
              // 跨工作区由目标 Root 消费 chat 意图后再导航，不能提前展示旧会话。
              if (!event.crossWorkspace) mobile.navigateToChat();
            }
          : handleWebRemoteTaskOpen
      }
      onWebRemoteTaskSwitchingChange={
        mobile
          ? (switching) => {
              handleWebRemoteTaskSwitchingChange(switching);
              mobile.setSwitching(switching);
            }
          : handleWebRemoteTaskSwitchingChange
      }
    />
  );
}
