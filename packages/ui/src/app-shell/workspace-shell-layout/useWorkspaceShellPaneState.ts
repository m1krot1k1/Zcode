import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { ResolvedWorkspaceShellLayoutProps } from "@/app-shell/workspace-shell-layout/helpers.js";
import type { WorkspaceShellBaseState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellBaseState.js";
import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import {
  readFloatingAnchorPreference,
  writeFloatingAnchorPreference,
  type FloatingAnchor,
  type SidePaneFullViewFloating,
  type SidePaneFullViewHostMode,
} from "@/side-pane-full-view/index.js";
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";

/**
 * pane 布局所有者：侧栏 terminal 的保活回收、完整视图（full view）派生与开关、
 * 会话列/终端/右侧面板的动画宽度。状态只在这里写入，渲染层只读结果。
 */
export function useWorkspaceShellPaneState(
  props: ResolvedWorkspaceShellLayoutProps,
  base: WorkspaceShellBaseState,
) {
  const {
    activeTaskTitle,
    isSidePaneOpen,
    isSidebarVisible,
    isTerminalOpen,
    sidePaneFullView,
    workspaceMainView,
    workspaceTabs,
  } = props;
  const { intl, isWebRemoteControlShell } = base;
  const openWorkspaceKeys = useMemo(
    () => workspaceTabs.map((tab) => tab.workspaceIdentity?.trim() || tab.workspacePath),
    [workspaceTabs],
  );
  // 保活回收：workspace tab 真正关闭（从 openWorkspaceKeys 移除）时，回收属于该 workspace 的
  // side pane terminal 常驻 session（杀 PTY + 销 xterm），避免孤儿进程泄漏。
  // 切 workspace 不会让 workspaceKey 离开这个集合，所以保活的 session 不受影响。
  // 对称下侧 Terminal.tsx:145-177 的 openWorkspaceKeys 回收逻辑。
  useEffect(() => {
    const retained = new Set(openWorkspaceKeys);
    sidePaneTerminalSessionRegistry.releaseByPredicate(
      (entry) => Boolean(entry.workspaceKey) && !retained.has(entry.workspaceKey),
    );
  }, [openWorkspaceKeys]);
  // 完整视图（docs/ui/side-pane-full-view.md）只读派生：不改侧栏、面板宽度等原有状态，退出后自然恢复。
  const fullViewController = isWebRemoteControlShell ? undefined : sidePaneFullView;
  const activeFullView =
    workspaceMainView === "chat" ? (fullViewController?.fullView ?? null) : null;
  const isFullView = activeFullView !== null;
  const fullViewMode: SidePaneFullViewHostMode = !activeFullView
    ? "normal"
    : activeFullView.surface === "conversation"
      ? "conversation"
      : "floating";
  const isFloatingFullView = fullViewMode === "floating";
  const isFullViewRef = useRef(isFullView);
  isFullViewRef.current = isFullView;
  const [fullViewSlotElement, setFullViewSlotElement] = useState<HTMLDivElement | null>(null);
  const [floatingAnchor, setFloatingAnchor] = useState<FloatingAnchor>(
    readFloatingAnchorPreference,
  );
  const handleFloatingAnchorChange = useCallback((anchor: FloatingAnchor) => {
    setFloatingAnchor(anchor);
    writeFloatingAnchorPreference(anchor);
  }, []);
  const handleFullViewFloatingChange = useCallback(
    (floating: SidePaneFullViewFloating) => fullViewController?.setFloating(floating),
    [fullViewController],
  );
  const handleOpenFullViewConversation = useCallback(
    () => fullViewController?.setSurface("conversation"),
    [fullViewController],
  );
  const fullViewConversationTitle =
    activeTaskTitle?.trim() || intl.formatMessage({ id: "taskList.untitled" });
  // 完整视图保留左侧任务列表与左上角按钮组，侧栏显隐只由用户开关决定。
  const isSidebarPanelVisible = isSidebarVisible;
  const {
    panelRef: terminalPanelRef,
    panelElementRef: terminalPanelElementRef,
    isVisible: isTerminalVisible,
  } = useAnimatedResizablePanel({
    // 浮窗只承载对话本身；终端只在普通视图和完整视图的对话 tab 中显示，开合状态不变。
    open: isTerminalOpen && !isFloatingFullView,
    expandedSize: "30%",
    rememberExpandedSize: true,
  });
  const {
    panelRef: sidePanePanelRef,
    panelElementRef: sidePanePanelElementRef,
    isVisible: isSidePaneVisible,
  } = useAnimatedResizablePanel({
    // 截图 surface 由 browser-use tab 自己的 fixed 承载层提供尺寸，不能再把整个右侧
    // ResizablePanel 撑开；否则自动化页会闪出空白的 tab 栏，且面板过渡期间 guest surface
    // 仍可能被 Chromium 判定为不可合成。
    open: workspaceMainView === "chat" && isSidePaneOpen,
    expandedSize: SIDE_PANE_DEFAULT_EXPANDED_SIZE,
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
  });
  const mobileSidePanePanelRef = useRef<PanelImperativeHandle | null>(null);
  const mobileSidePanePanelElementRef = useRef<HTMLDivElement | null>(null);
  return {
    openWorkspaceKeys,
    fullViewController,
    activeFullView,
    isFullView,
    fullViewMode,
    isFloatingFullView,
    isFullViewRef,
    fullViewSlotElement,
    setFullViewSlotElement,
    floatingAnchor,
    handleFloatingAnchorChange,
    handleFullViewFloatingChange,
    handleOpenFullViewConversation,
    fullViewConversationTitle,
    isSidebarPanelVisible,
    terminalPanelRef,
    terminalPanelElementRef,
    isTerminalVisible,
    sidePanePanelRef,
    sidePanePanelElementRef,
    isSidePaneVisible,
    mobileSidePanePanelRef,
    mobileSidePanePanelElementRef,
  };
}

export type WorkspaceShellPaneState = ReturnType<typeof useWorkspaceShellPaneState>;
