import { useCallback, useMemo } from "react";
import { createUuid } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  closeCodeViewerSidePane,
  closeGitSidePane,
  closeSidePaneTabs,
  ensureSidePaneTab,
  getVisibleSidePaneTabs,
  isSidePaneTabVisibleInScope,
  reorderSidePaneTab,
  restoreSidePaneTab,
  setActiveSidePaneTab,
  updateBrowserSidePaneTab,
  type BrowserSidePaneMetadata,
  type WorkspaceSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import type { AppPanelsCore } from "./useAppPanelsCore.js";
import { RECENT_CLOSED_SIDE_PANE_TAB_LIMIT, type AppPanelsPlatform } from "./types.js";

/**
 * 窗口/侧栏控件与 tab 生命周期：底部终端、侧边栏显隐、折叠、关闭/重开/排序。
 */
export function useAppPanelsTabControls({
  core,
  workspaceAbsPath,
  isDesktop,
  platform,
  closeSelectionSideChatRuntime,
}: {
  core: AppPanelsCore;
  workspaceAbsPath: string;
  isDesktop?: boolean;
  platform?: AppPanelsPlatform;
  closeSelectionSideChatRuntime: (
    tab: Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }>,
  ) => void;
}) {
  const {
    activeSidePaneMemoryKeyRef,
    activeWorkspaceKey,
    activeWorkspaceKeyRef,
    allRecentClosedSidePaneTabs,
    commitSidePaneState,
    currentSidePaneScope,
    isOfficeMode,
    lastActiveSubagentTabByRootRef,
    latestSidePaneMemoryRef,
    revealSidePaneForCurrentOwner,
    setAllRecentClosedSidePaneTabs,
    setBrowserNavigationRequest,
    setIsSidePaneCollapsed,
    setIsSidebarVisible,
    setIsTerminalOpen,
    sidePaneOwnerId,
    sidePaneOwnerIdRef,
    workspaceRemoteSessionId,
  } = core;
  const handleToggleTerminal = useCallback(() => {
    setIsTerminalOpen((open) => {
      if (isOfficeMode && !open) return open;
      const nextOpen = !open;
      logger.info("[App] 切换底部终端面板", {
        open: nextOpen,
        workspace: workspaceAbsPath,
      });
      return nextOpen;
    });
  }, [isOfficeMode, workspaceAbsPath]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarVisible((visible) => !visible);
  }, []);

  const handleToggleSidePaneCollapse = useCallback(() => {
    const nextCollapsed = !latestSidePaneMemoryRef.current.isSidePaneCollapsed;
    setIsSidePaneCollapsed(nextCollapsed);
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      nextCollapsed,
    );
    // 与显隐在同一交互内提交，避免先显示特殊空态再由 effect 补建标签。
    if (!nextCollapsed)
      commitSidePaneState((current) => ensureSidePaneTab(current, currentSidePaneScope()));
    logger.info(
      `[App] ${nextCollapsed ? "收起" : "展开"}右侧面板 workspace=${workspaceAbsPath} tabs=${latestSidePaneMemoryRef.current.sidePaneState?.tabs.length ?? 0}`,
    );
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  const handleCloseCodeViewer = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=code-viewer workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeCodeViewerSidePane(current);
      return next;
    });
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  const handleCloseGit = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=git workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeGitSidePane(current);
      return next;
    });
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  const handleActivateSidePaneTab = useCallback(
    (tabId: string) => {
      const tab = latestSidePaneMemoryRef.current.sidePaneState?.tabs.find(
        (candidate) => candidate.id === tabId,
      );
      if (
        (tab?.type === "browser" || tab?.type === "browser-use") &&
        tab.residency === "suspended"
      ) {
        const logicalTabId = tab.type === "browser-use" ? tab.tabId : tab.id;
        // human tab 的 attach 侧用 `tab.remoteSessionId ?? workspaceRemoteSessionId` 兜底冻结 owner，
        // 这里必须同源，否则创建时没冻结该字段的存量 tab 会 scope 失配、点开永远恢复不了。
        // browser-use 的 attach 侧没有这层兜底，跟着加反而会造成反向失配，故按类型区分。
        const scopedRemoteSessionId =
          tab.type === "browser-use"
            ? tab.remoteSessionId
            : (tab.remoteSessionId ?? workspaceRemoteSessionId);
        void platform
          ?.browserViewEnsureResident?.({
            tabId: logicalTabId,
            workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
            ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
            sessionId: tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
          })
          .catch((error) => {
            logger.warn("[App] 激活 suspended Browser tab 失败", {
              error: error instanceof Error ? error.message : String(error),
              tabId: logicalTabId,
            });
          });
      }
      commitSidePaneState((current) => {
        const target = current?.tabs.find((candidate) => candidate.id === tabId);
        if (target?.type === "subagent-session" || target?.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(target.rootSessionId, target.id);
        }
        return setActiveSidePaneTab(current, tabId);
      });
    },
    [commitSidePaneState, platform, workspaceRemoteSessionId],
  );

  const handleReorderSidePaneTab = useCallback(
    (activeTabId: string, overTabId: string) => {
      commitSidePaneState((current) => reorderSidePaneTab(current, activeTabId, overTabId));
    },
    [commitSidePaneState],
  );

  const rememberClosedSidePaneTabs = useCallback((tabs: WorkspaceSidePaneTab[]) => {
    const restorableTabs = tabs.filter(
      (tab) =>
        tab.type !== "selection-side-chat" && tab.type !== "browser-use" && tab.type !== "new-tab",
    );
    if (restorableTabs.length === 0) {
      return;
    }

    const closedAt = Date.now();
    setAllRecentClosedSidePaneTabs((current) => {
      const closingIds = new Set(restorableTabs.map((tab) => tab.id));
      return [
        ...restorableTabs.map((tab) => ({ tab, closedAt })),
        ...current.filter((item) => !closingIds.has(item.tab.id)),
      ].slice(0, RECENT_CLOSED_SIDE_PANE_TAB_LIMIT);
    });
  }, []);

  const closeBrowserTabsWithAuthority = useCallback(
    async (tabs: readonly WorkspaceSidePaneTab[]): Promise<boolean> => {
      const browserTabs = tabs.filter(
        (tab) => tab.type === "browser" || tab.type === "browser-use",
      );
      if (browserTabs.length === 0) return true;
      if (!platform?.browserViewCloseTab) {
        // Desktop 必须由 main 先删除 logical tab/recovery snapshot；bridge 缺失时不能只删 UI 壳，
        // 否则重启后已关闭 tab 会复活。Web 端没有 guest authority，保持原本的本地关闭语义。
        if (isDesktop) {
          logger.warn("[App] 关闭 Browser tab 时缺少 main authority");
          return false;
        }
        return true;
      }
      try {
        await Promise.all(
          browserTabs.map((tab) => {
            // 与 attach 侧同源：human tab 兜底到 workspaceRemoteSessionId，browser-use 不兜底。
            // 不同源就会 scope 失配 → main 拒绝授权 → UI 壳永不移除 → tab 关不掉。
            const scopedRemoteSessionId =
              tab.type === "browser-use"
                ? tab.remoteSessionId
                : (tab.remoteSessionId ?? workspaceRemoteSessionId);
            return platform.browserViewCloseTab!({
              tabId: tab.type === "browser-use" ? tab.tabId : tab.id,
              workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
              ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
              sessionId:
                tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
            });
          }),
        );
        return true;
      } catch (error) {
        logger.warn("[App] 关闭 Browser tab 的 main authority 失败", {
          error: error instanceof Error ? error.message : String(error),
          tabIds: browserTabs.map((tab) => (tab.type === "browser-use" ? tab.tabId : tab.id)),
        });
        return false;
      }
    },
    [isDesktop, platform, workspaceRemoteSessionId],
  );

  const closeSelectedSidePaneTabs = useCallback(
    async (closingTabs: WorkspaceSidePaneTab[], preferredTabId?: string) => {
      if (closingTabs.length === 0) return;
      const scope = currentSidePaneScope();
      if (!(await closeBrowserTabsWithAuthority(closingTabs))) return;
      for (const tab of closingTabs) {
        if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
        if (tab.type === "terminal") sidePaneTerminalSessionRegistry.release(tab.id);
      }
      rememberClosedSidePaneTabs(closingTabs);
      const closingIds = closingTabs.map((tab) => tab.id);
      // Bug 原因：main 确认关闭期间可能切换对话/工作区或新建 tab。归属与关闭目标在点击时
      // 冻结，完成后写回原 registry；当前可见范围与活动标签则按完成时的 scope 解析。
      if (scope.workspaceKey !== activeWorkspaceKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(scope.workspaceKey);
        const next = closeSidePaneTabs(stored.sidePaneState, closingIds, scope, preferredTabId);
        saveTaskSidePaneMemoryState(scope.workspaceKey, {
          sidePaneState: next,
          isSidePaneCollapsed: stored.isSidePaneCollapsed,
        });
      } else {
        const liveScope = currentSidePaneScope();
        commitSidePaneState((current) =>
          closeSidePaneTabs(
            current,
            closingIds,
            liveScope,
            liveScope.ownerTaskId === scope.ownerTaskId
              ? (preferredTabId ??
                  (liveScope.ownerTaskId
                    ? lastActiveSubagentTabByRootRef.current.get(liveScope.ownerTaskId)
                    : null))
              : undefined,
          ),
        );
      }
      logger.info("[App] 关闭右侧面板标签", { tabIds: closingIds, ...scope });
    },
    [
      closeBrowserTabsWithAuthority,
      closeSelectionSideChatRuntime,
      commitSidePaneState,
      currentSidePaneScope,
      rememberClosedSidePaneTabs,
    ],
  );

  const visibleSidePaneTabs = useCallback(
    () =>
      getVisibleSidePaneTabs(
        latestSidePaneMemoryRef.current.sidePaneState?.tabs ?? [],
        currentSidePaneScope(),
      ),
    [currentSidePaneScope],
  );

  const handleCloseSidePaneTab = useCallback(
    (tabId: string) => {
      void closeSelectedSidePaneTabs(visibleSidePaneTabs().filter((tab) => tab.id === tabId));
    },
    [closeSelectedSidePaneTabs, visibleSidePaneTabs],
  );

  const handleCloseOtherSidePaneTabs = useCallback(
    (tabId: string) => {
      const tabs = visibleSidePaneTabs();
      if (!tabs.some((tab) => tab.id === tabId)) return;
      void closeSelectedSidePaneTabs(
        tabs.filter((tab) => tab.id !== tabId),
        tabId,
      );
    },
    [closeSelectedSidePaneTabs, visibleSidePaneTabs],
  );

  const handleCloseAllSidePaneTabs = useCallback(() => {
    void closeSelectedSidePaneTabs(visibleSidePaneTabs());
  }, [closeSelectedSidePaneTabs, visibleSidePaneTabs]);

  const handleReopenClosedSidePaneTab = useCallback(
    (tabId: string) => {
      const item = allRecentClosedSidePaneTabs.find((entry) => entry.tab.id === tabId);
      if (
        !item ||
        !isSidePaneTabVisibleInScope(item.tab, currentSidePaneScope()) ||
        (isOfficeMode && (item.tab.type === "terminal" || item.tab.type === "git"))
      )
        return;

      // 交互说明：最近关闭列表里的 tab 被点回打开时，需要同步展开右侧面板。
      // 否则 tab 状态已经恢复，但用户看到的还是折叠态，会误以为点击没有生效。
      revealSidePaneForCurrentOwner();
      commitSidePaneState((sidePaneCurrent) => {
        let restoredTab = item.tab;
        if (item.tab.type === "browser") {
          const {
            residency: _residency,
            residencyGeneration: _residencyGeneration,
            ...browserTab
          } = item.tab;
          restoredTab = { ...browserTab, id: `browser:${createUuid()}` };
        }
        const next = restoreSidePaneTab(sidePaneCurrent, restoredTab);
        if (restoredTab.type === "subagent-session" || restoredTab.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(restoredTab.rootSessionId, restoredTab.id);
        }
        return next;
      });
      setAllRecentClosedSidePaneTabs((current) =>
        current.filter((entry) => entry.tab.id !== tabId),
      );
      logger.info(`[App] 重新打开最近关闭右侧面板 tab=${tabId} workspace=${workspaceAbsPath}`);
    },
    [
      isOfficeMode,
      allRecentClosedSidePaneTabs,
      currentSidePaneScope,
      commitSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
    ],
  );

  const handleBrowserNavigationRequestHandled = useCallback((requestId: string) => {
    setBrowserNavigationRequest((current) => (current?.id === requestId ? null : current));
  }, []);

  const handleBrowserPageMetadataChange = useCallback(
    (tabId: string, metadata: BrowserSidePaneMetadata) => {
      // 交互说明：Browser 的 title/favicon 来自 webview 事件，必须按 tab id 写回。
      // 多 Browser tab 共存时如果只存一份全局元数据，会导致后加载的页面覆盖其他 tab 标题。
      commitSidePaneState((current) => updateBrowserSidePaneTab(current, tabId, metadata));
    },
    [commitSidePaneState],
  );

  const recentClosedSidePaneTabs = useMemo(
    () =>
      allRecentClosedSidePaneTabs.filter(
        (item) =>
          isSidePaneTabVisibleInScope(item.tab, {
            workspaceKey: activeWorkspaceKey,
            ownerTaskId: sidePaneOwnerId,
          }) &&
          (!isOfficeMode || (item.tab.type !== "terminal" && item.tab.type !== "git")),
      ),
    [activeWorkspaceKey, sidePaneOwnerId, allRecentClosedSidePaneTabs, isOfficeMode],
  );
  return {
    handleActivateSidePaneTab,
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
    handleCloseAllSidePaneTabs,
    handleCloseCodeViewer,
    handleCloseGit,
    handleCloseOtherSidePaneTabs,
    handleCloseSidePaneTab,
    handleReorderSidePaneTab,
    handleReopenClosedSidePaneTab,
    handleToggleSidebar,
    handleToggleSidePaneCollapse,
    handleToggleTerminal,
    recentClosedSidePaneTabs,
  };
}
