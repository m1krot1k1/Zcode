import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { IPlatformService, RemoteTarget, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { createUuid } from "@zcode/shared";
import type { IServiceAccessor } from "../contract.ts";
import type {
  RemoteConnectionFeedbackOptions,
  RemoteWorkspaceRecoveryStatus,
} from "@/app-shell/types.js";
import { toast } from "@/components/ui/toast.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  formatRemoteConnectionDescription,
  formatRemoteConnectionError,
} from "@/lib/remoteConnectionPresentation.js";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { reconnectRemoteWorkspaceHistoryEntry } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import type { ReconnectRemoteWorkspaceOptions } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import {
  bindRemoteWorkspaceContextAndGetSession,
  collectSshReconnectGroup,
  shouldKeepRemoteWorkspaceInTabs,
} from "@/root/remote-workspace-history/reconnectPlanning.js";
import { reconnectRemoteWorkspaceGroup } from "@/root/remote-workspace-history/reconnectExecution.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  clearRemoteWorkspaceConnectionState,
  getRemoteWorkspaceSession,
  setRemoteWorkspaceConnectionState,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab, type TabStoreState } from "@/store/tabStore.js";
import { buildRemoteWorkspacePersistPatch } from "@/root/remoteWorkspaceSessionPersistence.js";

export interface UseRemoteWorkspaceConnectionParams {
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<
      typeof import("@/lib/remoteWorkspaceHistory.js").buildRemoteWorkspaceSessionMutation
    >,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  inflightReconnectWorkspaceKeysRef: RefObject<Set<string>>;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  isDesktop: boolean;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
  }) => void;
  pendingConnectionTargetsBySessionIdRef: RefObject<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >;
  pendingReconnectRequestIdsRef: RefObject<Map<string, string>>;
  platform: IPlatformService;
  remoteWorkspaceSessionsRef: RefObject<RemoteWorkspaceSessionEntry[]>;
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  services: IServiceAccessor;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  setRemoteWorkspaceRecoveryByWorkspaceKey: Dispatch<
    SetStateAction<Record<string, RemoteWorkspaceRecoveryStatus>>
  >;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
}

