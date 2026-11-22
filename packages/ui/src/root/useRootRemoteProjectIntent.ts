import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import type { IServiceAccessor, RemoteProjectHost } from "./contract.ts";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { resolveEntryProject } from "@/project-sidebar/index.js";
import type { DeviceAdditionReturnRef } from "@/root/useRootDeviceAdditionReturn.js";
import type { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

/**
 * 远程项目选择意图。
 *
 * 选目录只进入项目编辑，保存与入口登记完成之前不打开会话；epoch 负责让关闭弹窗、
 * 改选连接后迟到的成员资格校验失效。
 */
export function useRootRemoteProjectIntent({
  services,
  remoteConnectionOpenPreference,
  remoteWorkspaceController,
  deviceAdditionReturn,
  setRemoteConnectionDialogOpen,
  setRemoteConnectionOpenPreference,
}: {
  services: IServiceAccessor;
  remoteConnectionOpenPreference: RemoteConnectionOpenPreference | null;
  remoteWorkspaceController: ReturnType<
    typeof useRemoteWorkspaceHistory
  >["remoteWorkspaceController"];
  deviceAdditionReturn: DeviceAdditionReturnRef;
  setRemoteConnectionDialogOpen: Dispatch<SetStateAction<boolean>>;
  setRemoteConnectionOpenPreference: Dispatch<
    SetStateAction<RemoteConnectionOpenPreference | null>
  >;
}) {
  const remoteProjectIntentEpoch = useRef(0);
  const [remoteProjectSelection, setRemoteProjectSelection] = useState<{
    host: RemoteProjectHost;
    path: string;
    sessionId: string;
  } | null>(null);
  const selectDirectoryForRemoteProject = useCallback(
    async (sessionId: string, path: string, localWorkspacePath?: string) => {
      const epoch = remoteProjectIntentEpoch.current;
      const session = useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId];
      if (!session?.target || !services.remoteProjectService)
        throw new Error("project.connection-unavailable");
      const identity = session.sourceServerId
        ? buildServerRemoteWorkspaceIdentity({
            serverId: session.sourceServerId,
            workspacePath: path,
          })
        : buildRemoteWorkspaceIdentity(path, session.target);
      const hostId = remoteHostIdFromWorkspaceIdentity(identity);
      const directory = await services.remoteProjectService.readDirectory();
      if (epoch !== remoteProjectIntentEpoch.current) throw new Error("project.creation-cancelled");
      const host = directory.hosts.find((item) => item.id === hostId);
      if (!host) throw new Error("remote-project.host-removed");
      if (
        remoteConnectionOpenPreference?.preferredWorkspaceTabId ||
        remoteConnectionOpenPreference?.preferredProjectEntryId
      ) {
        // 原项目的认证/安装/升级完成应回到原目录，不能误入新建项目编辑。
        const retained = directory.entries.find(
          (entry) =>
            entry.hostId === host.id &&
            (!remoteConnectionOpenPreference.preferredProjectEntryId ||
              entry.id === remoteConnectionOpenPreference.preferredProjectEntryId) &&
            (entry.roots.some((root) => root.rootPath === path) ||
              entry.legacyWorkspace?.workspacePath === path),
        );
        if (!retained)
          throw Object.assign(new Error("remote-project.entry-not-found"), {
            code: "remote-connection-canceled",
          });
        let draftProjectId: string | undefined;
        // 会话重连只恢复原选择；打开项目才解析草稿归属，避免阻止已删除项目的历史会话重连。
        if (!remoteConnectionOpenPreference.preferredWorkspaceTabId) {
          if (!services.projectService) throw new Error("project.service-unavailable");
          // 入口 ID 只校验成员，不会初始化草稿归属；不能沿用本地同目录旧缓存。
          const project = resolveEntryProject(
            retained,
            await services.projectService.readTree({ hostId: host.id }),
          );
          if (!project || project.deleted || !project.roots.some((root) => root.rootPath === path))
            throw new Error("project.not-found");
          draftProjectId = project.id;
        }
        await remoteWorkspaceController.dispatch({
          type: "open-project",
          sourceServerId: session.sourceServerId ?? "",
          remoteSessionId: sessionId,
          path,
          localWorkspacePath,
          preparedWorkspaceIdentity: identity,
          draftProjectId,
          isCurrent: async () => {
            if (epoch !== remoteProjectIntentEpoch.current) return false;
            // bind 会等待远端 IO；初检快照不能授权迟到结果复活已移除/换代的成员。
            const current = await services.remoteProjectService!.readDirectory();
            return (
              epoch === remoteProjectIntentEpoch.current &&
              current.hosts.some(
                (item) => item.id === host.id && item.membershipId === host.membershipId,
              ) &&
              current.entries.some(
                (entry) =>
                  entry.id === retained.id &&
                  entry.hostId === host.id &&
                  (entry.roots.some((root) => root.rootPath === path) ||
                    entry.legacyWorkspace?.workspacePath === path),
              )
            );
          },
        });
        return;
      }
      // 选目录只进入项目编辑，保存与入口登记完成之前不打开会话。
      setRemoteProjectSelection({ host, path, sessionId });
    },
    [
      services.remoteProjectService,
      services.projectService,
      remoteConnectionOpenPreference,
      remoteWorkspaceController,
    ],
  );
  const handleRemoteConnectionDialogOpenChange = useCallback(
    (open: boolean) => {
      const target =
        deviceAdditionReturn.current?.completion === "delivered"
          ? undefined
          : deviceAdditionReturn.current?.target;
      if (target?.isCurrent()) target.onVisibilityChange?.(open);
      if (!open) remoteProjectIntentEpoch.current++;
      setRemoteConnectionDialogOpen(open);
    },
    [deviceAdditionReturn, setRemoteConnectionDialogOpen],
  );
  const handleRemoteProjectIntentCleared = useCallback(() => {
    // 改选新连接只清除原项目恢复意图；从设置进入仍须独立完成设备管理。
    setRemoteConnectionOpenPreference((current) =>
      current?.completion === "device-management"
        ? { completion: "device-management", returnTarget: current.returnTarget }
        : null,
    );
  }, [setRemoteConnectionOpenPreference]);

  return {
    remoteProjectIntentEpoch,
    remoteProjectSelection,
    setRemoteProjectSelection,
    selectDirectoryForRemoteProject,
    handleRemoteConnectionDialogOpenChange,
    handleRemoteProjectIntentCleared,
  };
}
