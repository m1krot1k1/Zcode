// SessionPane 拆分：组件 props 解构与 pane 级订阅/上下文初始化。
// 返回值是后续所有 hook 的输入面板（props 字段 + 本层声明），调用顺序与原文件一致。
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useComposerClientNamespace, useServices } from "@/hooks/useServices.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { useWorkspaceHomePath } from "@/hooks/useWorkspaceHomePath.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useFileTransactionStream } from "@/hooks/useFileTransactionStream.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { readPendingTaskDraft, resolveComposerScope } from "@/v4/composer/composerDraftStore.js";
import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import type { SessionPaneProps } from "@/v4/session-pane/types.js";
import { useSessionPaneLease } from "@/v4/session-pane/useSessionPaneLease.js";
import {
  useScopedConversationTelemetryForegroundEnabled,
  useScopedConversationTelemetrySupervisor,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useEffect, useMemo, useRef, useState } from "react";

export interface UseSessionPaneBootstrapParams {
  props: SessionPaneProps;
}

export function useSessionPaneBootstrap(params: UseSessionPaneBootstrapParams) {
  const { props } = params;
  const {
    paneId,
    sessionId,
    openTrigger,
    rootSessionId,
    readOnly = false,
    allowWorkspaceFileRewind = false,
    selectionSideChat = false,
    activeSelectionSideChatSessionId = null,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    isDesktop = false,
    compactForRemoteControl = false,
    provider,
    onSessionCreated,
    onSelectionSideChatUnavailable,
    focused = true,
    allowEscapeStopOutsidePane = false,
    telemetryVisible = true,
    onClosePane,
    workspaceBadge,
    draftComposerHeader,
    onDropTargetControllerChange,
    gitSummary,
    gitDirtyFileCount,
    gitWorktreeReviewSourceId,
    gitWorktreeChangeSummary,
    activeTaskChangeSummary,
    summaryPanelVariantOverride,
    onSummaryPanelVariantOverrideChange,
    onRefreshGit,
    onOpenGitReview,
    onOpenBrowserUrl,
    onOpenAutomationsMain,
    onOpenCodeViewer,
    onAutoOpenAssistantPptx,
    onOpenFileLink,
    onOpenSubagentSession,
    onOpenBackgroundBash,
    onOpenSubagentDirectory,
    onSyncSubagentSessionTabs,
    onOpenSelectionSideChat,
    onOpenPlanDetail,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    onOpenWorkflowRunDirectory,
    onOpenWorkflowActorSession,
    onOpenWorkflowWorkspace,
    conversationFindQuery = "",
    conversationFindActiveIndex = -1,
    conversationFindNavigationRequestId = 0,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
  } = props;

  const paneRef = useRef<HTMLDivElement>(null);
  const remoteAvailable = useRemoteConversationAvailable();
  const {
    layer,
    sendCommand,
    attachmentPut,
    attachmentRead,
    attachmentReadRange,
    onRuntimeRestart,
    onRuntimeLifecycle,
    fileChanges,
    fileRewindPreview,
  } = useV4Conversation();
  const platform = useOptionalPlatform();
  const {
    conversationShareService,
    highspeedCardService,
    modelSelectionService,
    usageStatsService,
    zcodeSessionService,
    zcodeTaskService,
  } = useServices();
  const { intl, locale } = useZCodeIntl();
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  const baseWorkspaceServices = useBaseWorkspaceServices();
  const composerClientNamespace = useComposerClientNamespace();
  const composerProjectId = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).draftProjectId,
  );
  const newTaskComposerScope = useMemo(
    () => resolveComposerScope(composerProjectId, workspaceIdentity, composerClientNamespace),
    [composerProjectId, workspaceIdentity, composerClientNamespace],
  );
  const composerDraftGeneration = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  const pendingAtEntry = useMemo(() => {
    if (sessionId !== null || newTaskComposerScope.projectId !== null) return null;
    const pending = readPendingTaskDraft(newTaskComposerScope);
    return pending?.workspacePath === workspacePath && pending.commandId ? pending : null;
  }, [sessionId, workspacePath, newTaskComposerScope, composerDraftGeneration]);
  const [resolvedDraftCommand, setResolvedDraftCommand] = useState<string | null>(null);
  const recoveringDraft =
    pendingAtEntry?.commandId !== resolvedDraftCommand ? pendingAtEntry : null;
  const workspaceHomePath = useWorkspaceHomePath({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  });
  // SessionPane 已位于目标 Workspace 的 ServiceProvider 内，直接订阅该 Host Service；
  // 不再从展示组件二次解析 workspace/remote 路由。
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundEnabled = useScopedConversationTelemetryForegroundEnabled({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundOwnerRef = useRef<object>({});
  useEffect(() => {
    if (
      !conversationTelemetry ||
      !conversationTelemetryForegroundEnabled ||
      !telemetryVisible ||
      !sessionId
    ) {
      return undefined;
    }
    return conversationTelemetry.attachForeground(
      conversationTelemetryForegroundOwnerRef.current,
      sessionId,
    );
  }, [conversationTelemetry, conversationTelemetryForegroundEnabled, sessionId, telemetryVisible]);
  const [lease, setLease] = useSessionPaneLease(sessionId, layer);
  // Этап 6.1c: единственная подписка pane на транзакционные изменения файлов.
  // Пишет только в useFileTransactionStore; панели читают срез по workspaceKey+sessionId.
  useFileTransactionStream({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { workspaceRemoteSessionId: remoteSessionId } : {}),
    sessionId,
  });
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  const runtimeReady =
    sessionId === null ||
    (snapshot?.sessionId === sessionId &&
      (!snapshot.runtimeInitialization || snapshot.runtimeInitialization.status === "ready"));
  const newlyCreatedSessionIdRef = useRef<string | null>(null);

  return {
    paneId,
    sessionId,
    openTrigger,
    rootSessionId,
    readOnly,
    allowWorkspaceFileRewind,
    selectionSideChat,
    activeSelectionSideChatSessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    isDesktop,
    compactForRemoteControl,
    provider,
    onSessionCreated,
    onSelectionSideChatUnavailable,
    focused,
    allowEscapeStopOutsidePane,
    telemetryVisible,
    onClosePane,
    workspaceBadge,
    draftComposerHeader,
    onDropTargetControllerChange,
    gitSummary,
    gitDirtyFileCount,
    gitWorktreeReviewSourceId,
    gitWorktreeChangeSummary,
    activeTaskChangeSummary,
    summaryPanelVariantOverride,
    onSummaryPanelVariantOverrideChange,
    onRefreshGit,
    onOpenGitReview,
    onOpenBrowserUrl,
    onOpenAutomationsMain,
    onOpenCodeViewer,
    onAutoOpenAssistantPptx,
    onOpenFileLink,
    onOpenSubagentSession,
    onOpenBackgroundBash,
    onOpenSubagentDirectory,
    onSyncSubagentSessionTabs,
    onOpenSelectionSideChat,
    onOpenPlanDetail,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    onOpenWorkflowRunDirectory,
    onOpenWorkflowActorSession,
    onOpenWorkflowWorkspace,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
    paneRef,
    remoteAvailable,
    layer,
    sendCommand,
    attachmentPut,
    attachmentRead,
    attachmentReadRange,
    onRuntimeRestart,
    onRuntimeLifecycle,
    fileChanges,
    fileRewindPreview,
    platform,
    conversationShareService,
    highspeedCardService,
    modelSelectionService,
    usageStatsService,
    zcodeSessionService,
    zcodeTaskService,
    intl,
    locale,
    slashCommands,
    baseWorkspaceServices,
    newTaskComposerScope,
    setResolvedDraftCommand,
    recoveringDraft,
    workspaceHomePath,
    conversationTelemetry,
    conversationTelemetryForegroundEnabled,
    lease,
    setLease,
    state,
    snapshot,
    runtimeReady,
    newlyCreatedSessionIdRef,
  };
}
