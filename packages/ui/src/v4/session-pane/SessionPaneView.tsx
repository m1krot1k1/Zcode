// SessionPane 拆分：pane 主体 JSX。
// 纯渲染函数保持原 DOM 结构与 props 顺序；scope 由 SessionPane 在同一渲染帧内构造。
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";
import { ConversationSharePopover } from "@/conversation-share-interaction/ConversationSharePopover.js";
import type { ConversationSharePreflightState } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";
import type {
  OpenBackgroundBashSideTabRequest,
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenSubagentSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
} from "@/lib/workspaceSidePane.js";
import { PluginUiSessionProvider } from "@/plugin-ui/index.js";
import type { ConversationPanePresentationValue } from "@/side-pane-full-view/contract.js";
import type { Theme } from "@/theme.js";
import { BotGroupDeliveryProvider } from "@/v4/BotGroupDeliveryAction.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { ConversationComposerSendOptions } from "@/v4/ConversationComposer.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ConversationHeader } from "@/v4/ConversationHeader.js";
import type { PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { hasOlderRows } from "@/v4/conversationProjectionStore.js";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationShareImportNotice } from "@/v4/ConversationShareImportNotice.js";
import { resolveConversationSelectionTooltipEnabled } from "@/v4/conversationShareModePolicy.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationLatestTurnSummary } from "@/v4/conversationTimelineLiveTail.js";
import type {
  ConversationTurnNavigatorHydrationResult,
  ConversationTurnNavigatorItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { PendingGuideQueueProjection } from "@/v4/pendingGuideProjection.js";
import type { useSessionPaneTurnActions } from "@/v4/session-pane/useSessionPaneTurnActions.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { SessionPluginReferenceIconBoundary } from "@/v4/SessionPluginReferenceIconProvider.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";
import type { ImportedConversationShare } from "@zcode/services";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  Locale,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { TID_CHAT_EMPTY, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import type { ConversationRowTarget, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { Hand } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export interface RenderSessionPaneViewParams {
  paneId: string;
  sessionId: string | null;
  rootSessionId: string | undefined;
  readOnly: boolean;
  selectionSideChat: boolean;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  remoteSessionId: string | null | undefined;
  compactForRemoteControl: boolean;
  focused: boolean;
  onClosePane: (() => void) | undefined;
  workspaceBadge: PaneWorkspaceBadge | undefined;
  gitSummary: GitRepositorySummary | null | undefined;
  gitDirtyFileCount: number | undefined;
  gitWorktreeReviewSourceId: GitChangeSourceId | null | undefined;
  gitWorktreeChangeSummary: { added: number; removed: number } | null | undefined;
  activeTaskChangeSummary: ZCodeTaskChangeSummary | null | undefined;
  onRefreshGit: (() => void) | undefined;
  onOpenGitReview: ((sourceId?: GitChangeSourceId) => void) | undefined;
  onOpenBrowserUrl: ((url: string) => void) | undefined;
  onOpenCodeViewer: ((source: CodeViewerSource) => void) | undefined;
  onOpenFileLink: ((target: MessageFileLinkTarget) => void) | undefined;
  onOpenSubagentSession: ((request: OpenScopedSubagentSideTabRequest) => void) | undefined;
  onOpenBackgroundBash: ((request: OpenBackgroundBashSideTabRequest) => void) | undefined;
  onOpenSubagentDirectory:
    | ((request: OpenScopedSubagentDirectorySideTabRequest) => void)
    | undefined;
  onOpenPlanDetail: ((request: OpenScopedPlanDetailSideTabRequest) => void) | undefined;
  onOpenWorkflowRun: ((request: OpenScopedWorkflowRunSideTabRequest) => void) | undefined;
  onOpenWorkflowRunDirectory:
    | ((request: OpenScopedWorkflowRunDirectorySideTabRequest) => void)
    | undefined;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange: ((state: ConversationFindMatchState) => void) | undefined;
  searchResultHighlightRequest: ChatSearchResultHighlightRequest | null | undefined;
  onSearchResultHighlightDone: ((requestId: number) => void) | undefined;
  paneRef: RefObject<HTMLDivElement | null>;
  remoteAvailable: boolean;
  intl: IntlInstance;
  locale: Locale;
  lease: SessionLease | null;
  state: ConversationStoreState;
  snapshot: ConversationSnapshot | null;
  runtimeReady: boolean;
  sharePublishing: boolean;
  shareActive: boolean;
  shareSelectionPanelVisible: boolean;
  dismissShareSelectionPanel: () => void;
  pendingShareRowIds: Set<number>;
  pendingShareTurnCount: number;
  shareItems: Array<ConversationTurnNavigatorItem>;
  sharePreflight: ConversationSharePreflightState;
  sessionLeaseReady: boolean;
  pluginReferenceIconsEnabled: boolean;
  terminalSectionOpen: boolean;
  setTerminalSectionOpen: Dispatch<SetStateAction<boolean>>;
  agentSectionOpen: boolean;
  setAgentSectionOpen: Dispatch<SetStateAction<boolean>>;
  workflowSectionOpen: boolean;
  setWorkflowSectionOpen: Dispatch<SetStateAction<boolean>>;
  effectiveDropTargetController: ConversationDropTargetController | null;
  isMobileTextInputViewport: boolean;
  timelineScrollToBottomRef: RefObject<(() => void) | null>;
  timelineScrollToQueryRef: RefObject<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >;
  conversationLayoutContainerRef: RefObject<HTMLDivElement | null>;
  effectiveSummaryPanelVariantOverride: ChatViewSummaryPanelVariant | null;
  handleSummaryPanelVariantChange: (variant: ChatViewSummaryPanelVariant | null) => void;
  blockingInteractionId: string | null;
  panePresentation: ConversationPanePresentationValue;
  isFloatingPresentation: boolean;
  handleFloatingLatestTurnSummaryChange: (summary: ConversationLatestTurnSummary) => void;
  selectionSideActionBlocked: boolean;
  timelineScrollMemoryKey: string | null;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  handleOpenSubagentSession: (request: OpenSubagentSideTabRequest) => void;
  handleOpenSubagentDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenSubagentDirectorySideTabRequest,
  ) => void;
  handleOpenPlanDetail: (request: OpenPlanDetailSideTabRequest) => void;
  endedWorkflowRunCount: number;
  handleOpenWorkflowRunFromPanel: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  handleOpenWorkflowRunDirectoryFromPanel: (
    request: OpenWorkflowRunDirectorySideTabRequest,
  ) => void;
  handleAddSelectionToCurrentTask: (reference: ConversationSelectionReference) => void;
  handleOpenSelectionSideConversation: (
    reference?: ConversationSelectionReference,
    forceNew?: boolean,
  ) => Promise<void>;
  handleCancelBackgroundWork: (workId: string) => void;
  rowContext: ConversationRowRenderContext;
  dispatchSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<"blocked" | "confirmationRequired" | "sent" | undefined>;
  handleFork: (target: ConversationRowTarget) => void;
  handleEdit: ReturnType<typeof useSessionPaneTurnActions>["handleEdit"];
  handleRetry: (target: ConversationRowTarget) => void;
  handleAssistantFeedback: (
    target: ConversationRowTarget,
    feedback: "like" | "dislike" | null,
  ) => Promise<boolean>;
  handlePauseGoal: () => void;
  handleResumeGoal: () => void;
  handleRetrySubscribe: () => void;
  handleLoadOlder: () => Promise<void> | undefined;
  handleLoadAllOlder: () => Promise<ConversationTurnNavigatorHydrationResult>;
  errored: boolean;
  retryActionsEnabled: boolean;
  forkActionsEnabled: boolean;
  editActionsEnabled: boolean;
  isDraft: boolean;
  timelineSnapshot: ConversationSnapshot | null;
  importedShare: ImportedConversationShare | null;
  importedShareArtifactNames: Map<string, string>;
  importedShareArtifactWorkspaceRelativePaths: Map<string, string>;
  handleOpenImportedShareUrl: () => void;
  initialDraftConfigForDiagnostics:
    | Partial<{
        provider: string;
        model: string;
        thought: string;
        thoughtLevels: Array<string>;
        followupMode: "queue" | "guide";
        mode: string;
        modelSelection?:
          | {
              providerId: string;
              modelId: string;
              options?:
                | { reasoningLevel?: string | undefined; providerFallback?: "disabled" | undefined }
                | undefined;
            }
          | undefined;
        planEnabled?: boolean | undefined;
        permissionGrant?: { interactionId: string } | undefined;
        planTransition?: { toolCallId: string; planEnabled: boolean } | undefined;
      }>
    | undefined;
  subagents: {
    revision: number;
    childSessionIds: Array<string>;
    running: Array<{
      childSessionId: string;
      subagentType: string;
      title: string;
      status: "running" | "waiting" | "blocked";
      agentId?: string | undefined;
      toolCallId?: string | undefined;
      summary?: string | undefined;
      startedAt?: number | undefined;
    }>;
    endedTotal: number;
  };
  statusPanelLayout: "auto" | "inline" | "none";
  controlLastError: ConversationSnapshot["control"]["lastError"];
  handleShareCancel: () => void;
  handleConfirmShareSelection: () => void;
  handleShareSelectionToggle: (rowId: number) => void;
  handleShareSelectionInspect: (target: { unitIndex: number; rowId: number }) => void;
  handleSelectAllShareRows: (selected: boolean) => void;
  pendingGuideProjection: PendingGuideQueueProjection | null;
  sharePopoverContent: JSX.Element | null;
  pluginUiUploadAttachment: (input: {
    fileName: string;
    mime: string;
    dataBase64: string;
  }) => Promise<{ ref: string; fileName: string; mime: string; bytes: number }>;
  conversationBottomDock: JSX.Element | null;
}

export function renderSessionPaneView(params: RenderSessionPaneViewParams) {
  const {
    paneId,
    sessionId,
    rootSessionId,
    readOnly,
    selectionSideChat,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    compactForRemoteControl,
    focused,
    onClosePane,
    workspaceBadge,
    gitSummary,
    gitDirtyFileCount,
    gitWorktreeReviewSourceId,
    gitWorktreeChangeSummary,
    activeTaskChangeSummary,
    onRefreshGit,
    onOpenGitReview,
    onOpenBrowserUrl,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenSubagentSession,
    onOpenBackgroundBash,
    onOpenSubagentDirectory,
    onOpenPlanDetail,
    onOpenWorkflowRun,
    onOpenWorkflowRunDirectory,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
    paneRef,
    remoteAvailable,
    intl,
    locale,
    lease,
    state,
    snapshot,
    runtimeReady,
    sharePublishing,
    shareActive,
    shareSelectionPanelVisible,
    dismissShareSelectionPanel,
    pendingShareRowIds,
    pendingShareTurnCount,
    shareItems,
    sharePreflight,
    sessionLeaseReady,
    pluginReferenceIconsEnabled,
    terminalSectionOpen,
    setTerminalSectionOpen,
    agentSectionOpen,
    setAgentSectionOpen,
    workflowSectionOpen,
    setWorkflowSectionOpen,
    effectiveDropTargetController,
    isMobileTextInputViewport,
    timelineScrollToBottomRef,
    timelineScrollToQueryRef,
    conversationLayoutContainerRef,
    effectiveSummaryPanelVariantOverride,
    handleSummaryPanelVariantChange,
    blockingInteractionId,
    panePresentation,
    isFloatingPresentation,
    handleFloatingLatestTurnSummaryChange,
    selectionSideActionBlocked,
    timelineScrollMemoryKey,
    theme,
    codePreviewSettings,
    handleOpenSubagentSession,
    handleOpenSubagentDirectory,
    handleOpenPlanDetail,
    endedWorkflowRunCount,
    handleOpenWorkflowRunFromPanel,
    handleOpenWorkflowRunDirectoryFromPanel,
    handleAddSelectionToCurrentTask,
    handleOpenSelectionSideConversation,
    handleCancelBackgroundWork,
    rowContext,
    dispatchSendText,
    handleFork,
    handleEdit,
    handleRetry,
    handleAssistantFeedback,
    handlePauseGoal,
    handleResumeGoal,
    handleRetrySubscribe,
    handleLoadOlder,
    handleLoadAllOlder,
    errored,
    retryActionsEnabled,
    forkActionsEnabled,
    editActionsEnabled,
    isDraft,
    timelineSnapshot,
    importedShare,
    importedShareArtifactNames,
    importedShareArtifactWorkspaceRelativePaths,
    handleOpenImportedShareUrl,
    initialDraftConfigForDiagnostics,
    subagents,
    statusPanelLayout,
    controlLastError,
    handleShareCancel,
    handleConfirmShareSelection,
    handleShareSelectionToggle,
    handleShareSelectionInspect,
    handleSelectAllShareRows,
    pendingGuideProjection,
    sharePopoverContent,
    pluginUiUploadAttachment,
    conversationBottomDock,
  } = params;

  return (
    <PluginUiSessionProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      sessionId={runtimeReady ? sessionId : null}
      readOnly={readOnly || !runtimeReady}
      sendText={dispatchSendText}
      uploadAttachment={pluginUiUploadAttachment}
      projectionStore={sessionLeaseReady ? lease?.store : null}
    >
      <div
        ref={paneRef}
        data-testid={testId(TID_V4_SESSION_PANE, paneId)}
        data-session-id={sessionId ?? "draft"}
        data-initial-draft-provider={initialDraftConfigForDiagnostics?.provider ?? ""}
        data-initial-draft-model={initialDraftConfigForDiagnostics?.model ?? ""}
        data-projection-seq={snapshot?.seq ?? ""}
        data-running-subagent-ids={subagents.running.map((item) => item.childSessionId).join(",")}
        data-running-subagent-work-ids={(snapshot?.backgroundWorks ?? [])
          .filter((work) => work.kind === "subagent" && work.status === "running")
          .map((work) => work.childSessionId ?? work.workId)
          .join(",")}
        data-v4-conversation-drop-target="true"
        onDragOver={effectiveDropTargetController?.onDragOver}
        onDragLeave={effectiveDropTargetController?.onDragLeave}
        onDrop={effectiveDropTargetController?.onDrop}
        className={cn(
          "relative flex h-full min-h-0 flex-col",
          compactForRemoteControl && "min-w-0",
        )}
      >
        {effectiveDropTargetController?.active ? (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>
                {intl.formatMessage({
                  id:
                    effectiveDropTargetController.kind === "workspace"
                      ? "chat.composer.workspaceFileDragHint"
                      : "chat.attachments.dragHint",
                })}
              </span>
            </div>
          </div>
        ) : null}
        <ConversationHeader
          title={snapshot?.meta.title ?? ""}
          onClosePane={onClosePane}
          workspaceBadge={workspaceBadge}
        />

        <div
          ref={conversationLayoutContainerRef}
          className={cn(
            "@container/conversation relative flex min-h-0 flex-1 flex-col",
            compactForRemoteControl && "min-w-0",
          )}
        >
          {sessionId && !compactForRemoteControl ? (
            <ConversationSharePopover
              key={sessionId}
              sessionId={sessionId}
              open={shareActive}
              publishing={sharePublishing}
              selecting={shareSelectionPanelVisible}
              onClose={handleShareCancel}
              onCancelSelection={dismissShareSelectionPanel}
            >
              {sharePopoverContent}
            </ConversationSharePopover>
          ) : null}
          <ConversationShareSelectionPanel
            visible={shareSelectionPanelVisible}
            items={shareItems}
            selectedRowIds={pendingShareRowIds}
            selectedCount={pendingShareTurnCount}
            preflight={sharePreflight}
            onSelectAllChange={handleSelectAllShareRows}
            onToggle={handleShareSelectionToggle}
            onInspect={handleShareSelectionInspect}
            onConfirm={handleConfirmShareSelection}
            onCancel={dismissShareSelectionPanel}
          />
          {!isDraft ? (
            <ConversationStatusPanel
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              gitSummary={gitSummary}
              gitDirtyFileCount={gitDirtyFileCount}
              gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
              gitWorktreeChangeSummary={gitWorktreeChangeSummary}
              activeTaskChangeSummary={activeTaskChangeSummary}
              goal={selectionSideChat ? null : (snapshot?.goal ?? null)}
              sessionPlans={state.sessionPlans}
              plan={snapshot?.plan ?? null}
              backgroundWorks={snapshot?.backgroundWorks ?? []}
              runningSubagents={subagents.running}
              workflowRuns={snapshot?.workflowRuns?.runs ?? []}
              endedSubagentCount={subagents.endedTotal}
              rootSessionId={rootSessionId ?? sessionId ?? undefined}
              parentSessionId={sessionId ?? undefined}
              isWebRemoteControl={compactForRemoteControl}
              isMobileViewport={isMobileTextInputViewport}
              layoutMode={statusPanelLayout}
              summaryPanelVariantOverride={effectiveSummaryPanelVariantOverride}
              onVariantChange={handleSummaryPanelVariantChange}
              terminalSectionOpen={terminalSectionOpen}
              onTerminalSectionOpenChange={setTerminalSectionOpen}
              agentSectionOpen={agentSectionOpen}
              onAgentSectionOpenChange={setAgentSectionOpen}
              workflowSectionOpen={workflowSectionOpen}
              onWorkflowSectionOpenChange={setWorkflowSectionOpen}
              onRefreshGit={onRefreshGit}
              onOpenGitReview={onOpenGitReview}
              onPauseGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.pauseGoal.allowed
                  ? handlePauseGoal
                  : undefined
              }
              onResumeGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.resumeGoal.allowed
                  ? handleResumeGoal
                  : undefined
              }
              onOpenPlanDetail={onOpenPlanDetail ? handleOpenPlanDetail : undefined}
              onOpenBackgroundBash={
                onOpenBackgroundBash && sessionId
                  ? (work) =>
                      onOpenBackgroundBash({
                        workspacePath,
                        workspaceIdentity: workspaceIdentity ?? undefined,
                        remoteSessionId: remoteSessionId ?? undefined,
                        rootSessionId: rootSessionId ?? sessionId,
                        sessionId,
                        workId: work.workId,
                        title: work.title,
                      })
                  : undefined
              }
              onCancelBackgroundWork={readOnly ? undefined : handleCancelBackgroundWork}
              onOpenSubagentSession={onOpenSubagentSession ? handleOpenSubagentSession : undefined}
              onOpenSubagentDirectory={
                onOpenSubagentDirectory && !compactForRemoteControl
                  ? handleOpenSubagentDirectory
                  : undefined
              }
              onOpenWorkflowRun={
                onOpenWorkflowRun && sessionId ? handleOpenWorkflowRunFromPanel : undefined
              }
              endedWorkflowRunCount={endedWorkflowRunCount}
              onOpenWorkflowRunDirectory={
                onOpenWorkflowRunDirectory && !compactForRemoteControl
                  ? handleOpenWorkflowRunDirectoryFromPanel
                  : undefined
              }
            />
          ) : null}

          {readOnly && controlLastError ? (
            <div
              role="alert"
              data-testid="v4-subagent-readonly-error"
              className="mx-4 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-ui-base text-[var(--color-danger)]"
            >
              {controlLastError.message}
            </div>
          ) : null}

          {errored && remoteAvailable && sessionId ? (
            <SessionSubscriptionErrorPanel
              error={state.lastError ?? intl.formatMessage({ id: "chat.error.connectionLost" })}
              sessionId={sessionId}
              workspacePath={workspacePath}
              onReconnect={handleRetrySubscribe}
            />
          ) : (
            <SessionPluginReferenceIconBoundary
              enabled={pluginReferenceIconsEnabled}
              remoteSessionId={remoteSessionId}
              sessionId={sessionId}
              workspaceIdentity={workspaceIdentity}
              workspacePath={workspacePath}
            >
              <BotGroupDeliveryProvider
                taskId={sessionId}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
              >
                <ConversationTimeline
                  compactForRemoteControl={compactForRemoteControl}
                  scrollToBottomActionRef={timelineScrollToBottomRef}
                  scrollToQueryActionRef={timelineScrollToQueryRef}
                  selectionPanelLayoutContainerRef={conversationLayoutContainerRef}
                  rows={timelineSnapshot?.rows.window ?? []}
                  pendingGuides={timelineSnapshot ? pendingGuideProjection?.pendingGuides : []}
                  apiRetry={timelineSnapshot?.control.apiRetry ?? null}
                  totalCount={timelineSnapshot?.rows.totalCount ?? 0}
                  sessionKey={sessionId ?? "draft"}
                  scrollMemoryKey={timelineScrollMemoryKey}
                  rowContext={rowContext}
                  onFork={forkActionsEnabled ? handleFork : undefined}
                  onRetry={retryActionsEnabled ? handleRetry : undefined}
                  onFeedbackChange={
                    !readOnly && !selectionSideChat && sessionId
                      ? handleAssistantFeedback
                      : undefined
                  }
                  onEdit={editActionsEnabled ? handleEdit : undefined}
                  canLoadOlder={timelineSnapshot ? hasOlderRows(timelineSnapshot) : false}
                  loadingOlder={timelineSnapshot ? state.loadingOlder : false}
                  onLoadOlder={handleLoadOlder}
                  onLoadAllOlder={handleLoadAllOlder}
                  turnNavigatorDirectoryRevision={state.turnNavigatorDirectoryRevision}
                  bottomDock={conversationBottomDock}
                  hideTurnNavigator={shareSelectionPanelVisible && !compactForRemoteControl}
                  backgroundScrollLocked={false}
                  headerSlot={
                    // unsupportedRowCount 也要开这个门：整份副本的行都被本 build 跳过时
                    // rows 为空，但只读块必须留下来显示「需要更新 ZCode」，不能整块消失。
                    importedShare &&
                    (importedShare.rows.length > 0 || importedShare.unsupportedRowCount > 0) ? (
                      <ConversationShareImportNotice
                        rows={importedShare.rows}
                        contentBlocks={importedShare.contentBlocks}
                        unsupportedRowCount={importedShare.unsupportedRowCount}
                        artifactNames={importedShareArtifactNames}
                        artifactWorkspaceRelativePaths={importedShareArtifactWorkspaceRelativePaths}
                        workspacePath={workspacePath}
                        {...(workspaceIdentity ? { workspaceIdentity } : {})}
                        {...(remoteSessionId ? { workspaceRemoteSessionId: remoteSessionId } : {})}
                        locale={locale}
                        theme={theme}
                        codePreviewSettings={codePreviewSettings}
                        onOpenShareUrl={onOpenBrowserUrl ? handleOpenImportedShareUrl : undefined}
                        onOpenFileLink={onOpenFileLink}
                        onOpenCodeViewer={onOpenCodeViewer}
                      />
                    ) : null
                  }
                  emptyState={
                    !remoteAvailable ? (
                      <div className="p-6 text-center text-ui-base text-foreground-subtle">
                        {intl.formatMessage({ id: "remote.conversation.placeholder" })}
                      </div>
                    ) : isDraft ? (
                      <div data-testid={TID_CHAT_EMPTY} className="w-full">
                        <ConversationDraftEmptyState
                          compactForRemoteControl={compactForRemoteControl}
                        />
                      </div>
                    ) : null
                  }
                  // 浮窗形态只露出底部输入区，空会话也必须贴底，不能居中。
                  centerEmptyStateWithDock={isDraft && !isFloatingPresentation}
                  floatingComposerDock={isFloatingPresentation}
                  onComposerDockHeightChange={
                    isFloatingPresentation && focused
                      ? panePresentation.reportComposerDockHeight
                      : undefined
                  }
                  onLatestTurnSummaryChange={
                    isFloatingPresentation && focused
                      ? handleFloatingLatestTurnSummaryChange
                      : undefined
                  }
                  compactEmptyStateWithDock={compactForRemoteControl}
                  summaryPanelLayout={statusPanelLayout}
                  conversationFindQuery={!isDraft && focused ? conversationFindQuery : ""}
                  conversationFindActiveIndex={
                    !isDraft && focused ? conversationFindActiveIndex : -1
                  }
                  conversationFindNavigationRequestId={
                    !isDraft && focused ? conversationFindNavigationRequestId : 0
                  }
                  onConversationFindMatchStateChange={
                    !isDraft && focused ? onConversationFindMatchStateChange : undefined
                  }
                  searchResultHighlightRequest={isDraft ? null : searchResultHighlightRequest}
                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                  sessionPhase={isDraft ? undefined : snapshot?.control.phase}
                  selectionActions={
                    !isDraft &&
                    sessionId &&
                    !readOnly &&
                    !selectionSideChat &&
                    !isMobileTextInputViewport
                      ? {
                          enabled: resolveConversationSelectionTooltipEnabled({
                            selectionActionsEnabled: focused && !blockingInteractionId,
                            partialShareActive: shareActive,
                          }),
                          sideActionDisabled: selectionSideActionBlocked,
                          onAddToCurrentTask: handleAddSelectionToCurrentTask,
                          onAskInSideChat: handleOpenSelectionSideConversation,
                        }
                      : undefined
                  }
                />
              </BotGroupDeliveryProvider>
            </SessionPluginReferenceIconBoundary>
          )}
        </div>
      </div>
    </PluginUiSessionProvider>
  );
}