export function useRemoteWorkspaceConnection({
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
}: UseRemoteWorkspaceConnectionParams) {
  const waitForRemoteWorkspaceSessionReady = useCallback(async (sessionId: string) => {
    if (getRemoteWorkspaceSession(sessionId)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const pollTimer = window.setInterval(() => {
        if (getRemoteWorkspaceSession(sessionId)) {
          window.clearInterval(pollTimer);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= 3000) {
          window.clearInterval(pollTimer);
          reject(new Error(`等待远程 workspace session 就绪超时: ${sessionId}`));
        }
      }, 50);
    });
  }, []);

  const connectRemoteWorkspaceTarget = useCallback(
    async (
      target: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
      feedback?: RemoteConnectionFeedbackOptions,
    ) => {
      const result = await platform.connectRemote(target, requestId, context);
      if (!result.success) {
        const error = new Error(getErrorMessage(result.error || "Connection failed")) as Error & {
          code?: string;
          retryable?: boolean;
          profileId?: string;
          resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
        };
        if (result.reasonCode) error.code = result.reasonCode;
        if (result.retryable !== undefined) error.retryable = result.retryable;
        if (result.profileId) error.profileId = result.profileId;
        if (result.resolvedWslTarget) error.resolvedWslTarget = result.resolvedWslTarget;
        throw error;
      }

      if (!result.sessionId) {
        throw new Error("Remote session was not created");
      }

      // 远程连接成功只代表 main/host 已经建好 session，
      // renderer 侧的 MessagePort 仍然可能在下一拍才注册进 zustand store。
      // 如果此时立刻 addTab，会短暂走到本地 services，导致首屏读目录/预热 ZCode Agent 命中错误服务。
      // 这里等 session 真正挂进 store 再继续。
      await waitForRemoteWorkspaceSessionReady(result.sessionId);
      if (!context) {
        // 共享 Host 只向 renderer store 回传脱敏 target；完整凭据只在选目录流程完成前临时保留。
        // Host 复用时本次密码从未参与认证；选目录也只能持久化实际连接的脱敏目标。
        pendingConnectionTargetsBySessionIdRef.current.set(
          result.sessionId,
          result.reusedConnectionTarget ?? target,
        );
      }
      if (result.reusedConnectionTarget && feedback?.announceReusedConnection) {
        toast(
          intl.formatMessage(
            { id: "remote.reusedConnection" },
            { connection: formatRemoteConnectionDescription(result.reusedConnectionTarget) },
          ),
          { variant: "info", durationMs: 8000 },
        );
      }
      return result.sessionId;
    },
    [intl, platform, waitForRemoteWorkspaceSessionReady],
  );

  const resolveRemoteWorkspaceCanonicalPath = useCallback(
    async (sessionId: string, workspacePath: string): Promise<string> => {
      const remoteSession = getRemoteWorkspaceSession(sessionId);
      if (!remoteSession) {
        return workspacePath;
      }

      try {
        // 同一目录可能通过符号链接别名输入（例如 /dev 与 /home/dev），
        // 之前直接持久化用户输入会把同一 workspace 识别成两个身份。
        // 这里在远端 host 上做一次 realpath 归一化，再参与 identity 计算与持久化。
        return await remoteSession.services.fileService.resolvePath({
          path: workspacePath,
        });
      } catch {
        return workspacePath;
      }
    },
    [],
  );

  const buildPersistedTabPatch = useCallback(
    (state: TabStoreState) =>
      buildRemoteWorkspacePersistPatch(state, remoteWorkspaceSessionsRef.current),
    [],
  );

  const handleCancelRemoteProject = useCallback(
    async (sessionId: string) => {
      try {
        await platform.disposeRemoteSession(sessionId);
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
        // 远程目录选择如果在确认前就取消，session 释放失败也不能把前端状态卡在“仍有一个待选远程 session”。
        // 这里始终清掉本地映射，避免下次再次打开弹窗时复用到一条已经失效的 session 记录。
        unregisterRemoteWorkspaceSession(sessionId);
      }
    },
    [platform],
  );

  const bindRemoteWorkspaceScope = useCallback(
    async (
      sessionId: string,
      workspacePath: string,
      workspaceIdentity?: string,
      workspacePurpose?: "project" | "conversation",
    ) => {
      try {
        const remoteSession = await bindRemoteWorkspaceContextAndGetSession({
          platform,
          sessionId,
          workspacePath,
          workspaceIdentity,
          workspacePurpose,
        });
        const boundWorkspacePath = remoteSession.workspacePath ?? workspacePath;
        const boundWorkspaceIdentity = remoteSession.workspaceIdentity;
        if (!boundWorkspaceIdentity) {
          throw new Error(`远程 workspace bind 缺少 stable identity: ${sessionId}`);
        }
        return {
          workspacePath: boundWorkspacePath,
          workspaceIdentity: boundWorkspaceIdentity,
          ...(remoteSession.workspacePurpose
            ? { workspacePurpose: remoteSession.workspacePurpose }
            : workspacePurpose
              ? { workspacePurpose }
              : {}),
          ...(isDesktop && remoteSession.previousWorkspaceIdentity
            ? {
                previousWorkspaceIdentity: remoteSession.previousWorkspaceIdentity,
              }
            : {}),
        };
      } catch (error) {
        // Bug 原因：Host bind 失败意味着 attachment 没有换代、也拿不到 remote:server:* 权威 identity，
        // 继续打开 tab 会让 Renderer 用半绑定的 session 与 Host 的 workspace scope 分裂。
        // 这里失败即回收 session，确保“打开 remote tab = Host 已完成 workspace bind”。
        await handleCancelRemoteProject(sessionId);
        throw error;
      }
    },
    [handleCancelRemoteProject, isDesktop, platform],
  );

  const runReconnectRemoteWorkspaceEntry = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ): Promise<boolean> => {
      const workspaceKey = buildWorkspaceSessionKey(sessionEntry);
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) {
        return false;
      }
      const workspaceTab = tabStoreApi
        .getState()
        .tabs.find(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
        );
      if (!workspaceTab || workspaceTab.remoteSessionId) {
        return false;
      }

      resetLogsForWorkspaceKey(workspaceKey);
      inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
      const requestId = createUuid();
      const recoveryMode = options?.recoveryMode ?? "manual";
      pendingReconnectRequestIdsRef.current.set(workspaceKey, requestId);
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => ({
        ...current,
        [workspaceKey]: { mode: recoveryMode },
      }));
      setRemoteWorkspaceConnectionState(workspaceKey, "reconnecting");
      let reconnected = false;
      try {
        // 重连期间只静默回填 ready 的 remoteSessionId；激活统一由 reconnect helper
        // 在回填之后执行，避免 active tab 暴露 remote-waiting 中间态。
        const upsertWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
        logger.debug("[Root] 远程 workspace 重连中，保留当前 conversation", {
          workspaceKey,
        });
        await reconnectRemoteWorkspaceHistoryEntry({
          sessionEntry,
          activateTabByPath,
          setReconnectingRemoteWorkspaceKeys,
          loadCredential: services.credentialService.load,
          getSettings: services.settingService.get,
          connectRemoteWorkspaceTarget,
          resolveRemoteWorkspaceCanonicalPath,
          bindRemoteWorkspaceScope,
          disposeRemoteWorkspaceSession: handleCancelRemoteProject,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          upsertWorkspaceTab,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          logger,
          toast,
          shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
            shouldKeepRemoteWorkspaceInTabs({
              tabStoreApi,
              workspacePath,
              workspaceIdentity,
            }),
          onWorkspaceActivated: (target) => {
            logger.debug("[Root] 远程 workspace ready，提交 tab 与 draft 激活", target);
            onWorkspaceActivated?.(target);
          },
          formatError: (error) => {
            const normalized = error as Error & {
              code?: string;
              retryable?: boolean;
              recoveryAttempt?: number;
              recoveryLimit?: number;
            };
            return formatRemoteConnectionError({
              fallback: getErrorMessage(error),
              reasonCode: normalized.code,
              retryable: normalized.retryable,
              recoveryAttempt: normalized.recoveryAttempt,
              recoveryLimit: normalized.recoveryLimit,
              formatMessage: intl.formatMessage,
            });
          },
          options: {
            ...options,
            requestId,
          },
        });
        reconnected = true;
        clearRemoteWorkspaceConnectionState(workspaceKey);
        return true;
      } finally {
        if (!reconnected) {
          setRemoteWorkspaceConnectionState(workspaceKey, "disconnected");
        }
        inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        if (pendingReconnectRequestIdsRef.current.get(workspaceKey) === requestId) {
          pendingReconnectRequestIdsRef.current.delete(workspaceKey);
        }
        setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
          if (current[workspaceKey]?.mode !== recoveryMode) return current;
          const next = { ...current };
          delete next[workspaceKey];
          return next;
        });
      }
    },
    [
      activateTabByPath,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      services.credentialService,
      services.settingService,
      bindRemoteWorkspaceScope,
      tabStoreApi,
      intl,
    ],
  );

  const runReconnectRemoteWorkspace = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ) => {
      const reconnectGroup = collectSshReconnectGroup({
        selected: sessionEntry,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
      });
      await reconnectRemoteWorkspaceGroup({
        selected: sessionEntry,
        reconnectGroup,
        reconnectEntry: runReconnectRemoteWorkspaceEntry,
        options,
      });
    },
    [runReconnectRemoteWorkspaceEntry, tabStoreApi],
  );

  return {
    waitForRemoteWorkspaceSessionReady,
    connectRemoteWorkspaceTarget,
    resolveRemoteWorkspaceCanonicalPath,
    buildPersistedTabPatch,
    handleCancelRemoteProject,
    bindRemoteWorkspaceScope,
    runReconnectRemoteWorkspaceEntry,
    runReconnectRemoteWorkspace,
  };
}
