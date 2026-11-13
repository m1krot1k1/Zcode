// SessionPane 的单 pane 竖切入口：只保留组件装配、公开 API 与渲染编排。
// 具体状态机按关注点拆到 ./session-pane/*；各 hook 的调用顺序与原文件一一对应。
import { ConversationSharePreflightStatus } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { ConversationBottomDockTransition } from "@/v4/ConversationBottomDockTransition.js";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";
import { ZCODE_AGENT_PROVIDER, buildCustomSupplierKey } from "@zcode/shared";
import { useCallback, useMemo } from "react";
import { useSessionPaneBootstrap } from "@/v4/session-pane/useSessionPaneBootstrap.js";
import {
  useSessionPaneShareSelection,
  useSessionPaneSharePublish,
} from "@/v4/session-pane/useSessionPaneShare.js";
import {
  useSessionPaneSessionOpen,
  useSessionPaneHighspeedCardState,
  useSessionPaneEmbeddedState,
  useSessionPaneHighspeedTurns,
} from "@/v4/session-pane/useSessionPanePaneState.js";
import {
  useSessionPaneWorkspaceSync,
  useSessionPaneDraftGates,
} from "@/v4/session-pane/useSessionPaneWorkspaceSync.js";
import {
  useSessionPaneCommandDispatch,
  useSessionPaneFileChanges,
} from "@/v4/session-pane/useSessionPaneCommands.js";
import { useSessionPaneSideTabs } from "@/v4/session-pane/useSessionPaneSideTabs.js";
import { useSessionPaneRowContext } from "@/v4/session-pane/useSessionPaneRowContext.js";
import { useSessionPaneDraftSession } from "@/v4/session-pane/useSessionPaneDraft.js";
import { useSessionPaneSend } from "@/v4/session-pane/useSessionPaneSend.js";
import { useSessionPaneTurnActions } from "@/v4/session-pane/useSessionPaneTurnActions.js";
import {
  useSessionPaneStopAndLoad,
  useSessionPanePresentation,
} from "@/v4/session-pane/useSessionPanePresentation.js";
import { useSessionPaneShareHandlers } from "@/v4/session-pane/useSessionPaneShareHandlers.js";
import type { SessionPaneProps } from "@/v4/session-pane/types.js";
import {
  renderSessionPaneBottomDock,
  renderSessionPaneComposer,
  renderSessionPaneSharePopover,
} from "@/v4/session-pane/SessionPaneChrome.js";
import { renderSessionPaneView } from "@/v4/session-pane/SessionPaneView.js";

export type { SessionPaneProps } from "@/v4/session-pane/types.js";
export type { QueuedComposerRestoreTarget } from "@/v4/session-pane/queuedComposerRestore.js";
export {
  resolveQueuedComposerRestore,
  shouldRestoreQueuedComposerFromAck,
} from "@/v4/session-pane/queuedComposerRestore.js";
export { useSessionPaneLease } from "@/v4/session-pane/useSessionPaneLease.js";

/**
 * 单 pane 竖切：订阅 → 渲染 rows → composer 发送 / stop（06-ui §SessionPane）。
 *
 * React 性能（vercel-react-best-practices）：
 * - 叶子组件（Header/Timeline/QueuePanel/InputControls/Composer/GoalBanner）均 memo；
 * - 所有回调用 useCallback 且**不依赖高频变化的 snapshot**——snapshot/composer 文本经 ref 读取，
 *   使回调在流式增量期间保持稳定引用，避免把新函数灌进 memo 子组件触发无谓重渲染；
 * - 模型表单的本地输入 state 下沉到对应子组件，输入时不牵动整个 pane。
 */
