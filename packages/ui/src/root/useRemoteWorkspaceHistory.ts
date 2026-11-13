import { useEffect } from "react";
import type { AppSettings, IPlatformService, SourceServerManagementSnapshot } from "@zcode/shared";
import type { IServiceAccessor } from "./contract.ts";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import type { WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import {
  buildWorkspaceSessionKey,
  projectRemoteWorkspaceSessionIdentityAliases,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  collectStartupRemoteWorkspaceReconnectGroups,
  shouldAttemptStartupReconnectForSourceState,
  shouldAttemptStartupReconnectForTabChange,
  updateStartupRemoteWorkspaceReconnectAttemptsForSourceState,
} from "@/root/remote-workspace-history/reconnectPlanning.js";
import { restoreSourceRemoteWorkspaceGroup } from "@/root/remote-workspace-history/reconnectExecution.js";
import { useRemoteWorkspaceConnection } from "@/root/remote-workspace-history/useRemoteWorkspaceConnection.js";
import { useRemoteWorkspaceController } from "@/root/remote-workspace-history/useRemoteWorkspaceController.js";
import { useRemoteWorkspaceSessionEvents } from "@/root/remote-workspace-history/useRemoteWorkspaceSessionEvents.js";
import { useRemoteWorkspaceRestore } from "@/root/remote-workspace-history/useRemoteWorkspaceRestore.js";
import { useRemoteWorkspaceSessionState } from "@/root/remote-workspace-history/useRemoteWorkspaceSessionState.js";

export { reconnectRemoteWorkspaceHistoryEntry } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
export {
  bindRemoteWorkspaceContextAndGetSession,
  collectSshReconnectGroup,
  collectStartupRemoteWorkspaceReconnectGroups,
  isRemoteWorkspaceCloseFailure,
  reconnectRemoteWorkspaceByKey,
  resolveRemoteWorkspaceClosedFallback,
  shouldAttemptStartupReconnectForSourceState,
  shouldAttemptStartupReconnectForTabChange,
  shouldPersistRemoteWorkspaceFailure,
  updateRemoteWorkspaceRecoveringKeys,
  updateStartupRemoteWorkspaceReconnectAttemptsForSourceState,
} from "@/root/remote-workspace-history/reconnectPlanning.js";
export {
  cancelPendingRemoteReconnectsForWorkspaceKeys,
  reconnectRemoteWorkspaceGroup,
  restoreSourceRemoteWorkspaceGroup,
} from "@/root/remote-workspace-history/reconnectExecution.js";
export {
  openRemoteWorkspaceFromHistoryEntry,
  selectRemoteWorkspaceProjectFromDialog,
} from "@/root/remote-workspace-history/openRemoteWorkspace.js";
export {
  openRemoteConversationWorkspace,
  resolveSourceRemoteConversationWorkspaceProjection,
} from "@/root/remote-workspace-history/conversationWorkspace.js";

export function useRemoteWorkspaceHistory({
  intl,
  services,
  platform,
  supportsSettings,
  isDesktop = false,
  allowRemoteWorkspace = true,
  ensureConversationWorkspaceOnRestore = false,
  deferInactiveWorkspaceRestore = false,
  unavailableWorkspacePath,
  tabStoreApi,
  activateTabByPath,
  addTab,
  persistenceGate,
  onWorkspaceActivated,
  onOpenRemoteConnection,
  manuallyOpeningWorkspaceTabId,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  services: IServiceAccessor;
  platform: IPlatformService;
  supportsSettings: boolean;
  isDesktop?: boolean;
  allowRemoteWorkspace?: boolean;
  ensureConversationWorkspaceOnRestore?: boolean;
  /** 仅 Desktop 主窗口：输入可用后再把 inactive workspace 加入 sidebar/task 数据源。 */
  deferInactiveWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  persistenceGate?: WorkspacePersistenceGate;
  /** 仅用于从已保存 Profile 发起普通连接；实际连接仍由唯一 SSHDialog 承载。 */
  onOpenRemoteConnection?: (preference?: RemoteConnectionOpenPreference) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
    projectId?: string | null;
  }) => void;
  manuallyOpeningWorkspaceTabId?: string;
}) {
  const {
    allowRemoteWorkspaceRestore,
    canUseRemoteWorkspace,
    commitRemoteWorkspaceSessionMutation,
    inflightReconnectWorkspaceKeysRef,
    manuallyOpeningWorkspaceTabIdRef,
    pendingConnectionTargetsBySessionIdRef,
    pendingCredentialDeletesRef,
    pendingReconnectRequestIdsRef,
    reconnectingRemoteWorkspaceKeys,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceReconnectRendererState,
    remoteWorkspaceSessions,
    remoteWorkspaceSessionsRef,
    resetLogsForWorkspaceKey,
    setReconnectingRemoteWorkspaceKeys,
    setRemoteWorkspaceRecoveryByWorkspaceKey,
    setRemoteWorkspaceSessions,
    syncPersistedWorkspaceSession,
  } = useRemoteWorkspaceSessionState({
    allowRemoteWorkspace,
    manuallyOpeningWorkspaceTabId,
    persistenceGate,
    platform,
    services,
    supportsSettings,
    tabStoreApi,
  });

  const {
    bindRemoteWorkspaceScope,
    buildPersistedTabPatch,
    connectRemoteWorkspaceTarget,
    handleCancelRemoteProject,
    resolveRemoteWorkspaceCanonicalPath,
    runReconnectRemoteWorkspace,
    runReconnectRemoteWorkspaceEntry,
    waitForRemoteWorkspaceSessionReady,
  } = useRemoteWorkspaceConnection({
    activateTabByPath,
    commitRemoteWorkspaceSessionMutation,
    inflightReconnectWorkspaceKeysRef,
    intl,
    isDesktop,
    onWorkspaceActivated,
    pendingConnectionTargetsBySessionIdRef,
    pendingReconnectRequestIdsRef,
    platform,
    remoteWorkspaceSessionsRef,
    resetLogsForWorkspaceKey,
    services,
    setReconnectingRemoteWorkspaceKeys,
    setRemoteWorkspaceRecoveryByWorkspaceKey,
    tabStoreApi,
  });

  useEffect(() => {
    const sourceManagement = services.sourceServerManagementService;
    if (!canUseRemoteWorkspace || remoteWorkspaceSessions.length === 0 || !sourceManagement) {
      return;
    }
    let disposed = false;
    let observedManagementGeneration = 0;
    const sourceStateByProfileId = new Map<
      string,
      Awaited<ReturnType<typeof sourceManagement.getSnapshot>>["states"][number]
    >();
    const collectOnlineSourceServerIds = () =>
      new Set(
        [...sourceStateByProfileId.values()].flatMap((state) =>
          state.state === "online" && state.sourceServerId ? [state.sourceServerId] : [],
        ),
      );
    const updateObservedSourceAvailability = () => {
      const onlineSourceServerIds = collectOnlineSourceServerIds();
      const reconnectState = remoteWorkspaceReconnectRendererState;
      reconnectState.observedOnlineSourceServerIds = onlineSourceServerIds;
      for (const sourceServerId of reconnectState.pendingTerminallyDisconnectedSourceServerIds) {
        if (onlineSourceServerIds.has(sourceServerId)) continue;
        reconnectState.pendingTerminallyDisconnectedSourceServerIds.delete(sourceServerId);
        reconnectState.currentRendererDisconnectedSourceServerIds.add(sourceServerId);
      }
    };
    const applyDirectoryWorkspaceIdentityProjection = (settings: {
      sourceServerWorkspaceHistory: SourceServerManagementSnapshot["workspaceHistory"];
      connectionProfiles: SourceServerManagementSnapshot["profiles"];
      remoteConversationWorkspaceBySourceServerId?: AppSettings["remoteConversationWorkspaceBySourceServerId"];
    }) => {
      const projection = projectRemoteWorkspaceSessionIdentityAliases(
        remoteWorkspaceSessionsRef.current,
        settings,
      );
      if (projection.identityRekeys.length === 0) return;

      // Bug 根因：同一 Renderer 生命周期内完成首次识别/版本升级后，Directory 已把
      // history 改成 stable identity，但内存 session/tab 仍停在 legacy route identity。
      // online 恢复门禁因此无法归属 Source，必须在重连判定前先原地重投影控制端状态。
      remoteWorkspaceSessionsRef.current = projection.remoteSessions;
      setRemoteWorkspaceSessions(projection.remoteSessions);
      const ensureWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
      for (const rekey of projection.identityRekeys) {
        const matchingTab = tabStoreApi
          .getState()
          .tabs.find(
            (tab) =>
              isWorkspaceTab(tab) &&
              tab.workspacePath === rekey.workspacePath &&
              tab.workspaceIdentity === rekey.previousWorkspaceIdentity,
          );
        if (!matchingTab) continue;
        // Bug 原因：首次识别时 project/conversation attachment 可能已经 ready；过去只
        // rekey 断连 tab，live tab 继续持有 legacy identity，随后 canonical purpose
        // 自愈按 stable workspaceKey 精确匹配时必然漏掉它。原地 rekey 会保留 remoteSessionId。
        ensureWorkspaceTab(rekey.workspacePath, {
          previousWorkspaceIdentity: rekey.previousWorkspaceIdentity,
          workspaceIdentity: rekey.workspaceIdentity,
        });
      }
    };
    const attemptReconnect = () => {
      const attemptedWorkspaceKeys = remoteWorkspaceReconnectRendererState.attemptedWorkspaceKeys;
      const groups = collectStartupRemoteWorkspaceReconnectGroups({
        manuallyOpeningWorkspaceTabId: manuallyOpeningWorkspaceTabIdRef.current,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
        attemptedWorkspaceKeys,
        onlineSourceServerIds: collectOnlineSourceServerIds(),
        currentRendererDisconnectedSourceServerIds:
          remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds,
        pendingTerminallyDisconnectedSourceServerIds:
          remoteWorkspaceReconnectRendererState.pendingTerminallyDisconnectedSourceServerIds,
      });
      if (groups.length === 0) return;
      for (const group of groups) {
        remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds.delete(
          group.sourceServerId,
        );
        for (const entry of group.entries) {
          attemptedWorkspaceKeys.add(buildWorkspaceSessionKey(entry));
        }
      }

      // Bug 原因：R3 Host 冷启动只恢复 physical Source，Renderer 仍沿用 R1 的“全部断连占位”
      // 旧语义，导致 online Source 下 A/B 永远没有新 remoteSessionId。按 Source 并发、组内串行恢复
      // logical attachments；physical Source 已 online，不再让某个 workspace 充当 Host gate。
      void Promise.all(
        groups.map(async (group) => {
          const groupWorkspaceKeys = new Set(
            group.entries.map((entry) => buildWorkspaceSessionKey(entry)),
          );
          await restoreSourceRemoteWorkspaceGroup({
            entries: remoteWorkspaceSessionsRef.current.filter((entry) =>
              groupWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
            ),
            reconnectEntry: runReconnectRemoteWorkspaceEntry,
            options: {
              activateWorkspaceAfterReconnect: false,
              showErrorToast: false,
              recoveryMode: "automatic",
            },
          });
        }),
      );
    };

    let refreshInFlight: Promise<void> | null = null;
    let refreshQueued = false;
    let refreshQueuedReconnect = false;
    const refreshSnapshot = (shouldAttemptReconnect: boolean) => {
      if (refreshInFlight) {
        refreshQueued = true;
        refreshQueuedReconnect ||= shouldAttemptReconnect;
        return;
      }
      refreshInFlight = sourceManagement
        .getSnapshot()
        .then(async (snapshot) => {
          if (disposed || snapshot.generation < observedManagementGeneration) return;
          observedManagementGeneration = snapshot.generation;
          let settings: Pick<AppSettings, "remoteConversationWorkspaceBySourceServerId"> = {};
          try {
            settings = await services.settingService.get();
          } catch (error) {
            // alias 读取失败不能阻断 Source 状态刷新；没有 map 时继续保持原有 fail-closed 行为。
            logger.warn("[Root] 读取 conversation workspace alias 失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          // 读取设置期间向导意图可能变化；已清理的订阅不能继续提交旧投影/恢复候选。
          if (disposed) return;
          applyDirectoryWorkspaceIdentityProjection({
            sourceServerWorkspaceHistory: snapshot.workspaceHistory,
            connectionProfiles: snapshot.profiles,
            remoteConversationWorkspaceBySourceServerId:
              settings.remoteConversationWorkspaceBySourceServerId,
          });
          sourceStateByProfileId.clear();
          for (const state of snapshot.states) sourceStateByProfileId.set(state.profileId, state);
          updateObservedSourceAvailability();
          if (shouldAttemptReconnect) attemptReconnect();
        })
        .catch((error) => {
          if (!disposed) {
            logger.warn("[Root] 读取 Source 启动恢复状态失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          refreshInFlight = null;
          if (!disposed && refreshQueued) {
            const queuedReconnect = refreshQueuedReconnect;
            refreshQueued = false;
            refreshQueuedReconnect = false;
            refreshSnapshot(queuedReconnect);
          }
        });
    };

    // Bug 原因：Renderer 过去在 Host 的 10 秒 startup flight 仍进行时就主动 connectProfile，
    // 既把“Host 只试一次”扩成第二条恢复入口，也会 join 同一超时 flight 后制造迟到连接。
    // logical workspace 只消费 Host 权威 online 状态；failed/offline 保持手动入口。
    const managementSubscription = sourceManagement.onDidChangeState((delta) => {
      if (disposed || delta.generation < observedManagementGeneration) return;
      observedManagementGeneration = delta.generation;
      sourceStateByProfileId.set(delta.state.profileId, delta.state);
      updateObservedSourceAvailability();
      // Bug 根因：主动断开会先发布 retrying/offline；这些状态不是启动恢复信号，
      // 只有 Source 真正进入 online 才允许重算历史 workspace 候选。
      if (shouldAttemptStartupReconnectForSourceState(delta.state.state)) {
        attemptReconnect();
      }
      updateStartupRemoteWorkspaceReconnectAttemptsForSourceState({
        state: delta.state,
        onlineSourceServerIds: collectOnlineSourceServerIds(),
        sessions: remoteWorkspaceSessionsRef.current,
        attemptedWorkspaceKeys: remoteWorkspaceReconnectRendererState.attemptedWorkspaceKeys,
      });
    });
    const directorySubscription = sourceManagement.onDidChangeDirectory?.(() => {
      // Directory 变更只刷新权威投影，不触发自动重连；重命名/删线路/打开项目不能被误判为连接信号。
      refreshSnapshot(false);
    });
    refreshSnapshot(true);
    // Desktop active-first 会在首帧后才补齐 inactive tabs；订阅 tabs 才能在 A/B 真正进入
    // TabStore 后重新计算一次候选。attempted workspace set 阻止其它 tab 变化重复连接已处理项，
    // 同时允许迟到的同 Source sibling 补上 logical session。
    const tabSubscription = tabStoreApi.subscribe((state, previousState) => {
      // Bug 根因：主动断开先清除已有 tab 的 remoteSessionId，再异步发布 Source offline；
      // 任意 tab 变化都会在这段窗口内误触发 startup reconnect。只对 active-first 新增的
      // 断连 tab 重算候选，已有 tab 的 live -> disconnected 变化保持手动重连语义。
      if (shouldAttemptStartupReconnectForTabChange(state.tabs, previousState.tabs)) {
        attemptReconnect();
      }
    });
    return () => {
      disposed = true;
      managementSubscription.dispose();
      directorySubscription?.dispose();
      tabSubscription();
    };
  }, [
    canUseRemoteWorkspace,
    manuallyOpeningWorkspaceTabId,
    remoteWorkspaceSessions,
    runReconnectRemoteWorkspaceEntry,
    services.settingService,
    services.sourceServerManagementService,
    syncPersistedWorkspaceSession,
    tabStoreApi,
  ]);

  const {
    restorePersistedSession,
    selectRemoteProjectFromDialog,
    openRemoteConversation,
    handleConnectRemote,
    runReconnectRemoteWorkspaceByKey,
    handleOpenRemoteWorkspaceFromHistory,
  } = useRemoteWorkspaceRestore({
    activateTabByPath,
    addTab,
    allowRemoteWorkspaceRestore,
    bindRemoteWorkspaceScope,
    canUseRemoteWorkspace,
    commitRemoteWorkspaceSessionMutation,
    connectRemoteWorkspaceTarget,
    deferInactiveWorkspaceRestore,
    ensureConversationWorkspaceOnRestore,
    handleCancelRemoteProject,
    inflightReconnectWorkspaceKeysRef,
    intl,
    manuallyOpeningWorkspaceTabIdRef,
    onOpenRemoteConnection,
    onWorkspaceActivated,
    pendingConnectionTargetsBySessionIdRef,
    pendingReconnectRequestIdsRef,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    remoteWorkspaceSessionsRef,
    resolveRemoteWorkspaceCanonicalPath,
    resetLogsForWorkspaceKey,
    runReconnectRemoteWorkspace,
    services,
    setReconnectingRemoteWorkspaceKeys,
    setRemoteWorkspaceSessions,
    tabStoreApi,
    unavailableWorkspacePath,
    waitForRemoteWorkspaceSessionReady,
  });

  const { handleRemoteWorkspaceTabsClosed } = useRemoteWorkspaceSessionEvents({
    commitRemoteWorkspaceSessionMutation,
    intl,
    pendingCredentialDeletesRef,
    pendingReconnectRequestIdsRef,
    persistenceGate,
    platform,
    remoteWorkspaceReconnectRendererState,
    remoteWorkspaceSessionsRef,
    services,
    setReconnectingRemoteWorkspaceKeys,
    setRemoteWorkspaceRecoveryByWorkspaceKey,
    syncPersistedWorkspaceSession,
    tabStoreApi,
  });

  const {
    handleOpenRemoteConversation,
    handleReconnectRemoteWorkspace,
    handleSelectRemoteProject,
    remoteWorkspaceController,
    remoteWorkspaceErrorByWorkspaceKey,
  } = useRemoteWorkspaceController({
    handleRemoteWorkspaceTabsClosed,
    onOpenRemoteConnection,
    openRemoteConversation,
    remoteWorkspaceSessions,
    runReconnectRemoteWorkspaceByKey,
    selectRemoteProjectFromDialog,
    services,
  });

  return {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleOpenRemoteConversation,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleOpenRemoteWorkspaceFromHistory,
    handleRemoteWorkspaceTabsClosed,
    remoteWorkspaceController,
  };
}
