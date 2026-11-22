import { useMemo } from "react";
import type { WorkspaceShellZCodeState } from "@/app-shell/types.js";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

/**
 * Данные workspace для App: вкладки, активная задача, provider-конфиг,
 * проекция workspace-вкладок для shell и имя проекта.
 */
export function useAppRootWorkspaceData({
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  selectedProvider,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId: string | null;
  selectedProvider: WorkspaceShellZCodeState["selectedProvider"];
}) {
  const { intl } = useZCodeIntl();
  const tabs = useTabStore((s) => s.tabs);
  const addTab = useTabStore((s) => s.addTab);
  const activateTabByPath = useTabStore((s) => s.activateTabByPath);
  const activeTaskState = useWorkspaceActiveTaskState({
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    selectedProvider,
    intl,
  });
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspaceAbsPath,
    activeTaskState.workspaceHeaderProvider,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const workspaceTabs = useMemo(
    () =>
      tabs.filter(isWorkspaceTab).map((tab) => ({
        workspacePath: tab.workspacePath,
        label: tab.label,
        remoteSessionId: tab.remoteSessionId,
        remoteTarget: tab.remoteTarget,
        workspaceIdentity: tab.workspaceIdentity,
        workspacePurpose: tab.workspacePurpose,
        localWorkspacePath: tab.localWorkspacePath,
        availability: tab.availability,
      })),
    [tabs],
  );
  const commandCenterWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const projectName = getPathLeaf(workspaceAbsPath);

  return {
    ...activeTaskState,
    tabs,
    addTab,
    activateTabByPath,
    providerConfigFile,
    workspaceTabs,
    commandCenterWorkspaceTabs,
    projectName,
  };
}
