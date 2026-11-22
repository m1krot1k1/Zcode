import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";

export const WEB_REMOTE_CONTROL_MOBILE_QUERY = "(max-width: 767px)";
export const WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY =
  "zcode:web-remote-control:collapse-navigation-once";
export const WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX = 800;
export const WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX = 4;
export const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
export const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
export const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
export const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "zcode:workspace-shell:sidebar-width-px";
export const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
export const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
export const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
export const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";
export const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
// 修复原因：WorkspaceShellLayout 是 memo 组件，默认 []/{} 会在缺省调用时每次创建新引用；
// 远控/本地入口缺省这些集合时复用常量，避免浅比较误判 props 变化。
export const EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY: NonNullable<
  WorkspaceShellLayoutProps["remoteWorkspaceRecoveryByWorkspaceKey"]
> = {};
export const CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX = 360;
export const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
// 性能修复：ResizablePanelGroup 收到深相等的新 panelIds 数组，
// 会跟随 chat streaming render 重算布局上下文；固定数组语义上不会随消息变化。
export const WORKSPACE_BODY_PANEL_IDS = ["conversation-column", "browser"];
export const WORKSPACE_CONVERSATION_PANEL_IDS = ["conversation", "terminal"];

export type WebRemoteNavigationDragSession = {
  pointerId: number;
  startHeightPx: number;
  startY: number;
  didDrag: boolean;
};

export type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

export function clampWorkspaceSidebarWidth(widthPx: number, containerWidthPx?: number) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)));
}

export function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkspaceSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

export function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

export function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
  } catch {
    // ignore
  }
}

export function getWebRemoteControlViewportHeight() {
  if (typeof window === "undefined") {
    return WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
  }

  return window.innerHeight || WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
}

export function getIsWebRemoteControlMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY).matches
  );
}

export function consumeWebRemoteControlCollapseIntent(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.sessionStorage.getItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY) === "1") {
      window.sessionStorage.removeItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY);
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

export function markWebRemoteControlCollapseIntent() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY, "1");
  } catch {
    // ignore
  }
}

/**
 * 缺省值收口：WorkspaceShellLayout 是 memo 组件，缺省调用时每次新建 []/{}
 * 会让浅比较误判 props 变化。这里一次性把默认值固化到对象上，
 * 子构建器与钩子按普通字段读取，不再各自兜底。
 */
export type ResolvedWorkspaceShellLayoutProps = Omit<
  WorkspaceShellLayoutProps,
  | "allowOpenWorkspace"
  | "allowRemoteWorkspace"
  | "isWorkspaceVisible"
  | "remoteWorkspaceRecoveryByWorkspaceKey"
  | "windowsWindowControlsRightPaddingPx"
> & {
  allowOpenWorkspace: boolean;
  allowRemoteWorkspace: boolean;
  isWorkspaceVisible: boolean;
  remoteWorkspaceRecoveryByWorkspaceKey: NonNullable<
    WorkspaceShellLayoutProps["remoteWorkspaceRecoveryByWorkspaceKey"]
  >;
  windowsWindowControlsRightPaddingPx: number;
};

export function resolveWorkspaceShellLayoutProps(
  props: WorkspaceShellLayoutProps,
): ResolvedWorkspaceShellLayoutProps {
  return {
    ...props,
    allowOpenWorkspace: props.allowOpenWorkspace ?? true,
    allowRemoteWorkspace: props.allowRemoteWorkspace ?? true,
    isWorkspaceVisible: props.isWorkspaceVisible ?? true,
    remoteWorkspaceRecoveryByWorkspaceKey:
      props.remoteWorkspaceRecoveryByWorkspaceKey ??
      EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY,
    windowsWindowControlsRightPaddingPx: props.windowsWindowControlsRightPaddingPx ?? 136,
  };
}
