import {
  createUuid,
  type BrowserTabResidencyState,
  type BrowserViewRestoredTabShell,
} from "@zcode/shared";
import { createBrowserSidePaneTab } from "./tabs.js";
import type {
  BrowserPermissionsSidePaneTab,
  BrowserSidePaneMetadata,
  BrowserSidePaneTab,
  BrowserUseSidePaneTab,
  WorkspaceSidePaneState,
} from "./types.js";
import {
  activateSidePaneTab,
  findTabIndexById,
  setActiveSidePaneTab,
  sidePaneOwnerKey,
  sidePaneTabMatchesWorkspace,
} from "./visibility.js";

export function activateBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    forceNew?: boolean;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  if (!options?.forceNew && !options?.tabId && !options?.initialUrl) {
    const ownerKey = sidePaneOwnerKey(options?.ownerTaskId);
    const existingBrowserTab = current?.tabs.find(
      (tab): tab is BrowserSidePaneTab =>
        tab.type === "browser" && sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
    );
    if (existingBrowserTab) {
      return activateSidePaneTab(current, existingBrowserTab);
    }
  }

  return activateSidePaneTab(current, createBrowserSidePaneTab(options));
}

/** 打开/复用站点权限设置标签：同站点 + 同工作区 + 同对话只保留一个标签。 */
export function openBrowserPermissionsSidePane(
  current: WorkspaceSidePaneState | null,
  options: Pick<BrowserPermissionsSidePaneTab, "origin" | "ownerTaskId" | "workspaceKey">,
): WorkspaceSidePaneState {
  const existing = current?.tabs.find(
    (tab) =>
      tab.type === "browser-permissions" &&
      tab.origin === options.origin &&
      tab.workspaceKey === options.workspaceKey &&
      sidePaneOwnerKey(tab.ownerTaskId) === sidePaneOwnerKey(options.ownerTaskId),
  );
  return activateSidePaneTab(
    current,
    existing ?? {
      ...options,
      id: `browser-permissions:${createUuid()}`,
      type: "browser-permissions",
      openedAt: Date.now(),
    },
  );
}

export function openBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    activate?: boolean;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  const next = activateBrowserSidePane(current, {
    ...options,
    forceNew: true,
  });
  if (options?.activate !== false) return next;
  return { ...next, activeTabId: current?.activeTabId ?? "" };
}

/**
 * 同一 workspace/owner 下认领同一个 URL 的 browser tab。
 *
 * 调用方（`useAppPanels`）需要**先**知道落点 tab 的 id 才能对它发导航请求，所以查找与打开
 * 拆成两步：这里定位，`openOrActivateBrowserSidePaneByUrl` 用同一个判据落点。两处共用它，
 * 不会出现「查的是 A、开的是 B」。
 */
export function findBrowserSidePaneTabByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
  },
): BrowserSidePaneTab | undefined {
  const ownerKey = sidePaneOwnerKey(options.ownerTaskId);
  return current?.tabs.find(
    (tab): tab is BrowserSidePaneTab =>
      tab.type === "browser" &&
      tab.initialUrl === options.initialUrl &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey &&
      sidePaneTabMatchesWorkspace(tab, options.workspaceKey ?? null),
  );
}

/**
 * URL 键复用：同一 workspace/session 的同一个 URL 只激活已有 tab。
 *
 * 两个用户：share handover 的分享链接，与 html 产物的直开。两者是同一句话——「带我去这个
 * 地址」，而不是「再开一个浏览器」。复用时**不**改 tab 的任何字段（`initialUrl` 就是键），
 * 要让 webview 重新取字节由调用方另发一次导航请求。
 */
export function openOrActivateBrowserSidePaneByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    /** 新建时用的 tab id；缺席即现生成。命中已有 tab 时忽略。 */
    tabId?: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState {
  const existing = findBrowserSidePaneTabByUrl(current, options);
  if (existing) return activateSidePaneTab(current, existing);
  return activateBrowserSidePane(current, {
    initialUrl: options.initialUrl,
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ownerTaskId: options.ownerTaskId,
    workspaceKey: options.workspaceKey,
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  });
}

