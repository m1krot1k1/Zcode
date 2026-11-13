import type { WorkspaceShellContext } from "@/app-shell/workspace-shell-layout/context.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";

/**
 * 桌面与手机远控共享同一份 WorkspaceHeader 映射：脱敏 variant 由 activeTaskId 决定，
 * 只有 reserveWindowControls / simplifyForNarrowRemote 按宿主覆写。
 */
export function buildWorkspaceHeaderSlot(
  { props, model }: WorkspaceShellContext,
  options: { reserveWindowControls?: boolean; simplifyForNarrowRemote: boolean },
) {
  const {
    activeSessionId,
    activeTaskId,
    activeTaskChangeSummary,
    activeTaskProvider,
    activeTaskTitle,
    activeTraceId,
    allowOpenWorkspace,
    gitState,
    handleRefreshGit,
    handleReloadSession,
    handleToggleBrowser,
    handleToggleSidePane,
    handleToggleTerminal,
    isDesktop,
    isMacDesktop,
    isMacFullscreen,
    isSidePaneOpen,
    isSidebarVisible,
    isTerminalOpen,
    isWindowsDesktop,
    onOpenWorkspace,
    projectName,
    providerConfigFile,
    reloadSessionPending,
    resolvedActiveTaskMeta,
    taskNativeSessionLogFile,
    taskSessionFile,
    toggleSidePaneShortcutLabel,
    user,
    windowsWindowControlsRightPaddingPx,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceReadOnlyReason,
    workspaceRemoteSessionId,
    workspaceShellZCodeState,
  } = props;
  const {
    draftHeaderDropTargetController,
    gitDirtyFileCount,
    hasUpdateStatusButton,
    isWebRemoteControlShell,
    workspaceLocalPathForRemoteMcpSync,
    workspaceOnlyResetKeys,
    workspaceRemoteTarget,
    workspaceSessionActionDisabled,
    createTaskInChat: handleCreateTaskInChat,
  } = model;
  return (
    <ScopedErrorBoundary
      scope="workspace-header"
      resetKeys={workspaceOnlyResetKeys}
      variant="compact"
      className="border-b"
    >
      <WorkspaceHeader
        {...(options.reserveWindowControls === undefined
          ? {}
          : { reserveWindowControls: options.reserveWindowControls })}
        variant={activeTaskId === null ? "draft" : "task"}
        draftDropTargetController={
          activeTaskId === null ? draftHeaderDropTargetController : undefined
        }
        readOnlyReason={workspaceReadOnlyReason}
        workspaceAbsPath={workspaceAbsPath}
        remoteSessionId={workspaceRemoteSessionId}
        workspaceIdentity={workspaceIdentity}
        remoteTarget={workspaceRemoteTarget}
        localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
        projectName={projectName}
        activeTaskTitle={activeTaskTitle}
        activeTaskChangeSummary={activeTaskChangeSummary}
        hasUpdateReady={hasUpdateStatusButton}
        activeTaskId={activeTaskId}
        user={user}
        activeTraceId={activeTraceId}
        activeSessionId={activeSessionId}
        activeTaskProvider={activeTaskProvider}
        resolvedActiveTaskMeta={resolvedActiveTaskMeta}
        sessionLogPath={taskSessionFile.path}
        nativeSessionLogProvider={taskNativeSessionLogFile.provider}
        nativeSessionLogPath={taskNativeSessionLogFile.path}
        nativeSessionLogExists={taskNativeSessionLogFile.exists}
        nativeSessionLogLoading={taskNativeSessionLogFile.loading}
        providerWorkspaceConfigPath={providerConfigFile.path}
        providerWorkspaceConfigExists={providerConfigFile.exists}
        providerWorkspaceConfigLoading={providerConfigFile.loading}
        workspaceHeaderState={workspaceShellZCodeState}
        gitSummary={gitState.summary}
        gitDirtyFileCount={gitDirtyFileCount}
        isMacDesktop={isMacDesktop}
        isMacFullscreen={isMacFullscreen}
        isWindowsDesktop={isWindowsDesktop}
        isWebRemoteControl={isWebRemoteControlShell}
        windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
        isDesktop={isDesktop}
        simplifyForNarrowRemote={options.simplifyForNarrowRemote}
        isSidebarVisible={isSidebarVisible}
        isTerminalOpen={isTerminalOpen}
        isSidePaneOpen={isSidePaneOpen}
        onRefreshGit={handleRefreshGit}
        onToggleTerminal={handleToggleTerminal}
        onToggleBrowser={handleToggleBrowser}
        onToggleSidePane={handleToggleSidePane}
        toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
        onReloadSession={handleReloadSession}
        reloadSessionDisabled={workspaceSessionActionDisabled}
        reloadSessionPending={reloadSessionPending}
        onCreateTask={handleCreateTaskInChat}
        onOpenWorkspace={onOpenWorkspace}
        allowOpenWorkspace={allowOpenWorkspace}
      />
    </ScopedErrorBoundary>
  );
}
