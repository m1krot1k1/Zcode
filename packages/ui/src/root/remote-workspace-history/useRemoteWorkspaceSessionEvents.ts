import { useCallback, useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { IServiceAccessor } from "../contract.ts";
import type { RemoteSessionClosedEvent, RemoteSessionReconnectedEvent } from "@zcode/shared";
import type { RemoteWorkspaceRecoveryStatus } from "@/app-shell/types.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import {
  buildRemoteWorkspaceSessionMutation,
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
  removeRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import type { WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import { cancelPendingRemoteReconnectsForWorkspaceKeys } from "@/root/remote-workspace-history/reconnectExecution.js";
import {
  isRemoteWorkspaceCloseFailure,
  resolveRemoteWorkspaceClosedFallback,
  shouldPersistRemoteWorkspaceFailure,
  updateRemoteWorkspaceRecoveringKeys,
} from "@/root/remote-workspace-history/reconnectPlanning.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  clearRemoteWorkspaceConnectionState,
  setRemoteWorkspaceConnectionState,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { RemoteWorkspaceReconnectRendererState } from "@/root/remote-workspace-history/types.js";

export interface UseRemoteWorkspaceSessionEventsParams {
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<
      typeof import("@/lib/remoteWorkspaceHistory.js").buildRemoteWorkspaceSessionMutation
    >,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  pendingCredentialDeletesRef: RefObject<Set<string>>;
  pendingReconnectRequestIdsRef: RefObject<Map<string, string>>;
  persistenceGate?: WorkspacePersistenceGate;
  platform: IPlatformService;
  remoteWorkspaceReconnectRendererState: RemoteWorkspaceReconnectRendererState;
  remoteWorkspaceSessionsRef: RefObject<RemoteWorkspaceSessionEntry[]>;
  services: IServiceAccessor;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  setRemoteWorkspaceRecoveryByWorkspaceKey: Dispatch<
    SetStateAction<Record<string, RemoteWorkspaceRecoveryStatus>>
  >;
  syncPersistedWorkspaceSession: (
    nextRemoteSessions: readonly RemoteWorkspaceSessionEntry[],
  ) => Promise<void>;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
}

export function useRemoteWorkspaceSessionEvents({
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
}: UseRemoteWorkspaceSessionEventsParams) {
  const handleRemoteWorkspaceSessionClosed = useCallback(
    async (event: RemoteSessionClosedEvent) => {
      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && tab.remoteSessionId === sessionId,
        );
      if (matchedTabs.length === 0) {
        unregisterRemoteWorkspaceSession(sessionId);
        return;
      }

      if (event.recoverable === true) {
        // Bug 原因：transient Source close 在 Main 转发时丢失 recoverable，Renderer 会立即
        // 清 remoteSessionId、标记运行任务失败并写 failed history；几秒后重连却无法回滚这些
        // 终态副作用。恢复预算内只释放失效 services，tab/session id 留给换代事件匹配。
        unregisterRemoteWorkspaceSession(sessionId);
        for (const tab of matchedTabs) {
          setRemoteWorkspaceConnectionState(buildWorkspaceSessionKey(tab), "reconnecting");
        }
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, true),
        );
        setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
          const next = { ...current };
          for (const tab of matchedTabs) {
            next[buildWorkspaceSessionKey(tab)] = {
              mode: "automatic",
              ...(event.recoveryAttempt ? { attempt: event.recoveryAttempt } : {}),
              ...(event.recoveryLimit ? { limit: event.recoveryLimit } : {}),
            };
          }
          return next;
        });
        logger.info("[Root] 远程 workspace session 进入可恢复断连状态", {
          sessionId,
        });
        return;
      }

      setReconnectingRemoteWorkspaceKeys((currentKeys) =>
        updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, false),
      );
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
        const next = { ...current };
        for (const tab of matchedTabs) delete next[buildWorkspaceSessionKey(tab)];
        return next;
      });

      // Bug 根因：terminal close 可能先于 Source offline 到达；旧 online 快照不能立即撤销断开。
      // 先等待权威 Source 离开 online，下一次 online 才允许重置该 Source 的尝试记录并恢复。
      for (const tab of matchedTabs) {
        const identity = tab.workspaceIdentity
          ? parseRemoteWorkspaceIdentity(tab.workspaceIdentity)
          : null;
        if (identity?.kind === "server" && identity.sourceServerId) {
          if (
            remoteWorkspaceReconnectRendererState.observedOnlineSourceServerIds.has(
              identity.sourceServerId,
            )
          ) {
            remoteWorkspaceReconnectRendererState.pendingTerminallyDisconnectedSourceServerIds.add(
              identity.sourceServerId,
            );
          } else {
            remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds.add(
              identity.sourceServerId,
            );
          }
        }
      }

      // Bugfix: 远端 host 退出后，tab 上的 remoteSessionId 之前不会被清空。
      // UI 因此持续显示“已连接”，并继续把请求路由到失效 session。
      // 这里在收到 main 进程的 session-close 事件时立即降级为断连态，后续只走用户手动重连。
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) && tab.remoteSessionId === sessionId
            ? { ...tab, remoteSessionId: undefined }
            : tab,
        ),
      }));
      unregisterRemoteWorkspaceSession(sessionId);

      const matchedWorkspaceKeys = [
        ...new Set(matchedTabs.map((tab) => buildWorkspaceSessionKey(tab))),
      ];
      const reason = formatRemoteConnectionError({
        fallback: resolveRemoteWorkspaceClosedFallback({
          event,
          formatMessage: intl.formatMessage,
          defaultFallback: [
            intl.formatMessage({ id: "remote.error.connectionClosed" }),
            event.exitCode != null ? `exitCode=${event.exitCode}` : null,
            event.signal ? `signal=${event.signal}` : null,
          ]
            .filter(Boolean)
            .join(" "),
        }),
        reasonCode: event.reasonCode,
        retryable: event.retryable,
        recoveryAttempt: event.recoveryAttempt,
        recoveryLimit: event.recoveryLimit,
        formatMessage: intl.formatMessage,
      });
      for (const workspaceKey of matchedWorkspaceKeys) {
        // 连接事实与远端 task terminal 状态分离：断连只更新 renderer overlay，
        // 不能把远端仍可能运行的 task 写成本地 failed。
        setRemoteWorkspaceConnectionState(workspaceKey, "disconnected");
      }

      logger.warn("[Root] 远程 workspace session 已关闭", {
        sessionId,
        reason: event.reason,
        exitCode: event.exitCode,
        signal: event.signal,
        matchedWorkspaceKeys,
      });

      for (const workspaceKey of matchedWorkspaceKeys) {
        const sessionEntry = remoteWorkspaceSessionsRef.current.find(
          (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
        );
        if (!sessionEntry) {
          continue;
        }

        const pendingReconnectRequestId = pendingReconnectRequestIdsRef.current.get(workspaceKey);
        if (
          !shouldPersistRemoteWorkspaceFailure({
            pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
            sessionEntry,
            workspaceKey,
          })
        ) {
          logger.info("[Root] WSL workspace session 关闭时跳过失败落盘，等待重连结果", {
            pendingReconnectRequestId,
            sessionId,
            workspaceIdentity: sessionEntry.workspaceIdentity ?? null,
            workspacePath: sessionEntry.workspacePath,
            workspaceKey,
          });
          continue;
        }

        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: sessionEntry.workspacePath,
            workspaceIdentity: sessionEntry.workspaceIdentity,
            target: createRemoteTargetFromSnapshot(sessionEntry.target, {
              password: null,
              privateKeyPassphrase: null,
            }),
            lastConnectionStatus: "failed",
            lastConnectionError: isRemoteWorkspaceCloseFailure(event) ? reason : "",
            touchOpenedAt: false,
          }),
        );
      }
    },
    [commitRemoteWorkspaceSessionMutation, intl, tabStoreApi],
  );

  const handleRemoteWorkspaceSessionReconnected = useCallback(
    (event: RemoteSessionReconnectedEvent) => {
      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) &&
            tab.workspacePath === event.workspacePath &&
            tab.workspaceIdentity === event.workspaceIdentity &&
            (!tab.remoteSessionId || tab.remoteSessionId === event.previousSessionId),
        );
      if (matchedTabs.length === 0) return;
      setReconnectingRemoteWorkspaceKeys((currentKeys) =>
        updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, false),
      );
      for (const tab of matchedTabs) {
        clearRemoteWorkspaceConnectionState(buildWorkspaceSessionKey(tab));
      }
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
        const next = { ...current };
        for (const tab of matchedTabs) delete next[buildWorkspaceSessionKey(tab)];
        return next;
      });
      unregisterRemoteWorkspaceSession(event.previousSessionId);
      bindRemoteWorkspacePath(event.workspacePath, event.sessionId);
      bindRemoteWorkspaceIdentity(event.workspaceIdentity, event.sessionId);
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) &&
          tab.workspacePath === event.workspacePath &&
          tab.workspaceIdentity === event.workspaceIdentity &&
          (!tab.remoteSessionId || tab.remoteSessionId === event.previousSessionId)
            ? { ...tab, remoteSessionId: event.sessionId }
            : tab,
        ),
      }));
    },
    [tabStoreApi],
  );

  useEffect(() => {
    return platform.onRemoteSessionClosed((event) => {
      void handleRemoteWorkspaceSessionClosed(event);
    });
  }, [handleRemoteWorkspaceSessionClosed, platform]);

  useEffect(() => {
    return (
      platform.onRemoteSessionReconnected?.((event) => {
        handleRemoteWorkspaceSessionReconnected(event);
      }) ?? (() => {})
    );
  }, [handleRemoteWorkspaceSessionReconnected, platform]);

  const handleRemoteWorkspaceTabsClosed = useCallback(
    (workspaceKeys: string[]) => {
      if (workspaceKeys.length === 0) {
        return;
      }

      const workspaceKeySet = new Set(workspaceKeys);
      for (const workspaceKey of workspaceKeys) {
        clearRemoteWorkspaceConnectionState(workspaceKey);
      }

      void (async () => {
        // 关闭断连态 remote tab 时，tab 上还没有 remoteSessionId，但 main 进程可能已经在上传 remote runtime。
        // 这里用重连 requestId 精准取消 pending host，避免 UI 已移除而后台 upload 继续跑。
        await cancelPendingRemoteReconnectsForWorkspaceKeys({
          workspaceKeys,
          pendingRequestIds: pendingReconnectRequestIdsRef.current,
          cancelPendingRemoteConnection: platform.cancelPendingRemoteConnection
            ? (requestId) =>
                platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve()
            : undefined,
          logger,
        });
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          currentKeys.filter((key) => !workspaceKeySet.has(key)),
        );

        const removal = removeRemoteWorkspaceSessionEntries(
          remoteWorkspaceSessionsRef.current,
          workspaceKeys,
        );
        if (
          removal.nextRemoteSessions.length === remoteWorkspaceSessionsRef.current.length &&
          removal.credentialKeysToDelete.length === 0
        ) {
          return;
        }

        // 用户在侧栏“移除”远程 workspace 后，只删 tab 不够：
        // remoteWorkspaceSessionsRef 仍被持久化补丁合并回 setting.json，
        // 所以下次启动又会恢复同一个断连项。这里把显式移除视为删除远程历史，
        // 同时清理该历史独占的 SSH 凭据，避免留下不可达的 credential key。
        await syncPersistedWorkspaceSession(removal.nextRemoteSessions);
        for (const credentialKey of removal.credentialKeysToDelete) {
          if (persistenceGate && !persistenceGate.canPersist) {
            pendingCredentialDeletesRef.current.add(credentialKey);
            continue;
          }
          try {
            await services.credentialService.delete(credentialKey);
          } catch (error) {
            logger.warn("[Root] 删除已移除远程 workspace 凭据失败", {
              credentialKey,
              error,
            });
          }
        }
      })();
    },
    [persistenceGate, platform, services.credentialService, syncPersistedWorkspaceSession],
  );

  return { handleRemoteWorkspaceTabsClosed };
}
