// SessionPane 拆分：pane 级状态（打开埋点、UI 状态、ref 绑定）与 Highspeed 加速卡/完成态聚合。
import { browserGlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";
import { calculateHighspeedSavedDurationFromMetrics } from "@/highspeed/highspeedSavedTime.js";
import { buildHighspeedShareNotice } from "@/highspeed/highspeedShare.js";
import {
  collectHighspeedCardShareBlockers,
  listHighspeedCardsAwaitingAutoShare,
} from "@/highspeed/highspeedShareDiagnostics.js";
import {
  claimHighspeedCardInvalidation,
  releaseHighspeedCardInvalidation,
} from "@/highspeed/highspeedToastClaims.js";
import {
  claimHighspeedCardAutoShare,
  claimHighspeedHealthyAttempt,
  completeHighspeedTurn,
  discardHighspeedTurn,
  getHighspeedCardTps,
  getHighspeedTurnVersion,
  hydrateHighspeedTurnsFromTranscript,
  listExpiredHighspeedCardsAwaitingTps,
  listHighspeedCardAutoShareCandidates,
  listHighspeedTurnsAwaitingMetricsPersistence,
  listPendingHighspeedTurns,
  markHighspeedCardAutoShared,
  markHighspeedTurnMetricsPersisted,
  resolveNextHighspeedAutoShareAt,
  setHighspeedCardTps,
  subscribeHighspeedTurns,
} from "@/highspeed/highspeedTurnStore.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { logger } from "@/logger.js";
import { createAssistantPreviewPptxAutoOpenGateState } from "@/v4/assistantPreviewPptxAutoOpen.js";
import type { AssistantPreviewPptxAutoOpenTarget } from "@/v4/assistantPreviewPptxAutoOpen.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { ComposerRestoreRequest } from "@/v4/ConversationComposer.js";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";
import {
  hasPluginReferenceUserRows,
  isSessionPluginCatalogReady,
} from "@/v4/pluginReferenceIconProjection.js";
import {
  MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS,
  isConversationFileDrag,
} from "@/v4/session-pane/helpers.js";
import type { SessionPaneDispatchCommand } from "@/v4/session-pane/helpers.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import type { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { useSessionOpenArmsTelemetry } from "@/v4/telemetry/useSessionOpenArmsTelemetry.js";
import type { IHighspeedCardService } from "@zcode/services";
import type { HighspeedCardSnapshot, IPlatformService } from "@zcode/shared";
import type {
  CommandAck,
  CommandType,
  ConversationSnapshot,
  UserInputRow,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export interface UseSessionPaneSessionOpenParams {
  sessionId: string | null;
  openTrigger: SessionOpenTrigger | undefined;
  readOnly: boolean;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  compactForRemoteControl: boolean;
  onDropTargetControllerChange:
    | ((controller: ConversationDropTargetController | null) => void)
    | undefined;
  fileChanges: (
    params: V4ConversationFileChangesParams,
  ) => Promise<V4ConversationFileChangesResult>;
  platform: IPlatformService | null;
  conversationTelemetry: ConversationTelemetrySupervisor | null;
  lease: SessionLease | null;
  state: ConversationStoreState;
  snapshot: ConversationSnapshot | null;
  newlyCreatedSessionIdRef: RefObject<string | null>;
}

export function useSessionPaneSessionOpen(params: UseSessionPaneSessionOpenParams) {
  const {
    sessionId,
    openTrigger,
    readOnly,
    workspacePath,
    workspaceIdentity,
    compactForRemoteControl,
    onDropTargetControllerChange,
    fileChanges,
    platform,
    conversationTelemetry,
    lease,
    state,
    snapshot,
    newlyCreatedSessionIdRef,
  } = params;

  const sessionLeaseReady = lease?.sessionId === sessionId;
  const shouldMeasureExistingSessionOpen =
    sessionLeaseReady && newlyCreatedSessionIdRef.current !== sessionId;
  useSessionOpenArmsTelemetry({
    sessionId,
    snapshot,
    openTiming: sessionLeaseReady ? state.openTiming : undefined,
    rendererTiming: sessionLeaseReady ? state.rendererTiming : undefined,
    openKind: sessionLeaseReady ? lease?.openKind : undefined,
    openTrigger,
    startedAt: sessionLeaseReady ? lease?.startedAt : undefined,
    status: state.status,
    lastError: state.lastError,
    enabled: shouldMeasureExistingSessionOpen,
    readOnly,
    reporter: platform,
  });
  useEffect(() => {
    const newlyCreatedSessionId = newlyCreatedSessionIdRef.current;
    if (newlyCreatedSessionId !== null && newlyCreatedSessionId !== sessionId) {
      newlyCreatedSessionIdRef.current = null;
    }
  }, [sessionId]);
  const mobilePlanInteractionReconcileTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  useEffect(() => {
    const timers = mobilePlanInteractionReconcileTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [lease, sessionId]);
  const handleMobilePlanInteractionAccepted = useCallback(
    (interactionId: string) => {
      if (!compactForRemoteControl || !lease) return;
      const timers = mobilePlanInteractionReconcileTimersRef.current;
      if (timers.has(interactionId)) return;
      const timer = setTimeout(() => {
        timers.delete(interactionId);
        const authoritativeSnapshot = lease.store.getState().snapshot;
        const stillPending = authoritativeSnapshot?.pendingInteractions.some(
          (interaction) => interaction.interactionId === interactionId,
        );
        if (!stillPending) return;
        // Bug 根因：手机 Plan 回执 ACK 与 replayable 清场分属两条异步路径；清场帧
        // 丢失时旧 interaction 会永久驻留。只在 grace 后仍读到权威 pending 时复用
        // 既有 same-sub recovery，不本地隐藏弹窗，也不影响 desktop continuous。
        logger.warn("[v4-pane] 手机 Plan ACK 后 pending 未收口，触发权威恢复", {
          interactionId,
          sessionId,
          workspaceKey: workspaceIdentity?.trim() || workspacePath,
        });
        lease.store.recoverFromStaleAuthority();
      }, MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS);
      timers.set(interactionId, timer);
    },
    [compactForRemoteControl, lease, sessionId, workspaceIdentity, workspacePath],
  );
  const pluginReferenceIconsEnabled =
    isSessionPluginCatalogReady(state.status, sessionId, snapshot?.sessionId) &&
    hasPluginReferenceUserRows(snapshot?.rows.window ?? []);
  // send_result 的落定信号：用户消息真正画进对话历史。z-code 没有乐观渲染，
  // 气泡必须等投影回流出 userInput row 才出现，所以 ACK accepted 不能算发送完成。
  // 取 useEffect 而非 store 订阅回调 —— effect 在 DOM commit 之后跑，此刻气泡已在屏幕上。
  useEffect(() => {
    const rows = snapshot?.rows.window;
    if (!rows || rows.length === 0) return;
    // 不能只取最后一条 userInput：后台结果行可能紧随其后插到尾部，
    // 只看尾部会漏掉用户自己那条，误判成 render_timeout。supervisor 侧按
    // 待渲染表 O(1) 过滤，历史回填 / 切会话重载推来的老 row 不会误触发。
    for (const row of rows) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        conversationTelemetry?.notifyUserInputRendered(row.sourceCommandId);
      }
    }
  }, [conversationTelemetry, snapshot]);
  const fileChangesRequestCache = useMemo(
    () => new Map<string, Promise<V4ConversationFileChangesResult>>(),
    [fileChanges, sessionId, snapshot?.logEpoch],
  );
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<readonly string[]>([]);
  const [sendSubmissionError, setSendSubmissionError] = useState<ZCodeUiError | null>(null);
  const [paneLocalSummaryPanelVariantOverride, setPaneLocalSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const [terminalSectionOpen, setTerminalSectionOpen] = useState(false);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [workflowSectionOpen, setWorkflowSectionOpen] = useState(false);
  const [dropTargetController, setDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const handleDropTargetControllerChange = useCallback(
    (controller: ConversationDropTargetController | null) => {
      setDropTargetController(controller);
      onDropTargetControllerChange?.(controller);
    },
    [onDropTargetControllerChange],
  );
  const readOnlyDropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: false,
      kind: null,
      onDragLeave: () => {},
      onDragOver: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      },
      onDrop: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [],
  );
  const effectiveDropTargetController = readOnly
    ? readOnlyDropTargetController
    : dropTargetController;
  const isMobileTextInputViewport = useIsMobileTextInputViewport();

  return {
    sessionLeaseReady,
    handleMobilePlanInteractionAccepted,
    pluginReferenceIconsEnabled,
    fileChangesRequestCache,
    dismissedErrorKeys,
    setDismissedErrorKeys,
    sendSubmissionError,
    setSendSubmissionError,
    paneLocalSummaryPanelVariantOverride,
    setPaneLocalSummaryPanelVariantOverride,
    terminalSectionOpen,
    setTerminalSectionOpen,
    agentSectionOpen,
    setAgentSectionOpen,
    workflowSectionOpen,
    setWorkflowSectionOpen,
    handleDropTargetControllerChange,
    effectiveDropTargetController,
    isMobileTextInputViewport,
  };
}

export interface UseSessionPaneHighspeedCardStateParams {
  sessionId: string | null;
  highspeedCardService: IHighspeedCardService;
  snapshot: ConversationSnapshot | null;
}

export function useSessionPaneHighspeedCardState(params: UseSessionPaneHighspeedCardStateParams) {
  const { sessionId, highspeedCardService, snapshot } = params;

  // 稳定回调读取的最新值经 ref 透传，避免回调依赖高频变化的 snapshot/文本。
  const snapshotRef = useRef<ConversationSnapshot | null>(snapshot);
  const sessionIdRef = useRef(sessionId);
  const [activeHighspeedCard, setActiveHighspeedCard] = useState<HighspeedCardSnapshot | null>(
    null,
  );
  const invalidateActiveHighspeedCard = useCallback(
    (cardId: string, failureKey: string) => {
      if (!claimHighspeedCardInvalidation(failureKey)) return;
      void highspeedCardService
        .invalidateCard(cardId)
        .then(() => {
          // Bug 根因：Highspeed 失败后若卡仍留在服务里，Composer 会继续显示加速态并锁死模型选择。
          // Service 按 cardId 作废唯一真相，再清同一张卡的展示投影；旧失败不能清掉后来抽中的新卡。
          setActiveHighspeedCard((current) => (current?.cardId === cardId ? null : current));
        })
        .catch((error) => {
          releaseHighspeedCardInvalidation(failureKey);
          logger.warn("[highspeed] 作废失败的加速卡失败", {
            cardId,
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    [highspeedCardService, sessionId],
  );
  // 激活动效的一次性请求：只由发送路径 draw 新命中登记，composer 锁定入场方式后消费。
  const [highspeedActivationCardId, setHighspeedActivationCardId] = useState<string | null>(null);
  // 本 pane 最近呈现过的卡片身份：恢复与复用同一张卡的发送据此判定不是新命中。
  const presentedHighspeedCardIdRef = useRef<string | null>(null);
  const highspeedMetricsInFlightRef = useRef(new Set<string>());
  const highspeedTurnVersion = useSyncExternalStore(
    subscribeHighspeedTurns,
    getHighspeedTurnVersion,
    getHighspeedTurnVersion,
  );
  const [highspeedAutoShareClock, refreshHighspeedAutoShareClock] = useState(0);

  return {
    snapshotRef,
    sessionIdRef,
    activeHighspeedCard,
    setActiveHighspeedCard,
    invalidateActiveHighspeedCard,
    highspeedActivationCardId,
    setHighspeedActivationCardId,
    presentedHighspeedCardIdRef,
    highspeedMetricsInFlightRef,
    highspeedTurnVersion,
    highspeedAutoShareClock,
    refreshHighspeedAutoShareClock,
  };
}

export interface UseSessionPaneEmbeddedStateParams {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  summaryPanelVariantOverride: ChatViewSummaryPanelVariant | null | undefined;
  onSummaryPanelVariantOverrideChange:
    | ((variant: ChatViewSummaryPanelVariant | null) => void)
    | undefined;
  onAutoOpenAssistantPptx: ((request: AssistantPreviewCardsAutoOpenRequest) => void) | undefined;
  snapshot: ConversationSnapshot | null;
  paneLocalSummaryPanelVariantOverride: ChatViewSummaryPanelVariant | null;
  setPaneLocalSummaryPanelVariantOverride: Dispatch<
    SetStateAction<ChatViewSummaryPanelVariant | null>
  >;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  sessionIdRef: RefObject<string | null>;
}

export function useSessionPaneEmbeddedState(params: UseSessionPaneEmbeddedStateParams) {
  const {
    sessionId,
    workspacePath,
    workspaceIdentity,
    summaryPanelVariantOverride,
    onSummaryPanelVariantOverrideChange,
    onAutoOpenAssistantPptx,
    snapshot,
    paneLocalSummaryPanelVariantOverride,
    setPaneLocalSummaryPanelVariantOverride,
    snapshotRef,
    sessionIdRef,
  } = params;

  const dispatchCommandRef = useRef<
    | ((
        type: CommandType,
        payload: Record<string, unknown>,
        targetSessionId: string | null,
        baseRevision?: number,
        baseLogEpoch?: string,
      ) => Promise<CommandAck>)
    | null
  >(null);
  const autoOpenedAssistantPptxKeysRef = useRef<Set<string>>(new Set());
  const assistantPreviewPptxGateRef = useRef(createAssistantPreviewPptxAutoOpenGateState());
  const [assistantPreviewPptxAutoOpenTarget, setAssistantPreviewPptxAutoOpenTarget] =
    useState<AssistantPreviewPptxAutoOpenTarget | null>(null);
  const autoLoadIncompleteTurnCursorRef = useRef<string | null>(null);
  snapshotRef.current = snapshot;
  sessionIdRef.current = sessionId;
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!onAutoOpenAssistantPptx || request.sources.length === 0) return;
      if (autoOpenedAssistantPptxKeysRef.current.has(request.key)) return;
      autoOpenedAssistantPptxKeysRef.current.add(request.key);
      onAutoOpenAssistantPptx(request);
    },
    [onAutoOpenAssistantPptx],
  );
  const composerDraftStateRef = useRef({ hasContent: false, busy: false });
  const [queueEditOperation, setQueueEditOperation] = useState<{
    queueItemId: string;
    sessionId: string;
    workspaceKey: string;
  } | null>(null);
  const queueEditOperationRef = useRef(queueEditOperation);
  queueEditOperationRef.current = queueEditOperation;
  const [composerRestoreRequest, setComposerRestoreRequest] =
    useState<ComposerRestoreRequest | null>(null);
  const nextComposerRestoreRequestIdRef = useRef(1);
  const timelineScrollToBottomRef = useRef<(() => void) | null>(null);
  const timelineScrollToQueryRef = useRef<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >(null);
  const conversationLayoutContainerRef = useRef<HTMLDivElement>(null);
  const hasExternalSummaryPanelVariantControl = Boolean(onSummaryPanelVariantOverrideChange);
  const effectiveSummaryPanelVariantOverride = hasExternalSummaryPanelVariantControl
    ? (summaryPanelVariantOverride ?? null)
    : paneLocalSummaryPanelVariantOverride;
  const handleSummaryPanelVariantChange = useCallback(
    (variant: ChatViewSummaryPanelVariant | null) => {
      if (onSummaryPanelVariantOverrideChange) {
        onSummaryPanelVariantOverrideChange(variant);
        return;
      }
      setPaneLocalSummaryPanelVariantOverride(variant);
    },
    [onSummaryPanelVariantOverrideChange],
  );

  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // pane 每次重新绑定 Task / 工作区时递增代次：A → B → A 后 sessionId 相同但代次不同。
  // 与 sessionIdRef 一样在渲染期同步，供跨 await 的发送回调读取最新绑定。
  const paneBindingKey = `${workspaceKey}\u0000${sessionId ?? ""}`;
  const paneBindingRef = useRef({ key: paneBindingKey, generation: 0 });
  if (paneBindingRef.current.key !== paneBindingKey) {
    paneBindingRef.current = {
      key: paneBindingKey,
      generation: paneBindingRef.current.generation + 1,
    };
  }

  return {
    dispatchCommandRef,
    autoOpenedAssistantPptxKeysRef,
    assistantPreviewPptxGateRef,
    assistantPreviewPptxAutoOpenTarget,
    setAssistantPreviewPptxAutoOpenTarget,
    autoLoadIncompleteTurnCursorRef,
    handleAutoOpenAssistantPptx,
    composerDraftStateRef,
    queueEditOperation,
    setQueueEditOperation,
    queueEditOperationRef,
    composerRestoreRequest,
    setComposerRestoreRequest,
    nextComposerRestoreRequestIdRef,
    timelineScrollToBottomRef,
    timelineScrollToQueryRef,
    conversationLayoutContainerRef,
    effectiveSummaryPanelVariantOverride,
    handleSummaryPanelVariantChange,
    workspaceKey,
    paneBindingRef,
  };
}

export interface UseSessionPaneHighspeedTurnsParams {
  sessionId: string | null;
  highspeedCardService: IHighspeedCardService;
  snapshot: ConversationSnapshot | null;
  activeHighspeedCard: HighspeedCardSnapshot | null;
  setActiveHighspeedCard: Dispatch<SetStateAction<HighspeedCardSnapshot | null>>;
  presentedHighspeedCardIdRef: RefObject<string | null>;
  highspeedMetricsInFlightRef: RefObject<Set<string>>;
  highspeedTurnVersion: number;
  highspeedAutoShareClock: number;
  refreshHighspeedAutoShareClock: Dispatch<SetStateAction<number>>;
  dispatchCommandRef: RefObject<SessionPaneDispatchCommand | null>;
}

export function useSessionPaneHighspeedTurns(params: UseSessionPaneHighspeedTurnsParams) {
  const {
    sessionId,
    highspeedCardService,
    snapshot,
    activeHighspeedCard,
    setActiveHighspeedCard,
    presentedHighspeedCardIdRef,
    highspeedMetricsInFlightRef,
    highspeedTurnVersion,
    highspeedAutoShareClock,
    refreshHighspeedAutoShareClock,
    dispatchCommandRef,
  } = params;

  useEffect(() => {
    let disposed = false;
    if (!sessionId) {
      setActiveHighspeedCard(null);
      return () => undefined;
    }
    void highspeedCardService
      .getSnapshot()
      .then((serviceSnapshot) => {
        if (disposed) return;
        const card = serviceSnapshot.card;
        const now = Date.now();
        if (!card || card.taskId !== sessionId || card.expiresAt <= now) {
          setActiveHighspeedCard(null);
          return;
        }
        presentedHighspeedCardIdRef.current = card.cardId;
        setActiveHighspeedCard(card);
      })
      .catch((error) => {
        if (disposed) return;
        setActiveHighspeedCard(null);
        logger.warn("[highspeed] 读取卡片状态失败，输入框按普通状态展示", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    return () => {
      disposed = true;
    };
  }, [highspeedCardService, sessionId]);
  useEffect(() => {
    if (!activeHighspeedCard) return;
    const cardId = activeHighspeedCard.cardId;
    const expiresAt = activeHighspeedCard.expiresAt;
    // Bug 根因：清卡曾只依赖一次性 setTimeout；窗口隐藏/息屏时页面被 Chromium 冻结、
    // 定时器停摆，唤醒后积压的 timeout 迟迟不触发，而 composer 倒计时是每秒读 Date.now()
    // 的 interval、唤醒即自愈——出现「倒计时已到 00:00:00 但输入框加速态不退出」的僵尸卡，
    // 只能等下一条消息的 prepareTurn 救活。回到窗口时按真实时钟重估：已过期立即清卡，
    // 未过期重挂剩余时长（与下方分享时钟补偿同口径，spec §9.2/§9.3）。
    const clearIfExpired = () => {
      if (Date.now() < expiresAt) return false;
      setActiveHighspeedCard((current) => (current?.cardId === cardId ? null : current));
      return true;
    };
    if (clearIfExpired()) return;
    let timer: number | undefined;
    const arm = () => {
      window.clearTimeout(timer);
      // Bug 根因：setTimeout 按单调时钟计时，到期判定读墙钟 Date.now()；两者的毫秒级偏差或
      // NTP 回拨会让 timer 在墙钟到期前触发。只判定不重挂时，窗口常驻前台的加速态永不退出。
      timer = window.setTimeout(() => {
        if (!clearIfExpired()) arm();
      }, expiresAt - Date.now());
    };
    arm();
    const refreshFromWindowWake = () => {
      if (document.visibilityState === "hidden") return;
      if (!clearIfExpired()) arm();
    };
    document.addEventListener("visibilitychange", refreshFromWindowWake);
    window.addEventListener("focus", refreshFromWindowWake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshFromWindowWake);
      window.removeEventListener("focus", refreshFromWindowWake);
    };
  }, [activeHighspeedCard]);
  useEffect(() => {
    if (!sessionId) return;
    const nextAutoShareAt = resolveNextHighspeedAutoShareAt(sessionId);
    if (nextAutoShareAt === null) return;
    const delayMs = Math.max(0, nextAutoShareAt - Date.now()) + 20;
    // Bug 根因：旧逻辑以 Turn 完成为分享时钟，第一轮结束就发布卡片；这里改由整张卡
    // 的 expiresAt 唤醒聚合流程，卡到期时若仍有 Turn 运行，则等待其完成事件再次触发。
    const timer = window.setTimeout(
      () => refreshHighspeedAutoShareClock((revision) => revision + 1),
      delayMs,
    );
    return () => window.clearTimeout(timer);
  }, [highspeedTurnVersion, sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    // Bug 根因（2026-08-31）：到期唤醒依赖 renderer setTimeout；窗口隐藏/被遮挡时页面被
    // Chromium 冻结，定时器停摆，卡级 TPS 采样与完成态持久化停在原地，footer 查看按钮
    // 一直置灰，直到用户再发一条消息才被 store 版本号变化救活（违反 spec 9.3「到期边界
    // 由会话时间时钟触发重渲染，不要求用户再发送一条消息」）。回到窗口时立即补一次
    // 时钟；聚合链路各入口均有 claim/幂等保护，重复触发无副作用。
    const refreshFromWindowWake = () => {
      if (document.visibilityState === "hidden") return;
      refreshHighspeedAutoShareClock((revision) => revision + 1);
    };
    document.addEventListener("visibilitychange", refreshFromWindowWake);
    window.addEventListener("focus", refreshFromWindowWake);
    return () => {
      document.removeEventListener("visibilitychange", refreshFromWindowWake);
      window.removeEventListener("focus", refreshFromWindowWake);
    };
  }, [refreshHighspeedAutoShareClock, sessionId]);
  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const terminalStates = new Set(["completedSuccess", "completedInterrupted", "failed"]);
    hydrateHighspeedTurnsFromTranscript(
      sessionId,
      snapshot.rows.window
        .filter((row): row is UserInputRow => row.kind === "userInput")
        .map((row) => ({
          sourceCommandId: row.sourceCommandId,
          createdAt: row.createdAt,
          highspeed: row.highspeed,
        })),
    );
    const pendingTurns = listPendingHighspeedTurns(sessionId);
    for (const record of pendingTurns) {
      const userRow = snapshot.rows.window.find(
        (row) => row.kind === "userInput" && row.sourceCommandId === record.sourceCommandId,
      );
      if (userRow?.kind === "userInput" && !userRow.highspeed) {
        // Bug 根因：Highspeed queue 在 admission ACK 时先登记统计；若真正提升时卡已过期，
        // CLI 会移除 Highspeed intent 并走原模型。以权威 user row 撤销预登记，避免普通
        // 输出被错误计入 Highspeed 分享。
        discardHighspeedTurn(record.sourceCommandId);
        continue;
      }
      const header = snapshot.rows.window.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === record.sourceCommandId,
      );
      // 诊断（debug，随 snapshot 高频触发）：完成态统计迟迟收不了口时，日志直接点名卡在哪。
      if (!header || header.kind !== "turnHeader") {
        logger.debug("[highspeed] turn 统计未完成：rows.window 中缺少 turnHeader", {
          sourceCommandId: record.sourceCommandId,
        });
        continue;
      }
      if (!terminalStates.has(header.state) || header.outputTokens === undefined) {
        logger.debug("[highspeed] turn 统计未完成：turnHeader 非终态或无 outputTokens", {
          sourceCommandId: record.sourceCommandId,
          state: header.state,
          hasOutputTokens: header.outputTokens !== undefined,
        });
        continue;
      }
      const durationMs = Math.max(
        0,
        header.activeMs ?? (header.endedAt !== undefined ? header.endedAt - header.startedAt : 0),
      );
      completeHighspeedTurn({
        sourceCommandId: record.sourceCommandId,
        outputTokens: header.outputTokens,
        durationMs,
        ...(header.modelDurationMs !== undefined
          ? { modelDurationMs: header.modelDurationMs }
          : {}),
        ...(header.toolDurationMs !== undefined ? { toolDurationMs: header.toolDurationMs } : {}),
        ...(header.otherDurationMs !== undefined
          ? { otherDurationMs: header.otherDurationMs }
          : {}),
      });
    }

    const autoShareNow = Date.now();
    for (const card of listExpiredHighspeedCardsAwaitingTps(sessionId, autoShareNow)) {
      if (!claimHighspeedHealthyAttempt(card.cardId, card.allTurnsCompleted)) {
        // 诊断（debug）：每卡到期一次 + 完成后补查一次，机会用尽仍无 TPS 时分享链路必然停摆。
        logger.debug("[highspeed] 卡级 healthy 查询机会已用尽，仍无有效 TPS", {
          cardId: card.cardId,
          allTurnsCompleted: card.allTurnsCompleted,
        });
        continue;
      }
      void highspeedCardService
        .healthy(card.cardId)
        .then((usage) => {
          if (usage.completionTokens <= 0 || usage.durationSeconds <= 0) {
            logger.warn("[highspeed] 卡级 healthy 未返回有效 TPS，本轮完成后再补查", {
              cardId: card.cardId,
              completionTokens: usage.completionTokens,
              durationSeconds: usage.durationSeconds,
            });
            return;
          }
          setHighspeedCardTps(card.cardId, usage.completionTokens / usage.durationSeconds);
        })
        .catch((error) => {
          logger.warn("[highspeed] 卡级 healthy 查询失败，本轮完成后再补查", {
            cardId: card.cardId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    const dispatch = dispatchCommandRef.current;
    if (dispatch) {
      for (const record of listHighspeedTurnsAwaitingMetricsPersistence(sessionId)) {
        if (!record.metrics || highspeedMetricsInFlightRef.current.has(record.sourceCommandId)) {
          continue;
        }
        const userRow = snapshot.rows.window.find(
          (row): row is UserInputRow =>
            row.kind === "userInput" && row.sourceCommandId === record.sourceCommandId,
        );
        const regularTps = record.card.regularTps ?? userRow?.highspeed?.regularTps;
        const highspeedTps = getHighspeedCardTps(record.card.cardId);
        // 诊断（debug）：持久化前置条件缺失会让该轮永远停在等待队列里，静默跳过无法定位。
        if (!userRow || !userRow.entityId || !regularTps || !highspeedTps) {
          logger.debug("[highspeed] 完成态持久化前置缺失，本轮暂不派发", {
            sourceCommandId: record.sourceCommandId,
            userRowInWindow: userRow !== undefined && userRow !== null,
            hasEntityId: Boolean(userRow?.entityId),
            hasRegularTps: Boolean(regularTps),
            hasCardTps: Boolean(highspeedTps),
          });
          continue;
        }
        const savedDurationMs = calculateHighspeedSavedDurationFromMetrics(
          record.metrics,
          regularTps,
          highspeedTps,
        );
        highspeedMetricsInFlightRef.current.add(record.sourceCommandId);
        let metricsPersisted = false;
        void dispatch(
          "setHighspeedMetrics",
          {
            target: { rowId: userRow.rowId, entityId: userRow.entityId },
            regularTps,
            outputTokens: record.metrics.outputTokens,
            durationMs: record.metrics.durationMs,
            highspeedTps,
            savedDurationMs,
            ...(record.metrics.modelDurationMs !== undefined
              ? { modelDurationMs: record.metrics.modelDurationMs }
              : {}),
            ...(record.metrics.toolDurationMs !== undefined
              ? { toolDurationMs: record.metrics.toolDurationMs }
              : {}),
            ...(record.metrics.otherDurationMs !== undefined
              ? { otherDurationMs: record.metrics.otherDurationMs }
              : {}),
          },
          sessionId,
          snapshot.revision,
          snapshot.logEpoch,
        )
          .then((ack) => {
            if (ack.status !== "accepted" && ack.status !== "duplicate") {
              logger.warn("[highspeed] 完成态统计持久化被拒绝", {
                reasonCode: ack.reasonCode,
                sourceCommandId: record.sourceCommandId,
                status: ack.status,
              });
              return;
            }
            markHighspeedTurnMetricsPersisted(record.sourceCommandId, savedDurationMs);
            metricsPersisted = true;
          })
          .catch((error) => {
            logger.warn("[highspeed] 完成态统计持久化失败", {
              error: error instanceof Error ? error.message : String(error),
              sourceCommandId: record.sourceCommandId,
            });
          })
          .finally(() => {
            highspeedMetricsInFlightRef.current.delete(record.sourceCommandId);
            // Bug 根因：持久化 ACK 触发的 store 更新可能先于 in-flight 清理被 React 消费，
            // 导致本轮重算被跳过；ACK 成功后显式唤醒一次，避免必须发送下一条 prompt。
            if (metricsPersisted) {
              refreshHighspeedAutoShareClock((revision) => revision + 1);
            }
          });
      }
    }

    for (const candidate of listHighspeedCardAutoShareCandidates(sessionId)) {
      if (candidate.expiresAt > autoShareNow) continue;
      // Bug 根因：失败后只清理 in-flight 会让后续 snapshot 重复触发自动分享，最终打到 429。
      if (!claimHighspeedCardAutoShare(candidate.cardId, autoShareNow)) continue;
      // 分享卡片改为客户端生成，不再请求后端 share 接口；到期后直接把本地统计发布到左下角。
      browserGlobalNoticeStore?.publish(
        buildHighspeedShareNotice({ cardId: candidate.cardId, metrics: candidate.metrics }),
      );
      markHighspeedCardAutoShared(candidate.cardId);
    }

    // 诊断（debug，随 snapshot 高频触发）：卡已到期、从未尝试分享、但也没进候选时，
    // 直接输出阻塞原因。2026-08-31 左下角分享卡停留在旧卡 36 分钟无任何日志可查，
    // 根因就是这些门禁此前全部静默跳过。
    for (const cardId of listHighspeedCardsAwaitingAutoShare(sessionId, autoShareNow)) {
      const blockers = collectHighspeedCardShareBlockers(cardId);
      if (blockers.length > 0) {
        logger.debug("[highspeed] 卡已到期但未进入自动分享，阻塞原因", {
          cardId,
          blockers,
        });
      }
    }
  }, [highspeedAutoShareClock, highspeedCardService, highspeedTurnVersion, sessionId, snapshot]);

  return {};
}
