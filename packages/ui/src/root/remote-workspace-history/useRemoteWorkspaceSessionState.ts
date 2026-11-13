import { useCallback, useRef, useState } from "react";
import type { IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { RemoteWorkspaceRecoveryStatus } from "@/app-shell/types.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import type { WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import {
  buildRemoteWorkspaceSessionMutation,
  buildWorkspaceSessionKey,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { buildRemoteWorkspacePersistPatch } from "@/root/remoteWorkspaceSessionPersistence.js";
import { useReconnectingRemoteWorkspaceLogs } from "@/root/useReconnectingRemoteWorkspaceLogs.js";
import type { RemoteWorkspaceReconnectRendererState } from "@/root/remote-workspace-history/types.js";

export interface UseRemoteWorkspaceSessionStateParams {
  allowRemoteWorkspace: boolean;
  manuallyOpeningWorkspaceTabId?: string;
  persistenceGate?: WorkspacePersistenceGate;
  platform: IPlatformService;
  services: IServiceAccessor;
  supportsSettings: boolean;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
}

export function useRemoteWorkspaceSessionState({
  allowRemoteWorkspace,
  manuallyOpeningWorkspaceTabId,
  persistenceGate,
  platform,
  services,
  supportsSettings,
  tabStoreApi,
}: UseRemoteWorkspaceSessionStateParams) {
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const allowRemoteWorkspaceRestore = canUseRemoteWorkspace;
  const [remoteWorkspaceSessions, setRemoteWorkspaceSessions] = useState<
    RemoteWorkspaceSessionEntry[]
  >([]);
  const remoteWorkspaceSessionsRef = useRef<RemoteWorkspaceSessionEntry[]>([]);
  const manuallyOpeningWorkspaceTabIdRef = useRef(manuallyOpeningWorkspaceTabId);
  manuallyOpeningWorkspaceTabIdRef.current = manuallyOpeningWorkspaceTabId;
  const pendingCredentialDeletesRef = useRef<Set<string>>(new Set());
  const flushPendingCredentialDeletes = useCallback(async () => {
    const credentialKeys = [...pendingCredentialDeletesRef.current];
    pendingCredentialDeletesRef.current.clear();
    await Promise.all(
      credentialKeys.map(async (credentialKey) => {
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] 延迟删除远程 workspace 凭据失败", {
            credentialKey,
            error,
          });
        }
      }),
    );
  }, [services.credentialService]);
  if (persistenceGate) {
    persistenceGate.onCanPersist = flushPendingCredentialDeletes;
  }
  const [reconnectingRemoteWorkspaceKeys, setReconnectingRemoteWorkspaceKeys] = useState<string[]>(
    [],
  );
  const [remoteWorkspaceRecoveryByWorkspaceKey, setRemoteWorkspaceRecoveryByWorkspaceKey] =
    useState<Record<string, RemoteWorkspaceRecoveryStatus>>({});
  const inflightReconnectWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const pendingReconnectRequestIdsRef = useRef<Map<string, string>>(new Map());
  const pendingConnectionTargetsBySessionIdRef = useRef<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >(new Map());
  // R3 只允许每个 stable workspace 在本次 Renderer 生命周期尝试一次；同时复用旧 ref hook slot，
  // 避免 Fast Refresh 把后续 useState 落到历史 useRef 位置。不能按 Source 去重，否则 active-first
  // 首帧只恢复一个 tab 时，会永久漏掉稍后进入 TabStore 的同 Source sibling。
  const remoteStartupReconnectRefreshCompatibilityRef = useRef<
    Set<string> | RemoteWorkspaceReconnectRendererState
  >(new Set());
  const remoteWorkspaceReconnectRendererState =
    remoteStartupReconnectRefreshCompatibilityRef.current instanceof Set
      ? {
          attemptedWorkspaceKeys: remoteStartupReconnectRefreshCompatibilityRef.current,
          currentRendererDisconnectedSourceServerIds: new Set<string>(),
          pendingTerminallyDisconnectedSourceServerIds: new Set<string>(),
          observedOnlineSourceServerIds: new Set<string>(),
        }
      : remoteStartupReconnectRefreshCompatibilityRef.current;
  // 复用历史 ref hook slot，避免新增 useRef 破坏 Fast Refresh 的 Hook 顺序；扩展出的状态
  // 只属于当前 Renderer 生命周期，不会把 failed history 持久化成自动恢复资格。
  remoteStartupReconnectRefreshCompatibilityRef.current = remoteWorkspaceReconnectRendererState;
  const {
    logsByWorkspaceKey: reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  } = useReconnectingRemoteWorkspaceLogs({
    platform,
    reconnectingWorkspaceKeys: reconnectingRemoteWorkspaceKeys,
    resolveWorkspaceTargetByKey: (workspaceKey) =>
      remoteWorkspaceSessionsRef.current.find(
        (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
      )?.target ?? null,
    resolveWorkspaceRequestIdByKey: (workspaceKey) =>
      pendingReconnectRequestIdsRef.current.get(workspaceKey) ?? null,
  });

  const syncPersistedWorkspaceSession = useCallback(
    async (nextRemoteSessions: readonly RemoteWorkspaceSessionEntry[]) => {
      setRemoteWorkspaceSessions([...nextRemoteSessions]);
      remoteWorkspaceSessionsRef.current = [...nextRemoteSessions];

      if (!supportsSettings) {
        return;
      }
      if (persistenceGate && !persistenceGate.canPersist) {
        return;
      }

      await services.settingService.update(
        buildRemoteWorkspacePersistPatch(tabStoreApi.getState(), nextRemoteSessions),
      );
    },
    [persistenceGate, services.settingService, supportsSettings, tabStoreApi],
  );

  const commitRemoteWorkspaceSessionMutation = useCallback(
    async (mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>) => {
      for (const credentialKey of mutation.credentialKeysToDelete) {
        if (persistenceGate && !persistenceGate.canPersist) {
          pendingCredentialDeletesRef.current.add(credentialKey);
          continue;
        }
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] 删除远程 workspace 凭据失败", {
            credentialKey,
            error,
          });
        }
      }

      for (const credential of mutation.credentialsToSave) {
        await services.credentialService.save(credential.key, credential.value);
      }

      await syncPersistedWorkspaceSession(mutation.nextRemoteSessions);
      return mutation.entry;
    },
    [persistenceGate, services.credentialService, syncPersistedWorkspaceSession],
  );

  return {
    canUseRemoteWorkspace,
    allowRemoteWorkspaceRestore,
    remoteWorkspaceSessions,
    setRemoteWorkspaceSessions,
    remoteWorkspaceSessionsRef,
    manuallyOpeningWorkspaceTabIdRef,
    pendingCredentialDeletesRef,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    setReconnectingRemoteWorkspaceKeys,
    setRemoteWorkspaceRecoveryByWorkspaceKey,
    inflightReconnectWorkspaceKeysRef,
    pendingReconnectRequestIdsRef,
    pendingConnectionTargetsBySessionIdRef,
    remoteWorkspaceReconnectRendererState,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    resetLogsForWorkspaceKey,
    syncPersistedWorkspaceSession,
    commitRemoteWorkspaceSessionMutation,
  };
}
