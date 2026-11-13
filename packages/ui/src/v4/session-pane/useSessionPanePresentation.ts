// SessionPane 拆分：展示态派生（布局、状态面板、错误/配额横幅）与会话生命周期动作。
import type { ChatErrorBannerModelConfigTarget } from "@/ChatErrorBanner.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ModelConfigMissingUiError } from "@/lib/chatPrepareError.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { setSelectionSideChatBlocked } from "@/lib/selectionSideChatRuntime.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { logger } from "@/logger.js";
import type { CodingPlanUpgradeDialogContextValue } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { TimelineBottomRequest } from "@/store/zcodeSessionStoreTypes.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { shouldIgnoreEscapeForStopGeneration } from "@/v4/composer/escapeStop.js";
import type { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import {
  resolveConversationStatusPanelVariant,
  shouldUseConversationStatusPanelInlineLayout,
} from "@/v4/conversationLayout.js";
import {
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import {
  buildConversationStatusPanelModel,
  resolveSoleRunningWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";
import { resolveMcpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import type { SessionPaneDispatchCommand } from "@/v4/session-pane/helpers.js";
import {
  EMPTY_SUBAGENT_PROJECTION,
  createSessionErrorKey,
  toComposerUiError,
} from "@/v4/session-pane/helpers.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { parseV4VisibleSlashCommand } from "@/v4/slashCommands.js";
import type { V4VisibleSlashCommand } from "@/v4/slashCommands.js";
import type { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { useSessionSubscriptionErrorTelemetry } from "@/v4/telemetry/useSessionSubscriptionErrorTelemetry.js";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";
import type {
  IConversationShareService,
  IServiceAccessor,
  ImportedConversationShare,
} from "@zcode/services";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isRemoteWorkspaceIdentity,
  localizeConversationShareUrl,
} from "@zcode/shared";
import type { AppSettings, GitRepositorySummary, Locale } from "@zcode/shared";
import type { ConversationSnapshot, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export interface UseSessionPaneStopAndLoadParams {
  sessionId: string | null;
  readOnly: boolean;
  focused: boolean;
  allowEscapeStopOutsidePane: boolean;
  paneRef: RefObject<HTMLDivElement | null>;
  lease: SessionLease | null;
  state: ConversationStoreState;
  snapshot: ConversationSnapshot | null;
  shareActive: boolean;
  shareHydratedSessionRef: RefObject<string | null>;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  autoLoadIncompleteTurnCursorRef: RefObject<string | null>;
  handleDraftSwitchMode: (mode: string) => void;
  dispatchCommand: SessionPaneDispatchCommand;
  dispatchSlashCommand: (
    command: V4VisibleSlashCommand,
    targetSessionId: string,
    baseRevision: number | undefined,
    heldQueueDisposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
    expectedHeldQueueItemIds?: readonly string[],
    submission?: ComposerSubmissionConfig,
    onAccepted?: (messageId: string) => void,
  ) => Promise<boolean | "confirmationRequired">;
}

export function useSessionPaneStopAndLoad(params: UseSessionPaneStopAndLoadParams) {
  const {
    sessionId,
    readOnly,
    focused,
    allowEscapeStopOutsidePane,
    paneRef,
    lease,
    state,
    snapshot,
    shareActive,
    shareHydratedSessionRef,
    snapshotRef,
    autoLoadIncompleteTurnCursorRef,
    handleDraftSwitchMode,
    dispatchCommand,
    dispatchSlashCommand,
  } = params;

  // 模式与模型一样属于下一次 Submission；选择时只更新 Composer。
  const handleSwitchMode = useCallback(
    (mode: string) => {
      handleDraftSwitchMode(mode);
    },
    [handleDraftSwitchMode],
  );

  // context usage 面板的压缩入口（命令文本 = "/compact"，复用 slash 解析路径）。
  const handleSendCompressionCommand = useCallback(
    (command: string) => {
      if (!sessionId) return;
      const parsed = parseV4VisibleSlashCommand(command);
      if (!parsed) return;
      void dispatchSlashCommand(parsed, sessionId, snapshotRef.current?.revision, undefined);
    },
    [dispatchSlashCommand, sessionId],
  );

  // 误停排障需要区分按钮与 Esc；普通 info 在生产禁用，必须走生命周期日志。
  const handleStop = useCallback(
    (source: "button" | "escape") => {
      const current = snapshotRef.current;
      if (!sessionId || !current?.control.canStop) {
        logger.lifecycle.info("[v4-pane] stop 命令被跳过（无可停执行）", {
          source,
          sessionId: sessionId ?? "",
        });
        return;
      }
      const externalAgentRun = current.control.activeWorks.find(
        (work) => work.kind === "externalAgentRun",
      );
      if (externalAgentRun) {
        if (!externalAgentRun.commandId || !externalAgentRun.runId) {
          logger.lifecycle.warn(
            "[v4-pane] OpenCode Stop пропущен: отсутствует точная идентичность запуска",
          );
          return;
        }
        logger.lifecycle.info("[v4-pane] Stop направлен в OpenCode ACP", {
          source,
          sessionId,
          commandId: externalAgentRun.commandId,
          runId: externalAgentRun.runId,
        });
        void dispatchCommand(
          "stop",
          {
            expectedOpenCodeAgentRun: {
              expectedCommandId: externalAgentRun.commandId,
              expectedRunId: externalAgentRun.runId,
            },
          },
          sessionId,
        ).catch((error) => {
          logger.lifecycle.warn(`[v4-pane] Stop OpenCode ACP завершился ошибкой: ${String(error)}`);
        });
        return;
      }
      const foregroundExecutionId = current.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      )?.foregroundExecutionId;
      logger.lifecycle.info("[v4-pane] stop 命令发出", {
        source,
        sessionId,
        foregroundExecutionId: foregroundExecutionId ?? "",
      });
      void dispatchCommand(
        "stop",
        foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {},
        sessionId,
      ).catch((error) => {
        logger.lifecycle.warn(`[v4-pane] stop 失败: ${String(error)}`);
      });
    },
    [dispatchCommand, sessionId],
  );

  const handlePauseGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.pauseGoal.allowed) return;
    void dispatchCommand("pauseGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] pauseGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  const handleResumeGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.resumeGoal.allowed) return;
    void dispatchCommand("resumeGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] resumeGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  // 主、辅对话可同时 focused（各自布局的可见态），不能据此争抢窗口 Esc。
  // 面板打开时按 DOM 归属隔离；关闭时由 Shell 授权主区接收对话外 Esc，避免焦点离开输入框后无法停止。
  // 保留窗口冒泡阶段，让 mention/slash 的 preventDefault 和 dialog 优先处理。
  useEffect(() => {
    if (!focused || readOnly) return;
    if (!sessionId || !snapshot?.control.canStop) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!paneRef.current) return;
      if (!allowEscapeStopOutsidePane && !event.composedPath().includes(paneRef.current)) return;
      if (shouldIgnoreEscapeForStopGeneration(event)) return;
      event.preventDefault();
      handleStop("escape");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    allowEscapeStopOutsidePane,
    focused,
    handleStop,
    readOnly,
    sessionId,
    snapshot?.control.canStop,
  ]);

  // handleStop 带 source 参数（button / escape 两个调用点），但 ConversationComposer 是 memo：
  // 直接写 onStop={() => handleStop("button")} 每次 render 都换引用，memo 白做，而 composer
  // 恰好是每次输入都可能重渲染的组件。这里固定 button 版的引用，不动 handleStop 的双入口设计。
  const handleStopFromButton = useCallback(() => handleStop("button"), [handleStop]);

  const handleRetrySubscribe = useCallback(() => {
    void lease?.store.retry();
  }, [lease]);

  // loadOlder 触发（接近顶部自动预取）。store 内部单飞防重入。
  const handleLoadOlder = useCallback(() => {
    return lease?.store.loadOlder();
  }, [lease]);

  const handleLoadAllOlder = useCallback(() => {
    return lease
      ? lease.store.loadAllOlder()
      : Promise.resolve({
          status: "stale" as const,
          logEpoch: snapshot?.logEpoch ?? "unknown",
        });
  }, [lease, snapshot?.logEpoch]);

  useEffect(() => {
    if (!shareActive || !sessionId || !hasOlderRows(snapshot)) return;
    const key = `${sessionId}:${snapshot?.logEpoch ?? "unknown"}`;
    if (shareHydratedSessionRef.current === key) return;
    shareHydratedSessionRef.current = key;
    void handleLoadAllOlder().catch((error) => {
      shareHydratedSessionRef.current = null;
      logger.warn("[conversation-share] 补齐分享目录失败", { error });
    });
  }, [handleLoadAllOlder, sessionId, shareActive, snapshot]);

  useEffect(() => {
    if (
      !sessionId ||
      !lease?.store ||
      !shouldAutoLoadIncompleteLeadingTurn(snapshot, state.loadingOlder)
    ) {
      return;
    }
    const firstRowId = snapshot?.rows.window[0]?.rowId;
    if (firstRowId === undefined) return;
    const cursorKey = `${sessionId}:${state.subscriptionId ?? "connecting"}:${firstRowId}`;
    if (autoLoadIncompleteTurnCursorRef.current === cursorKey) return;
    autoLoadIncompleteTurnCursorRef.current = cursorKey;

    // snapshotTailWindowRows 按 row 截尾，可能把一个长 turn 的 header/user
    // 留在窗口外。旧 UI 只在 scroll 事件到达顶边时 loadOlder；内容不足一屏或 scrollTop
    // 已经为 0 时不会再产生事件，于是只渲染 assistant，必须先下滚再上滚。检测到首 turn
    // 缺 header 后立即逐窗补齐；cursor 去重避免空 range 或失败时 effect 自旋。
    logger.debug("[v4-pane] 冷快照首 turn 不完整，自动补拉更早行", {
      firstRowId,
      sessionId,
      turnId: snapshot?.rows.window[0]?.turnId,
    });
    void lease.store.loadOlder();
  }, [lease, sessionId, snapshot, state.loadingOlder, state.subscriptionId]);

  return {
    handleSwitchMode,
    handleSendCompressionCommand,
    handlePauseGoal,
    handleResumeGoal,
    handleStopFromButton,
    handleRetrySubscribe,
    handleLoadOlder,
    handleLoadAllOlder,
  };
}

export interface UseSessionPanePresentationParams {
  sessionId: string | null;
  rootSessionId: string | undefined;
  readOnly: boolean;
  selectionSideChat: boolean;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  compactForRemoteControl: boolean;
  telemetryVisible: boolean;
  gitSummary: GitRepositorySummary | null | undefined;
  gitDirtyFileCount: number | undefined;
  gitWorktreeChangeSummary: { added: number; removed: number } | null | undefined;
  onOpenBrowserUrl: ((url: string) => void) | undefined;
  onSyncSubagentSessionTabs: ((request: SyncSubagentSessionTabsRequest) => void) | undefined;
  onOpenWorkflowRun: ((request: OpenScopedWorkflowRunSideTabRequest) => void) | undefined;
  conversationShareService: IConversationShareService;
  intl: IntlInstance;
  locale: Locale;
  baseWorkspaceServices: IServiceAccessor;
  conversationTelemetry: ConversationTelemetrySupervisor | null;
  conversationTelemetryForegroundEnabled: boolean;
  lease: SessionLease | null;
  state: ConversationStoreState;
  snapshot: ConversationSnapshot | null;
  runtimeReady: boolean;
  sessionLeaseReady: boolean;
  dismissedErrorKeys: ReadonlyArray<string>;
  setDismissedErrorKeys: Dispatch<SetStateAction<ReadonlyArray<string>>>;
  sendSubmissionError: ZCodeUiError | null;
  setSendSubmissionError: Dispatch<SetStateAction<ZCodeUiError | null>>;
  setTerminalSectionOpen: Dispatch<SetStateAction<boolean>>;
  setAgentSectionOpen: Dispatch<SetStateAction<boolean>>;
  setWorkflowSectionOpen: Dispatch<SetStateAction<boolean>>;
  queueEditOperation: { queueItemId: string; sessionId: string; workspaceKey: string } | null;
  timelineScrollToBottomRef: RefObject<(() => void) | null>;
  effectiveSummaryPanelVariantOverride: ChatViewSummaryPanelVariant | null;
  handleSummaryPanelVariantChange: (variant: ChatViewSummaryPanelVariant | null) => void;
  workspaceKey: string;
  timelineBottomRequest: TimelineBottomRequest | null;
  blockingInteractionId: string | null;
  draftModelReadinessError: ModelConfigMissingUiError | null;
  dismissDraftModelReadinessError: () => void;
  sharedSettings: AppSettings | null;
  draftConfig: ReturnType<typeof useDraftConfigControl>["draftConfig"];
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  codingPlanUpgradeDialog: CodingPlanUpgradeDialogContextValue | null;
  openSettingsTab: () => void;
  handleOpenWorkflowRunFromPanel: (target: ConversationStatusPanelWorkflowRunTarget) => void;
}

export function useSessionPanePresentation(params: UseSessionPanePresentationParams) {
  const {
    sessionId,
    rootSessionId,
    readOnly,
    selectionSideChat,
    workspacePath,
    workspaceIdentity,
    compactForRemoteControl,
    telemetryVisible,
    gitSummary,
    gitDirtyFileCount,
    gitWorktreeChangeSummary,
    onOpenBrowserUrl,
    onSyncSubagentSessionTabs,
    onOpenWorkflowRun,
    conversationShareService,
    intl,
    locale,
    baseWorkspaceServices,
    conversationTelemetry,
    conversationTelemetryForegroundEnabled,
    lease,
    state,
    snapshot,
    runtimeReady,
    sessionLeaseReady,
    dismissedErrorKeys,
    setDismissedErrorKeys,
    sendSubmissionError,
    setSendSubmissionError,
    setTerminalSectionOpen,
    setAgentSectionOpen,
    setWorkflowSectionOpen,
    queueEditOperation,
    timelineScrollToBottomRef,
    effectiveSummaryPanelVariantOverride,
    handleSummaryPanelVariantChange,
    workspaceKey,
    timelineBottomRequest,
    blockingInteractionId,
    draftModelReadinessError,
    dismissDraftModelReadinessError,
    sharedSettings,
    draftConfig,
    resolveInitialDraftConfig,
    codingPlanUpgradeDialog,
    openSettingsTab,
    handleOpenWorkflowRunFromPanel,
  } = params;

  // subscribe ACK 会先把 store 置 live，initial snapshot 稍后才到；只看
  // status 会在无投影窗口提前启用编辑器。正式 session 必须等首个 snapshot 才可输入。
  const connecting =
    sessionId !== null &&
    (snapshot === null || (state.status === "connecting" && !snapshot.runtimeInitialization));
  const queueEditActiveForCurrentComposer =
    queueEditOperation?.sessionId === sessionId && queueEditOperation.workspaceKey === workspaceKey;
  const errored = sessionId !== null && state.status === "error";
  useSessionSubscriptionErrorTelemetry({
    supervisor: conversationTelemetry,
    sessionId,
    lastError: state.lastError,
    visible: errored && telemetryVisible && conversationTelemetryForegroundEnabled,
  });
  // retry 的产品裁决属于行级权威投影。这里仅提供命令能力，入口是否展示
  // 完全读取 row.actions.canRetry，禁止再用 pane phase 形成第二套 guard。
  const retryActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  // fork 可用性完全由 row.actions.canFork（CLI stable resolver 投影）裁决；pane 只提供命令回调。
  const forkActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  // editUserQuery 已由 command 层防御 latest real user query，并在 running
  // 提交时先 stop barrier 再 rewind/rerun；UI 不应再用 completed gate 把入口整轮隐藏。
  const editActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  const isDraft = sessionId === null;
  // 滚动恢复必须使用与 sessionId 匹配的 lease projection。切换 session 的 render 与
  // passive effect 不在同一时刻，旧 lease 的 rows 若提前交给 timeline，会让新记忆按旧
  // 内容高度 clamp，后续目标 rows 到达时也无法区分这次临时落点。
  const timelineSnapshot =
    !isDraft && (lease === null || sessionLeaseReady) && snapshot?.sessionId === sessionId
      ? snapshot
      : null;
  const shareHandoverContext =
    snapshot?.sharedContextImport && "contextId" in snapshot.sharedContextImport
      ? snapshot.sharedContextImport
      : null;
  // 导入的分享对话：读取落盘的公开 rows 用于会话顶部的只读块。
  // 分享页可能过期或未上线，所以只读本地副本，不回源。
  const [importedShare, setImportedShare] = useState<ImportedConversationShare | null>(null);
  const importedShareContextId =
    shareHandoverContext && shareHandoverContext.status !== "discarded"
      ? shareHandoverContext.contextId
      : null;
  useEffect(() => {
    if (!importedShareContextId || compactForRemoteControl) {
      setImportedShare(null);
      return;
    }
    let disposed = false;
    void conversationShareService
      .getImportedConversation({
        workspacePath,
        contextId: importedShareContextId,
      })
      .then((imported) => {
        if (disposed) return;
        setImportedShare(imported);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // 只读块是增强，读不到就不渲染，不打断会话。
        logger.warn("[conversation-share] 读取导入的分享对话失败", { error });
        setImportedShare(null);
      });
    return () => {
      disposed = true;
    };
  }, [compactForRemoteControl, conversationShareService, importedShareContextId, workspacePath]);
  // normalizeConversationShareMarkdown 在 artifactNames 里找不到匹配名字时，会把正文里的
  // 文件引用替换成空字符串（直接删掉）。不接这份映射，只读块里的文件引用会静默消失。
  const importedShareArtifactNames = useMemo(
    () =>
      new Map(
        (importedShare?.artifacts ?? []).map((artifact) => [
          artifact.artifactId,
          artifact.displayName,
        ]),
      ),
    [importedShare],
  );
  const importedShareArtifactWorkspaceRelativePaths = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const artifact of importedShare?.artifacts ?? []) {
      if (artifact.workspaceRelativePath) {
        entries.push([artifact.artifactId, artifact.workspaceRelativePath]);
      }
    }
    return new Map(entries);
  }, [importedShare]);
  useLayoutEffect(() => {
    if (
      compactForRemoteControl ||
      !timelineBottomRequest ||
      timelineBottomRequest.taskId !== sessionId ||
      !importedShare ||
      importedShare.contextId !== importedShareContextId
    ) {
      return;
    }
    // 分享块是异步挂载的；请求保留到目标 task 与本地副本都就绪，再在布局稳定后消费。
    const scrollToBottom = () => {
      const action = timelineScrollToBottomRef.current;
      if (!action) return false;
      action();
      return true;
    };
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToBottom();
      secondFrame = window.requestAnimationFrame(() => {
        if (!scrollToBottom()) return;
        useZCodeSessionStore
          .getState()
          .clearTimelineBottomRequest(
            workspacePath,
            timelineBottomRequest.requestId,
            workspaceIdentity,
          );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    compactForRemoteControl,
    importedShare,
    importedShareContextId,
    sessionId,
    timelineBottomRequest,
    workspaceIdentity,
    workspacePath,
  ]);
  const handleOpenImportedShareUrl = useCallback(() => {
    if (!shareHandoverContext || !onOpenBrowserUrl) return;
    // 持久化的是规范 /cn/share/ 路径；展示/打开时才按界面语言本地化。
    onOpenBrowserUrl(localizeConversationShareUrl(shareHandoverContext.shareUrl, locale));
  }, [locale, onOpenBrowserUrl, shareHandoverContext]);
  const initialDraftConfigForDiagnostics = isDraft ? resolveInitialDraftConfig() : undefined;
  const telemetryDraftConfig = draftConfig;
  // CLI V4 projection 是 running/count/manifest 的唯一权威；renderer 不再在 spawn
  // 事件后另发查询拼接第二份状态，避免并发 child 的 in-flight refresh 丢更新。
  const subagents = snapshot?.subagents ?? EMPTY_SUBAGENT_PROJECTION;
  useEffect(() => {
    if (!sessionId || subagents.revision === 0 || !onSyncSubagentSessionTabs) return;
    onSyncSubagentSessionTabs({
      rootSessionId: rootSessionId ?? sessionId,
      parentSessionId: sessionId,
      validChildSessionIds: subagents.childSessionIds,
    });
  }, [
    onSyncSubagentSessionTabs,
    rootSessionId,
    sessionId,
    subagents.childSessionIds,
    subagents.revision,
  ]);
  useEffect(() => {
    if (!selectionSideChat || !sessionId) return;
    setSelectionSideChatBlocked(sessionId, Boolean(blockingInteractionId));
    return () => setSelectionSideChatBlocked(sessionId, false);
  }, [blockingInteractionId, selectionSideChat, sessionId]);
  const isOfficeMode = useIsOfficeMode();
  const statusPanelModel = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        workspacePath,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal: selectionSideChat ? null : (snapshot?.goal ?? null),
        sessionPlans: state.sessionPlans,
        plan: snapshot?.plan ?? null,
        backgroundWorks: snapshot?.backgroundWorks ?? [],
        runningSubagents: subagents.running,
        workflowRuns: snapshot?.workflowRuns?.runs ?? [],
      }),
    [
      isOfficeMode,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      snapshot?.backgroundWorks,
      snapshot?.goal,
      snapshot?.plan,
      snapshot?.workflowRuns,
      state.sessionPlans,
      selectionSideChat,
      subagents.running,
      workspacePath,
    ],
  );
  const runningBackgroundWorkCount =
    statusPanelModel.runningBashWorks.length +
    statusPanelModel.runningSubagentWorks.length +
    statusPanelModel.runningWorkflowRuns.length;
  const runningTerminalCount = statusPanelModel.runningBashWorks.length;
  const runningAgentCount = statusPanelModel.runningSubagentWorks.length;
  const runningWorkflowCount = statusPanelModel.runningWorkflowRuns.length;
  useEffect(() => {
    setTerminalSectionOpen(false);
    setAgentSectionOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (runningTerminalCount === 0) {
      setTerminalSectionOpen(false);
    }
  }, [runningTerminalCount]);
  // 「工作流」分区跟着「有没有活的 run」走（docs/dynamic-workflow/presentation.md「Other places a
  // run appears」）：在跑数从 0 变成 ≥1 时打开、归零时折起，进入会话时按该会话重新判定。只在这个
  // 布尔翻转（或换会话）时写入，所以读者手动折起后，run 还在跑就一直保持折起。
  // Bug 原因：过去它和终端 / 智能体一样默认折起；胶囊改为按名字显示工作流后，点开胶囊反而把刚才
  // 看到的那条 run 折进了分区里——展开后看到的比胶囊还少。
  const hasLiveWorkflowRun = runningWorkflowCount > 0;
  useEffect(() => {
    setWorkflowSectionOpen(hasLiveWorkflowRun);
  }, [hasLiveWorkflowRun, sessionId]);
  useEffect(() => {
    if (runningAgentCount === 0) {
      setAgentSectionOpen(false);
    }
  }, [runningAgentCount]);
  // composer 徽标直达：唯一在跑的是一条可开
  // 详情页的 workflow run 时，徽标点击直接开它的 side tab，胶囊不动。判定吃胶囊的同一份模型；
  // 宿主没给 onOpenWorkflowRun（面板行同样不可点）时不直达。
  const soleRunningWorkflowRunTarget = useMemo(
    () => (onOpenWorkflowRun ? resolveSoleRunningWorkflowRunTarget(statusPanelModel) : null),
    [onOpenWorkflowRun, statusPanelModel],
  );
  const handleOpenRunningBackgroundWorks = useCallback(() => {
    if (runningBackgroundWorkCount === 0) return;
    if (soleRunningWorkflowRunTarget) {
      // 与面板行同一个 handler：不存在第二条打开路径。
      handleOpenWorkflowRunFromPanel(soleRunningWorkflowRunTarget);
      return;
    }
    // 产品规则：Composer 是全部实时活动的入口；分区拆开后一次点击仍要展开所有非空类型，
    // 但三个区块后续保持独立折叠状态，不能再共享一个 open 布尔值。
    setTerminalSectionOpen(runningTerminalCount > 0);
    setAgentSectionOpen(runningAgentCount > 0);
    setWorkflowSectionOpen(runningWorkflowCount > 0);
    handleSummaryPanelVariantChange("panel");
  }, [
    handleOpenWorkflowRunFromPanel,
    handleSummaryPanelVariantChange,
    runningAgentCount,
    runningBackgroundWorkCount,
    runningTerminalCount,
    runningWorkflowCount,
    soleRunningWorkflowRunTarget,
  ]);
  const statusPanelVariant = resolveConversationStatusPanelVariant({
    variantOverride: effectiveSummaryPanelVariantOverride,
  });
  // 若只有 status panel 内部知道自动展开态，而 timeline/composer 未同步调整布局，
  // 宽屏下就会出现面板覆盖内容。因此外层布局也必须使用同一展开状态。
  const shouldUseStatusPanelInlineLayout =
    !isDraft &&
    shouldUseConversationStatusPanelInlineLayout({
      hasContent: statusPanelModel.hasContent,
      variant: statusPanelVariant,
    });
  const statusPanelLayout: "none" | "auto" | "inline" = !shouldUseStatusPanelInlineLayout
    ? "none"
    : statusPanelVariant === "auto"
      ? "auto"
      : "inline";
  const controlLastError = snapshot?.control.lastError ?? null;
  const controlLastErrorKey = controlLastError
    ? createSessionErrorKey(snapshot?.sessionId ?? sessionId, controlLastError)
    : null;
  const projectedComposerError =
    controlLastError && controlLastErrorKey && !dismissedErrorKeys.includes(controlLastErrorKey)
      ? toComposerUiError(snapshot?.sessionId ?? sessionId, controlLastError)
      : null;
  // 官方 Server MCP 不可用（额度耗尽 / 无 Coding Plan）：事实来自 tool row 上的结构化标识，
  // 与模型额度是两条独立信息通道，这里只做投影。
  const mcpUnavailableNotice = useMemo(
    () => resolveMcpUnavailableNotice(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  const quotaBanner = useV4SessionQuotaBanner({
    sessionId: snapshot?.sessionId ?? sessionId,
    error: controlLastError,
    errorKey: controlLastErrorKey,
    phase: snapshot?.control.phase ?? null,
    providerId: snapshot?.config.provider ?? null,
    modelId: snapshot?.config.model ?? null,
    usageStatsService: baseWorkspaceServices.usageStatsService,
    mcpUnavailableNotice,
  });
  const composerError =
    draftModelReadinessError ??
    sendSubmissionError ??
    (quotaBanner.takesOverError ? null : projectedComposerError);
  useEffect(() => {
    setSendSubmissionError(null);
  }, [sessionId]);
  const handleDismissComposerError = useCallback(() => {
    if (draftModelReadinessError) {
      dismissDraftModelReadinessError();
      return;
    }
    if (sendSubmissionError) {
      setSendSubmissionError(null);
      return;
    }
    if (!controlLastErrorKey) return;
    // v4 control.lastError 是投影事实，单纯关闭 banner 不会改投影。
    // 这里只记录当前错误指纹，避免下一次 render 把同一条错误立刻重新顶回来；新错误 at/message 变化仍会显示。
    setDismissedErrorKeys((keys) =>
      keys.includes(controlLastErrorKey) ? keys : [...keys.slice(-19), controlLastErrorKey],
    );
  }, [
    controlLastErrorKey,
    dismissDraftModelReadinessError,
    draftModelReadinessError,
    sendSubmissionError,
  ]);
  // 远端 workspace 的模型目录来自远端 Registry；本机配置保存后由 Provisioning 自动下发，
  // 因此缺模型横幅只切换措辞，配置/升级动作仍统一指向本机。
  const modelConfigTarget: ChatErrorBannerModelConfigTarget = isRemoteWorkspaceIdentity(
    workspaceIdentity ?? "",
  )
    ? "remote"
    : "local";
  const handleOpenModelSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const handleOpenModelUpgrade = useCallback(() => {
    if (!codingPlanUpgradeDialog) return;
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    codingPlanUpgradeDialog.openCodingPlanUpgrade({ providerId });
  }, [codingPlanUpgradeDialog, sharedSettings?.providerFamilyDomain]);
  const handleOpenQuotaUpgrade = useCallback(() => {
    const providerId = quotaBanner.upgradeProviderId;
    if (!providerId || !codingPlanUpgradeDialog) return;
    const eventText = intl.formatMessage({
      id: quotaBanner.upgradeActionLabelId,
    });
    // 横幅只建立漏斗上下文；coding_plan_upgrade_ck 仍由真实购买面板打开后统一上报。
    codingPlanUpgradeDialog.openCodingPlanUpgrade({
      providerId,
      funnelContext: createCodingPlanFunnelContext({
        providerId,
        upgradeSource: "session_quota_alert",
        eventRegion: "app.session",
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanState({
          providerId,
          displayStatus: "purchased",
          planLevel: "start",
        }),
      }),
    });
  }, [
    codingPlanUpgradeDialog,
    intl,
    quotaBanner.upgradeActionLabelId,
    quotaBanner.upgradeProviderId,
  ]);

  return {
    connecting,
    queueEditActiveForCurrentComposer,
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
    telemetryDraftConfig,
    subagents,
    isOfficeMode,
    runningBackgroundWorkCount,
    runningAgentCount,
    soleRunningWorkflowRunTarget,
    handleOpenRunningBackgroundWorks,
    statusPanelLayout,
    controlLastError,
    projectedComposerError,
    quotaBanner,
    composerError,
    handleDismissComposerError,
    modelConfigTarget,
    handleOpenModelSettings,
    handleOpenModelUpgrade,
    handleOpenQuotaUpgrade,
  };
}