export function SessionPane(props: SessionPaneProps) {
  const setup = useSessionPaneBootstrap({ props });

  const share = useSessionPaneShareSelection({
    sessionId: setup.sessionId,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    remoteSessionId: setup.remoteSessionId,
    compactForRemoteControl: setup.compactForRemoteControl,
    conversationShareService: setup.conversationShareService,
    intl: setup.intl,
    snapshot: setup.snapshot,
  });

  const paneState = useSessionPaneSessionOpen({
    sessionId: setup.sessionId,
    openTrigger: setup.openTrigger,
    readOnly: setup.readOnly,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    compactForRemoteControl: setup.compactForRemoteControl,
    onDropTargetControllerChange: setup.onDropTargetControllerChange,
    fileChanges: setup.fileChanges,
    platform: setup.platform,
    conversationTelemetry: setup.conversationTelemetry,
    lease: setup.lease,
    state: setup.state,
    snapshot: setup.snapshot,
    newlyCreatedSessionIdRef: setup.newlyCreatedSessionIdRef,
  });

  const highspeed = useSessionPaneHighspeedCardState({
    sessionId: setup.sessionId,
    highspeedCardService: setup.highspeedCardService,
    snapshot: setup.snapshot,
  });

  const embedded = useSessionPaneEmbeddedState({
    sessionId: setup.sessionId,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    summaryPanelVariantOverride: setup.summaryPanelVariantOverride,
    onSummaryPanelVariantOverrideChange: setup.onSummaryPanelVariantOverrideChange,
    onAutoOpenAssistantPptx: setup.onAutoOpenAssistantPptx,
    snapshot: setup.snapshot,
    paneLocalSummaryPanelVariantOverride: paneState.paneLocalSummaryPanelVariantOverride,
    setPaneLocalSummaryPanelVariantOverride: paneState.setPaneLocalSummaryPanelVariantOverride,
    snapshotRef: highspeed.snapshotRef,
    sessionIdRef: highspeed.sessionIdRef,
  });

  const highspeedTurns = useSessionPaneHighspeedTurns({
    sessionId: setup.sessionId,
    highspeedCardService: setup.highspeedCardService,
    snapshot: setup.snapshot,
    activeHighspeedCard: highspeed.activeHighspeedCard,
    setActiveHighspeedCard: highspeed.setActiveHighspeedCard,
    presentedHighspeedCardIdRef: highspeed.presentedHighspeedCardIdRef,
    highspeedMetricsInFlightRef: highspeed.highspeedMetricsInFlightRef,
    highspeedTurnVersion: highspeed.highspeedTurnVersion,
    highspeedAutoShareClock: highspeed.highspeedAutoShareClock,
    refreshHighspeedAutoShareClock: highspeed.refreshHighspeedAutoShareClock,
    dispatchCommandRef: embedded.dispatchCommandRef,
  });

  const workspaceSync = useSessionPaneWorkspaceSync({
    paneId: setup.paneId,
    sessionId: setup.sessionId,
    activeSelectionSideChatSessionId: setup.activeSelectionSideChatSessionId,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    focused: setup.focused,
    onAutoOpenAssistantPptx: setup.onAutoOpenAssistantPptx,
    snapshot: setup.snapshot,
    autoOpenedAssistantPptxKeysRef: embedded.autoOpenedAssistantPptxKeysRef,
    assistantPreviewPptxGateRef: embedded.assistantPreviewPptxGateRef,
    setAssistantPreviewPptxAutoOpenTarget: embedded.setAssistantPreviewPptxAutoOpenTarget,
    workspaceKey: embedded.workspaceKey,
  });

  const draftGates = useSessionPaneDraftGates({
    sessionId: setup.sessionId,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    compactForRemoteControl: setup.compactForRemoteControl,
    provider: setup.provider,
    focused: setup.focused,
    remoteAvailable: setup.remoteAvailable,
    modelSelectionService: setup.modelSelectionService,
    intl: setup.intl,
    snapshot: setup.snapshot,
    runtimeReady: setup.runtimeReady,
    activeHighspeedCard: highspeed.activeHighspeedCard,
    invalidateActiveHighspeedCard: highspeed.invalidateActiveHighspeedCard,
  });

  const commands = useSessionPaneCommandDispatch({
    sessionId: setup.sessionId,
    rootSessionId: setup.rootSessionId,
    selectionSideChat: setup.selectionSideChat,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    remoteSessionId: setup.remoteSessionId,
    isDesktop: setup.isDesktop,
    compactForRemoteControl: setup.compactForRemoteControl,
    provider: setup.provider,
    onSessionCreated: setup.onSessionCreated,
    remoteAvailable: setup.remoteAvailable,
    sendCommand: setup.sendCommand,
    platform: setup.platform,
    intl: setup.intl,
    baseWorkspaceServices: setup.baseWorkspaceServices,
    newTaskComposerScope: setup.newTaskComposerScope,
    conversationTelemetry: setup.conversationTelemetry,
    lease: setup.lease,
    snapshot: setup.snapshot,
    newlyCreatedSessionIdRef: setup.newlyCreatedSessionIdRef,
    dispatchCommandRef: embedded.dispatchCommandRef,
    workspaceKey: embedded.workspaceKey,
    sharedSettings: draftGates.sharedSettings,
    modelSelectionRead: draftGates.modelSelectionRead,
    draftConfig: draftGates.draftConfig,
    draftConfigRef: draftGates.draftConfigRef,
    promoteComposerDraft: draftGates.promoteComposerDraft,
    captureAcceptedModelSelection: draftGates.captureAcceptedModelSelection,
  });

  const fileChanges = useSessionPaneFileChanges({
    sessionId: setup.sessionId,
    fileChanges: setup.fileChanges,
    fileRewindPreview: setup.fileRewindPreview,
    lease: setup.lease,
    fileChangesRequestCache: paneState.fileChangesRequestCache,
    snapshotRef: highspeed.snapshotRef,
    dispatchCommand: commands.dispatchCommand,
  });

  const sideTabs = useSessionPaneSideTabs({
    sessionId: setup.sessionId,
    rootSessionId: setup.rootSessionId,
    readOnly: setup.readOnly,
    allowWorkspaceFileRewind: setup.allowWorkspaceFileRewind,
    selectionSideChat: setup.selectionSideChat,
    activeSelectionSideChatSessionId: setup.activeSelectionSideChatSessionId,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    remoteSessionId: setup.remoteSessionId,
    compactForRemoteControl: setup.compactForRemoteControl,
    focused: setup.focused,
    onOpenSubagentSession: setup.onOpenSubagentSession,
    onOpenSubagentDirectory: setup.onOpenSubagentDirectory,
    onOpenSelectionSideChat: setup.onOpenSelectionSideChat,
    onOpenPlanDetail: setup.onOpenPlanDetail,
    onOpenWorkflowRun: setup.onOpenWorkflowRun,
    onOpenWorkflowArtifact: setup.onOpenWorkflowArtifact,
    onOpenWorkflowRunDirectory: setup.onOpenWorkflowRunDirectory,
    onOpenWorkflowActorSession: setup.onOpenWorkflowActorSession,
    onOpenWorkflowWorkspace: setup.onOpenWorkflowWorkspace,
    zcodeSessionService: setup.zcodeSessionService,
    intl: setup.intl,
    slashCommands: setup.slashCommands,
    state: setup.state,
    snapshot: setup.snapshot,
    runtimeReady: setup.runtimeReady,
    isMobileTextInputViewport: paneState.isMobileTextInputViewport,
    snapshotRef: highspeed.snapshotRef,
    workspaceKey: embedded.workspaceKey,
    blockingInteractionId: workspaceSync.blockingInteractionId,
    selectionSideChatKey: workspaceSync.selectionSideChatKey,
    selectionSideActionBlocked: workspaceSync.selectionSideActionBlocked,
    handleDraftSwitchMode: draftGates.handleDraftSwitchMode,
    modelSelectionView: commands.modelSelectionView,
    recommendStartPlan: commands.recommendStartPlan,
    dispatchCommand: commands.dispatchCommand,
  });

  const rowContext = useSessionPaneRowContext({
    sessionId: setup.sessionId,
    rootSessionId: setup.rootSessionId,
    readOnly: setup.readOnly,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    remoteSessionId: setup.remoteSessionId,
    compactForRemoteControl: setup.compactForRemoteControl,
    onOpenBrowserUrl: setup.onOpenBrowserUrl,
    onOpenAutomationsMain: setup.onOpenAutomationsMain,
    onOpenCodeViewer: setup.onOpenCodeViewer,
    onOpenFileLink: setup.onOpenFileLink,
    onOpenSubagentSession: setup.onOpenSubagentSession,
    onOpenPlanDetail: setup.onOpenPlanDetail,
    onOpenWorkflowRun: setup.onOpenWorkflowRun,
    onOpenWorkflowArtifact: setup.onOpenWorkflowArtifact,
    onOpenWorkflowActorSession: setup.onOpenWorkflowActorSession,
    onOpenWorkflowWorkspace: setup.onOpenWorkflowWorkspace,
    attachmentRead: setup.attachmentRead,
    attachmentReadRange: setup.attachmentReadRange,
    workspaceHomePath: setup.workspaceHomePath,
    snapshot: setup.snapshot,
    runtimeReady: setup.runtimeReady,
    assistantPreviewPptxAutoOpenTarget: embedded.assistantPreviewPptxAutoOpenTarget,
    handleAutoOpenAssistantPptx: embedded.handleAutoOpenAssistantPptx,
    modelSelectionView: commands.modelSelectionView,
    messageStreamShowReasoning: commands.messageStreamShowReasoning,
    messageStreamShowTodos: commands.messageStreamShowTodos,
    toolGroupingExploreEnabled: commands.toolGroupingExploreEnabled,
    toolGroupingTerminalEnabled: commands.toolGroupingTerminalEnabled,
    toolGroupingChangesEnabled: commands.toolGroupingChangesEnabled,
    theme: commands.theme,
    codePreviewSettings: commands.codePreviewSettings,
    handleNavigateToRow: commands.handleNavigateToRow,
    handleFetchFileChanges: fileChanges.handleFetchFileChanges,
    handlePreviewFileRewind: fileChanges.handlePreviewFileRewind,
    handleApplyFileRewind: fileChanges.handleApplyFileRewind,
    handleOpenSubagentSession: sideTabs.handleOpenSubagentSession,
    handleOpenPlanDetail: sideTabs.handleOpenPlanDetail,
    handleOpenWorkflowRun: sideTabs.handleOpenWorkflowRun,
    handleOpenWorkflowActorSession: sideTabs.handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace: sideTabs.handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact: sideTabs.handleOpenWorkflowArtifact,
    workflowRunByToolCallId: sideTabs.workflowRunByToolCallId,
    workflowRunByRunId: sideTabs.workflowRunByRunId,
    workflowGraphByToolCallId: sideTabs.workflowGraphByToolCallId,
    workflowFillGraphByRunId: sideTabs.workflowFillGraphByRunId,
    workflowDraftByToolCallId: sideTabs.workflowDraftByToolCallId,
    workflowSaveCandidatesByRunId: sideTabs.workflowSaveCandidatesByRunId,
    workflowRunPendingQuestionsByRunId: sideTabs.workflowRunPendingQuestionsByRunId,
    chatLoadingBlockedByInteraction: sideTabs.chatLoadingBlockedByInteraction,
    chatLoadingBlockedByActiveWork: sideTabs.chatLoadingBlockedByActiveWork,
    workspaceFileRewindEnabled: sideTabs.workspaceFileRewindEnabled,
    handleCancelBackgroundWork: sideTabs.handleCancelBackgroundWork,
    handleRespondOpenCodePermission: sideTabs.handleRespondOpenCodePermission,
    dynamicWorkflowEnabled: sideTabs.dynamicWorkflowEnabled,
    handleResumeWorkflowRun: sideTabs.handleResumeWorkflowRun,
    handleAmendWorkflowRunSettings: sideTabs.handleAmendWorkflowRunSettings,
    workflowSessionModel: sideTabs.workflowSessionModel,
    handleSendWorkflowSaveRequest: sideTabs.handleSendWorkflowSaveRequest,
  });

  const draftSession = useSessionPaneDraftSession({
    paneId: setup.paneId,
    sessionId: setup.sessionId,
    selectionSideChat: setup.selectionSideChat,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    provider: setup.provider,
    onSelectionSideChatUnavailable: setup.onSelectionSideChatUnavailable,
    focused: setup.focused,
    remoteAvailable: setup.remoteAvailable,
    layer: setup.layer,
    onRuntimeRestart: setup.onRuntimeRestart,
    onRuntimeLifecycle: setup.onRuntimeLifecycle,
    intl: setup.intl,
    newTaskComposerScope: setup.newTaskComposerScope,
    setResolvedDraftCommand: setup.setResolvedDraftCommand,
    recoveringDraft: setup.recoveringDraft,
    lease: setup.lease,
    setLease: setup.setLease,
    state: setup.state,
    snapshot: setup.snapshot,
    snapshotRef: highspeed.snapshotRef,
    workspaceKey: embedded.workspaceKey,
    draftRuntimeInvalidationVersion: workspaceSync.draftRuntimeInvalidationVersion,
    draftAgentStartupAllowed: draftGates.draftAgentStartupAllowed,
    resolveInitialDraftConfig: draftGates.resolveInitialDraftConfig,
    modelSelectionView: commands.modelSelectionView,
    handleDraftSessionCreated: commands.handleDraftSessionCreated,
    dispatchCommand: commands.dispatchCommand,
  });

  const send = useSessionPaneSend({
    sessionId: setup.sessionId,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    highspeedCardService: setup.highspeedCardService,
    usageStatsService: setup.usageStatsService,
    intl: setup.intl,
    baseWorkspaceServices: setup.baseWorkspaceServices,
    setSendSubmissionError: paneState.setSendSubmissionError,
    snapshotRef: highspeed.snapshotRef,
    sessionIdRef: highspeed.sessionIdRef,
    setActiveHighspeedCard: highspeed.setActiveHighspeedCard,
    invalidateActiveHighspeedCard: highspeed.invalidateActiveHighspeedCard,
    setHighspeedActivationCardId: highspeed.setHighspeedActivationCardId,
    presentedHighspeedCardIdRef: highspeed.presentedHighspeedCardIdRef,
    timelineScrollToBottomRef: embedded.timelineScrollToBottomRef,
    paneBindingRef: embedded.paneBindingRef,
    configCommandBarrier: workspaceSync.configCommandBarrier,
    ensureDraftModelReadyForSend: draftGates.ensureDraftModelReadyForSend,
    markDraftProviderNotReady: draftGates.markDraftProviderNotReady,
    sharedSettings: draftGates.sharedSettings,
    draftConfigRef: draftGates.draftConfigRef,
    resolveInitialDraftConfig: draftGates.resolveInitialDraftConfig,
    captureAcceptedModelSelection: draftGates.captureAcceptedModelSelection,
    recommendStartPlan: commands.recommendStartPlan,
    createSubmissionFromComposer: commands.createSubmissionFromComposer,
    reportDraftCreated: commands.reportDraftCreated,
    handleDraftSessionCreated: commands.handleDraftSessionCreated,
    dispatchCommand: commands.dispatchCommand,
    handleOpenSelectionSideConversationWithPrompt:
      sideTabs.handleOpenSelectionSideConversationWithPrompt,
    availableSelectionSideSlashCommandNames: sideTabs.availableSelectionSideSlashCommandNames,
    appSlashCommands: sideTabs.appSlashCommands,
    sendTextRef: sideTabs.sendTextRef,
    waitForDraftSession: draftSession.waitForDraftSession,
    prewarmBindingRef: draftSession.prewarmBindingRef,
    ensureDraftPrewarmConfigBeforeSendRef: draftSession.ensureDraftPrewarmConfigBeforeSendRef,
    settleCurrentQueueInputs: draftSession.settleCurrentQueueInputs,
  });

  const turnActions = useSessionPaneTurnActions({
    sessionId: setup.sessionId,
    onSessionCreated: setup.onSessionCreated,
    attachmentRead: setup.attachmentRead,
    intl: setup.intl,
    runtimeReady: setup.runtimeReady,
    snapshotRef: highspeed.snapshotRef,
    activeHighspeedCard: highspeed.activeHighspeedCard,
    setHighspeedActivationCardId: highspeed.setHighspeedActivationCardId,
    composerDraftStateRef: embedded.composerDraftStateRef,
    setQueueEditOperation: embedded.setQueueEditOperation,
    queueEditOperationRef: embedded.queueEditOperationRef,
    setComposerRestoreRequest: embedded.setComposerRestoreRequest,
    nextComposerRestoreRequestIdRef: embedded.nextComposerRestoreRequestIdRef,
    workspaceKey: embedded.workspaceKey,
    composerBindingRef: workspaceSync.composerBindingRef,
    configCommandBarrier: workspaceSync.configCommandBarrier,
    draftConfigRef: draftGates.draftConfigRef,
    handleDraftSelectModel: draftGates.handleDraftSelectModel,
    handleDraftSelectThought: draftGates.handleDraftSelectThought,
    appFollowupMode: commands.appFollowupMode,
    snapshotSessionId: commands.snapshotSessionId,
    snapshotFollowupMode: commands.snapshotFollowupMode,
    snapshotRevision: commands.snapshotRevision,
    dispatchCommand: commands.dispatchCommand,
    prewarmBindingRef: draftSession.prewarmBindingRef,
    prewarmSessionId: draftSession.prewarmSessionId,
    ensureDraftPrewarmConfigBeforeSendRef: draftSession.ensureDraftPrewarmConfigBeforeSendRef,
    captureHighspeedPaneOrigin: send.captureHighspeedPaneOrigin,
    prepareHighspeedTurnFrom: send.prepareHighspeedTurnFrom,
    focusTimelineToLatest: send.focusTimelineToLatest,
  });

  const {
    sessionId,
    workspacePath,
    workspaceIdentity,
    provider,
    zcodeSessionService,
    zcodeTaskService,
    handleDraftSelectModel,
    modelSelectionView,
    showModelChangeNotice,
  } = { ...setup, ...draftGates, ...commands, ...draftSession };

  const handleRecoverCustomModelSelection = useCallback(
    async (value: string, sourceModel: ModelSelectionSource | null) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.providerId) {
        return;
      }
      const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
      let modelValue = value;
      if (!decoded.modelName) {
        const fallbackModel =
          modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )?.models[0]?.modelId ?? (modelSelectionView ? null : undefined);
        if (!fallbackModel) {
          logger.warn("[v4-pane] custom provider 恢复跳过：provider 没有可用模型", {
            customProviderId: decoded.providerId,
            workspacePath,
          });
          return;
        }
        modelValue = encodeCustomModelValue(decoded.providerId, fallbackModel);
      }
      const modelSelection = parseModelPickerValue(modelValue);
      // Bug 原因：configOptions error 的 custom provider 选择绕过普通 onSelectModel；
      // 已绑定任务仍复用同一提示入口，草稿态由入口统一静默。
      showModelChangeNotice(sourceModel, {
        provider: modelSelection.providerId,
        model: modelSelection.modelId,
      });
      const store = useZCodeSessionStore.getState();
      store.setModelSelectionResolution(
        workspacePath,
        {
          selectedSupplierKey: buildCustomSupplierKey(decoded.providerId),
          isGhostSupplier: false,
          supplierMismatchReason: null,
        },
        workspaceIdentity,
      );
      store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
      logger.info("[v4-pane] configOptions error custom provider recovery start", {
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });

      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          bumpRuntimeEpoch: true,
        });

        const prepareResult = await prepareWorkspaceWithZCodeSessionService({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          zcodeSessionService,
        });
        handleDraftSelectModel(modelSelection.providerId, modelSelection.modelId);
        store.setConfigOptions(workspacePath, prepareResult.configOptions ?? [], workspaceIdentity);
        store.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        store.setSlashCommands(workspacePath, prepareResult.slashCommands ?? [], workspaceIdentity);
        logger.info("[v4-pane] configOptions error custom provider recovery done", {
          configOptionsCount: prepareResult.configOptions?.length ?? 0,
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
      } catch (error) {
        store.setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn("[v4-pane] configOptions error custom provider recovery failed", {
          error: error instanceof Error ? error.message : String(error),
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
        throw error;
      }
    },
    [
      provider,
      handleDraftSelectModel,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspacePath,
      zcodeSessionService,
      zcodeTaskService,
    ],
  );

  const stopAndLoad = useSessionPaneStopAndLoad({
    sessionId: setup.sessionId,
    readOnly: setup.readOnly,
    focused: setup.focused,
    allowEscapeStopOutsidePane: setup.allowEscapeStopOutsidePane,
    paneRef: setup.paneRef,
    lease: setup.lease,
    state: setup.state,
    snapshot: setup.snapshot,
    shareActive: share.shareActive,
    shareHydratedSessionRef: share.shareHydratedSessionRef,
    snapshotRef: highspeed.snapshotRef,
    autoLoadIncompleteTurnCursorRef: embedded.autoLoadIncompleteTurnCursorRef,
    handleDraftSwitchMode: draftGates.handleDraftSwitchMode,
    dispatchCommand: commands.dispatchCommand,
    dispatchSlashCommand: send.dispatchSlashCommand,
  });

  const presentation = useSessionPanePresentation({
    sessionId: setup.sessionId,
    rootSessionId: setup.rootSessionId,
    readOnly: setup.readOnly,
    selectionSideChat: setup.selectionSideChat,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    compactForRemoteControl: setup.compactForRemoteControl,
    telemetryVisible: setup.telemetryVisible,
    gitSummary: setup.gitSummary,
    gitDirtyFileCount: setup.gitDirtyFileCount,
    gitWorktreeChangeSummary: setup.gitWorktreeChangeSummary,
    onOpenBrowserUrl: setup.onOpenBrowserUrl,
    onSyncSubagentSessionTabs: setup.onSyncSubagentSessionTabs,
    onOpenWorkflowRun: setup.onOpenWorkflowRun,
    conversationShareService: setup.conversationShareService,
    intl: setup.intl,
    locale: setup.locale,
    baseWorkspaceServices: setup.baseWorkspaceServices,
    conversationTelemetry: setup.conversationTelemetry,
    conversationTelemetryForegroundEnabled: setup.conversationTelemetryForegroundEnabled,
    lease: setup.lease,
    state: setup.state,
    snapshot: setup.snapshot,
    runtimeReady: setup.runtimeReady,
    sessionLeaseReady: paneState.sessionLeaseReady,
    dismissedErrorKeys: paneState.dismissedErrorKeys,
    setDismissedErrorKeys: paneState.setDismissedErrorKeys,
    sendSubmissionError: paneState.sendSubmissionError,
    setSendSubmissionError: paneState.setSendSubmissionError,
    setTerminalSectionOpen: paneState.setTerminalSectionOpen,
    setAgentSectionOpen: paneState.setAgentSectionOpen,
    setWorkflowSectionOpen: paneState.setWorkflowSectionOpen,
    queueEditOperation: embedded.queueEditOperation,
    timelineScrollToBottomRef: embedded.timelineScrollToBottomRef,
    effectiveSummaryPanelVariantOverride: embedded.effectiveSummaryPanelVariantOverride,
    handleSummaryPanelVariantChange: embedded.handleSummaryPanelVariantChange,
    workspaceKey: embedded.workspaceKey,
    timelineBottomRequest: workspaceSync.timelineBottomRequest,
    blockingInteractionId: workspaceSync.blockingInteractionId,
    draftModelReadinessError: draftGates.draftModelReadinessError,
    dismissDraftModelReadinessError: draftGates.dismissDraftModelReadinessError,
    sharedSettings: draftGates.sharedSettings,
    draftConfig: draftGates.draftConfig,
    resolveInitialDraftConfig: draftGates.resolveInitialDraftConfig,
    codingPlanUpgradeDialog: commands.codingPlanUpgradeDialog,
    openSettingsTab: commands.openSettingsTab,
    handleOpenWorkflowRunFromPanel: sideTabs.handleOpenWorkflowRunFromPanel,
  });

  const sharePublish = useSessionPaneSharePublish({
    sessionId: setup.sessionId,
    workspacePath: setup.workspacePath,
    workspaceIdentity: setup.workspaceIdentity,
    remoteSessionId: setup.remoteSessionId,
    onOpenBrowserUrl: setup.onOpenBrowserUrl,
    conversationShareService: setup.conversationShareService,
    intl: setup.intl,
    locale: setup.locale,
    snapshot: setup.snapshot,
    shareDraft: share.shareDraft,
    shareTitle: share.shareTitle,
    sharePublishing: share.sharePublishing,
    publishedShareUrl: share.publishedShareUrl,
    shareError: share.shareError,
    closeShare: share.closeShare,
    updateShareDockState: share.updateShareDockState,
  });

  const { sharePublishing, updateShareDockState, confirmShareSelection } = share;

  const handleConfirmShareSelection = useCallback(() => {
    if (!sharePublishing && sessionId) confirmShareSelection(sessionId);
  }, [confirmShareSelection, sessionId, sharePublishing]);
  const handleDismissShareError = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { error: null });
  }, [sessionId, updateShareDockState]);

  const shareHandlers = useSessionPaneShareHandlers({
    sessionId: setup.sessionId,
    shareDisclosureAccepted: share.shareDisclosureAccepted,
    sharePublishing: share.sharePublishing,
    publishedShareUrl: share.publishedShareUrl,
    shareSelectionPanelVisible: share.shareSelectionPanelVisible,
    updateShareDockState: share.updateShareDockState,
    beginShareSelection: share.beginShareSelection,
    toggleShareRow: share.toggleShareRow,
    deselectShareProductTurn: share.deselectShareProductTurn,
    setShareAccessMode: share.setShareAccessMode,
    sharePreflight: share.sharePreflight,
    timelineScrollToQueryRef: embedded.timelineScrollToQueryRef,
    workspaceKey: embedded.workspaceKey,
    handleDraftSessionCreated: commands.handleDraftSessionCreated,
    dispatchCommand: commands.dispatchCommand,
    recoverableCommands: draftSession.recoverableCommands,
    handleConfirmShareDisclosure: sharePublish.handleConfirmShareDisclosure,
  });

  const {
    attachmentPut,
    snapshot,
    setAllPendingShareRows,
    retrySharePreflight,
    sharePreflight,
    handleDeselectShareTurn,
  } = { ...setup, ...share, ...shareHandlers };

  const sharePreflightContent = useMemo(
    () => (
      <ConversationSharePreflightStatus
        preflight={sharePreflight}
        onDeselectTurn={handleDeselectShareTurn}
        onRetryPreflight={retrySharePreflight}
      />
    ),
    [sharePreflight, handleDeselectShareTurn, retrySharePreflight],
  );
  const handleSelectAllShareRows = useCallback(
    (selected: boolean) => {
      if (sessionId) setAllPendingShareRows(sessionId, selected);
    },
    [sessionId, setAllPendingShareRows],
  );
  const pendingGuideProjection = snapshot ? projectPendingGuideQueue(snapshot.queue) : null;

  // 插件 ui/message 的图片走与粘贴截图相同的 v4 attachmentPut；草稿（无 sessionId）没有插件 UI。
  const pluginUiUploadAttachment = useCallback(
    async (input: { fileName: string; mime: string; dataBase64: string }) => {
      if (!sessionId) throw new Error("Plugin UI attachments need an open session");
      const { ref } = await attachmentPut({ sessionId, ...input });
      const padding = input.dataBase64.endsWith("==") ? 2 : input.dataBase64.endsWith("=") ? 1 : 0;
      return {
        ref,
        fileName: input.fileName,
        mime: input.mime,
        bytes: Math.floor((input.dataBase64.length * 3) / 4) - padding,
      };
    },
    [attachmentPut, sessionId],
  );

  const paneScope = {
    ...props,
    ...setup,
    ...share,
    ...paneState,
    ...highspeed,
    ...embedded,
    ...highspeedTurns,
    ...workspaceSync,
    ...draftGates,
    ...commands,
    ...fileChanges,
    ...sideTabs,
    ...rowContext,
    ...draftSession,
    ...send,
    ...turnActions,
    ...stopAndLoad,
    ...presentation,
    ...sharePublish,
    ...shareHandlers,
  };

  const composerNode = renderSessionPaneComposer({
    ...paneScope,
    handleRecoverCustomModelSelection,
  });
  const sharePopoverContent = renderSessionPaneSharePopover({
    ...paneScope,
    handleDismissShareError,
    sharePreflightContent,
  });
  const conversationBottomDockContent = renderSessionPaneBottomDock({
    ...paneScope,
    composerNode,
    pendingGuideProjection,
  });

  // 分享浮窗不再替换输入区，保持 Composer 与对话滚动位置稳定。
  const conversationBottomDock = conversationBottomDockContent ? (
    <ConversationBottomDockTransition mode="chat">
      {conversationBottomDockContent}
    </ConversationBottomDockTransition>
  ) : null;

  return renderSessionPaneView({
    ...paneScope,
    handleConfirmShareSelection,
    handleSelectAllShareRows,
    pendingGuideProjection,
    pluginUiUploadAttachment,
    conversationBottomDock,
    sharePopoverContent,
  });
}
