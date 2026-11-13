import { useMemo } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { isSettingsTab, isWorkspaceTab } from "@/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";

/**
 * Root 的 tab store 投影：窗口级 workspace tab、激活 tab 与 workspace shell 目标。
 *
 * 这里只做派生，不写回 store；`workspaceShell*` 是唯一 shell 身份来源，避免调用方各自反查。
 */
export function useRootTabState() {
  const tabs = useTabStore((state) => state.tabs);
  const windowWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const isSettingsTabActive = activeTab ? isSettingsTab(activeTab) : false;
  const {
    workspaceShellPath,
    workspaceIdentity: workspaceShellIdentity,
    workspaceRemoteSessionId: workspaceShellRemoteSessionId,
  } = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    // Settings 覆盖时仍使用被覆盖 tab 的完整远程身份，避免通知与侧栏建立重复订阅。
    workspaceTabs: windowWorkspaceTabs,
  });
  const workspaceScopedServices = useWorkspaceServices(
    workspaceShellPath,
    workspaceShellRemoteSessionId,
    workspaceShellIdentity,
  );

  const localWorkspacePathForRemoteConnection = useTabStore((state) => {
    const activeTab = state.activeTabId
      ? state.tabs.find((tab) => tab.id === state.activeTabId)
      : null;
    if (
      !activeTab ||
      !isWorkspaceTab(activeTab) ||
      activeTab.remoteSessionId ||
      activeTab.remoteTarget ||
      activeTab.workspaceIdentity ||
      activeTab.workspacePurpose === "conversation"
    ) {
      return undefined;
    }
    return activeTab.workspacePath;
  });
  const addTab = useTabStore((state) => state.addTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const tabStoreApi = useTabStoreApi();

  return {
    tabs,
    windowWorkspaceTabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    activeWorkspaceTab,
    isSettingsTabActive,
    workspaceShellPath,
    workspaceShellIdentity,
    workspaceShellRemoteSessionId,
    workspaceScopedServices,
    localWorkspacePathForRemoteConnection,
    addTab,
    activateTabByPath,
    tabStoreApi,
  };
}