/** 打开或更新一个受控 browser-use tab；ready 重放按 tabId 幂等。 */
export function openBrowserUseSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
    remoteSessionId?: string;
    title?: string;
    activate?: boolean;
  },
): WorkspaceSidePaneState {
  const id = `browser-use:${options.tabId}`;
  const existing = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && tab.id === id,
  );
  const remoteSessionId = options.remoteSessionId ?? existing?.remoteSessionId;
  const tab: BrowserUseSidePaneTab = {
    id,
    type: "browser-use",
    ownerTaskId: options.sessionId,
    workspaceKey: options.workspaceKey,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: options.sessionId,
    tabId: options.tabId,
    ...(options.browserId ? { browserId: options.browserId } : {}),
    ...(options.browserGeneration !== undefined
      ? { browserGeneration: options.browserGeneration }
      : {}),
    openedAt: existing?.openedAt ?? Date.now(),
    ...((options.title ?? existing?.title)
      ? { title: options.title ?? existing?.title ?? null }
      : {}),
    ...(existing?.faviconUrl !== undefined ? { faviconUrl: existing.faviconUrl } : {}),
    ...(existing?.residency !== undefined ? { residency: existing.residency } : {}),
    ...(existing?.residencyGeneration !== undefined
      ? { residencyGeneration: existing.residencyGeneration }
      : {}),
    ...(existing?.browserUseOperationUntil !== undefined
      ? { browserUseOperationUntil: existing.browserUseOperationUntil }
      : {}),
    ...(existing?.browserUseResizeBaselineVersion !== undefined
      ? {
          browserUseResizeBaselineVersion: existing.browserUseResizeBaselineVersion,
        }
      : {}),
  };

  if (options.activate !== false) {
    return activateSidePaneTab(current, tab);
  }
  if (!current) {
    return { tabs: [tab], activeTabId: "" };
  }
  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const tabs = [...current.tabs];
    tabs[existingIndex] = tab;
    return { ...current, tabs };
  }
  return { ...current, tabs: [...current.tabs, tab] };
}

interface BrowserUseSidePaneScope {
  workspaceKey: string;
  remoteSessionId?: string;
  ownerTaskId: string | null;
}

/** ready/show 事件只允许激活其 origin workspace + session，后台事件仅挂载 guest。 */
export function applyBrowserUseSidePaneEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): { state: WorkspaceSidePaneState; shouldReveal: boolean } {
  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: openBrowserUseSidePane(current, {
      ...options,
      activate: shouldReveal,
    }),
    shouldReveal,
  };
}

/** visibility 只选择 ready 已创建的 shell；迟到事件不得重建已关闭 tab。 */
export function applyBrowserUseSidePaneVisibilityEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): {
  state: WorkspaceSidePaneState | null;
  shouldReveal: boolean;
  didMatch: boolean;
} {
  const target = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab =>
      tab.type === "browser-use" &&
      tab.tabId === options.tabId &&
      tab.workspaceKey === options.workspaceKey &&
      (tab.remoteSessionId ?? "") === (options.remoteSessionId ?? "") &&
      tab.sessionId === options.sessionId &&
      (options.browserId === undefined || tab.browserId === options.browserId) &&
      (options.browserGeneration === undefined ||
        tab.browserGeneration === options.browserGeneration),
  );
  if (!target) {
    // 旧 visibility 路径复用了 ready 的 open helper。main 已关闭 tab 后，队列中
    // 迟到的 visible=true 会在 renderer 重建无 main authority 的僵尸 shell，之后点击关闭必然
    // 失败。visibility 是选择信号，只能命中现存且 scope/generation 完全一致的 shell。
    return { state: current, shouldReveal: false, didMatch: false };
  }

  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: shouldReveal ? setActiveSidePaneTab(current, target.id) : current,
    shouldReveal,
    didMatch: true,
  };
}

