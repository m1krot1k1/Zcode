import { useCallback } from "react";
import type { AppSettings, IPlatformService, UserInfo } from "@zcode/shared";
import type { IServiceAccessor } from "./contract.ts";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import type { WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/index.js";
import type { WelcomeScreenOpenReason } from "@/root/useRootEntryState.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import type { RootProps } from "@/root/types.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { TabStore, TabStoreState } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * workspace shell 控制器：本地动作、远程历史恢复与远程项目打开共享同一组 tab store 写入。
 *
 * `openPreparedRemoteProjectWorkspace` 仍以函数声明提供：`useRootWorkspaceActions` 会在首次
 * render 就持有它（放进 ref），而它又依赖 `useRemoteWorkspaceHistory` 的连接动作。保持现有
 * 声明提升 + 延迟调用的结构，避免把远程打开链路拆成两条写入路径。
 */
export function useRootWorkspaceShellController({
  intl,
  platform,
  services,
  tabStoreApi,
  addTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  supportsSettings,
  allowOpenWorkspace,
  preferDirectoryBrowser,
  openDirectoryBrowser,
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
}: {
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  addTab: TabStoreState["addTab"];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  supportsSettings: boolean;
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  preferDirectoryBrowser: boolean;
  openDirectoryBrowser: () => void;
  refreshProviderState: () => Promise<void>;
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setOAuthError: (error: string | null) => void;
  setUser: (user: UserInfo | null) => void;
  setWelcomeScreenOpenReason: (reason: WelcomeScreenOpenReason) => void;
  user: UserInfo | null;
  allowRemoteWorkspace: boolean;
  handleOpenRemoteConnection: (preference?: RemoteConnectionOpenPreference) => void;
  webRemoteControlWorkspaceSwitcher?: RootProps["webRemoteControlWorkspaceSwitcher"];
  isWebRemoteControlRoot: boolean;
  isDesktop?: boolean;
  restoreSession: boolean;
  initialWorkspaceIdentity?: string;
  unavailableWorkspacePath?: string;
  activateTabByPath: TabStoreState["activateTabByPath"];
  workspacePersistenceGate: WorkspacePersistenceGate;
  remoteConnectionDialogOpen: boolean;
  remoteConnectionInProgress: boolean;
  remoteConnectionOpenPreference: RemoteConnectionOpenPreference | null;
}) {
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
  } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    allowOpenWorkspace,
    preferDirectoryBrowser,
    openDirectoryBrowser,
    refreshProviderState,
    updateAppSettings,
    setOAuthError,
    setUser,
    onProviderFamilyDomainClearedAfterLogout: () => {
      setWelcomeScreenOpenReason("logout-provider-required");
    },
    userId: user?.id,
    onOpenRemoteConnection: allowRemoteWorkspace ? handleOpenRemoteConnection : undefined,
    openRemoteProjectWorkspace: openPreparedRemoteProjectWorkspace,
    openMobileProjectDraft: webRemoteControlWorkspaceSwitcher?.openProjectDraft,
    workbenchGroupClientMode: isWebRemoteControlRoot
      ? "web-remote-replayable"
      : "desktop-continuous",
  });
  const handleRemoteWorkspaceActivated = useCallback(
    ({
      workspacePath,
      workspaceIdentity,
      restoreSelection,
      projectId,
    }: {
      workspacePath: string;
      workspaceIdentity: string;
      restoreSelection?: boolean;
      projectId?: string | null;
    }) => {
      // 桌面重连只恢复连接，不得把已选会话覆盖成草稿；手机仍沿用 replayable 入口。
      const selectedTask = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId;
      if (!isDesktop || !restoreSelection || !selectedTask) {
        if (projectId !== undefined)
          logger.info("[Root] 按原项目初始化远程草稿", { workspaceIdentity, projectId });
        startDraftInWorkspace(workspacePath, workspaceIdentity, { projectId });
      }
    },
    [isDesktop, startDraftInWorkspace],
  );

  const {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,

    buildPersistedTabPatch,
    restorePersistedSession: restoreWorkspaceTabs,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    remoteWorkspaceController,
  } = useRemoteWorkspaceHistory({
    intl,
    services,
    platform,
    supportsSettings,
    isDesktop,
    allowRemoteWorkspace,
    // conversation backing workspace 只属于本地桌面主恢复链路；远程窗口和手机
    // shared-host attachment 不能因此创建独立本地 runtime 或改变 replayable 边界。
    ensureConversationWorkspaceOnRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    deferInactiveWorkspaceRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    unavailableWorkspacePath,
    tabStoreApi,
    activateTabByPath,
    addTab,
    persistenceGate: workspacePersistenceGate,
    onWorkspaceActivated: handleRemoteWorkspaceActivated,
    onOpenRemoteConnection: handleOpenRemoteConnection,
    manuallyOpeningWorkspaceTabId:
      remoteConnectionDialogOpen || remoteConnectionInProgress
        ? remoteConnectionOpenPreference?.preferredWorkspaceTabId
        : undefined,
  });

  async function openPreparedRemoteProjectWorkspace(target: {
    expectedMembershipId?: string;
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    projectId: string | null;
    isCurrent?: () => boolean;
  }): Promise<void> {
    if (!target.workspaceIdentity) throw new Error("project.workspace-identity-required");
    if (!services.remoteProjectService) throw new Error("remote-project.service-unavailable");
    await attachRemoteProjectWorkspace({
      ...target,
      workspaceIdentity: target.workspaceIdentity,
      remoteService: services.remoteProjectService,
      ...(target.expectedMembershipId ? { projectService: services.projectService } : {}),
      findSession: (identity) =>
        Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
          (session) => session.workspaceIdentity === identity,
        ),
      connect: handleConnectRemote,
      cancel: handleCancelRemoteProject,
      bind: async (remoteSessionId, path, isCurrent) => {
        const session = useRemoteWorkspaceSessionStore.getState().sessionsById[remoteSessionId];
        await remoteWorkspaceController.dispatch({
          type: "open-project",
          sourceServerId: session?.sourceServerId ?? "",
          path,
          remoteSessionId,
          draftProjectId: target.projectId,
          preparedWorkspaceIdentity: target.workspaceIdentity,
          isCurrent,
        });
      },
    });
  }

  return {
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
  };
}
