import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import type { WorkspaceShellContext } from "@/app-shell/workspace-shell-layout/context.js";
import {
  buildDesktopChatBody,
  buildAutomationsMainBody,
  buildPluginStoreMainBody,
} from "@/app-shell/workspace-shell-layout/WorkspaceMainViewBodies.js";
import { buildWorkspaceHeaderSlot } from "@/app-shell/workspace-shell-layout/WorkspaceHeaderSlot.js";
import { Button } from "@/components/ui/button.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { GripHorizontal } from "lucide-react";
import { SidePaneFullViewConversationHost } from "@/side-pane-full-view/index.js";
import { cn } from "@/components/lib/utils.js";
import { resolveWorkspaceShellWindowChromeClass } from "@/app-shell/workspaceShellWindowChrome.js";
import { WORKSPACE_CONVERSATION_PANEL_IDS } from "@/app-shell/workspace-shell-layout/helpers.js";

/**
 * 会话列：完整视图宿主 + 垂直 conversation/terminal 分栏 + 页头与远控导航拖拽把手。
 * 主视图主体按 workspaceMainView 复用一个 switch，与手机远控保持同一条件。
 */
export function buildConversationColumn(ctx: WorkspaceShellContext) {
  const { props, model } = ctx;
  const {
    activeTaskId,
    desktopWindowChromeState,
    handleOpenBrowserUrl,
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    services,
    setIsTerminalOpen,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceMainView,
  } = props;
  const {
    activeFullView,
    conversationPanelElementRef,
    finishWebRemoteNavigationResize,
    floatingAnchor,
    fullViewMode,
    fullViewSlotElement,
    handleFloatingAnchorChange,
    handleFullViewFloatingChange,
    handleOpenFullViewConversation,
    handleWebRemoteNavigationHandleClick,
    handleWebRemoteNavigationResizeMove,
    handleWebRemoteNavigationResizeStart,
    intl,
    isFullView,
    isLinuxDesktop,
    isSidePaneVisible,
    isTerminalVisible,
    isWebRemoteControlNavigationCollapsed,
    isWebRemoteControlNavigationDragging,
    isWebRemoteControlShell,
    openWorkspaceKeys,
    simplifyHeaderForNarrowRemote,
    terminalPanelElementRef,
    terminalPanelRef,
  } = model;
  const shouldRenderWorkspaceHeader =
    workspaceMainView !== "automations" &&
    workspaceMainView !== "plugin-store" &&
    (activeTaskId !== null || isDesktop);
  return (
    <ResizablePanel
      id="conversation-column"
      minSize={isWebRemoteControlShell ? "0px" : "35%"}
      defaultSize={isSidePaneVisible ? "52%" : undefined}
      className={
        isWebRemoteControlShell
          ? "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0"
          : undefined
      }
    >
      <SidePaneFullViewConversationHost
        mode={fullViewMode}
        floating={activeFullView?.floating ?? "collapsed"}
        anchor={floatingAnchor}
        slotElement={fullViewSlotElement}
        onFloatingChange={handleFullViewFloatingChange}
        onAnchorChange={handleFloatingAnchorChange}
        onOpenConversation={handleOpenFullViewConversation}
      >
        <ResizablePanelGroup
          orientation="vertical"
          layoutId="workspace-conversation-column-layout"
          panelIds={WORKSPACE_CONVERSATION_PANEL_IDS}
          className="h-full min-h-0"
        >
          <ResizablePanel id="conversation" elementRef={conversationPanelElementRef} minSize="35%">
            <section
              data-workspace-conversation-frame="true"
              className={cn(
                "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                isSidePaneVisible
                  ? "rounded-[var(--workspace-panel-radius)] border border-border"
                  : resolveWorkspaceShellWindowChromeClass({
                      isMacDesktop,
                      isWindowsDesktop,
                      isLinuxDesktop,
                      macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                      isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                      supportsNativeRoundedCorners:
                        desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                    }),
                isTerminalVisible && "rounded-b-[var(--workspace-panel-radius)] border-b",
                isWebRemoteControlShell &&
                  "max-md:rounded-none max-md:border-x-0 max-md:border-b-0",
                // 完整视图由面板外框或浮窗外框承担边框与圆角，对话 frame 不再叠一层。
                isFullView && "rounded-none border-0",
              )}
            >
              {shouldRenderWorkspaceHeader && !isFullView
                ? buildWorkspaceHeaderSlot(ctx, {
                    reserveWindowControls: !isSidePaneVisible,
                    simplifyForNarrowRemote: simplifyHeaderForNarrowRemote,
                  })
                : null}
              {isWebRemoteControlShell ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-md"
                  data-web-remote-navigation-resize-handle="true"
                  className={cn(
                    "absolute left-1/2 z-30 hidden -translate-x-1/2 -translate-y-1/2 touch-none cursor-ns-resize border-border bg-surface text-foreground-subtle shadow-sm hover:bg-surface-hover hover:text-foreground max-md:inline-flex [app-region:no-drag]",
                    shouldRenderWorkspaceHeader ? "top-12" : "top-0",
                    isWebRemoteControlNavigationDragging &&
                      "border-border-hover bg-surface-hover text-foreground",
                  )}
                  aria-expanded={!isWebRemoteControlNavigationCollapsed}
                  aria-controls="web-remote-control-navigation-panel"
                  aria-label={intl.formatMessage({
                    id: isWebRemoteControlNavigationCollapsed
                      ? "webRemoteControl.expandNavigation"
                      : "webRemoteControl.collapseNavigation",
                  })}
                  onPointerDown={handleWebRemoteNavigationResizeStart}
                  onPointerMove={handleWebRemoteNavigationResizeMove}
                  onPointerUp={(event) => {
                    finishWebRemoteNavigationResize(event);
                  }}
                  onPointerCancel={(event) => {
                    finishWebRemoteNavigationResize(event, true);
                  }}
                  onClick={handleWebRemoteNavigationHandleClick}
                >
                  <GripHorizontal className="size-4" />
                </Button>
              ) : null}
              <div className="min-h-0 flex-1 overflow-hidden">
                {workspaceMainView === "automations" && !isWebRemoteControlShell
                  ? buildAutomationsMainBody(ctx)
                  : workspaceMainView === "plugin-store" && !isWebRemoteControlShell
                    ? buildPluginStoreMainBody(ctx)
                    : buildDesktopChatBody(ctx)}
              </div>
            </section>
          </ResizablePanel>
          {isWebRemoteControlShell ||
          (workspaceMainView !== "automations" && workspaceMainView !== "plugin-store") ? (
            <AnimatedTerminalPanel
              frameClassName={cn(
                isSidePaneVisible
                  ? "rounded-[var(--workspace-panel-radius)] border border-border"
                  : resolveWorkspaceShellWindowChromeClass({
                      isMacDesktop,
                      isWindowsDesktop,
                      isLinuxDesktop,
                      macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                      isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                      supportsNativeRoundedCorners:
                        desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                    }),
                "rounded-t-[var(--workspace-panel-radius)] border-t",
              )}
              services={services}
              workspaceAbsPath={workspaceAbsPath}
              workspaceIdentity={workspaceIdentity}
              openWorkspaceKeys={openWorkspaceKeys}
              isVisible={isTerminalVisible}
              isWindowsDesktop={isWindowsDesktop}
              panelRef={terminalPanelRef}
              panelElementRef={terminalPanelElementRef}
              onClose={() => setIsTerminalOpen(false)}
              onOpenBrowserUrl={handleOpenBrowserUrl}
            />
          ) : null}
        </ResizablePanelGroup>
      </SidePaneFullViewConversationHost>
    </ResizablePanel>
  );
}
