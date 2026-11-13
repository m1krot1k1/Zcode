import { AUTOMATIONS_TOAST_ANCHOR_ID, AutomationsSection } from "@/settings/AutomationsSection.js";
import type { WorkspaceShellContext } from "@/app-shell/workspace-shell-layout/context.js";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

/**
 * 主视图主体：automations 中枢、插件商店、手机远控聊天页与桌面分屏聊天区。
 * 手机与桌面共用中枢/商店主体，聊天区因 pane 宿主不同保持两份映射。
 */
export function buildAutomationsMainBody({ props, model }: WorkspaceShellContext) {
  const {
    isDesktop,
    onOpenAutomationConsumed,
    openAutomationId,
    openAutomationTab,
    onOpenWorkflowConsumed,
    openWorkflow,
    workspaceAbsPath,
    workspaceIdentity,
  } = props;
  const {
    handleCreateAutomationInChat,
    handleNavigateToLaunchedRun,
    handleOpenSavedWorkflowArtifact,
    handleOpenSavedWorkflowRun,
    intl,
    selectTaskInChat: handleSelectTaskInChat,
    workspaceOnlyResetKeys,
  } = model;
  return (
    <main
      id={AUTOMATIONS_TOAST_ANCHOR_ID}
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
    >
      <AutomationsMainBreadcrumbFrame
        isDesktop={Boolean(isDesktop)}
        sectionLabel={intl.formatMessage({
          id: "settings.automations.title",
        })}
        ariaLabel={intl.formatMessage({
          id: "automations.breadcrumbLabel",
        })}
      >
        <div
          // 修复原因：不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
          // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <ScopedErrorBoundary
            scope="automations-main"
            resetKeys={workspaceOnlyResetKeys}
            variant="panel"
            className="min-h-full"
          >
            <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
              <AutomationsSection
                workspacePath={workspaceAbsPath}
                workspaceIdentity={workspaceIdentity}
                onCreateViaChat={handleCreateAutomationInChat}
                onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                openAutomationId={openAutomationId}
                openAutomationTab={openAutomationTab}
                onOpenAutomationConsumed={onOpenAutomationConsumed}
                openWorkflow={openWorkflow}
                onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                onOpenSession={({ sessionId, workspacePath, workspaceIdentity }) =>
                  handleSelectTaskInChat(workspacePath, sessionId, workspaceIdentity)
                }
              />
            </div>
          </ScopedErrorBoundary>
        </div>
      </AutomationsMainBreadcrumbFrame>
    </main>
  );
}

export function buildPluginStoreMainBody({ props, model }: WorkspaceShellContext) {
  const {
    activeTaskId,
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    pluginStoreOpenVersion,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  } = props;
  const { createTaskInChat: handleCreateTaskInChat, intl, isWebRemoteControlShell } = model;
  return (
    <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <AutomationsMainBreadcrumbFrame
        isDesktop={Boolean(isDesktop)}
        sectionLabel={intl.formatMessage({
          id: "workspace.openPluginsSettings",
        })}
        ariaLabel={intl.formatMessage({
          id: "settings.breadcrumbLabel",
        })}
      >
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
            <PluginStorePage
              isDesktop={isDesktop}
              isMacDesktop={isMacDesktop}
              isWindowsDesktop={isWindowsDesktop}
              isWebRemoteControl={isWebRemoteControlShell}
              key={`plugin-store:${pluginStoreOpenVersion}`}
              workspacePath={workspaceAbsPath}
              workspaceIdentity={workspaceIdentity}
              onCreateTask={handleCreateTaskInChat}
              sessionId={activeTaskId}
              remoteSessionId={workspaceRemoteSessionId}
            />
          </div>
        </div>
      </AutomationsMainBreadcrumbFrame>
    </main>
  );
}

