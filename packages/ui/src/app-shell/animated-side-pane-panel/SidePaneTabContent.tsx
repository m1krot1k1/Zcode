import type { ReactNode } from "react";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabsContent } from "@/components/ui/tabs.js";
import { cn } from "@/components/lib/utils.js";
import { SidePaneTerminalPane } from "@/SidePaneTerminalPane.js";
import { FileManagerPane } from "@/WorkspaceFileTree.js";
import { BrowserUseSidePaneContent } from "@/browser-use/BrowserUseSidePaneContent.js";
import { BrowserSitePermissionsPage } from "@/browser-use/BrowserSitePermissionsPage.js";
import { HumanBrowserView } from "@/browser-use/HumanBrowserView.js";
import { GitPane } from "@/GitPane.js";
import { TreemappingPane } from "@/TreemappingPane.js";
import { WhiteboardPane } from "@/WhiteboardPane.js";
import { ModelTrajectoryPane } from "@/ModelTrajectoryPane.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { DeveloperToolsPane } from "@/DeveloperToolsPane.js";
import { AgentWorkbenchView } from "@/agent-workbench/index.js";
import { PlanDetailSidePane } from "@/app-shell/PlanDetailSidePane.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import { SubagentDirectorySidePane } from "@/app-shell/SubagentDirectorySidePane.js";
import { SelectionSideChatPane } from "@/app-shell/SelectionSideChatPane.js";
import { BackgroundBashOutputSidePane } from "@/app-shell/BackgroundBashOutputSidePane.js";
import { WorkflowRunSidePane } from "@/app-shell/WorkflowRunSidePane.js";
import { WorkflowRunDirectorySidePane } from "@/app-shell/WorkflowRunDirectorySidePane.js";
import { WorkflowActorSessionSidePane } from "@/app-shell/WorkflowActorSessionSidePane.js";
import { WorkflowWorkspaceSidePane } from "@/app-shell/WorkflowWorkspaceSidePane.js";
import { WorkflowArtifactSidePane } from "@/app-shell/WorkflowArtifactSidePane.js";
import { PluginUiSidePane } from "@/plugin-ui/index.js";
import { SuspendedBrowserSidePaneContent } from "@/app-shell/animated-side-pane-panel/SuspendedBrowserSidePaneContent.js";
import type { AnimatedSidePanePanelProps } from "@/app-shell/animated-side-pane-panel/types.js";
import { inferMediaPreview } from "@/lib/codeViewer.js";
import { shouldRenderPreviewPaneHeavyContent } from "@/app-shell/animatedSidePanePanelModel.js";
import type { BrowserViewScreenshotSurfacePreparePayload } from "@zcode/shared";
import {
  createSubagentDirectorySidePaneTab,
  shouldMountBrowserTabGuest,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

type TabContentProps = Pick<
  AnimatedSidePanePanelProps,
  | "services"
  | "isVisible"
  | "isDesktop"
  | "isWindowsDesktop"
  | "isMacDesktop"
  | "isBrowserOpen"
  | "gitState"
  | "activeGitSourceId"
  | "browserNavigationRequest"
  | "browserRestoreUrls"
  | "fileChangeFindActiveIndex"
  | "fileChangeFindNavigationRequestId"
  | "fileChangeFindQuery"
  | "onFileChangeFindMatchCountChange"
  | "onCloseGit"
  | "onOpenBrowserPermissionSettings"
  | "onOpenBrowserUrl"
  | "onOpenCodeViewer"
  | "onOpenFileLink"
  | "onOpenSubagentSession"
  | "onOpenWorkflowActorSession"
  | "onOpenWorkflowWorkspace"
  | "onOpenWorkflowArtifact"
  | "onOpenWorkflowRun"
  | "onOpenBackgroundBash"
  | "onRevealGitFileInTree"
  | "onRefreshGit"
  | "onBrowserNavigationRequestHandled"
  | "onBrowserUrlChange"
  | "onBrowserPageMetadataChange"
  | "onSelectGitSource"
  | "onNavigateFileManager"
  | "onCloseTab"
  | "onCreateTask"
  | "workspaceAbsPath"
  | "workspaceIdentity"
  | "workspaceRemoteSessionId"
> & {
  tabs: WorkspaceSidePaneState["tabs"];
  contentActiveTabId: string;
  mobileOverlay: boolean;
  activeTaskId: string | null;
  sidePaneOwnerId: string | null;
  workspaceKey: string;
  draftScopeKey: string;
  screenshotSurfaceRequest: BrowserViewScreenshotSurfacePreparePayload | null;
  screenshotSurfaceTabId: string | undefined;
  /** 「新标签页」空白页节点；与完整视图下的浮层共用同一份渲染结果。 */
  newTabContent: ReactNode;
  sidePaneVisibleInlineSizePx: number | null;
  isWindowResizeSettling: boolean;
  /** 插件市场返回原 tab；返回目标由面板持有，这里只接收已校验的回调。 */
  onPluginMarketBack?: (tabId: string) => void;
};

/**
 * 每个 side pane tab 的内容宿主。所有 tab 均 forceMount，只靠 TabsContent 的
 * data-state 隐藏，保证 browser guest / 终端 / 编辑器实例在切换时不被卸载。
 */
export function SidePaneTabContent({
  tabs,
  contentActiveTabId,
  mobileOverlay,
  isVisible,
  activeTaskId,
  sidePaneOwnerId,
  workspaceKey,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  draftScopeKey,
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isBrowserOpen,
  services,
  gitState,
  activeGitSourceId,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  browserNavigationRequest,
  browserRestoreUrls,
  screenshotSurfaceRequest,
  screenshotSurfaceTabId,
  newTabContent,
  sidePaneVisibleInlineSizePx,
  isWindowResizeSettling,
  onPluginMarketBack,
  onCloseGit,
  onOpenBrowserPermissionSettings,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenBackgroundBash,
  onRevealGitFileInTree,
  onRefreshGit,
  onBrowserNavigationRequestHandled,
  onBrowserUrlChange,
  onBrowserPageMetadataChange,
  onSelectGitSource,
  onNavigateFileManager,
  onCloseTab,
  onCreateTask,
}: TabContentProps) {
  return (
    <>
      {tabs.map((tab) => {
        if (
          (tab.type === "browser" || tab.type === "browser-use") &&
          !shouldMountBrowserTabGuest(tab)
        ) {
          return <SuspendedBrowserSidePaneContent key={tab.id} tab={tab} />;
        }
        if (tab.type === "browser-use") {
          return (
            <BrowserUseSidePaneContent
              key={tab.id}
              tab={tab}
              onOpenPermissionSettings={onOpenBrowserPermissionSettings}
              isPanelVisible={isVisible}
              isSelected={tab.id === contentActiveTabId}
              isCurrentTask={tab.sessionId === sidePaneOwnerId}
              screenshotSurfaceRequest={
                screenshotSurfaceTabId === tab.id ? screenshotSurfaceRequest : null
              }
              // restoring guest 的完整 history 由 main 在 did-attach 后写入；
              // renderer 同时消费 initialUrl 会抢先提交导航，使 Chromium 拒绝 restore。
              initialUrl={tab.residency === "restoring" ? undefined : browserRestoreUrls[tab.id]}
              workspacePath={workspaceAbsPath}
              workspaceIdentity={workspaceIdentity}
              residencyGeneration={tab.residencyGeneration}
              onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
              onPageMetadataChange={(metadata) => onBrowserPageMetadataChange(tab.id, metadata)}
            />
          );
        }
        return (
          <TabsContent
            key={tab.id}
            value={tab.id}
            forceMount
            className={cn(
              "relative z-10 h-full min-h-0 bg-background data-[state=inactive]:hidden",
              mobileOverlay && "min-w-0",
            )}
          >
            {tab.type === "bash-output" ? (
              <BackgroundBashOutputSidePane
                tab={tab}
                visible={isVisible && tab.id === contentActiveTabId}
                onOpenCodeViewer={onOpenCodeViewer}
              />
            ) : tab.type === "subagent-session" ? (
              <SubagentSessionSidePane
                tab={tab}
                focused={isVisible && tab.id === contentActiveTabId}
                compactForRemoteControl={mobileOverlay}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onOpenCodeViewer={onOpenCodeViewer}
                onOpenFileLink={onOpenFileLink}
                onOpenSubagentSession={onOpenSubagentSession}
                onOpenBackgroundBash={onOpenBackgroundBash}
              />
            ) : tab.type === "subagent-directory" ? (
              <SubagentDirectorySidePane tab={tab} onOpenSubagentSession={onOpenSubagentSession} />
            ) : tab.type === "selection-side-chat" ? (
              <SelectionSideChatPane
                tab={tab}
                focused={isVisible && tab.id === contentActiveTabId}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onOpenCodeViewer={onOpenCodeViewer}
                onOpenFileLink={onOpenFileLink}
                onUnavailable={onCloseTab}
              />
            ) : tab.type === "plugin-ui" ? (
              <PluginUiSidePane
                tab={tab}
                visible={isVisible && tab.id === contentActiveTabId}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onCloseTab={onCloseTab}
              />
            ) : tab.type === "plan-detail" ? (
              <PlanDetailSidePane
                tab={tab}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onOpenCodeViewer={onOpenCodeViewer}
                onOpenFileLink={onOpenFileLink}
              />
            ) : tab.type === "workflow-run" ? (
              <WorkflowRunSidePane
                tab={tab}
                {...(onOpenWorkflowActorSession === undefined
                  ? {}
                  : { onOpenWorkflowActorSession })}
                {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact })}
                {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
                {...(onOpenWorkflowWorkspace === undefined ? {} : { onOpenWorkflowWorkspace })}
              />
            ) : tab.type === "workflow-directory" ? (
              // 类型分支必须先收窄，回调缺席在**分支内部**处理：把
              // `&& onOpenWorkflowRun` 写进条件会让这个 tab 类型继续留在后面
              // 那些分支的联合里（browser 分支于是拿它去读 residency）。
              onOpenWorkflowRun ? (
                <WorkflowRunDirectorySidePane tab={tab} onOpenWorkflowRun={onOpenWorkflowRun} />
              ) : null
            ) : tab.type === "workflow-actor-session" ? (
              <WorkflowActorSessionSidePane
                tab={tab}
                focused={isVisible && tab.id === contentActiveTabId}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onOpenCodeViewer={onOpenCodeViewer}
                onOpenFileLink={onOpenFileLink}
              />
            ) : tab.type === "workflow-workspace" ? (
              <WorkflowWorkspaceSidePane
                tab={tab}
                focused={isVisible && tab.id === contentActiveTabId}
                onOpenCodeViewer={onOpenCodeViewer}
              />
            ) : tab.type === "workflow-artifact" ? (
              // 「在工作区显示」复用 Git 面板那条文件树 reveal（同一个宿主回调），
              // 不新造第二条定位路径。
              <WorkflowArtifactSidePane
                tab={tab}
                onOpenBrowserUrl={onOpenBrowserUrl}
                {...(onRevealGitFileInTree === undefined
                  ? {}
                  : { onRevealFileInTree: onRevealGitFileInTree })}
              />
            ) : tab.type === "code-viewer" || tab.type === "file-manager" ? (
              <FileManagerPane
                markdownSelectionTarget={{
                  sessionId: activeTaskId,
                  workspaceKey,
                  draftScopeKey,
                }}
                source={tab.source}
                target={
                  tab.type === "file-manager"
                    ? tab.target
                    : {
                        workspacePath: tab.source.workspacePath ?? workspaceAbsPath,
                        workspaceIdentity: tab.source.workspacePath
                          ? tab.source.workspaceIdentity
                          : workspaceIdentity,
                        workspaceRemoteSessionId: tab.source.workspacePath
                          ? tab.source.workspaceRemoteSessionId
                          : workspaceRemoteSessionId,
                      }
                }
                mobileOverlay={mobileOverlay}
                canOpenLocalFileManager={Boolean(isDesktop)}
                onNavigate={(source) => onNavigateFileManager(tab.id, source)}
                onClose={() => onCloseTab(tab.id)}
                workspacePath={workspaceAbsPath}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onOpenCodeViewer={onOpenCodeViewer}
                // inactive/窄条/resize 中的 code preview 不应继续让
                // @pierre/diffs 的千行 Shadow DOM 参与布局；这里只裁剪 body，保留 tab/source/file state。
                renderHeavyContent={shouldRenderPreviewPaneHeavyContent({
                  isActiveTab: tab.id === contentActiveTabId,
                  // video/audio 原生全屏会触发 resize，resize settling
                  // 期间必须保持当前媒体节点挂载，否则浏览器会立即退出全屏。
                  isMediaPreview:
                    tab.source?.type === "media" ||
                    (tab.source?.type === "file" && inferMediaPreview(tab.source.path) !== null),
                  isMobileOverlay: mobileOverlay,
                  isResizeSettling: isWindowResizeSettling,
                  isSidePaneVisible: isVisible,
                  visibleInlineSizePx: sidePaneVisibleInlineSizePx,
                })}
              />
            ) : tab.type === "git" ? (
              <GitPane
                workspacePath={workspaceAbsPath}
                workspaceIdentity={workspaceIdentity}
                workspaceRemoteSessionId={workspaceRemoteSessionId}
                gitState={gitState}
                isDesktop={isDesktop}
                selectedSourceId={activeGitSourceId}
                fileChangeFindActiveIndex={fileChangeFindActiveIndex}
                fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
                fileChangeFindQuery={fileChangeFindQuery}
                onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
                onSelectSource={onSelectGitSource}
                onClose={onCloseGit}
                onRefresh={onRefreshGit}
                onRevealFileInTree={onRevealGitFileInTree}
              />
            ) : tab.type === "treemapping" ? (
              <TreemappingPane
                activeTaskId={activeTaskId}
                workspacePath={workspaceAbsPath}
                workspaceIdentity={workspaceIdentity}
                source={tab.source ?? { kind: "current" }}
              />
            ) : tab.type === "whiteboard" ? (
              <WhiteboardPane
                workspacePath={workspaceAbsPath}
                workspaceIdentity={workspaceIdentity}
                boardId={tab.boardId}
              />
            ) : tab.type === "model-trajectory" ? (
              <ModelTrajectoryPane
                taskId={tab.taskId}
                title={tab.title}
                workspacePath={workspaceAbsPath}
                workspaceIdentity={workspaceIdentity}
                onClose={() => onCloseTab(tab.id)}
              />
            ) : tab.type === "new-tab" ? (
              newTabContent
            ) : tab.type === "plugin-market" ? (
              <ServiceProvider services={services}>
                <div className="h-full min-w-0 overflow-y-auto p-4">
                  <PluginStorePage
                    onBack={onPluginMarketBack ? () => onPluginMarketBack(tab.id) : undefined}
                    embedded
                    onCreateTask={onCreateTask}
                    workspacePath={workspaceAbsPath}
                    workspaceIdentity={workspaceIdentity}
                    remoteSessionId={workspaceRemoteSessionId}
                    sessionId={activeTaskId}
                    isDesktop={isDesktop}
                    isWindowsDesktop={isWindowsDesktop}
                    isMacDesktop={isMacDesktop}
                    isWebRemoteControl={mobileOverlay}
                  />
                </div>
              </ServiceProvider>
            ) : tab.type === "developer-tools" ? (
              <ServiceProvider services={services}>
                <DeveloperToolsPane
                  workspacePath={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  taskId={activeTaskId}
                  enabled={isVisible && tab.id === contentActiveTabId}
                />
              </ServiceProvider>
            ) : tab.type === "agent-workbench" ? (
              <ServiceProvider services={services}>
                <AgentWorkbenchView
                  workspacePath={tab.workspacePath || workspaceAbsPath}
                  workspaceIdentity={tab.workspaceIdentity ?? workspaceIdentity}
                  workspaceName={workspaceAbsPath}
                  remoteSessionId={tab.remoteSessionId ?? workspaceRemoteSessionId}
                  runActivity={
                    activeTaskId ? (
                      <SubagentDirectorySidePane
                        tab={createSubagentDirectorySidePaneTab({
                          workspaceKey,
                          workspacePath: tab.workspacePath || workspaceAbsPath,
                          workspaceIdentity: tab.workspaceIdentity ?? workspaceIdentity,
                          remoteSessionId: tab.remoteSessionId ?? workspaceRemoteSessionId,
                          rootSessionId: activeTaskId,
                          parentSessionId: activeTaskId,
                        })}
                        onOpenSubagentSession={onOpenSubagentSession}
                      />
                    ) : null
                  }
                />
              </ServiceProvider>
            ) : tab.type === "terminal" ? (
              <SidePaneTerminalPane
                services={services}
                sessionId={tab.id}
                workspaceKey={workspaceKey}
                cwd={tab.cwd ?? workspaceAbsPath}
                isVisible={isVisible && tab.id === contentActiveTabId}
                isWindowsDesktop={isWindowsDesktop}
                onOpenBrowserUrl={onOpenBrowserUrl}
              />
            ) : tab.type === "browser-permissions" ? (
              <BrowserSitePermissionsPage
                origin={tab.origin}
                isVisible={isVisible && tab.id === contentActiveTabId}
              />
            ) : (
              <HumanBrowserView
                browserKey={tab.id}
                onOpenPermissionSettings={onOpenBrowserPermissionSettings}
                agentOpened={tab.agentOpened}
                deferEmptyGuest
                isResidencyRestore={tab.residency === "restoring"}
                isVisible={isVisible && isBrowserOpen && tab.id === contentActiveTabId}
                isSelected={tab.id === contentActiveTabId}
                isCurrentTask={tab.ownerTaskId === sidePaneOwnerId}
                // restoring 只挂载不会提交 document 的 bootstrap URL，
                // 由 main 独占 pageState/URL 恢复事务。
                initialUrl={
                  tab.residency === "restoring"
                    ? undefined
                    : (browserRestoreUrls[tab.id] ?? tab.initialUrl)
                }
                faviconUrl={tab.faviconUrl}
                workspacePath={workspaceAbsPath}
                workspaceIdentity={workspaceIdentity}
                remoteSessionId={tab.remoteSessionId ?? workspaceRemoteSessionId}
                residencyGeneration={tab.residencyGeneration}
                sessionId={tab.ownerTaskId ?? "unscoped"}
                onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
                onPageMetadataChange={(metadata) => onBrowserPageMetadataChange(tab.id, metadata)}
                navigationRequest={
                  browserNavigationRequest?.targetTabId === tab.id
                    ? {
                        id: browserNavigationRequest.id,
                        url: browserNavigationRequest.url,
                      }
                    : null
                }
                onNavigationRequestHandled={onBrowserNavigationRequestHandled}
              />
            )}
          </TabsContent>
        );
      })}
    </>
  );
}
