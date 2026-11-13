import { useCallback, useMemo } from "react";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { createRemoteWorkspaceController } from "@/remote/remoteWorkspaceController.js";
import type { RemoteWorkspaceController } from "@/remote/remoteWorkspaceController.js";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import {
  getRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import type { ReconnectRemoteWorkspaceOptions } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";

export interface UseRemoteWorkspaceControllerParams {
  handleRemoteWorkspaceTabsClosed: (workspaceKeys: string[]) => void;
  onOpenRemoteConnection?: (preference?: RemoteConnectionOpenPreference) => void;
  openRemoteConversation: (sessionId: string, sourceServerId?: string) => Promise<void>;
  remoteWorkspaceSessions: RemoteWorkspaceSessionEntry[];
  runReconnectRemoteWorkspaceByKey: (
    workspaceKey: string,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  selectRemoteProjectFromDialog: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    workspacePurpose?: "project" | "conversation",
    draftProjectId?: string | null,
    preparedWorkspaceIdentity?: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ) => Promise<void>;
  services: IServiceAccessor;
}

export function useRemoteWorkspaceController({
  handleRemoteWorkspaceTabsClosed,
  onOpenRemoteConnection,
  openRemoteConversation,
  remoteWorkspaceSessions,
  runReconnectRemoteWorkspaceByKey,
  selectRemoteProjectFromDialog,
  services,
}: UseRemoteWorkspaceControllerParams) {
  const remoteWorkspaceController = useMemo<RemoteWorkspaceController>(
    () =>
      createRemoteWorkspaceController({
        connectDevice: async (profileId, effect) => {
          if (!onOpenRemoteConnection) {
            throw new Error("Remote connection dialog is unavailable");
          }
          // 发起入口保留完成意图；凭据、安装、升级和错误仍由唯一向导承载。
          onOpenRemoteConnection({
            preferredProfileId: profileId,
            ...(effect === "device-management" ? { completion: effect } : {}),
          });
        },
        disconnectDevice: async (sourceServerId) => {
          const management = services.sourceServerManagementService;
          if (!management) {
            throw new Error("Source Server management is unavailable");
          }
          await management.disconnectSource(sourceServerId);
        },
        openConversation: async ({ sourceServerId, remoteSessionId }) => {
          const resolvedSessionId =
            remoteSessionId ??
            Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
              (session) => session.sourceServerId === sourceServerId,
            )?.sessionId;
          if (!resolvedSessionId) {
            throw new Error("Remote conversation intent requires an attached session");
          }
          await openRemoteConversation(resolvedSessionId, sourceServerId);
        },
        openProject: async ({
          sourceServerId,
          path,
          localWorkspacePath,
          remoteSessionId,
          draftProjectId,
          preparedWorkspaceIdentity,
          isCurrent,
        }) => {
          const sessions = Object.values(
            useRemoteWorkspaceSessionStore.getState().sessionsById,
          ).filter((session) =>
            remoteSessionId
              ? session.sessionId === remoteSessionId
              : sourceServerId
                ? session.sourceServerId === sourceServerId
                : !session.sourceServerId,
          );
          if (sessions.length !== 1) {
            throw new Error(
              `Remote project requires one attached session for Source Server: ${sourceServerId}`,
            );
          }
          await selectRemoteProjectFromDialog(
            sessions[0]!.sessionId,
            path,
            localWorkspacePath,
            "project",
            draftProjectId,
            preparedWorkspaceIdentity,
            isCurrent,
          );
        },
        reconnectWorkspace: async (workspaceKey, options) => {
          await runReconnectRemoteWorkspaceByKey(workspaceKey, options);
        },
        closeWorkspace: async (workspaceKey) => {
          handleRemoteWorkspaceTabsClosed([workspaceKey]);
        },
      }),
    [
      handleRemoteWorkspaceTabsClosed,
      onOpenRemoteConnection,
      openRemoteConversation,
      runReconnectRemoteWorkspaceByKey,
      selectRemoteProjectFromDialog,
      services.sourceServerManagementService,
    ],
  );

  const handleSelectRemoteProject = useCallback(
    async (
      sessionId: string,
      path: string,
      localWorkspacePath?: string,
      preparedWorkspaceIdentity?: string,
      isCurrent?: () => boolean | Promise<boolean>,
    ) => {
      const session = getRemoteWorkspaceSession(sessionId);
      await remoteWorkspaceController.dispatch({
        type: "open-project",
        isCurrent,
        sourceServerId: session?.sourceServerId ?? "",
        path,
        localWorkspacePath,
        remoteSessionId: sessionId,
        ...(preparedWorkspaceIdentity ? { preparedWorkspaceIdentity } : {}),
      });
    },
    [remoteWorkspaceController],
  );

  const handleOpenRemoteConversation = useCallback(
    async (sessionId: string, sourceServerId?: string) => {
      await remoteWorkspaceController.dispatch({
        type: "open-conversation",
        sourceServerId:
          sourceServerId ?? getRemoteWorkspaceSession(sessionId)?.sourceServerId ?? "",
        remoteSessionId: sessionId,
      });
    },
    [remoteWorkspaceController],
  );

  const handleReconnectRemoteWorkspace = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      await remoteWorkspaceController.dispatch({
        type: "reconnect-workspace",
        workspaceKey,
        options,
      });
    },
    [remoteWorkspaceController],
  );

  const remoteWorkspaceErrorByWorkspaceKey = useMemo(
    () =>
      Object.fromEntries(
        remoteWorkspaceSessions.flatMap((entry) =>
          entry.lastConnectionError?.trim()
            ? [[buildWorkspaceSessionKey(entry), entry.lastConnectionError] as const]
            : [],
        ),
      ),
    [remoteWorkspaceSessions],
  );

  return {
    remoteWorkspaceController,
    handleSelectRemoteProject,
    handleOpenRemoteConversation,
    handleReconnectRemoteWorkspace,
    remoteWorkspaceErrorByWorkspaceKey,
  };
}
