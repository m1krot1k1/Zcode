import type { ReactNode } from "react";
import type { WorkspaceShellContext } from "@/app-shell/workspace-shell-layout/context.js";
import {
  buildAutomationsMainBody,
  buildPluginStoreMainBody,
  buildRemoteChatBody,
} from "@/app-shell/workspace-shell-layout/WorkspaceMainViewBodies.js";
import { buildWorkspaceHeaderSlot } from "@/app-shell/workspace-shell-layout/WorkspaceHeaderSlot.js";
import { buildWorkspaceSidePanePanel } from "@/app-shell/workspace-shell-layout/WorkspaceSidePaneSlot.js";
import { buildWorkspaceSidebar } from "@/app-shell/workspace-shell-layout/WorkspaceSidebarSlot.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";

/**
 * 手机远控壳：同一 Shell 持有查看与导航，只替换布局内容；断点切换不再卸载 Reporter，
 * 真实 Home/后台仍立即撤销查看。无 switcher 时原样返回桌面内容。
 */
export function buildRemoteShell(ctx: WorkspaceShellContext, wideContent: ReactNode) {
  const { props, model } = ctx;
  const {
    activeTaskId,
    handleToggleSidePane,
    initialWebRemoteControlMobileNavigationIntent,
    isDesktop,
    isSidePaneOpen,
    isWorkspaceVisible,
    taskFindDialogProps,
    webRemoteControlTerminalTransportState,
    webRemoteControlWorkspaceSwitcher,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceMainView,
  } = props;
  const {
    isWebRemoteControlMobileViewport,
    isWebRemoteControlShell,
    isWebRemoteControlTaskSwitching,
  } = model;
  const shouldRenderWorkspaceHeader =
    workspaceMainView !== "automations" &&
    workspaceMainView !== "plugin-store" &&
    (activeTaskId !== null || isDesktop);
  if (!webRemoteControlWorkspaceSwitcher) {
    return wideContent;
  }
  return (
    <WebRemoteControlMobileShell
      isMobileViewport={isWebRemoteControlMobileViewport}
      taskViewEnabled={
        isWorkspaceVisible && workspaceMainView === "chat" && !isWebRemoteControlTaskSwitching
      }
      activeTaskId={activeTaskId}
      activeWorkspaceIdentity={workspaceIdentity}
      activeWorkspacePath={workspaceAbsPath}
      initialNavigationIntent={initialWebRemoteControlMobileNavigationIntent}
      webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
      isSidePaneOpen={isSidePaneOpen}
      onCloseSidePane={isSidePaneOpen ? handleToggleSidePane : undefined}
      renderTaskHome={(mobile) => buildWorkspaceSidebar(ctx, mobile)}
      switcher={webRemoteControlWorkspaceSwitcher}
      renderChatHeader={() =>
        shouldRenderWorkspaceHeader
          ? buildWorkspaceHeaderSlot(ctx, { simplifyForNarrowRemote: true })
          : null
      }
      chatOverlay={
        workspaceMainView === "chat" ? (
          <TaskFindDialog {...taskFindDialogProps} placement="chat" />
        ) : undefined
      }
      chatContent={
        workspaceMainView === "automations" && !isWebRemoteControlShell
          ? buildAutomationsMainBody(ctx)
          : workspaceMainView === "plugin-store" && !isWebRemoteControlShell
            ? buildPluginStoreMainBody(ctx)
            : buildRemoteChatBody(ctx)
      }
      sidePaneContent={buildWorkspaceSidePanePanel(ctx, { mobileOverlay: true })}
    >
      {wideContent}
    </WebRemoteControlMobileShell>
  );
}
