import { LoaderIcon } from "lucide-react";
import type { WorkspaceShellContext } from "@/app-shell/workspace-shell-layout/context.js";
import {
  WORKSPACE_BODY_PANEL_IDS,
  WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
} from "@/app-shell/workspace-shell-layout/helpers.js";
import { buildConversationColumn } from "@/app-shell/workspace-shell-layout/WorkspaceConversationColumn.js";
import { buildWorkspaceSidePanePanel } from "@/app-shell/workspace-shell-layout/WorkspaceSidePaneSlot.js";
import { buildWorkspaceSidebar } from "@/app-shell/workspace-shell-layout/WorkspaceSidebarSlot.js";
import { cn } from "@/components/lib/utils.js";
import { ResizablePanelGroup } from "@/components/ui/resizable.js";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { SavedWorkflowHubProvider } from "@/v4/savedWorkflowHubContext.js";
import { V4SplitPaneEntryProvider } from "@/v4/splitPaneEntryContext.js";
import { WorkflowRunOpenProvider } from "@/v4/workflowRunOpenContext.js";

/**
 * 桌面宽屏骨架：CSS 变量驱动的专用 split（侧栏 / 会话列 / 共享右侧面板），
 * 加上桌面顶栏与远控切换遮罩。完成卡的壳级落点由 SavedWorkflowHubProvider 提供。
 */
