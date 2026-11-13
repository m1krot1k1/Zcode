import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AppSettings, IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { createUuid } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type {
  RemoteConnectionFeedbackOptions,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { requestRemoteProjectConnection } from "@/remote-connection-flow/contract.js";
import { requestRetainedRemoteProjectConnection } from "@/project-sidebar/remote-project-connection.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import {
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { buildRemoteTargetFromProfile } from "@/lib/remoteConnectionWizard.js";
import {
  buildWorkspaceSessionKey,
  getRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { reconnectRemoteWorkspaceByKey } from "@/root/remote-workspace-history/reconnectPlanning.js";
import {
  openRemoteWorkspaceFromHistoryEntry,
  selectRemoteWorkspaceProjectFromDialog,
} from "@/root/remote-workspace-history/openRemoteWorkspace.js";
import { openRemoteConversationWorkspace } from "@/root/remote-workspace-history/conversationWorkspace.js";
import { restorePersistedRemoteWorkspaceSessions } from "@/root/remoteWorkspaceSessionPersistence.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ReconnectRemoteWorkspaceOptions } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";

type RemoteConnectionLogEntry =
  import("@/hooks/useRemoteConnectionLogs.js").RemoteConnectionLogEntry;

export interface UseRemoteWorkspaceRestoreParams {
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
    },
  ) => void;
  allowRemoteWorkspaceRestore: boolean;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<import("@/root/remote-workspace-history/types.js").BoundRemoteWorkspaceScope>;
  canUseRemoteWorkspace: boolean;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<
      typeof import("@/lib/remoteWorkspaceHistory.js").buildRemoteWorkspaceSessionMutation
    >,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
    feedback?: RemoteConnectionFeedbackOptions,
  ) => Promise<string>;
  deferInactiveWorkspaceRestore: boolean;
  ensureConversationWorkspaceOnRestore: boolean;
  handleCancelRemoteProject: (sessionId: string) => Promise<void>;
  inflightReconnectWorkspaceKeysRef: RefObject<Set<string>>;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  manuallyOpeningWorkspaceTabIdRef: RefObject<string | undefined>;
  onOpenRemoteConnection?: (preference?: RemoteConnectionOpenPreference) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
    projectId?: string | null;
  }) => void;
  pendingConnectionTargetsBySessionIdRef: RefObject<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >;
  pendingReconnectRequestIdsRef: RefObject<Map<string, string>>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  remoteWorkspaceSessionsRef: RefObject<RemoteWorkspaceSessionEntry[]>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  runReconnectRemoteWorkspace: (
    sessionEntry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  services: IServiceAccessor;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  setRemoteWorkspaceSessions: Dispatch<SetStateAction<RemoteWorkspaceSessionEntry[]>>;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
  unavailableWorkspacePath?: string;
  waitForRemoteWorkspaceSessionReady: (sessionId: string) => Promise<void>;
}

