// SessionPane 拆分：时间线行渲染上下文（memo 键保持原样）。
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { WorkflowRunSettingsChange } from "@/components/workflow-timeline/workflowRunSettings.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenSubagentSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type { Theme } from "@/theme.js";
import type {
  WorkflowDraftPosition,
  WorkflowRunCardSummary,
} from "@/ToolCallBlocks/fileSummaryTypes.js";
import type { AssistantPreviewPptxAutoOpenTarget } from "@/v4/assistantPreviewPptxAutoOpen.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";
import type { WorkflowFillGraph } from "@/v4/workflowRunCardJoin.js";
import type { ModelSelectionView } from "@zcode/services";
import type { CommandAck, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useMemo } from "react";

export interface UseSessionPaneRowContextParams {
  sessionId: string | null;
  rootSessionId: string | undefined;
  readOnly: boolean;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  remoteSessionId: string | null | undefined;
  compactForRemoteControl: boolean;
  onOpenBrowserUrl: ((url: string) => void) | undefined;
  onOpenAutomationsMain: OpenAutomationsMain | undefined;
  onOpenCodeViewer: ((source: CodeViewerSource) => void) | undefined;
  onOpenFileLink: ((target: MessageFileLinkTarget) => void) | undefined;
  onOpenSubagentSession: ((request: OpenScopedSubagentSideTabRequest) => void) | undefined;
  onOpenPlanDetail: ((request: OpenScopedPlanDetailSideTabRequest) => void) | undefined;
  onOpenWorkflowRun: ((request: OpenScopedWorkflowRunSideTabRequest) => void) | undefined;
  onOpenWorkflowArtifact: ((request: OpenScopedWorkflowArtifactSideTabRequest) => void) | undefined;
  onOpenWorkflowActorSession:
    | ((request: OpenScopedWorkflowActorSessionSideTabRequest) => void)
    | undefined;
  onOpenWorkflowWorkspace:
    | ((request: OpenScopedWorkflowWorkspaceSideTabRequest) => void)
    | undefined;
  attachmentRead: ReturnType<typeof useV4Conversation>["attachmentRead"];
  attachmentReadRange: ReturnType<typeof useV4Conversation>["attachmentReadRange"];
  workspaceHomePath: string | undefined;
  snapshot: ConversationSnapshot | null;
  runtimeReady: boolean;
  assistantPreviewPptxAutoOpenTarget: AssistantPreviewPptxAutoOpenTarget | null;
  handleAutoOpenAssistantPptx: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  modelSelectionView: ModelSelectionView | null;
  messageStreamShowReasoning: boolean;
  messageStreamShowTodos: boolean;
  toolGroupingExploreEnabled: boolean;
  toolGroupingTerminalEnabled: boolean;
  toolGroupingChangesEnabled: boolean;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  handleNavigateToRow: (targetSessionId: string, _rowId: number) => void;
  handleFetchFileChanges: ConversationRowRenderContext["fetchFileChanges"];
  handlePreviewFileRewind: ConversationRowRenderContext["previewFileRewind"];
  handleApplyFileRewind: ConversationRowRenderContext["applyFileRewind"];
  handleOpenSubagentSession: (request: OpenSubagentSideTabRequest) => void;
  handleOpenPlanDetail: (request: OpenPlanDetailSideTabRequest) => void;
  handleOpenWorkflowRun: (request: OpenWorkflowRunSideTabRequest) => void;
  handleOpenWorkflowActorSession: (request: OpenWorkflowActorSessionSideTabRequest) => void;
  handleOpenWorkflowWorkspace: (request: OpenWorkflowWorkspaceSideTabRequest) => void;
  handleOpenWorkflowArtifact: (request: OpenWorkflowArtifactSideTabRequest) => void;
  workflowRunByToolCallId: ReadonlyMap<string, WorkflowRunCardSummary>;
  workflowRunByRunId: ReadonlyMap<string, WorkflowRunCardSummary>;
  workflowGraphByToolCallId: ConversationRowRenderContext["workflowGraphByToolCallId"];
  workflowFillGraphByRunId: ReadonlyMap<string, WorkflowFillGraph>;
  workflowDraftByToolCallId: ReadonlyMap<string, WorkflowDraftPosition>;
  workflowSaveCandidatesByRunId: ReadonlyMap<
    string,
    ReadonlyArray<{ name: string; scope?: "project" | "global" | undefined }>
  >;
  workflowRunPendingQuestionsByRunId: ReadonlyMap<string, ReadonlySet<string>>;
  chatLoadingBlockedByInteraction: boolean;
  chatLoadingBlockedByActiveWork: boolean;
  workspaceFileRewindEnabled: boolean;
  handleCancelBackgroundWork: (workId: string) => void;
  handleRespondOpenCodePermission: (params: {
    commandId: string;
    runId: string;
    opencodeSessionId: string;
    requestId: string;
    optionId: string;
  }) => Promise<void>;
  dynamicWorkflowEnabled: boolean;
  handleResumeWorkflowRun: (workId: string, name?: string) => void;
  handleAmendWorkflowRunSettings: (
    workId: string,
    change: WorkflowRunSettingsChange,
  ) => Promise<CommandAck>;
  workflowSessionModel: { providerId: string; modelId: string } | undefined;
  handleSendWorkflowSaveRequest: (text: string) => Promise<void>;
}