export function buildRemoteChatBody({ props, model }: WorkspaceShellContext) {
  const {
    activeTaskChangeSummary,
    activeTaskId,
    activeTaskProvider,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    conversationFindQuery,
    gitState,
    gitWorktreeChangeSummary,
    gitWorktreeReviewSourceId,
    handleAutoOpenAssistantPptx,
    handleOpenAutomations,
    handleOpenBackgroundBash,
    handleOpenBrowserUrl,
    handleOpenCodeViewer,
    handleOpenGitReview,
    handleOpenPlanDetail,
    handleOpenSubagentDirectory,
    handleOpenSubagentSession,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowArtifact,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowWorkspace,
    handleRefreshGit,
    handleSyncSubagentSessionTabs,
    isDesktop,
    isSidePaneOpen,
    isWorkspaceVisible,
    onConversationFindMatchStateChange,
    onSearchResultHighlightDone,
    onSummaryPanelVariantOverrideChange,
    summaryPanelVariantOverride,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceReadOnlyReason,
  } = props;
  const {
    activeSearchResultHighlightRequest,
    draftComposerHeader,
    gitDirtyFileCount,
    handleOpenMarkdownFileLink,
    handleV4SessionCreated,
    handleV4SessionDeleted,
    isSidePaneVisible,
    isWebRemoteControlShell,
    workspaceDraftResetKeys,
  } = model;
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* Bugfix: 手机远控聊天页中间层必须继续提供 flex 高度链。
                只有 h-full 的普通 block 会让 ChatView 的 flex-1 失效，草稿空态贴顶且内部滚动被外层裁掉。 */}
      <ScopedErrorBoundary
        scope="workspace-chat"
        resetKeys={workspaceDraftResetKeys}
        variant="panel"
        className="h-full"
      >
        {/* Bugfix(2026-07-05, M3 验收)：同桌面布局——绑定 activeTaskId 而非 meta 派生的
                  activeSessionId，避免新建 v4 session 因 meta 缓存未刷新而停在 draft。 */}
        {/* Bug 根因：计划详情功能只给桌面 V4WorkspaceChatArea 接了回调，手机卡片因此
                  显示按钮却无法打开抽屉；两端必须复用同一个 renderer Side Pane 入口。 */}
        <V4ChatPane
          allowEscapeStopOutsidePane={isWorkspaceVisible && !isSidePaneOpen && !isSidePaneVisible}
          readOnly={Boolean(workspaceReadOnlyReason)}
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          isDesktop={isDesktop === true}
          compactForRemoteControl={isWebRemoteControlShell}
          sessionId={activeTaskId}
          provider={activeTaskProvider ?? undefined}
          onSessionCreated={handleV4SessionCreated}
          onSessionDeleted={handleV4SessionDeleted}
          draftComposerHeader={draftComposerHeader}
          gitSummary={gitState.summary}
          gitDirtyFileCount={gitDirtyFileCount}
          gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
          gitWorktreeChangeSummary={gitWorktreeChangeSummary}
          activeTaskChangeSummary={activeTaskChangeSummary}
          summaryPanelVariantOverride={summaryPanelVariantOverride}
          onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
          onRefreshGit={handleRefreshGit}
          onOpenGitReview={handleOpenGitReview}
          onOpenBrowserUrl={handleOpenBrowserUrl}
          onOpenAutomationsMain={handleOpenAutomations}
          onOpenCodeViewer={handleOpenCodeViewer}
          onAutoOpenAssistantPptx={
            isDesktop && !isWebRemoteControlShell ? handleAutoOpenAssistantPptx : undefined
          }
          onOpenFileLink={handleOpenMarkdownFileLink}
          onOpenBackgroundBash={handleOpenBackgroundBash}
          onOpenSubagentSession={handleOpenSubagentSession}
          onOpenSubagentDirectory={handleOpenSubagentDirectory}
          onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
          onOpenPlanDetail={handleOpenPlanDetail}
          onOpenWorkflowRun={handleOpenWorkflowRun}
          onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
          onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
          onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
          onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
          conversationFindQuery={conversationFindQuery}
          conversationFindActiveIndex={conversationFindActiveIndex}
          conversationFindNavigationRequestId={conversationFindNavigationRequestId}
          onConversationFindMatchStateChange={onConversationFindMatchStateChange}
          searchResultHighlightRequest={activeSearchResultHighlightRequest}
          onSearchResultHighlightDone={onSearchResultHighlightDone}
        />
      </ScopedErrorBoundary>
    </div>
  );
}