export function applyBrowserTabResidencyEvent(
  current: WorkspaceSidePaneState | null,
  event: {
    tabId: string;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    browserId?: string;
    browserGeneration?: number;
    generation: number;
    residency: Extract<
      BrowserTabResidencyState,
      "live-visible" | "live-background" | "suspended" | "restoring"
    >;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  const index = current.tabs.findIndex(
    (tab) =>
      (tab.type === "browser" && tab.id === event.tabId) ||
      (tab.type === "browser-use" && tab.tabId === event.tabId),
  );
  if (index < 0) return current;
  const target = current.tabs[index] as BrowserSidePaneTab | BrowserUseSidePaneTab;
  if (event.workspaceKey !== undefined && target.workspaceKey !== event.workspaceKey)
    return current;
  if (
    Object.hasOwn(event, "remoteSessionId") &&
    (target.remoteSessionId ?? "") !== (event.remoteSessionId ?? "")
  ) {
    return current;
  }
  if (
    event.sessionId !== undefined &&
    (target.type === "browser-use"
      ? target.sessionId !== event.sessionId
      : (target.ownerTaskId ?? "unscoped") !== event.sessionId)
  ) {
    return current;
  }
  if ((target.residencyGeneration ?? 0) > event.generation) return current;
  const tabs = [...current.tabs];
  tabs[index] = {
    ...target,
    ...(target.type === "browser-use" && event.browserId ? { browserId: event.browserId } : {}),
    ...(target.type === "browser-use" && event.browserGeneration !== undefined
      ? { browserGeneration: event.browserGeneration }
      : {}),
    residency: event.residency,
    residencyGeneration: event.generation,
  };
  return { ...current, tabs };
}

export function restoreBrowserTabShells(
  current: WorkspaceSidePaneState | null,
  shells: readonly BrowserViewRestoredTabShell[],
  scope?: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
  },
): WorkspaceSidePaneState {
  let next: WorkspaceSidePaneState = current ?? { tabs: [], activeTabId: "" };
  const hadActiveTabInScope = Boolean(
    scope &&
    current?.tabs.some(
      (tab) =>
        tab.id === current.activeTabId &&
        (tab.type === "browser" || tab.type === "browser-use") &&
        tab.workspaceKey === scope.workspaceKey &&
        (tab.remoteSessionId ?? "") === (scope.remoteSessionId ?? "") &&
        (tab.type === "browser-use"
          ? tab.sessionId === scope.sessionId
          : (tab.ownerTaskId ?? "unscoped") === scope.sessionId),
    ),
  );
  for (const shell of shells) {
    const existing = next.tabs.find(
      (tab) =>
        (tab.type === "browser" && tab.id === shell.tabId) ||
        (tab.type === "browser-use" && tab.tabId === shell.tabId),
    );
    if (existing) continue;
    const tab: BrowserSidePaneTab | BrowserUseSidePaneTab =
      shell.origin === "agent"
        ? {
            id: `browser-use:${shell.tabId}`,
            type: "browser-use",
            ownerTaskId: shell.sessionId,
            workspaceKey: shell.workspaceKey,
            ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
            sessionId: shell.sessionId,
            tabId: shell.tabId,
            browserId: shell.browserId,
            browserGeneration: shell.browserGeneration,
            openedAt: shell.openedAt,
            title: shell.title,
            faviconUrl: shell.faviconUrl,
            residency: "suspended",
            residencyGeneration: 0,
          }
        : {
            id: shell.tabId,
            type: "browser",
            // Bug 原因：草稿态内存 owner 是 null，但 IPC/持久层编码为 "unscoped"；
            // 冷恢复必须对称解码，否则 tab 虽已恢复到状态中，却会被草稿 scope 永久隐藏。
            ownerTaskId: shell.sessionId === "unscoped" ? null : shell.sessionId,
            workspaceKey: shell.workspaceKey,
            ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
            initialUrl: shell.restoreUrl,
            title: shell.title,
            faviconUrl: shell.faviconUrl,
            openedAt: shell.openedAt,
            residency: "suspended",
            residencyGeneration: 0,
          };
    next = {
      tabs: [...next.tabs, tab],
      activeTabId: next.activeTabId || tab.id,
    };
  }
  if (scope && !hadActiveTabInScope) {
    const preferred = shells
      .filter(
        (shell) =>
          shell.workspaceKey === scope.workspaceKey &&
          (shell.remoteSessionId ?? "") === (scope.remoteSessionId ?? "") &&
          shell.sessionId === scope.sessionId,
      )
      .sort(
        (left, right) =>
          (right.lastSelectedAt ?? Number.NEGATIVE_INFINITY) -
            (left.lastSelectedAt ?? Number.NEGATIVE_INFINITY) ||
          left.openedAt - right.openedAt ||
          left.tabId.localeCompare(right.tabId),
      )[0];
    if (preferred) {
      // Bug 原因：旧恢复直接激活 openedAt 第一条，持久化的 lastSelectedAt 完全未消费。
      // tab strip 仍按 openedAt 保持原顺序，只单独选择当前 scope 的最近使用项。
      next = {
        ...next,
        activeTabId:
          preferred.origin === "agent" ? `browser-use:${preferred.tabId}` : preferred.tabId,
      };
    }
  }
  return next;
}

export function updateBrowserSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  patch: BrowserSidePaneMetadata,
): WorkspaceSidePaneState | null {
  if (!current) {
    return current;
  }

  let didUpdate = false;
  const nextTabs = current.tabs.map((tab) => {
    if (tab.id !== tabId) {
      return tab;
    }
    if (tab.type === "browser" || tab.type === "browser-use") {
      didUpdate = true;
      return { ...tab, ...patch };
    }
    return tab;
  });

  return didUpdate
    ? {
        ...current,
        tabs: nextTabs,
      }
    : current;
}

/** 按 workspace/session/browser generation/tab 完整匹配运行态，避免 stale run 串写。 */
export function markBrowserUseSidePaneTabOperation(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    operationUntil: number;
    resetsResizeBaseline?: boolean;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  let didUpdate = false;
  const tabs = current.tabs.map((tab) => {
    if (
      tab.type !== "browser-use" ||
      tab.workspaceKey !== options.workspaceKey ||
      tab.sessionId !== options.sessionId ||
      (tab.browserId !== undefined && tab.browserId !== options.browserId) ||
      (tab.browserGeneration !== undefined &&
        tab.browserGeneration !== options.browserGeneration) ||
      tab.tabId !== options.tabId
    ) {
      return tab;
    }
    didUpdate = true;
    return {
      ...tab,
      browserUseOperationUntil: options.operationUntil,
      ...(options.resetsResizeBaseline
        ? {
            browserUseResizeBaselineVersion: (tab.browserUseResizeBaselineVersion ?? 0) + 1,
          }
        : {}),
    };
  });
  return didUpdate ? { ...current, tabs } : current;
}
