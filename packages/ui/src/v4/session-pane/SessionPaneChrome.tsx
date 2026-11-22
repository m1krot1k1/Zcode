// SessionPane 拆分：底部输入区渲染节点。
// 纯渲染函数（非组件）返回原有 JSX，不引入新的组件边界改变 reconciliation 身份。
import type { ChatErrorBannerModelConfigTarget } from "@/ChatErrorBanner.js";
import type { ConversationSharePreflightState } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import type { ModelSelectionRead } from "@/hooks/useModelSelectionView.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ModelConfigMissingUiError } from "@/lib/chatPrepareError.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type { CodingPlanUpgradeDialogContextValue } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { DEFAULT_CONVERSATION_SHARE_ACCESS_MODE } from "@/store/conversationShareSelectionStore.js";
import type {
  ConversationShareDisplayError,
  ConversationShareDisplayWarnings,
  ConversationShareProgressPhase,
  ConversationShareSelectionDraft,
} from "@/store/conversationShareSelectionStore.js";
import type { ComposerTextInsertRequest } from "@/store/zcodeSessionStoreTypes.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";
import { composerScopeKey } from "@/v4/composer/composerDraftStore.js";
import type {
  ComposerScope,
  PendingTaskDraft,
  V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import type {
  ComposerRestoreRequest,
  ConversationComposerSendOptions,
  ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import type { ConversationLatestTurnSummary } from "@/v4/conversationTimelineLiveTail.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import type { PendingGuideQueueProjection } from "@/v4/pendingGuideProjection.js";
import type { SessionQuotaBannerState } from "@/v4/sessionQuotaBannerState.js";
import type { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import { WorkspaceHookPendingBanner } from "@/v4/WorkspaceHookPendingBanner.js";
import type { ModelSelectionView } from "@zcode/services";
import type {
  AppSettings,
  CodingPlanBillingDiscountConfig,
  ConversationShareAccessMode,
  HighspeedCardSnapshot,
  PlanIdentitySnapshot,
} from "@zcode/shared";
import type {
  ConversationSnapshot,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ReactNode } from "react";

export interface RenderSessionPaneComposerParams {
  sessionId: string | null;
  readOnly: boolean;
  selectionSideChat: boolean;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  remoteSessionId: string | null | undefined;
  compactForRemoteControl: boolean;
  provider: "glm" | undefined;
  focused: boolean;
  telemetryVisible: boolean;
  draftComposerHeader: ReactNode;
  onOpenCodeViewer: ((source: CodeViewerSource) => void) | undefined;
  attachmentPut: (
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ) => Promise<V4AttachmentPutResult>;
  onRuntimeRestart: (listener: () => void) => () => void;
  onRuntimeLifecycle:
    | ((listener: (state: "available" | "unavailable") => void) => () => void)
    | undefined;
  newTaskComposerScope: ComposerScope;
  recoveringDraft: PendingTaskDraft | null;
  conversationTelemetryForegroundEnabled: boolean;
  snapshot: ConversationSnapshot | null;
  runtimeReady: boolean;
  handleDropTargetControllerChange: (controller: ConversationDropTargetController | null) => void;
  activeHighspeedCard: HighspeedCardSnapshot | null;
  highspeedActivationCardId: string | null;
  composerRestoreRequest: ComposerRestoreRequest | null;
  composerTextInsertRequest: ComposerTextInsertRequest | null;
  handleExternalTextInsertApplied: (requestId: number) => void;
  blockingInteractionId: string | null;
  isFloatingPresentation: boolean;
  floatingLatestTurnSummary: ConversationLatestTurnSummary | null;
  floatingTurnRunning: boolean;
  composerDraft: V4ComposerDraft;
  modelSelectionRead: ModelSelectionRead;
  draftConfig: ReturnType<typeof useDraftConfigControl>["draftConfig"];
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  setComposerOrchestrationMode: (enabled: boolean) => void;
  modelSelectionView: ModelSelectionView | null;
  createSubmissionFromComposer: () => ComposerSubmissionConfig | null;
  composerSubmissionReady: boolean;
  readPlanIdentitySnapshot: () => PlanIdentitySnapshot;
  appSlashCommands: Array<AppSlashCommand> | undefined;
  draftRuntimeRebuilding: boolean;
  effectiveSessionId: string | null;
  handleSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<ConversationComposerSendResult>;
  handleComposerDraftStateChange: (state: { hasContent: boolean; busy: boolean }) => void;
  handleComposerRestoreApplied: (requestId: number) => void;
  handleHighspeedActivationApplied: (cardId: string) => void;
  handleSelectModel: (
    modelProvider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void;
  handleSelectThought: (
    thought: string,
    _modelContext: { provider: string; model: string },
  ) => void;
  handleRecoverCustomModelSelection: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void>;
  handleSwitchMode: (mode: string) => void;
  handleSendCompressionCommand: (command: string) => void;
  handleStopFromButton: () => void;
  handleRetrySubscribe: () => void;
  connecting: boolean;
  queueEditActiveForCurrentComposer: boolean;
  isDraft: boolean;
  telemetryDraftConfig: Partial<{
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
  }>;
  runningBackgroundWorkCount: number;
  runningAgentCount: number;
  soleRunningWorkflowRunTarget: ConversationStatusPanelWorkflowRunTarget | null;
  handleOpenRunningBackgroundWorks: () => void;
  quotaBanner: {
    readonly state: SessionQuotaBannerState;
    readonly dismissKey: string | null;
    readonly dismissed: boolean;
    readonly dismiss: () => void;
    readonly markShown: () => void;
    readonly takesOverError: boolean;
    readonly upgradeProviderId: string | null;
    readonly upgradeActionLabelId: "chat.quota.action.renew" | "chat.quota.action.upgrade";
  };
  composerError: ZCodeUiError | ModelConfigMissingUiError | null;
  handleDismissComposerError: () => void;
  modelConfigTarget: ChatErrorBannerModelConfigTarget;
  handleOpenModelSettings: () => void;
  handleOpenModelUpgrade: () => void;
}

export function renderSessionPaneComposer(params: RenderSessionPaneComposerParams) {
  const {
    sessionId,
    readOnly,
    selectionSideChat,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    compactForRemoteControl,
    provider,
    focused,
    telemetryVisible,
    draftComposerHeader,
    onOpenCodeViewer,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    newTaskComposerScope,
    recoveringDraft,
    conversationTelemetryForegroundEnabled,
    snapshot,
    runtimeReady,
    handleDropTargetControllerChange,
    activeHighspeedCard,
    highspeedActivationCardId,
    composerRestoreRequest,
    composerTextInsertRequest,
    handleExternalTextInsertApplied,
    blockingInteractionId,
    isFloatingPresentation,
    floatingLatestTurnSummary,
    floatingTurnRunning,
    composerDraft,
    modelSelectionRead,
    draftConfig,
    replaceComposerDraft,
    updateComposerContent,
    setComposerOrchestrationMode,
    modelSelectionView,
    createSubmissionFromComposer,
    composerSubmissionReady,
    readPlanIdentitySnapshot,
    appSlashCommands,
    draftRuntimeRebuilding,
    effectiveSessionId,
    handleSendText,
    handleComposerDraftStateChange,
    handleComposerRestoreApplied,
    handleHighspeedActivationApplied,
    handleSelectModel,
    handleSelectThought,
    handleRecoverCustomModelSelection,
    handleSwitchMode,
    handleSendCompressionCommand,
    handleStopFromButton,
    handleRetrySubscribe,
    connecting,
    queueEditActiveForCurrentComposer,
    isDraft,
    telemetryDraftConfig,
    runningBackgroundWorkCount,
    runningAgentCount,
    soleRunningWorkflowRunTarget,
    handleOpenRunningBackgroundWorks,
    quotaBanner,
    composerError,
    handleDismissComposerError,
    modelConfigTarget,
    handleOpenModelSettings,
    handleOpenModelUpgrade,
  } = params;

  // subagent 右侧 child tab 是观察视图；复用普通 SessionPane 时
  // 若仍创建 composer，会让用户误以为可以直接向 child session 继续输入。
  const composerNode = readOnly ? null : (
    <ConversationComposer
      key="conversation-composer"
      // Snapshot 仍服务用量、路由与运行态；工具栏的 mode/model 只读下方 Composer Draft。
      snapshot={snapshot}
      sessionId={sessionId}
      // 草稿 taskId 仍为 null，但 prewarm 已经拥有独立 AgentRuntime。
      // 只给 Skill catalog 下发 effective id，避免 UI 扫到 prewarm runtime 尚未加载的新 Skill。
      skillCatalogSessionId={effectiveSessionId}
      draftMode={isDraft}
      draftConfig={draftConfig}
      composerDraft={composerDraft}
      rootDraftScopeKey={composerScopeKey(newTaskComposerScope)}
      replaceComposerDraft={replaceComposerDraft}
      onSetComposerOrchestrationMode={setComposerOrchestrationMode}
      submissionReady={composerSubmissionReady && runtimeReady && !recoveringDraft}
      updateComposerContent={updateComposerContent}
      createSubmissionFromComposer={createSubmissionFromComposer}
      telemetryDraftConfig={telemetryDraftConfig}
      // 完整视图浮窗默认是一条输入框：草稿项目栏不进入浮窗，切到对话 tab 再选择项目。
      contextHeader={isDraft && !isFloatingPresentation ? draftComposerHeader : undefined}
      centered={isDraft}
      layout={isFloatingPresentation ? "inline" : "stacked"}
      workingDurationMs={
        floatingTurnRunning ? floatingLatestTurnSummary?.workDurationMs : undefined
      }
      blockingRequestId={blockingInteractionId}
      listenAddToChatEvents={focused}
      externalTextInsertRequest={focused && sessionId === null ? composerTextInsertRequest : null}
      onExternalTextInsertApplied={handleExternalTextInsertApplied}
      autoFocusEnabled={focused}
      disabled={
        connecting ||
        draftRuntimeRebuilding ||
        queueEditActiveForCurrentComposer ||
        quotaBanner.state.blocksSubmit
      }
      isWebRemoteControl={compactForRemoteControl}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId ?? undefined}
      modelSelectionView={
        modelSelectionView ??
        (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null)
      }
      modelSelectionState={modelSelectionRead.state}
      modelSelectionReload={modelSelectionRead.reload}
      modelSelectionRefresh={modelSelectionRead.refresh}
      attachmentSessionId={effectiveSessionId}
      attachmentPut={attachmentPut}
      onRuntimeRestart={onRuntimeRestart}
      onRuntimeLifecycle={onRuntimeLifecycle}
      provider={provider}
      telemetryVisible={telemetryVisible && conversationTelemetryForegroundEnabled}
      readPlanIdentitySnapshot={readPlanIdentitySnapshot}
      onSendText={handleSendText}
      highspeedCard={activeHighspeedCard}
      highspeedActivationCardId={highspeedActivationCardId}
      onHighspeedActivationApplied={handleHighspeedActivationApplied}
      onDraftStateChange={handleComposerDraftStateChange}
      composerRestoreRequest={composerRestoreRequest}
      onComposerRestoreApplied={handleComposerRestoreApplied}
      onStop={handleStopFromButton}
      onSelectModel={handleSelectModel}
      onSelectThought={handleSelectThought}
      onSwitchMode={handleSwitchMode}
      onOpenRunningBackgroundWorks={
        sessionId && runningBackgroundWorkCount > 0 ? handleOpenRunningBackgroundWorks : undefined
      }
      backgroundWorkOpenTarget={soleRunningWorkflowRunTarget ? "workflow-run" : "panel"}
      // 父轮结束后 subagents.running 的目录投影可能短暂落后于仍为 running 的
      // backgroundWorks；Composer 若直接读目录会提前隐藏 Agent 入口。这里复用状态面板按
      // childSessionId 精确回退后的计数，让两个入口共享同一份运行态真值。
      runningSubagentCount={runningAgentCount}
      onRecoverCustomModelSelection={handleRecoverCustomModelSelection}
      onSendCompressionCommand={handleSendCompressionCommand}
      error={composerError}
      onDismissError={handleDismissComposerError}
      onRetryInitialization={handleRetrySubscribe}
      onOpenModelSettings={handleOpenModelSettings}
      onOpenModelUpgrade={handleOpenModelUpgrade}
      modelConfigTarget={modelConfigTarget}
      onOpenCodeViewer={onOpenCodeViewer}
      suppressGoalCommands={selectionSideChat}
      appSlashCommands={appSlashCommands}
      onDropTargetControllerChange={handleDropTargetControllerChange}
    />
  );

  return composerNode;
}

export interface RenderSessionPaneSharePopoverParams {
  sessionId: string | null;
  readOnly: boolean;
  intl: IntlInstance;
  shareDraft: ConversationShareSelectionDraft | undefined;
  shareTitle: string;
  shareDisclosureAccepted: boolean;
  sharePublishing: boolean;
  shareProgress: ConversationShareProgressPhase;
  shareCompletedArtifacts: number;
  shareTotalArtifacts: number;
  publishedShareUrl: string | null;
  shareError: ConversationShareDisplayError | null;
  shareWarnings: ConversationShareDisplayWarnings | null;
  shareSelectionPanelVisible: boolean;
  selectedShareProductTurnIds: Array<string>;
  preflightShareProductTurnIds: Array<string>;
  eligibleShareProductTurnIds: Array<string>;
  sharePreflight: ConversationSharePreflightState;
  handleCopyPublishedShare: () => Promise<boolean>;
  handleOpenPublishedShare: () => void;
  handleCopyShareRequestId: () => void;
  handleShareCancel: () => void;
  handleDismissShareError: () => void;
  handleDismissShareWarnings: () => void;
  handleDeselectShareTurn: (productTurnId: string) => void;
  handleShareTitleChange: (value: string) => void;
  handleShareAccessModeChange: (accessMode: ConversationShareAccessMode) => void;
  handleShareDisclosureAcceptedChange: (accepted: boolean) => void;
  handleEditShareSelection: () => void;
  handleShareConfirm: () => void;
  sharePreflightContent: JSX.Element;
}

export function renderSessionPaneSharePopover(params: RenderSessionPaneSharePopoverParams) {
  const {
    sessionId,
    readOnly,
    intl,
    shareDraft,
    shareTitle,
    shareDisclosureAccepted,
    sharePublishing,
    shareProgress,
    shareCompletedArtifacts,
    shareTotalArtifacts,
    publishedShareUrl,
    shareError,
    shareWarnings,
    shareSelectionPanelVisible,
    selectedShareProductTurnIds,
    preflightShareProductTurnIds,
    eligibleShareProductTurnIds,
    sharePreflight,
    handleCopyPublishedShare,
    handleOpenPublishedShare,
    handleCopyShareRequestId,
    handleShareCancel,
    handleDismissShareError,
    handleDismissShareWarnings,
    handleDeselectShareTurn,
    handleShareTitleChange,
    handleShareAccessModeChange,
    handleShareDisclosureAcceptedChange,
    handleEditShareSelection,
    handleShareConfirm,
    sharePreflightContent,
  } = params;

  const sharePopoverContent =
    readOnly || !sessionId ? null : publishedShareUrl ? (
      <ConversationShareSuccessDock
        url={publishedShareUrl}
        title={shareTitle}
        warnings={shareWarnings}
        onOpen={handleOpenPublishedShare}
        onCopy={handleCopyPublishedShare}
        onDismiss={handleShareCancel}
      />
    ) : (
      <ConversationShareConfirmationDock
        preflightChecking={
          sharePreflight.status === "checking" ||
          sharePreflight.status === "stale" ||
          (sharePreflight.status === "idle" && preflightShareProductTurnIds.length > 0)
        }
        selectionEditing={shareSelectionPanelVisible}
        publishDisabled={
          sharePreflight.status !== "ready" || sharePreflight.blockingIssues.length > 0
        }
        preflightContent={sharePreflightContent}
        selectedCount={selectedShareProductTurnIds.length}
        totalCount={eligibleShareProductTurnIds.length}
        title={shareTitle}
        accessMode={shareDraft?.accessMode ?? DEFAULT_CONVERSATION_SHARE_ACCESS_MODE}
        progressLabel={intl.formatMessage({
          id:
            shareProgress === "uploading"
              ? "conversationShare.progress.uploading"
              : shareProgress === "checking"
                ? "conversationShare.progress.checking"
                : "conversationShare.progress.collecting",
        })}
        progressPhase={shareProgress}
        completedArtifacts={shareCompletedArtifacts}
        totalArtifacts={shareTotalArtifacts}
        pending={sharePublishing}
        error={shareError}
        warnings={shareWarnings}
        onDismissError={handleDismissShareError}
        onDismissWarnings={handleDismissShareWarnings}
        onCopyRequestId={handleCopyShareRequestId}
        onDeselectTurn={handleDeselectShareTurn}
        onTitleChange={handleShareTitleChange}
        onAccessModeChange={handleShareAccessModeChange}
        disclosureAccepted={shareDisclosureAccepted}
        onDisclosureAcceptedChange={handleShareDisclosureAcceptedChange}
        onCancel={handleShareCancel}
        onEditSelection={handleEditShareSelection}
        onConfirm={handleShareConfirm}
      />
    );

  return sharePopoverContent;
}

export interface RenderSessionPaneBottomDockParams {
  sessionId: string | null;
  readOnly: boolean;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  remoteSessionId: string | null | undefined;
  isDesktop: boolean;
  compactForRemoteControl: boolean;
  provider: "glm" | undefined;
  onOpenAutomationsMain: OpenAutomationsMain | undefined;
  attachmentRead: ReturnType<typeof useV4Conversation>["attachmentRead"];
  snapshot: ConversationSnapshot | null;
  runtimeReady: boolean;
  handleMobilePlanInteractionAccepted: (interactionId: string) => void;
  queueEditOperation: { queueItemId: string; sessionId: string; workspaceKey: string } | null;
  isFloatingPresentation: boolean;
  sharedSettings: AppSettings | null;
  codingPlanUpgradeDialog: CodingPlanUpgradeDialogContextValue | null;
  billingDiscount: {
    active: boolean;
    config: CodingPlanBillingDiscountConfig | undefined;
    loading: boolean;
    refresh: () => Promise<void>;
  };
  handleDeleteQueueItem: (queueItemId: string) => void;
  handleEditQueueItem: (queueItemId: string) => Promise<void>;
  handleSendQueuedNow: (queueItemId: string) => void;
  handleReorderQueueItem: (queueItemId: string, beforeQueueItemId: string | null) => void;
  handleResumeQueue: () => Promise<void>;
  queueEditActiveForCurrentComposer: boolean;
  isDraft: boolean;
  isOfficeMode: boolean;
  projectedComposerError: ZCodeUiError | null;
  quotaBanner: {
    readonly state: SessionQuotaBannerState;
    readonly dismissKey: string | null;
    readonly dismissed: boolean;
    readonly dismiss: () => void;
    readonly markShown: () => void;
    readonly takesOverError: boolean;
    readonly upgradeProviderId: string | null;
    readonly upgradeActionLabelId: "chat.quota.action.renew" | "chat.quota.action.upgrade";
  };
  handleOpenQuotaUpgrade: () => void;
  recoverableCommand: PendingCommandEntry | null;
  handleDismissPendingRecovery: () => void;
  handleResendPendingCommand: () => void;
  composerNode: JSX.Element | null;
  pendingGuideProjection: PendingGuideQueueProjection | null;
}

export function renderSessionPaneBottomDock(params: RenderSessionPaneBottomDockParams) {
  const {
    sessionId,
    readOnly,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    isDesktop,
    compactForRemoteControl,
    provider,
    onOpenAutomationsMain,
    attachmentRead,
    snapshot,
    runtimeReady,
    handleMobilePlanInteractionAccepted,
    queueEditOperation,
    isFloatingPresentation,
    sharedSettings,
    codingPlanUpgradeDialog,
    billingDiscount,
    handleDeleteQueueItem,
    handleEditQueueItem,
    handleSendQueuedNow,
    handleReorderQueueItem,
    handleResumeQueue,
    queueEditActiveForCurrentComposer,
    isDraft,
    isOfficeMode,
    projectedComposerError,
    quotaBanner,
    handleOpenQuotaUpgrade,
    recoverableCommand,
    handleDismissPendingRecovery,
    handleResendPendingCommand,
    composerNode,
    pendingGuideProjection,
  } = params;

  const conversationBottomDockContent = readOnly ? null : (
    <>
      {quotaBanner.state.visible &&
      !quotaBanner.dismissed &&
      (!projectedComposerError || quotaBanner.takesOverError || quotaBanner.state.blocksSubmit) ? (
        <ConversationQuotaBanner
          state={quotaBanner.state}
          onShown={quotaBanner.markShown}
          billingDiscountActive={billingDiscount.active}
          billingDiscountConfig={billingDiscount.config}
          upgradeActionLabelId={quotaBanner.upgradeActionLabelId}
          onUpgrade={
            quotaBanner.upgradeProviderId && codingPlanUpgradeDialog
              ? handleOpenQuotaUpgrade
              : undefined
          }
          onDismiss={quotaBanner.dismiss}
        />
      ) : null}
      {recoverableCommand ? (
        <PendingCommandRecoveryBanner
          entry={recoverableCommand}
          onResend={
            recoverableCommand.replay.kind === "input" ? handleResendPendingCommand : undefined
          }
          onDismiss={handleDismissPendingRecovery}
        />
      ) : null}
      {sessionId && snapshot?.workspaceHookAdmission ? (
        <WorkspaceHookPendingBanner
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          admission={snapshot.workspaceHookAdmission}
        />
      ) : null}
      {sessionId && snapshot ? (
        <ConversationQueuePanel
          key="conversation-queue"
          queue={pendingGuideProjection?.visibleQueue ?? snapshot.queue}
          onDeleteItem={handleDeleteQueueItem}
          onEditItem={handleEditQueueItem}
          pendingEditQueueItemId={
            queueEditActiveForCurrentComposer && queueEditOperation
              ? queueEditOperation.queueItemId
              : null
          }
          onSendNow={handleSendQueuedNow}
          onMoveItem={handleReorderQueueItem}
          onResume={handleResumeQueue}
          sessionId={sessionId}
          readAttachment={runtimeReady ? attachmentRead : undefined}
        />
      ) : null}
      {/* Bugfix: v4 权限/问答等待态只是 runtime 的阻塞交互，必须和 composer
        共享 timeline bottom dock；渲染在 SessionPane 外层会脱离主列宽度并挤占下半屏。 */}
      {sessionId && snapshot ? (
        <V4InteractionDialogs
          key="conversation-interactions"
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          provider={provider}
          snapshot={snapshot}
          onPlanInteractionAccepted={
            compactForRemoteControl ? handleMobilePlanInteractionAccepted : undefined
          }
        />
      ) : null}
      {composerNode}
      {/* 办公模式显示主动任务推荐；编程模式保留原有小型场景入口。 */}
      {/* 完整视图浮窗只露出输入框，草稿推荐提示不进入浮窗。 */}
      {isDraft &&
      !isFloatingPresentation &&
      (!isOfficeMode || sharedSettings?.proactiveSuggestionsEnabled === true) ? (
        <ConversationDraftSuggestedPromptsContainer
          className={isOfficeMode ? "mt-4" : "mt-6"}
          proactive={isOfficeMode}
          onOpenAutomations={
            onOpenAutomationsMain && !compactForRemoteControl
              ? (automationTab) => onOpenAutomationsMain(undefined, automationTab)
              : undefined
          }
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          isDesktop={isDesktop}
        />
      ) : null}
    </>
  );

  return conversationBottomDockContent;
}