export function useRemoteWorkspaceRestore({
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
}: UseRemoteWorkspaceRestoreParams) {
  const restorePersistedSession = useCallback(
    async (settings: AppSettings) => {
      const persistedRemoteSessions = getRemoteWorkspaceSessionEntries(settings);
      setRemoteWorkspaceSessions(persistedRemoteSessions);
      remoteWorkspaceSessionsRef.current = persistedRemoteSessions;
      let conversationWorkspacePath: string | undefined;
      if (ensureConversationWorkspaceOnRestore) {
        try {
          conversationWorkspacePath = (await services.fileService.ensureConversationWorkspace())
            .path;
        } catch (error) {
          // 路径创建失败不能连带吞掉真实项目恢复；后续显式新建对话仍会走原有可重试错误入口。
          logger.warn("[Root] 恢复阶段解析 conversation workspace 失败", {
            error,
          });
        }
      }
      // R3 先把历史恢复为断连 tab；上方自动恢复 effect 只消费近 7 天、Source 已 online 的
      // remote:server stable history。legacy/过期历史仍保持手动入口，Web 普通模式则
      // 继续把 allowRemoteWorkspaceRestore 置为 false，不恢复 tab 或创建远端 runtime。
      const workspaceRestore = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        allowRemoteWorkspaceRestore,
        unavailableWorkspacePath,
        conversationWorkspacePath,
        remoteConversationWorkspaceBySourceServerId:
          settings.remoteConversationWorkspaceBySourceServerId,
        restoreMode: deferInactiveWorkspaceRestore ? "active-first" : "all",
      });
      return {
        ...(conversationWorkspacePath
          ? { excludedRecentProjectPaths: [conversationWorkspacePath] }
          : {}),
        ...(workspaceRestore?.deferredRestore
          ? { deferredRestore: workspaceRestore.deferredRestore }
          : {}),
      };
    },
    [
      allowRemoteWorkspaceRestore,
      deferInactiveWorkspaceRestore,
      ensureConversationWorkspaceOnRestore,
      services.fileService,
      tabStoreApi,
      unavailableWorkspacePath,
    ],
  );

  const selectRemoteProjectFromDialog = useCallback(
    async (
      sessionId: string,
      path: string,
      localWorkspacePath?: string,
      workspacePurpose: "project" | "conversation" = "project",
      draftProjectId?: string | null,
      preparedWorkspaceIdentity?: string,
      isCurrent?: () => boolean | Promise<boolean>,
    ) => {
      try {
        await selectRemoteWorkspaceProjectFromDialog({
          canUseRemoteWorkspace,
          isCurrent,
          sessionId,
          path,
          preparedWorkspaceIdentity,
          draftProjectId,
          localWorkspacePath,
          workspacePurpose,
          loadingMessage: intl.formatMessage({ id: "common.loading" }),
          getRemoteWorkspaceSession,
          connectionTarget: pendingConnectionTargetsBySessionIdRef.current.get(sessionId),
          getWorkspaceTabs: () => tabStoreApi.getState().tabs,
          restoringWorkspaceTabId: manuallyOpeningWorkspaceTabIdRef.current,
          resolveRemoteWorkspaceCanonicalPath,
          activateTabByPath,
          handleCancelRemoteProject,
          bindRemoteWorkspaceScope,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          addTab,
          // 原项目 ID 必须到达 Root 的草稿 owner，由它同步内存与持久化范围。
          onWorkspaceActivated:
            onWorkspaceActivated ??
            (draftProjectId === undefined
              ? undefined
              : ({ workspacePath, workspaceIdentity }) => {
                  useZCodeSessionStore
                    .getState()
                    .startDraft(workspacePath, undefined, workspaceIdentity, {
                      projectId: draftProjectId,
                    });
                }),
        });
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
      }
    },
    [
      activateTabByPath,
      addTab,
      tabStoreApi,
      commitRemoteWorkspaceSessionMutation,
      handleCancelRemoteProject,
      intl,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      canUseRemoteWorkspace,
    ],
  );

  const openRemoteConversation = useCallback(
    async (sessionId: string, sourceServerId?: string) =>
      await openRemoteConversationWorkspace({
        sessionId,
        sourceServerId,
        getRemoteWorkspaceSession,
        getSettings: services.settingService.get,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        waitForRemoteWorkspaceSessionReady,
        ensureConversationWorkspace: async (resolvedSourceServerId) => {
          const management = services.sourceServerManagementService;
          if (!management) {
            throw new Error("Remote conversation requires an identified Source Server");
          }
          return management.ensureConversationWorkspace(resolvedSourceServerId);
        },
        selectRemoteWorkspace: async (conversationSessionId, conversationPath, workspacePurpose) =>
          await selectRemoteProjectFromDialog(
            conversationSessionId,
            conversationPath,
            undefined,
            workspacePurpose,
          ),
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
      }),
    [
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      selectRemoteProjectFromDialog,
      // RPC getter 每次返回新函数；依赖服务身份，避免普通 Root 更新重建整条导航链。
      services.credentialService,
      services.settingService,
      services.sourceServerManagementService,
      waitForRemoteWorkspaceSessionReady,
    ],
  );
  const handleConnectRemote = useCallback(
    async (
      options: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
      feedback?: RemoteConnectionFeedbackOptions,
    ) => {
      if (!canUseRemoteWorkspace) {
        throw new Error("Remote workspace is disabled in this mode");
      }

      return connectRemoteWorkspaceTarget(options, requestId, context, feedback);
    },
    [canUseRemoteWorkspace, connectRemoteWorkspaceTarget],
  );

  const runReconnectRemoteWorkspaceByKey = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      const reconnect = async (nextOptions?: ReconnectRemoteWorkspaceOptions) => {
        await reconnectRemoteWorkspaceByKey({
          workspaceKey,
          canUseRemoteWorkspace,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          runReconnectRemoteWorkspace,
          options: { ...options, ...nextOptions },
        });
      };
      // 手机 RPC/自动恢复沿用既有返回与错误语义，不打开桌面向导。
      if (
        options?.throwOnFailure ||
        options?.recoveryMode === "automatic" ||
        !onOpenRemoteConnection
      ) {
        await reconnect(options);
        return;
      }
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) return;
      const tab = tabStoreApi
        .getState()
        .tabs.find(
          (candidate) =>
            isWorkspaceTab(candidate) && buildWorkspaceSessionKey(candidate) === workspaceKey,
        );
      const entry = remoteWorkspaceSessionsRef.current.find(
        (candidate) => buildWorkspaceSessionKey(candidate) === workspaceKey,
      );
      if (!tab || !isWorkspaceTab(tab) || !entry) {
        if (!services.remoteProjectService) throw new Error("remote-project.service-unavailable");
        inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
        try {
          await requestRetainedRemoteProjectConnection({
            workspaceKey,
            service: services.remoteProjectService,
            getSnapshot: services.sourceServerManagementService
              ? () => services.sourceServerManagementService!.getSnapshot()
              : undefined,
            openWizard: onOpenRemoteConnection,
          });
        } finally {
          inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        }
        return;
      }
      const snapshot = await services.sourceServerManagementService
        ?.getSnapshot()
        .catch(() => undefined);
      const isCurrent = () =>
        tabStoreApi.getState().tabs.some((candidate) => candidate.id === tab.id);
      if (!isCurrent()) return;
      const sourceId = getWorkspaceSourceServerId(tab, {
        workspaceHistory: snapshot?.workspaceHistory,
      });
      const device = sourceId ? getRemoteDevicePresentationInput(snapshot, sourceId) : undefined;
      const profile = snapshot?.profiles.find(
        (candidate) => candidate.profileId === device?.profileId,
      );
      const presentation = resolveRemoteConnectionPresentation({
        ...device,
        attached: false,
        projectError: entry.lastConnectionError,
      });
      await requestRemoteProjectConnection({
        preference: {
          preferredWorkspaceTabId: tab.id,
          preferredDirectoryPath: entry.workspacePath,
          preferredProfileId: profile?.profileId,
          preferredTarget: profile ? buildRemoteTargetFromProfile(profile) : tab.remoteTarget,
        },
        presentation,
        failure: {
          code: device?.errorCode,
          message: device?.error ?? entry.lastConnectionError ?? "",
          logs: reconnectingRemoteWorkspaceLogsByWorkspaceKey[workspaceKey] ?? [],
        },
        reconnect,
        openWizard: onOpenRemoteConnection,
        isCurrent,
      });
    },
    [
      canUseRemoteWorkspace,
      runReconnectRemoteWorkspace,
      onOpenRemoteConnection,
      tabStoreApi,
      services.sourceServerManagementService,
      services.remoteProjectService,
      reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    ],
  );

  const handleOpenRemoteWorkspaceFromHistory = useCallback(
    async (workspaceKey: string) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      // 远程历史入口与侧栏重连都可能命中“重连中被用户移除”的竞态。
      // 这里抽成统一入口，确保两条路径共享相同的并发保护、保留校验与错误处理语义。
      await openRemoteWorkspaceFromHistoryEntry({
        workspaceKey,
        tabStoreApi,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        inflightReconnectWorkspaceKeys: inflightReconnectWorkspaceKeysRef.current,
        activateTabByPath,
        setReconnectingRemoteWorkspaceKeys,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        resolveRemoteWorkspaceCanonicalPath,
        bindRemoteWorkspaceScope,
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
        addTab,
        commitRemoteWorkspaceSessionMutation,
        createReconnectRequestId: createUuid,
        pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
        resetLogsForWorkspaceKey,
        onWorkspaceActivated,
      });
    },
    [
      activateTabByPath,
      addTab,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      onWorkspaceActivated,
      services.credentialService,
      bindRemoteWorkspaceScope,
      tabStoreApi,
      canUseRemoteWorkspace,
    ],
  );

  return {
    restorePersistedSession,
    selectRemoteProjectFromDialog,
    openRemoteConversation,
    handleConnectRemote,
    runReconnectRemoteWorkspaceByKey,
    handleOpenRemoteWorkspaceFromHistory,
  };
}
