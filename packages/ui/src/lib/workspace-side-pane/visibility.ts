import type { WorkspaceSidePaneState, WorkspaceSidePaneTab } from "./types.js";

export interface SidePaneVisibilityScope {
  workspaceKey: string | null;
  ownerTaskId: string | null;
}

export function activateSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  if (!current) {
    return {
      tabs: [tab],
      activeTabId: tab.id,
    };
  }

  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const nextTabs = [...current.tabs];
    nextTabs[existingIndex] = tab;
    return {
      tabs: nextTabs,
      activeTabId: tab.id,
    };
  }

  return {
    tabs: [...current.tabs, tab],
    activeTabId: tab.id,
  };
}

export function getActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneTab | null {
  if (!current) {
    return null;
  }

  return current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
}

/** 把草稿态的 null/undefined 归一，供侧栏按对话隔离。 */
export function sidePaneOwnerKey(taskId: string | null | undefined): string {
  return taskId ?? "__draft__";
}

export function sidePaneTabMatchesWorkspace(
  tab: WorkspaceSidePaneTab,
  activeWorkspaceKey: string | null,
): boolean {
  return tab.workspaceKey == null || tab.workspaceKey === activeWorkspaceKey;
}

/**
 * 新建 tab 在提交到共享侧栏状态时统一冻结工作区与对话归属。
 * browser-use 自带事件来源归属，因此已打标的 tab 绝不能被当前 UI scope 覆盖。
 */
export function stampSidePaneTabsOwnership(
  state: WorkspaceSidePaneState | null,
  ownership: {
    ownerTaskId: string | null;
    workspaceKey: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState | null {
  if (!state) return state;
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.ownerTaskId !== undefined && tab.workspaceKey != null) return tab;
    changed = true;
    return {
      ...tab,
      // 快捷入口可能已写 owner 但未写 workspace；两者独立补齐，否则最近关闭会跨工作区泄漏。
      ownerTaskId: tab.ownerTaskId === undefined ? ownership.ownerTaskId : tab.ownerTaskId,
      workspaceKey: tab.workspaceKey ?? ownership.workspaceKey,
      ...(tab.ownerTaskId === undefined &&
      (tab.type === "browser" || tab.type === "browser-use") &&
      ownership.remoteSessionId
        ? { remoteSessionId: ownership.remoteSessionId }
        : {}),
    } as WorkspaceSidePaneTab;
  });
  return changed ? { ...state, tabs } : state;
}

/** 显示与操作必须共用归属判断；旧 parent-only 分支会把新类型误当成公共 tab。 */
export function isSidePaneTabVisibleInScope(
  tab: WorkspaceSidePaneTab,
  scope: SidePaneVisibilityScope,
): boolean {
  if (!sidePaneTabMatchesWorkspace(tab, scope.workspaceKey)) return false;
  switch (tab.type) {
    case "git":
    case "developer-tools":
    case "agent-workbench":
    case "plugin-market":
    case "treemapping":
      return true;
    case "browser-use":
      return tab.sessionId === scope.ownerTaskId;
    case "subagent-session":
    case "subagent-directory":
    case "bash-output":
      return tab.rootSessionId === scope.ownerTaskId;
    case "selection-side-chat":
    case "plan-detail":
    case "plugin-ui":
    case "workflow-run":
    case "workflow-directory":
    case "workflow-actor-session":
    case "workflow-workspace":
    case "workflow-artifact":
      return tab.parentSessionId === scope.ownerTaskId;
    case "browser":
    case "browser-permissions":
    case "file-manager":
    case "code-viewer":
    case "whiteboard":
    case "model-trajectory":
    case "new-tab":
    case "terminal":
      return sidePaneOwnerKey(tab.ownerTaskId) === sidePaneOwnerKey(scope.ownerTaskId);
  }
}

export function getVisibleSidePaneTabs(
  tabs: readonly WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[] {
  return tabs.filter((tab) => isSidePaneTabVisibleInScope(tab, scope));
}

export function resolveActiveTabForOwner(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): string | null {
  if (!state) return null;
  const visibleTabs = getVisibleSidePaneTabs(state.tabs, scope);
  if (visibleTabs.length === 0) return null;
  if (preferredTabId && visibleTabs.some((tab) => tab.id === preferredTabId)) {
    return preferredTabId;
  }
  if (visibleTabs.some((tab) => tab.id === state.activeTabId)) {
    return state.activeTabId;
  }
  return visibleTabs.at(-1)?.id ?? null;
}

/**
 * 对话 scope 切换时同时解析 active tab 与折叠态。
 *
 * 目标对话没有 preferredTabId 时不能沿用上一个对话的 collapsed 状态，也不能简单地
 * 用“有可见 tab 就展开”覆盖状态。否则用户在 A 主动收起后切到 B 再切回 A，仍会被 A 的可见 tab
 * 自动展开。现在由调用方传入当前对话的主动偏好；没有偏好时才沿用默认的“有 tab 展开、无 tab 收起”。
 */
export function resolveSidePaneScopeState(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
  collapsedPreference?: boolean,
): {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
} {
  const activeTabId = resolveActiveTabForOwner(state, scope, preferredTabId);
  return {
    sidePaneState:
      state && state.activeTabId !== (activeTabId ?? "")
        ? { ...state, activeTabId: activeTabId ?? "" }
        : state,
    // 草稿重新进入时默认收起；空 scope 的历史展开偏好不能生成新标签页。
    isSidePaneCollapsed:
      scope.ownerTaskId === null || activeTabId === null ? true : (collapsedPreference ?? false),
  };
}

export function restoreSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, {
    ...tab,
    openedAt: tab.openedAt ?? Date.now(),
  });
}

export function findTabIndexById(tabs: WorkspaceSidePaneTab[], tabId: string): number {
  return tabs.findIndex((tab) => tab.id === tabId);
}

export function selectSidePaneTabsForScope(
  current: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current.tabs, scope);
  if (visibleTabs.length === 0) {
    return current.activeTabId === "" ? current : { ...current, activeTabId: "" };
  }
  const preferred = preferredTabId
    ? visibleTabs.find((tab) => tab.id === preferredTabId)
    : undefined;
  const currentActive = visibleTabs.find((tab) => tab.id === current.activeTabId);
  const nextActive =
    currentActive ??
    preferred ??
    visibleTabs.findLast(
      (tab) =>
        tab.type === "subagent-session" ||
        tab.type === "subagent-directory" ||
        tab.type === "selection-side-chat" ||
        tab.type === "plan-detail" ||
        tab.type === "workflow-run" ||
        tab.type === "workflow-actor-session" ||
        tab.type === "workflow-workspace" ||
        tab.type === "workflow-artifact",
    ) ??
    visibleTabs.at(-1);
  return nextActive && nextActive.id !== current.activeTabId
    ? { ...current, activeTabId: nextActive.id }
    : current;
}

export function setActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current || !current.tabs.some((tab) => tab.id === tabId)) {
    return current;
  }

  return {
    ...current,
    activeTabId: tabId,
  };
}
