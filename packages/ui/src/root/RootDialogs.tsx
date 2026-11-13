import type { IServiceAccessor } from "@zcode/services";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { logger } from "@/logger.js";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import type { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import type { useRootDeviceAdditionReturn } from "@/root/useRootDeviceAdditionReturn.js";
import type { useRootRemoteProjectIntent } from "@/root/useRootRemoteProjectIntent.js";
import type { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import type { useSourceServerUpdateNotifications } from "@/root/sourceServerUpdateNotifications.js";
import type { TabStore } from "@/store/tabStore.js";
import { RemoteConnectionDialog } from "@/SSHDialog.js";
import { RemoteProjectPicker } from "@/project-sidebar/RemoteProjectPicker.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";

type RemoteWorkspaceHistory = ReturnType<typeof useRemoteWorkspaceHistory>;
type RemoteProjectIntent = ReturnType<typeof useRootRemoteProjectIntent>;

/**
 * Root 入口级弹窗：远程连接流程 + 服务端目录浏览器。
 *
 * 两个弹窗都挂在 RootShell 内、与 shell 选择分支无关，保证无 workspace 时仍可完成连接或选目录。
 * 设备新增的返回目标由 `finishDeviceAddition` 唯一消费，这里只负责把结果转交。
 */
export function RootDialogs({
  services,
  allowRemoteWorkspace,
  remoteConnectionOpenPreference,
  remoteWorkspaceSessions,
  remoteConnectionDialogOpen,
  remoteConnectionOpenIntentId,
  localWorkspacePathForRemoteConnection,
  isWindowsDesktop,
  remoteProjectSelection,
  remoteProjectIntentEpoch,
  setRemoteProjectSelection,
  selectDirectoryForRemoteProject,
  handleCancelRemoteProject,
  handleConnectRemote,
  finishDeviceAddition,
  handleRemoteConnectionDialogOpenChange,
  handleRemoteProjectIntentCleared,
  handleRemoteConnectionTargetChange,
  setRemoteConnectionInProgress,
  setRemoteConnectionRequestId,
  directoryBrowserOpen,
  setDirectoryBrowserOpen,
  handleSelectProject,
  tabStoreApi,
}: {
  services: IServiceAccessor;
  allowRemoteWorkspace: boolean;
  remoteConnectionOpenPreference: RemoteConnectionOpenPreference | null;
  remoteWorkspaceSessions: RemoteWorkspaceHistory["remoteWorkspaceSessions"];
  remoteConnectionDialogOpen: boolean;
  remoteConnectionOpenIntentId: number;
  localWorkspacePathForRemoteConnection: string | undefined;
  isWindowsDesktop?: boolean;
  remoteProjectSelection: RemoteProjectIntent["remoteProjectSelection"];
  remoteProjectIntentEpoch: { current: number };
  setRemoteProjectSelection: RemoteProjectIntent["setRemoteProjectSelection"];
  selectDirectoryForRemoteProject: RemoteProjectIntent["selectDirectoryForRemoteProject"];
  handleCancelRemoteProject: RemoteWorkspaceHistory["handleCancelRemoteProject"];
  handleConnectRemote: RemoteWorkspaceHistory["handleConnectRemote"];
  finishDeviceAddition: ReturnType<typeof useRootDeviceAdditionReturn>["finishDeviceAddition"];
  handleRemoteConnectionDialogOpenChange: RemoteProjectIntent["handleRemoteConnectionDialogOpenChange"];
  handleRemoteProjectIntentCleared: RemoteProjectIntent["handleRemoteProjectIntentCleared"];
  handleRemoteConnectionTargetChange: ReturnType<typeof useSourceServerUpdateNotifications>;
  setRemoteConnectionInProgress: (inProgress: boolean) => void;
  setRemoteConnectionRequestId: (requestId: string | null) => void;
  directoryBrowserOpen: boolean;
  setDirectoryBrowserOpen: (open: boolean) => void;
  handleSelectProject: ReturnType<typeof useRootWorkspaceActions>["handleSelectProject"];
  tabStoreApi: TabStore;
}) {
  const remoteConnectionDialog = allowRemoteWorkspace ? (
    <>
      {remoteProjectSelection && services.projectService && services.remoteProjectService ? (
        <RemoteProjectPicker
          key={remoteProjectSelection.host.membershipId}
          host={remoteProjectSelection.host}
          initialRoots={[remoteProjectSelection.path]}
          service={services.projectService}
          remoteService={services.remoteProjectService}
          onClose={() => {
            remoteProjectIntentEpoch.current++;
            const sessionId = remoteProjectSelection.sessionId;
            setRemoteProjectSelection(null);
            void handleCancelRemoteProject(sessionId).catch((error) =>
              logger.warn("[Root] 释放项目创建 attachment 失败", error),
            );
          }}
          onSaved={async () => {}}
        />
      ) : null}
      <RemoteConnectionDialog
        completion={remoteConnectionOpenPreference?.completion}
        onCancelled={(background) => {
          void finishDeviceAddition(
            { kind: "cancelled", ...(background ? { background: true } : {}) },
            background,
          ).catch((error) => logger.warn("[Root] device addition cancellation failed", error));
        }}
        onDeviceConnected={async (sourceServerId, canDeliver) => {
          if (await finishDeviceAddition({ kind: "connected", sourceServerId }, false, canDeliver))
            return;
          if (canDeliver?.() === false) return;
          setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
          tabStoreApi.getState().openSettingsTab();
        }}
        onConnect={handleConnectRemote}
        onSelectProject={selectDirectoryForRemoteProject}
        onCancelSession={handleCancelRemoteProject}
        localWorkspacePath={localWorkspacePathForRemoteConnection}
        isWindowsDesktop={isWindowsDesktop}
        remoteWorkspaceSessions={remoteWorkspaceSessions}
        open={remoteConnectionDialogOpen && !remoteProjectSelection}
        onOpenChange={handleRemoteConnectionDialogOpenChange}
        onProjectIntentCleared={handleRemoteProjectIntentCleared}
        onFlowActiveChange={setRemoteConnectionInProgress}
        onFlowRequestIdChange={setRemoteConnectionRequestId}
        onFlowTargetChange={handleRemoteConnectionTargetChange}
        openIntentId={remoteConnectionOpenIntentId}
        initialFailure={remoteConnectionOpenPreference?.initialFailure}
        preferredKind={remoteConnectionOpenPreference?.preferredKind}
        preferredWslDistro={remoteConnectionOpenPreference?.preferredWslDistro}
        preferredSourceServerId={remoteConnectionOpenPreference?.preferredSourceServerId}
        preferredProfileId={remoteConnectionOpenPreference?.preferredProfileId}
        preferredDirectoryPath={remoteConnectionOpenPreference?.preferredDirectoryPath}
        preferredTarget={remoteConnectionOpenPreference?.preferredTarget}
        hideTriggerWhenClosed
      />
    </>
  ) : null;
  const directoryBrowserDialog = directoryBrowserOpen ? (
    <ScopedErrorBoundary
      scope="directory-browser"
      resetKeys={["directory-browser"]}
      variant="silent"
    >
      <DirectoryBrowser
        services={services}
        onCancel={() => setDirectoryBrowserOpen(false)}
        onSelect={(path) => {
          setDirectoryBrowserOpen(false);
          void handleSelectProject(path);
        }}
      />
    </ScopedErrorBoundary>
  ) : null;

  return (
    <>
      {remoteConnectionDialog}
      {directoryBrowserDialog}
    </>
  );
}