export function useSessionPaneRowContext(params: UseSessionPaneRowContextParams) {
  const {
    sessionId,
    rootSessionId,
    readOnly,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    compactForRemoteControl,
    onOpenBrowserUrl,
    onOpenAutomationsMain,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenSubagentSession,
    onOpenPlanDetail,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    onOpenWorkflowActorSession,
    onOpenWorkflowWorkspace,
    attachmentRead,
    attachmentReadRange,
    workspaceHomePath,
    snapshot,
    runtimeReady,
    assistantPreviewPptxAutoOpenTarget,
    handleAutoOpenAssistantPptx,
    modelSelectionView,
    messageStreamShowReasoning,
    messageStreamShowTodos,
    toolGroupingExploreEnabled,
    toolGroupingTerminalEnabled,
    toolGroupingChangesEnabled,
    theme,
    codePreviewSettings,
    handleNavigateToRow,
    handleFetchFileChanges,
    handlePreviewFileRewind,
    handleApplyFileRewind,
    handleOpenSubagentSession,
    handleOpenPlanDetail,
    handleOpenWorkflowRun,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    workflowRunByToolCallId,
    workflowRunByRunId,
    workflowGraphByToolCallId,
    workflowFillGraphByRunId,
    workflowDraftByToolCallId,
    workflowSaveCandidatesByRunId,
    workflowRunPendingQuestionsByRunId,
    chatLoadingBlockedByInteraction,
    chatLoadingBlockedByActiveWork,
    workspaceFileRewindEnabled,
    handleCancelBackgroundWork,
    handleRespondOpenCodePermission,
    dynamicWorkflowEnabled,
    handleResumeWorkflowRun,
    handleAmendWorkflowRunSettings,
    workflowSessionModel,
    handleSendWorkflowSaveRequest,
  } = params;

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      workspaceRemoteSessionId: remoteSessionId ?? undefined,
      modelSelectionView,
      logEpoch: snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId: rootSessionId ?? sessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      onNavigateToRow: handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx: runtimeReady ? handleAutoOpenAssistantPptx : undefined,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession:
        runtimeReady && onOpenSubagentSession ? handleOpenSubagentSession : undefined,
      onOpenPlanDetail: runtimeReady && onOpenPlanDetail ? handleOpenPlanDetail : undefined,
      onOpenWorkflowRun: runtimeReady && onOpenWorkflowRun ? handleOpenWorkflowRun : undefined,
      onOpenWorkflowActor:
        runtimeReady && onOpenWorkflowActorSession ? handleOpenWorkflowActorSession : undefined,
      onOpenWorkflowWorkspace:
        runtimeReady && onOpenWorkflowWorkspace ? handleOpenWorkflowWorkspace : undefined,
      onOpenWorkflowArtifact:
        runtimeReady && onOpenWorkflowArtifact ? handleOpenWorkflowArtifact : undefined,
      onCancelBackgroundWork: readOnly || !runtimeReady ? undefined : handleCancelBackgroundWork,
      onRespondOpenCodePermission:
        readOnly || !runtimeReady || !sessionId ? undefined : handleRespondOpenCodePermission,
      // Resume 进入会话上下文的唯一供给点；灰度与只读两道门都在 resolveWorkflowResumeHandler 里，
      // 断在这里等于工具卡页脚与摘要卡的按钮一起消失。
      onResumeWorkflowRun: resolveWorkflowResumeHandler({
        readOnly: readOnly || !runtimeReady,
        dynamicWorkflowEnabled,
        handler: handleResumeWorkflowRun,
      }),
      onAmendWorkflowRunSettings:
        runtimeReady && sessionId
          ? resolveWorkflowResumeHandler({
              readOnly,
              dynamicWorkflowEnabled,
              handler: handleAmendWorkflowRunSettings,
            })
          : undefined,
      // 保存与 Resume 同一道门、同一个供给点：写文件与起引擎都属于「Resume 被收走的地方一并收走」
      // （docs/dynamic-workflow/launch.md「Gray release」）。芯片不经这道门，它只是一条事实。
      onSendWorkflowSaveRequest:
        runtimeReady && sessionId
          ? resolveWorkflowResumeHandler({
              readOnly,
              dynamicWorkflowEnabled,
              handler: handleSendWorkflowSaveRequest,
            })
          : undefined,
      workflowSaveCandidatesByRunId,
      ...(workflowSessionModel === undefined ? {} : { workflowSessionModel }),
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      fetchFileChanges: runtimeReady ? handleFetchFileChanges : undefined,
      previewFileRewind:
        runtimeReady && workspaceFileRewindEnabled ? handlePreviewFileRewind : undefined,
      applyFileRewind:
        runtimeReady && workspaceFileRewindEnabled ? handleApplyFileRewind : undefined,
      readAttachment: runtimeReady ? attachmentRead : undefined,
      readAttachmentRange: runtimeReady ? attachmentReadRange : undefined,
    }),
    [
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      remoteSessionId,
      modelSelectionView,
      snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession,
      handleOpenSubagentSession,
      onOpenPlanDetail,
      handleOpenPlanDetail,
      onOpenWorkflowRun,
      handleOpenWorkflowRun,
      onOpenWorkflowActorSession,
      handleOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      handleOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      handleOpenWorkflowArtifact,
      readOnly,
      runtimeReady,
      handleCancelBackgroundWork,
      handleRespondOpenCodePermission,
      dynamicWorkflowEnabled,
      handleResumeWorkflowRun,
      handleAmendWorkflowRunSettings,
      handleSendWorkflowSaveRequest,
      workflowSaveCandidatesByRunId,
      workflowSessionModel,
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      workspaceFileRewindEnabled,
      handleFetchFileChanges,
      handlePreviewFileRewind,
      handleApplyFileRewind,
      attachmentRead,
      attachmentReadRange,
    ],
  );

  return { rowContext };
}