export function buildDesktopWideContent(ctx: WorkspaceShellContext) {
  const { props, model } = ctx;
  const {
    appLogoUrl,
    canGoBack,
    canGoForward,
    canTaskNavForward,
    goBackShortcutLabel,
    goForwardShortcutLabel,
    handleTaskNavForward,
    handleToggleSidebar,
    isDesktop,
    isMacDesktop,
    isMacFullscreen,
    isSidebarVisible,
    isWindowsDesktop,
    macWindowControlsLeftPaddingPx,
    newTaskShortcutLabel,
    platform,
    sidebarContainerRef,
    toggleSidebarShortcutLabel,
    updateReadyVersion,
    updateState,
    windowsWindowControlsRightPaddingPx,
    workspaceAbsPath,
    workspaceReadOnlyReason,
  } = props;
  const {
    canPrimaryNavigationBack,
    finishWorkspaceSidebarResize,
    handleNavigateToLaunchedRun,
    handleOpenSavedWorkflowInHub,
    handleOpenSidebarWorkflowRun,
    handleWorkspaceSidebarResizeKeyDown,
    handleWorkspaceSidebarResizeMove,
    handleWorkspaceSidebarResizeStart,
    hasDesktopPanelInset,
    intl,
    isFullView,
    isSidebarPanelVisible,
    isWebRemoteControlMobileViewport,
    isWebRemoteControlShell,
    isWebRemoteControlTaskSwitching,
    primaryNavigationBack,
    renderWebRemoteNavigationPanel,
    showTopOverlayNewTaskButton,
    simplifyHeaderForNarrowRemote,
    workspaceOnlyResetKeys,
    workspaceShellRef,
    workspaceShellSplitStyle,
    workspaceSidebarPanelElementRef,
    workspaceSidebarPanelWidthPx,
    workspaceSidebarResizeLabel,
    workspaceSidebarVisibilityResetKeys,
    createTaskInChat: handleCreateTaskInChat,
  } = model;
  return (
    <SavedWorkflowHubProvider
      openWorkflow={handleOpenSavedWorkflowInHub}
      navigateToRun={handleNavigateToLaunchedRun}
    >
      <div
        ref={workspaceShellRef}
        data-workspace-shell="true"
        style={workspaceShellSplitStyle}
        className={cn(
          "relative flex h-full min-h-0 w-full overflow-hidden [anchor-scope:--sidebar-task-list-divider]",
          // 修复原因：窗口原生 resize 时，外层 react-resizable-panels 会把每一帧
          // 都写进 layout store，连带侧栏 tooltip/menu 子树反复 commit。这里改成
          // CSS 变量驱动的专用 split，普通窗口 resize 只走浏览器布局，不触发 React 状态。
          isWebRemoteControlShell && "max-md:flex-col",
        )}
      >
        <div
          ref={workspaceSidebarPanelElementRef}
          data-panel=""
          data-workspace-sidebar-panel="true"
          id="sidebar"
          className={cn(
            "w-[var(--workspace-sidebar-panel-width)] max-w-[50%] flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity",
            // 修复原因：拖动侧栏宽度时如果继续过渡 width，会让指针移动和实际宽度之间产生滞后。
            // 拖拽 active 通过 DOM 标记切 transition，避免 pointerdown/up 为了切 class 重渲染整棵 workspace。
            isWebRemoteControlShell &&
              cn(
                // Bugfix: Web 远程控制在手机浏览器里仍复用桌面横向 shell，
                // 264px 侧栏 + 320px 内容区会直接超过视口宽度，导致页面只能横向滚动。
                // 这里只在远控模式的小屏断点把主布局改为上下堆叠，桌面端仍保持原来的分栏。
                // 交互修复：远控移动端改为拖动 WorkspaceHeader 下边框的按钮控制顶部高度，
                // 这里用 CSS 变量同步高度，避免拖动时卸载导航内容或打断任务列表状态。
                renderWebRemoteNavigationPanel
                  ? "max-md:!h-[var(--web-remote-navigation-height)] max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-b max-md:border-border max-md:bg-sidebar"
                  : "max-md:!h-0 max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-0 max-md:!border-b-0",
              ),
            isSidebarPanelVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          {/* Bugfix: 折叠远控顶部导航时保持组件挂载，避免展开后整块 sidebar 重新加载。 */}
          <aside
            id={isWebRemoteControlShell ? "web-remote-control-navigation-panel" : undefined}
            ref={sidebarContainerRef}
            className={cn(
              "h-full overflow-hidden select-none",
              isWebRemoteControlShell && "max-md:min-h-0 max-md:flex-1",
              !renderWebRemoteNavigationPanel && "max-md:hidden",
            )}
            aria-hidden={!isSidebarPanelVisible || !renderWebRemoteNavigationPanel}
          >
            <ScopedErrorBoundary
              scope="workspace-sidebar"
              resetKeys={workspaceOnlyResetKeys}
              variant="panel"
              className="h-full"
            >
              <V4SplitPaneEntryProvider
                enabled={!isWebRemoteControlShell && !isWebRemoteControlMobileViewport}
              >
                <WorkflowRunOpenProvider onOpenRun={handleOpenSidebarWorkflowRun}>
                  {buildWorkspaceSidebar(ctx)}
                </WorkflowRunOpenProvider>
              </V4SplitPaneEntryProvider>
            </ScopedErrorBoundary>
          </aside>
        </div>

        {isSidebarPanelVisible && renderWebRemoteNavigationPanel ? (
          <div
            role="separator"
            tabIndex={0}
            aria-controls="sidebar"
            aria-label={workspaceSidebarResizeLabel}
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH_PX}
            aria-valuenow={Math.round(workspaceSidebarPanelWidthPx)}
            data-testid="resizable-handle"
            onKeyDown={handleWorkspaceSidebarResizeKeyDown}
            onPointerCancel={(event) => finishWorkspaceSidebarResize(event, true)}
            onPointerDown={handleWorkspaceSidebarResizeStart}
            onPointerMove={handleWorkspaceSidebarResizeMove}
            onPointerUp={(event) => finishWorkspaceSidebarResize(event)}
            className={cn(
              "group/handle relative z-10 flex h-full w-1 shrink-0 touch-none cursor-ew-resize items-center justify-center bg-transparent outline-none [app-region:no-drag] focus:outline-none focus-visible:ring-0",
              "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 platform-mac-desktop:after:bg-resize-handle platform-windows-desktop:after:bg-resize-handle platform-linux-desktop:after:bg-resize-handle after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius)] after:w-0.5",
              "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100 [[data-workspace-sidebar-resizing=true]_&]:after:opacity-100",
              hasDesktopPanelInset && "after:inset-y-[var(--workspace-resize-handle-inset)]",
              isWebRemoteControlShell && "max-md:hidden",
            )}
          />
        ) : null}
        {isSidebarPanelVisible && renderWebRemoteNavigationPanel ? (
          // 原因：侧栏 overflow 裁掉横线末端；延伸装饰放在共同布局容器，不改变拖拽命中区。
          <span
            aria-hidden="true"
            data-sidebar-divider-extension="true"
            className={cn(
              "pointer-events-none absolute h-px w-1 bg-border/50 [left:anchor(--sidebar-task-list-divider_right,-4px)] [top:anchor(--sidebar-task-list-divider_top,-1px)]",
              isWebRemoteControlShell && "max-md:hidden",
            )}
          />
        ) : null}
        {/* 右侧主工作区：上方 header，下面左侧会话+终端，右侧共享 browser/code-viewer 槽位 */}
        <div
          data-panel=""
          id="content"
          className={cn(
            "flex min-w-[320px] flex-1 flex-col",
            hasDesktopPanelInset ? (isWindowsDesktop ? "pr-1.5 pb-1.5" : "pr-1 pb-1") : "p-0",
            isWebRemoteControlShell &&
              "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0",
          )}
        >
          {
            hasDesktopPanelInset && (
              <div className={cn("w-full [app-region:drag]", isWindowsDesktop ? "h-1.5" : "h-1")} />
            ) /* 修复 macOS 顶部窗口控制按钮被 header 遮挡无法点击的问题 */
          }
          <ResizablePanelGroup
            layoutId="workspace-body-layout"
            panelIds={WORKSPACE_BODY_PANEL_IDS}
            className={cn(
              "min-h-0 flex-1",
              isWebRemoteControlShell && "max-md:!flex-col",
              // 完整视图：面板外框以 Group 为定位容器铺满整行，对话内容由宿主 fixed 定位。
              // 修复原因：曾用 CSS 把对话列 flex 压成 0，react-resizable-panels 以各 panel offsetWidth
              // 之和作为 group 尺寸，面板从收起展开时两者皆为 0，resize 得到 NaN，面板一直停在收起态。
              // 这里不改库管理的 flex，已保存的面板占比也不写入。
              isFullView && "relative",
            )}
          >
            {buildConversationColumn(ctx)}
            {/* Bugfix：Browser Guest Host 必须与主视图路由解耦，避免 automations/plugin
                    切换时卸载 Guest；截图请求期间由上层临时展开真实面板承载可合成的 WebContents。 */}
            {buildWorkspaceSidePanePanel(ctx)}
          </ResizablePanelGroup>
        </div>
        <ScopedErrorBoundary
          scope="desktop-top-overlay"
          resetKeys={workspaceSidebarVisibilityResetKeys}
          variant="silent"
        >
          <DesktopTopOverlay
            newTaskDisabledReason={workspaceReadOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            isMacDesktop={isMacDesktop}
            isMacFullscreen={isMacFullscreen}
            macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            isWindowsDesktop={isWindowsDesktop}
            isDesktop={isDesktop}
            isSidebarVisible={isSidebarVisible}
            updateReadyVersion={updateReadyVersion}
            updateState={updateState}
            toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
            newTaskShortcutLabel={newTaskShortcutLabel}
            goBackShortcutLabel={goBackShortcutLabel}
            goForwardShortcutLabel={goForwardShortcutLabel}
            canTaskNavBack={canPrimaryNavigationBack}
            canTaskNavForward={canTaskNavForward}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            showNewTaskButton={showTopOverlayNewTaskButton}
            appLogoUrl={appLogoUrl}
            platform={platform}
            onToggleSidebar={handleToggleSidebar}
            onCreateTask={handleCreateTaskInChat}
            onGoBack={primaryNavigationBack}
            onGoForward={handleTaskNavForward}
            hideTaskNavigationButtons={simplifyHeaderForNarrowRemote}
          />
        </ScopedErrorBoundary>

        {isWebRemoteControlShell && isWebRemoteControlTaskSwitching ? (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
              <LoaderIcon className="size-4 animate-spin" />
              {/* Bugfix: 跨 workspace 点击任务时旧页会很快卸载，之前在卸载前缺少统一占位，视觉上像“先白屏再渲染”。
                  这里补一个全局 loading overlay，给切换过程稳定反馈。 */}
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          </div>
        ) : null}
      </div>
    </SavedWorkflowHubProvider>
  );
}
