import { useShallow } from "zustand/react/shallow";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly, isWorkspaceTab } from "@/store/tabStore.js";
import { resolveAppWorkspaceRpcTarget } from "@/app-shell/workspaceRpcTarget.js";
import { useWorkspaceShellZCodeState } from "@/app-shell/useWorkspaceShellZCodeState.js";
import type { AppRootWorkspaceScope } from "@/app-root/types.js";

/**
 * Workspace-скоуп App: резолв RPC-таргета, доступность workspace-сервисов,
 * read-only гейт и shell-состояние ZCode.
 *
 * Порядок подписок и разрешение identity сохранены из App: активная вкладка
 * имеет приоритет, явные props нужны как fallback, когда Settings перекрывает
 * workspace-вкладку.
 */
export function useAppRootWorkspaceScope({
  workspaceAbsPath,
  explicitWorkspaceIdentity,
  workspaceRemoteSessionId,
}: {
  workspaceAbsPath: string;
  explicitWorkspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): AppRootWorkspaceScope {
  const { intl } = useZCodeIntl();
  const activeWorkspaceRpcTarget = useTabStore(
    useShallow((state) => {
      if (!state.activeTabId) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (
        !activeTab ||
        !isWorkspaceTab(activeTab) ||
        activeTab.workspacePath !== workspaceAbsPath
      ) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      return {
        workspaceIdentity: activeTab.workspaceIdentity,
        remoteSessionId: activeTab.remoteSessionId,
        remoteTarget: activeTab.remoteTarget,
      };
    }),
  );
  const workspaceRpcTarget = resolveAppWorkspaceRpcTarget({
    activeTarget: activeWorkspaceRpcTarget,
    explicitWorkspaceIdentity,
    explicitRemoteSessionId: workspaceRemoteSessionId,
  });
  const workspaceIdentity = workspaceRpcTarget.workspaceIdentity;
  const { rpcReady: workspaceRpcReady } = useWorkspaceServicesResolution(
    workspaceAbsPath,
    workspaceRpcTarget.remoteSessionId,
    workspaceIdentity,
    workspaceRpcTarget.remoteTarget,
  );
  const workspaceReadOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, workspaceAbsPath, workspaceIdentity),
  );
  const workspaceReadOnlyReason = workspaceReadOnly
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const { workspaceShellZCodeState, reloadSessionDisabled } = useWorkspaceShellZCodeState(
    workspaceAbsPath,
    workspaceIdentity,
  );
  const activeTaskId = workspaceShellZCodeState.activeTaskId;
  const sidePaneOwnerId = activeTaskId;

  return {
    workspaceIdentity,
    workspaceRpcTarget,
    workspaceRpcReady,
    workspaceReadOnlyReason,
    workspaceShellZCodeState,
    reloadSessionDisabled,
    activeTaskId,
    sidePaneOwnerId,
  };
}
