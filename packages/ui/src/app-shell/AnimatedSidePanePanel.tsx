import { useEffect, useMemo, useState } from "react";
import { PlusIcon } from "lucide-react";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { useOpenPluginUi } from "@/plugin-ui/index.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import {
  SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE,
  SidePaneFullViewToggleButton,
} from "@/side-pane-full-view/index.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { findScreenshotSurfaceTabForRender } from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ResizableHandle,
  ResizablePanel,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";
import { Tabs } from "@/components/ui/tabs.js";
import { SidePaneTabsBar } from "@/app-shell/animated-side-pane-panel/SidePaneTabsBar.js";
import { SidePaneTabContent } from "@/app-shell/animated-side-pane-panel/SidePaneTabContent.js";
import { SidePaneTabsOverviewPane } from "@/app-shell/animated-side-pane-panel/SidePaneTabsOverviewPane.js";
import { SidePaneOpenTabLauncher } from "@/app-shell/animated-side-pane-panel/SidePaneOpenTabLauncher.js";
import { buildOpenTabLauncherItems } from "@/app-shell/animated-side-pane-panel/openTabLauncherItems.js";
import { useSidePaneContentWidthLock } from "@/app-shell/animated-side-pane-panel/useSidePaneContentWidthLock.js";
import { useSidePaneTabStrip } from "@/app-shell/animated-side-pane-panel/useSidePaneTabStrip.js";
import { useSidePaneViewportMetrics } from "@/app-shell/animated-side-pane-panel/useSidePaneViewportMetrics.js";
import type { AnimatedSidePanePanelProps } from "@/app-shell/animated-side-pane-panel/types.js";
import {
  resolveAnimatedSidePanePanelLayout,
  shouldOfferSelectionSideConversation,
} from "@/app-shell/animatedSidePanePanelModel.js";
import { useDeveloperToolsVisibility } from "@/hooks/useDeveloperToolsVisibility.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { composerScopeKey, resolveComposerScope } from "@/v4/composer/composerDraftStore.js";
import {
  getVisibleSidePaneTabs,
  shouldMountSidePaneContent,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

const EMPTY_SIDE_PANE_TABS: WorkspaceSidePaneState["tabs"] = [];

export function AnimatedSidePanePanel({
  services,
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isVisible,
  sidePaneState,
  recentClosedSidePaneTabs,
  isBrowserOpen,
  supportsEmbeddedBrowser = true,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  sidePaneOwnerId,
  gitState,
  activeGitSourceId,
  panelRef,
  panelElementRef,
  browserNavigationRequest,
  browserRestoreUrls,
  screenshotSurfaceRequest: screenshotSurfaceRequestProp = null,
  screenshotSurfaceTabId = null,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  onCloseGit,
  onActivateTab,
  onOpenNewTab,
  onReorderTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onReopenClosedTab,
  onOpenBrowserTab,
  onOpenBrowserPermissionSettings,
  onOpenWhiteboard: _onOpenWhiteboard,
  onOpenDeveloperTools,
  onOpenAgentWorkbench,
  onOpenFileManager,
  onNavigateFileManager,
  onOpenPluginMarket,
  onCreateTask,
  onOpenTerminalTab,
  onOpenReviewTab,
  onOpenSelectionSideConversation,
  onRevealGitFileInTree,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenBackgroundBash,
  onRefreshGit,
  onBrowserNavigationRequestHandled,
  onBrowserUrlChange,
  onBrowserPageMetadataChange,
  onSelectGitSource,
  frameClassName = "rounded-xl border border-border",
  captionControlsStyle,
  showWindowControls,
  onCloseSidePane,
  toggleSidePaneShortcutLabel,
  fullViewToggle,
  fullView = null,
  fullViewSlotRef,
  mobileOverlay = false,
  mobileStacked = false,
}: AnimatedSidePanePanelProps) {
  const onOpenPluginUi = useOpenPluginUi();
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const developerToolsEnabled = useDeveloperToolsVisibility();
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const isDragCollapsible = !isVisible;
  const isResizeDisabled = !isVisible;
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const composerClientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const draftScopeKey = composerScopeKey(
    resolveComposerScope(draftProjectId, workspaceIdentity, composerClientNamespace),
  );
  const tabs = sidePaneState?.tabs ?? EMPTY_SIDE_PANE_TABS;
  const screenshotSurfaceRequest = screenshotSurfaceRequestProp;
  const isScreenshotSurfaceActive = Boolean(screenshotSurfaceRequest);
  const screenshotSurfaceTab = screenshotSurfaceTabId
    ? tabs.find((tab) => tab.id === screenshotSurfaceTabId)
    : screenshotSurfaceRequest
      ? findScreenshotSurfaceTabForRender(tabs, screenshotSurfaceRequest)
      : undefined;
  const visibleTabs = useMemo(
    () =>
      getVisibleSidePaneTabs(tabs, {
        workspaceKey,
        ownerTaskId: sidePaneOwnerId,
      }),
    [sidePaneOwnerId, tabs, workspaceKey],
  );
  const activeTabId = sidePaneState?.activeTabId ?? "";
  const visibleActiveTabId = visibleTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (visibleTabs.at(-1)?.id ?? "");
  // 完整视图切到对话 tab 时，面板内容全部视为未选中：对话宿主覆盖内容区，webview / 终端不再自认可见。
  const contentActiveTabId = fullView?.surface === "conversation" ? "" : visibleActiveTabId;
  // 面板 tab trigger 在 pointerdown 上阻止了默认行为，Radix 收不到 mousedown，不会走 onValueChange；
  // 所有激活面板 tab 的入口都必须经过这里，才能把完整视图切回面板 surface。
  const activateSidePaneTab = (tabId: string) => {
    fullView?.onSelectSurface("side-pane");
    onActivateTab(tabId);
  };
  const [marketReturnTarget, setMarketReturnTarget] = useState<{
    workspaceKey: string;
    ownerId: string | null;
    tabId: string;
  } | null>(null);
  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.type === "plugin-market")) {
      setMarketReturnTarget(null);
    }
  }, [visibleTabs]);
  const hasVisibleTabs = visibleTabs.length > 0;
  // 插件市场返回原 tab 的目标由面板持有：进入市场前记录来源 tab，
  // 返回时若该 tab 还在就切回，否则补建「新标签页」。
  const pluginMarketBackHandler =
    marketReturnTarget?.workspaceKey === workspaceKey &&
    marketReturnTarget.ownerId === (sidePaneOwnerId ?? null)
      ? (tabId: string) => {
          const targetId = marketReturnTarget.tabId;
          setMarketReturnTarget(null);
          onCloseTab(tabId);
          if (visibleTabs.some((item) => item.id === targetId)) {
            onActivateTab(targetId);
          } else {
            onOpenNewTab();
          }
        }
      : undefined;
  const openPluginMarketFromLauncher = onOpenPluginMarket
    ? () => {
        setMarketReturnTarget({
          workspaceKey,
          ownerId: sidePaneOwnerId ?? null,
          tabId: visibleActiveTabId,
        });
        onOpenPluginMarket();
      }
    : undefined;
  const lockedContentStyle = useSidePaneContentWidthLock({ isVisible, panelElementRef });
  const shouldMountContent = shouldMountSidePaneContent(isVisible, tabs);
  const [hasRenderedSidePane, setHasRenderedSidePane] = useState(shouldMountContent);
  const tabStrip = useSidePaneTabStrip({
    visibleTabs,
    visibleActiveTabId,
    onReorderTab,
  });
  const { sidePaneVisibleInlineSizePx, isWindowResizeSettling } = useSidePaneViewportMetrics({
    elementRef: panelElementRef,
    hasRenderedSidePane,
  });
  const panelLayout = resolveAnimatedSidePanePanelLayout({ mobileOverlay });
  const hasReviewTab = visibleTabs.some((tab) => tab.type === "git");
  const canOpenSelectionSideConversation = shouldOfferSelectionSideConversation({
    activeTaskId,
    isMobileTextInputViewport,
    mobileOverlay,
  });

  useEffect(() => {
    if (shouldMountContent) {
      // side pane 收起动画原本依赖外层 panel 的 opacity/flex-grow 过渡，
      // 但这里之前把内容写成 `isVisible && sidePaneState ? ... : null`，
      // 一收起就会先把 Tabs/Git/Browser 整块卸载，动画还没走完内容就没了。
      // 改成首次打开后保持挂载，后续收起只隐藏不卸载，这样动画和内部状态都能一起保留。
      setHasRenderedSidePane(true);
    }
  }, [shouldMountContent]);

  const addTabButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      className="shrink-0"
      data-side-pane-add-trigger
      data-side-pane-add-tab-trigger=""
      aria-label={intl.formatMessage({ id: "sidePane.addTab" })}
      onClick={() => {
        fullView?.onSelectSurface("side-pane");
        onOpenNewTab();
      }}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
  const openTabLauncherItems = buildOpenTabLauncherItems({
    intl,
    canOpenSelectionSideConversation,
    developerToolsEnabled,
    hasReviewTab,
    isOfficeMode,
    supportsEmbeddedBrowser,
    onOpenSelectionSideConversation,
    onOpenFileManager: () => onOpenFileManager(),
    onOpenReviewTab,
    onOpenTerminalTab,
    onOpenBrowserTab,
    onOpenDeveloperTools,
    onOpenAgentWorkbench,
  });
  const closeSidePaneButton =
    isVisible && !mobileOverlay && onCloseSidePane ? (
      <div className="flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
        {fullViewToggle ? (
          <SidePaneFullViewToggleButton
            active={fullViewToggle.active}
            onToggle={fullViewToggle.onToggle}
            shortcutLabel={fullViewToggle.shortcutLabel}
          />
        ) : null}
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen
          onToggleSidePane={onCloseSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
        />
        {showWindowControls ? <DesktopWindowControls /> : null}
      </div>
    ) : null;
  const openTabLauncher = (
    <SidePaneOpenTabLauncher
      items={openTabLauncherItems}
      activeTaskId={activeTaskId}
      workspaceAbsPath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      intl={intl}
      onOpenPluginMarket={openPluginMarketFromLauncher}
      onOpenPluginUi={onOpenPluginUi}
    />
  );
  const sidePaneTabOverview = (
    <SidePaneTabsOverviewPane
      tabs={visibleTabs}
      activeTabId={visibleActiveTabId}
      recentClosedTabs={recentClosedSidePaneTabs}
      intl={intl}
      onActivateTab={activateSidePaneTab}
      onCloseTab={onCloseTab}
      onReopenClosedTab={onReopenClosedTab}
    />
  );

  const panelContent = (
    <div
      aria-hidden={!isVisible}
      data-workspace-side-frame={mobileOverlay ? undefined : "true"}
      className={cn(
        // 独立外框放在内容层：关闭仍保留 Browser Guest 和 tab 实例，不改变面板持久化边界。
        "h-full overflow-hidden bg-background",
        !mobileOverlay && frameClassName,
        mobileStacked && "max-md:rounded-none max-md:border-0",
        mobileOverlay && "min-w-0",
        mobileStacked && "max-md:!w-full",
        // 完整视图：相对外层 PanelGroup 铺满整行，库管理的 panel 宽度保持不变。
        // 修复原因：插件 UI 页面挂在 body 末尾的 fixed 停靠层（无 z-index）里，外框曾用 z-10
        // 把不透明背景画在它上面，插件 tab 显示为空白。对话列内容都在 z-30 的宿主里，
        // 外框只需 z-0 建立自己的层叠上下文，按 DOM 顺序排在停靠层之下。
        fullView && "absolute inset-0 z-0",
      )}
      style={mobileOverlay || fullView ? undefined : lockedContentStyle}
    >
      <ScopedErrorBoundary
        scope="workspace-side-pane"
        resetKeys={[workspaceKey, visibleActiveTabId]}
        variant="panel"
        className="h-full"
      >
        {hasRenderedSidePane && (sidePaneState || fullView) ? (
          <>
            {/* 收起或切换对话时保留其他对话的内容挂载，避免丢失辅助对话草稿和引用。
                展开后的空标签集合由 useAppPanels 统一补建「新标签页」。 */}
            <div
              className={cn(
                "h-full min-h-0",
                !hasVisibleTabs && !screenshotSurfaceRequest && !fullView && "hidden",
              )}
            >
              <Tabs
                value={
                  fullView?.surface === "conversation"
                    ? SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE
                    : visibleActiveTabId
                }
                onValueChange={(value) => {
                  if (fullView && value === SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE) {
                    fullView.onSelectSurface("conversation");
                    return;
                  }
                  activateSidePaneTab(value);
                }}
                className="relative h-full gap-0"
              >
                <SidePaneTabsBar
                  tabs={visibleTabs}
                  contentActiveTabId={contentActiveTabId}
                  intl={intl}
                  overview={sidePaneTabOverview}
                  addTabButton={addTabButton}
                  closeSidePaneButton={closeSidePaneButton}
                  isTabsOverflowing={tabStrip.isTabsOverflowing}
                  tabsScrollMaskEdges={tabStrip.tabsScrollMaskEdges}
                  tabsScrollViewportRef={tabStrip.tabsScrollViewportRef}
                  tabsScrollContentRef={tabStrip.tabsScrollContentRef}
                  draggingTab={tabStrip.draggingTab}
                  tabDragSensors={tabStrip.tabDragSensors}
                  onTabDragStart={tabStrip.handleTabDragStart}
                  onTabDragEnd={tabStrip.handleTabDragEnd}
                  onTabDragCancel={tabStrip.handleTabDragCancel}
                  onActivateTab={activateSidePaneTab}
                  onCloseTab={onCloseTab}
                  onCloseOtherTabs={onCloseOtherTabs}
                  onCloseAllTabs={onCloseAllTabs}
                  fullView={fullView}
                  mobileOverlay={mobileOverlay}
                  captionControlsStyle={captionControlsStyle}
                  isDesktop={isDesktop}
                />

                <div
                  ref={mobileOverlay ? undefined : fullViewSlotRef}
                  data-side-pane-content-slot=""
                  className={cn("relative min-h-0 flex-1 isolate", mobileOverlay && "min-w-0")}
                >
                  {fullView && !hasVisibleTabs ? (
                    <div className="absolute inset-0 z-10">{openTabLauncher}</div>
                  ) : null}
                  <SidePaneTabContent
                    tabs={tabs}
                    contentActiveTabId={contentActiveTabId}
                    mobileOverlay={mobileOverlay}
                    isVisible={isVisible}
                    activeTaskId={activeTaskId}
                    sidePaneOwnerId={sidePaneOwnerId}
                    workspaceKey={workspaceKey}
                    workspaceAbsPath={workspaceAbsPath}
                    workspaceIdentity={workspaceIdentity}
                    workspaceRemoteSessionId={workspaceRemoteSessionId}
                    draftScopeKey={draftScopeKey}
                    isDesktop={isDesktop}
                    isWindowsDesktop={isWindowsDesktop}
                    isMacDesktop={isMacDesktop}
                    isBrowserOpen={isBrowserOpen}
                    services={services}
                    gitState={gitState}
                    activeGitSourceId={activeGitSourceId}
                    fileChangeFindActiveIndex={fileChangeFindActiveIndex}
                    fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
                    fileChangeFindQuery={fileChangeFindQuery}
                    onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
                    browserNavigationRequest={browserNavigationRequest}
                    browserRestoreUrls={browserRestoreUrls}
                    screenshotSurfaceRequest={screenshotSurfaceRequest}
                    screenshotSurfaceTabId={screenshotSurfaceTab?.id}
                    newTabContent={openTabLauncher}
                    sidePaneVisibleInlineSizePx={sidePaneVisibleInlineSizePx}
                    isWindowResizeSettling={isWindowResizeSettling}
                    onPluginMarketBack={pluginMarketBackHandler}
                    onCloseGit={onCloseGit}
                    onOpenBrowserPermissionSettings={onOpenBrowserPermissionSettings}
                    onOpenBrowserUrl={onOpenBrowserUrl}
                    onOpenCodeViewer={onOpenCodeViewer}
                    onOpenFileLink={onOpenFileLink}
                    onOpenSubagentSession={onOpenSubagentSession}
                    onOpenWorkflowActorSession={onOpenWorkflowActorSession}
                    onOpenWorkflowWorkspace={onOpenWorkflowWorkspace}
                    onOpenWorkflowArtifact={onOpenWorkflowArtifact}
                    onOpenWorkflowRun={onOpenWorkflowRun}
                    onOpenBackgroundBash={onOpenBackgroundBash}
                    onRevealGitFileInTree={onRevealGitFileInTree}
                    onRefreshGit={onRefreshGit}
                    onBrowserNavigationRequestHandled={onBrowserNavigationRequestHandled}
                    onBrowserUrlChange={onBrowserUrlChange}
                    onBrowserPageMetadataChange={onBrowserPageMetadataChange}
                    onSelectGitSource={onSelectGitSource}
                    onNavigateFileManager={onNavigateFileManager}
                    onCloseTab={onCloseTab}
                    onCreateTask={onCreateTask}
                  />
                </div>
              </Tabs>
            </div>
          </>
        ) : null}
      </ScopedErrorBoundary>
    </div>
  );

  if (!panelLayout.useResizablePanel) {
    return (
      <>
        {/* Bugfix: 手机远控侧栏是覆盖聊天区的抽屉，不在 ResizablePanelGroup 的布局上下文里。
            如果继续渲染 ResizablePanel，外层 auto 宽度会把子级 100% 宽度链路解析成 0px，
            diff / preview 内容就会挂载但不可见；这里改用普通满宽容器承接内容。 */}
        <div
          ref={panelElementRef}
          aria-hidden={!isVisible}
          className={cn(
            "h-full w-full min-w-0 border-l border-border bg-background transition-opacity duration-200 ease-out",
            isVisible || isScreenshotSurfaceActive
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          )}
        >
          {panelContent}
        </div>
      </>
    );
  }

  return (
    <>
      {isVisible && !fullView ? (
        <ResizableHandle
          data-workspace-side-pane-resize-handle="true"
          className={cn(
            WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
            mobileStacked && "max-md:hidden",
          )}
        />
      ) : null}
      <ResizablePanel
        id="browser"
        panelRef={panelRef}
        elementRef={panelElementRef}
        defaultSize={panelLayout.defaultSize}
        minSize={panelLayout.minSize}
        maxSize={panelLayout.maxSize}
        collapsedSize={panelLayout.collapsedSize}
        // 右侧面板常驻声明成 collapsible 时，拖到最小宽度会被库判定为 collapse。
        // 这里改成只在显式关闭时允许折叠，避免用户只是想拖到最小宽度时面板自动收起。
        collapsible={isDragCollapsible}
        // preview/side pane 收起时没有 ResizableHandle，但库仍会暴露 collapsed panel 边缘拖拽区。
        // 收起后禁用面板 resize target，避免用户绕过显式开关从右侧边缘拖出面板。
        disabled={isResizeDisabled}
        className={cn(
          "!overflow-hidden transition-opacity duration-200 ease-out",
          mobileOverlay &&
            "max-md:!h-full max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-1 max-md:!basis-auto max-md:border-l",
          mobileStacked &&
            !mobileOverlay &&
            "max-md:!h-[min(45dvh,24rem)] max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-l-0 max-md:border-t",
          // 截图期间 panel 仍保持 opacity=1，避免 opacity=0 让 Chromium 丢弃 guest
          // compositor surface；实际 browser surface 已 fixed 到窗口内的低透明合成层，不会露出 tab 栏。
          isVisible || isScreenshotSurfaceActive ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {panelContent}
      </ResizablePanel>
    </>
  );
}
