import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";
import {
  buildTaskSidePaneMemoryKey,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  isSidePaneTabVisibleInScope,
  resolveSidePaneScopeState,
  stampSidePaneTabsOwnership,
} from "@/lib/workspaceSidePane.js";
import type { WorkspaceSidePaneState } from "@/lib/workspaceSidePane.js";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "./types.js";

export interface UseAppPanelsCoreParams {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  activeTaskId: string | null;
  sidePaneOwnerId: string | null;
}

/**
 * side pane 的 canonical 状态：内存记忆、owner scope、折叠态与统一写入口。
 *
 * 所有侧栏写入口都必须经由 commitSidePaneState 提交 canonical ref，保证交互与
 * BrowserView IPC 严格按接收顺序合并。
 */
export function useAppPanelsCore({
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  sidePaneOwnerId,
}: UseAppPanelsCoreParams) {
  const activeWorkspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const { zcodeAgentService, zcodeSessionService } = useServices();
  const isOfficeMode = useIsOfficeMode();
  const sidePaneMemoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  const initialSidePaneMemoryState = readTaskSidePaneMemoryState(sidePaneMemoryKey);

  // 修复说明：之前终端区域被固定写死在 <main> 底部，页面一进入就会直接挂载 Terminal，
  // 不仅默认占用高度，还会立刻创建终端会话。这里改成显式开关，默认关闭，
  // 只有用户主动点击后才渲染 Terminal，这样就不会出现"terminal 不用默认打开"的问题。
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // 修复说明：右侧共享面板（browser / code-viewer）需要默认关闭。
  // 否则一进工作区就会先占住主会话空间，和"只在用户主动查看时再展开"的预期相反。
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(
    initialSidePaneMemoryState.sidePaneState,
  );
  const [isSidePaneCollapsed, setIsSidePaneCollapsedState] = useState(
    getSidePaneCollapsedPreference(initialSidePaneMemoryState, sidePaneOwnerId) ??
      initialSidePaneMemoryState.isSidePaneCollapsed,
  );
  // 交互说明：侧栏显隐按钮放在 App 外层，而不是 Sidebar 内部。
  // 这样即使侧栏被隐藏，入口也仍然留在左上角，不会出现"收起后没有地方再展开"的问题；
  // 同时这里统一处理 macOS 红绿灯安全区，避免按钮和系统窗口控件重叠。
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [browserNavigationRequest, setBrowserNavigationRequest] =
    useState<BrowserNavigationRequest | null>(null);
  const [allRecentClosedSidePaneTabs, setAllRecentClosedSidePaneTabs] = useState<
    RecentClosedSidePaneTab[]
  >([]);
  const lastActiveSubagentTabByRootRef = useRef<Map<string, string>>(new Map());
  const sidePaneOwnerIdRef = useRef(sidePaneOwnerId);
  sidePaneOwnerIdRef.current = sidePaneOwnerId;
  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  activeWorkspaceKeyRef.current = activeWorkspaceKey;
  const activeTabByOwnerRef = useRef<Map<string, string>>(new Map());
  const activeSidePaneMemoryKeyRef = useRef<string | null>(sidePaneMemoryKey);
  const latestSidePaneMemoryRef = useRef({
    sidePaneState,
    isSidePaneCollapsed,
  });
  latestSidePaneMemoryRef.current = {
    sidePaneState,
    isSidePaneCollapsed,
  };

  // 折叠态参与同一批事件的后续决策，统一同步 ref，避免 React 提交前读到旧值。
  const setIsSidePaneCollapsed = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    const next =
      typeof value === "function"
        ? value(latestSidePaneMemoryRef.current.isSidePaneCollapsed)
        : value;
    latestSidePaneMemoryRef.current.isSidePaneCollapsed = next;
    setIsSidePaneCollapsedState(next);
  }, []);

  const currentSidePaneScope = useCallback(
    () => ({
      workspaceKey: activeWorkspaceKeyRef.current,
      ownerTaskId: sidePaneOwnerIdRef.current,
    }),
    [],
  );

  const revealSidePaneForCurrentOwner = useCallback(() => {
    setIsSidePaneCollapsed(false);
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      false,
    );
  }, []);

  const commitSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      const next = updater(latestSidePaneMemoryRef.current.sidePaneState);
      // 关闭末标签必须收敛到收起态；在此补建入口会让 Cmd/Ctrl+W 永远关闭不完。
      // 仅显式展开空面板时创建 new-tab，后台关闭也不能重新展开面板。
      if (getVisibleSidePaneTabs(next?.tabs ?? [], currentSidePaneScope()).length === 0) {
        setIsSidePaneCollapsed(true);
      }
      // 普通侧栏交互和 BrowserView IPC 可在同一 React batch 内相邻到达。
      // 若只有 BrowserView 更新同步 ref，后到的具体值会覆盖尚未提交的打开、激活或排序更新。
      // 所有侧栏写入口统一先提交 canonical ref，保证交互与 lifecycle 严格按接收顺序合并。
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        sidePaneState: next,
      };
      setSidePaneState(next);
      return next;
    },
    [currentSidePaneScope],
  );

  const commitOpenedSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      commitSidePaneState((current) => {
        const next = stampSidePaneTabsOwnership(updater(current), {
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
          remoteSessionId: workspaceRemoteSessionId ?? null,
        });
        const launcher = getActiveSidePaneTab(current);
        const opened = getActiveSidePaneTab(next);
        const scope = currentSidePaneScope();
        // 新标签页被内容替换，保留原位置；后台或其他对话的打开事件不能消费当前入口。
        // 插件市场保留返回入口，不属于在新标签页内启动的工具。
        if (
          !next ||
          launcher?.type !== "new-tab" ||
          !opened ||
          opened.type === "new-tab" ||
          opened.type === "plugin-market" ||
          !isSidePaneTabVisibleInScope(launcher, scope) ||
          !isSidePaneTabVisibleInScope(opened, scope)
        )
          return next;
        const alreadyOpen = current?.tabs.some((tab) => tab.id === opened.id);
        return {
          ...next,
          tabs: alreadyOpen
            ? next.tabs.filter((tab) => tab.id !== launcher.id)
            : next.tabs.flatMap((tab) =>
                tab.id === launcher.id ? [opened] : tab.id === opened.id ? [] : [tab],
              ),
        };
      });
    },
    [commitSidePaneState, currentSidePaneScope, workspaceRemoteSessionId],
  );

  useEffect(() => {
    const previousKey = activeSidePaneMemoryKeyRef.current;
    if (previousKey === sidePaneMemoryKey) {
      return;
    }

    // side pane 原来是 workspace 组件内的瞬时状态，跨 workspace 切换会被新渲染覆盖。
    // 这里在 key 变更前先把旧 workspace 的 tabs/折叠态写入内存，再恢复新 workspace，避免不同 workspace 串状态。
    // 同一 workspace 内切换 task 不应该影响 side pane，所以 key 已经不再按 task 维度切分。
    saveTaskSidePaneMemoryState(previousKey, latestSidePaneMemoryRef.current);
    const restored = readTaskSidePaneMemoryState(sidePaneMemoryKey);
    activeSidePaneMemoryKeyRef.current = sidePaneMemoryKey;
    const collapsed =
      getSidePaneCollapsedPreference(restored, sidePaneOwnerIdRef.current) ??
      restored.isSidePaneCollapsed;
    setIsSidePaneCollapsed(collapsed);
    commitSidePaneState(() => restored.sidePaneState);
  }, [commitSidePaneState, sidePaneMemoryKey]);

  useEffect(() => {
    return () => {
      saveTaskSidePaneMemoryState(
        activeSidePaneMemoryKeyRef.current,
        latestSidePaneMemoryRef.current,
      );
    };
  }, []);

  useEffect(() => {
    commitSidePaneState((current) => {
      const scopeKey = `${activeWorkspaceKey}::${sidePaneOwnerId ?? "__draft__"}`;
      const preferredTabId =
        activeTabByOwnerRef.current.get(scopeKey) ??
        (activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : undefined);
      const collapsedPreference = getSidePaneCollapsedPreference(
        readTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current),
        sidePaneOwnerId,
      );
      const resolved = resolveSidePaneScopeState(
        current,
        { workspaceKey: activeWorkspaceKey, ownerTaskId: sidePaneOwnerId },
        preferredTabId,
        collapsedPreference,
      );
      setIsSidePaneCollapsed(resolved.isSidePaneCollapsed);
      logger.debug("[App] 同步对话右侧面板 scope", {
        activeTabId: resolved.sidePaneState?.activeTabId ?? null,
        activeTaskId,
        isSidePaneCollapsed: resolved.isSidePaneCollapsed,
        ownerTaskId: sidePaneOwnerId,
        preferredTabId: preferredTabId ?? null,
        workspaceKey: activeWorkspaceKey,
      });
      return resolved.sidePaneState;
    });
  }, [activeTaskId, activeWorkspaceKey, commitSidePaneState, sidePaneOwnerId]);
  return {
    activeWorkspaceKey,
    activeWorkspaceKeyRef,
    activeSidePaneMemoryKeyRef,
    activeTabByOwnerRef,
    allRecentClosedSidePaneTabs,
    browserNavigationRequest,
    commitOpenedSidePaneState,
    commitSidePaneState,
    currentSidePaneScope,
    isOfficeMode,
    isSidePaneCollapsed,
    isSidebarVisible,
    isTerminalOpen,
    lastActiveSubagentTabByRootRef,
    latestSidePaneMemoryRef,
    revealSidePaneForCurrentOwner,
    setAllRecentClosedSidePaneTabs,
    setBrowserNavigationRequest,
    setIsSidePaneCollapsed,
    setIsSidebarVisible,
    setIsTerminalOpen,
    sidePaneMemoryKey,
    sidePaneOwnerId,
    sidePaneOwnerIdRef,
    sidePaneState,
    workspaceRemoteSessionId,
    zcodeAgentService,
    zcodeSessionService,
  };
}

export type AppPanelsCore = ReturnType<typeof useAppPanelsCore>;