export function buildDesktopChatBody({ props, model }: WorkspaceShellContext) {
  const {
    activeTaskChangeSummary,
    activeTaskId,
    activeTaskProvider,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    conversationFindQuery,
    gitState,
    gitWorktreeChangeSummary,
    gitWorktreeReviewSourceId,
    handleAutoOpenAssistantPptx,
    handleOpenAutomations,
    handleOpenBackgroundBash,
    handleOpenBrowserUrl,
    handleOpenCodeViewer,
    handleOpenGitReview,
    handleOpenPlanDetail,
    handleOpenSelectionSideChat,
    handleOpenSubagentDirectory,
    handleOpenSubagentSession,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowArtifact,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowWorkspace,
    handleRefreshGit,
    handleSyncSubagentSessionTabs,
    isDesktop,
    isSidePaneOpen,
    isWorkspaceVisible,
    onConversationFindMatchStateChange,
    onSearchResultHighlightDone,
    onSummaryPanelVariantOverrideChange,
    summaryPanelVariantOverride,
    taskFindDialogProps,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceReadOnlyReason,
    workspaceRemoteSessionId,
  } = props;
  const {
    activeSearchResultHighlightRequest,
    activeSelectionSideChatSessionId,
    draftComposerHeader,
    gitDirtyFileCount,
    handleOpenMarkdownFileLink,
    handlePaneActiveSessionChange,
    handleV4SessionCreated,
    handleV4SessionDeleted,
    isSidePaneVisible,
    isWebRemoteControlShell,
    setDraftHeaderDropTargetController,
    workspaceDraftResetKeys,
  } = model;
  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <TaskFindDialog {...taskFindDialogProps} placement="chat" />
      <ScopedErrorBoundary
        scope="workspace-chat"
        resetKeys={workspaceDraftResetKeys}
        variant="panel"
        className="h-full"
      >
        {/* Bugfix(2026-07-05, M3 验收)：pane 绑定必须用原始选择态 activeTaskId，
                                  不能用 meta 派生的 activeSessionId——v4 createSession 刚建的会话
                                  不在 taskListCache/optimistic 缓存里，meta 解析为 null 会让 pane
                                  永远停在 draft。v4 语义下 sessionId ≡ taskId，meta 只服务 Header 显示。
                                  M5⑤：桌面主区升级为分屏宿主（Layout/Focus 两层）；primary pane
                                  绑定语义与 testid 契约（paneId=workspace-main）不变。 */}
        <V4WorkspaceChatArea
          allowEscapeStopOutsidePane={isWorkspaceVisible && !isSidePaneOpen && !isSidePaneVisible}
          readOnly={Boolean(workspaceReadOnlyReason)}
          foregroundEnabled={isWorkspaceVisible}
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          isDesktop={isDesktop === true}
          remoteSessionId={workspaceRemoteSessionId}
          compactForRemoteControl={isWebRemoteControlShell}
          sessionId={activeTaskId}
          activeSelectionSideChatSessionId={activeSelectionSideChatSessionId}
          provider={activeTaskProvider ?? undefined}
          onSessionCreated={handleV4SessionCreated}
          onSessionDeleted={handleV4SessionDeleted}
          draftComposerHeader={draftComposerHeader}
          onPrimaryDraftDropTargetControllerChange={setDraftHeaderDropTargetController}
          gitSummary={gitState.summary}
          gitDirtyFileCount={gitDirtyFileCount}
          activeTaskChangeSummary={activeTaskChangeSummary}
          gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
          gitWorktreeChangeSummary={gitWorktreeChangeSummary}
          summaryPanelVariantOverride={summaryPanelVariantOverride}
          onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
          onRefreshGit={handleRefreshGit}
          onOpenGitReview={handleOpenGitReview}
          onPaneActiveSessionChange={handlePaneActiveSessionChange}
          onOpenBrowserUrl={handleOpenBrowserUrl}
          onOpenAutomationsMain={handleOpenAutomations}
          onOpenCodeViewer={handleOpenCodeViewer}
          onAutoOpenAssistantPptx={
            isDesktop && !isWebRemoteControlShell ? handleAutoOpenAssistantPptx : undefined
          }
          onOpenBackgroundBash={handleOpenBackgroundBash}
          onOpenSubagentSession={handleOpenSubagentSession}
          onOpenSubagentDirectory={handleOpenSubagentDirectory}
          onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
          onOpenSelectionSideChat={handleOpenSelectionSideChat}
          onOpenPlanDetail={handleOpenPlanDetail}
          onOpenWorkflowRun={handleOpenWorkflowRun}
          onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
          onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
          onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
          onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
          onOpenFileLink={handleOpenMarkdownFileLink}
          conversationFindQuery={conversationFindQuery}
          conversationFindActiveIndex={conversationFindActiveIndex}
          conversationFindNavigationRequestId={conversationFindNavigationRequestId}
          onConversationFindMatchStateChange={onConversationFindMatchStateChange}
          searchResultHighlightRequest={activeSearchResultHighlightRequest}
          onSearchResultHighlightDone={onSearchResultHighlightDone}
        />
      </ScopedErrorBoundary>
    </main>
  );
}
