// SessionPane 拆分：workspace 只读投影同步与草稿模型就绪门禁。
import { toast } from "@/components/ui/toast.js";
import { claimHighspeedFallbackToast } from "@/highspeed/highspeedToastClaims.js";
import { useSettings } from "@/hooks/useSettingService.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import { buildChatSessionScrollMemoryKey } from "@/lib/chatSessionScrollMemory.js";
import {
  buildSelectionSideChatKey,
  isSelectionSideChatBlocked,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import { useConversationPanePresentation } from "@/side-pane-full-view/index.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  resolveLatestCompletedAssistantPreviewTurn,
} from "@/v4/assistantPreviewPptxAutoOpen.js";
import type {
  AssistantPreviewPptxAutoOpenGateState,
  AssistantPreviewPptxAutoOpenTarget,
} from "@/v4/assistantPreviewPptxAutoOpen.js";
import { projectSessionConfigToTaskConfigOptions } from "@/v4/composer/sessionConfigTaskCache.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";
import { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import type { ConversationLatestTurnSummary } from "@/v4/conversationTimelineLiveTail.js";
import type { IModelSelectionService } from "@zcode/services";
import type { HighspeedCardSnapshot } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export interface UseSessionPaneWorkspaceSyncParams {
  paneId: string;
  sessionId: string | null;
  activeSelectionSideChatSessionId: string | null;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  focused: boolean;
  onAutoOpenAssistantPptx: ((request: AssistantPreviewCardsAutoOpenRequest) => void) | undefined;
  snapshot: ConversationSnapshot | null;
  autoOpenedAssistantPptxKeysRef: RefObject<Set<string>>;
  assistantPreviewPptxGateRef: RefObject<AssistantPreviewPptxAutoOpenGateState>;
  setAssistantPreviewPptxAutoOpenTarget: Dispatch<
    SetStateAction<AssistantPreviewPptxAutoOpenTarget | null>
  >;
  workspaceKey: string;
}

export function useSessionPaneWorkspaceSync(params: UseSessionPaneWorkspaceSyncParams) {
  const {
    paneId,
    sessionId,
    activeSelectionSideChatSessionId,
    workspacePath,
    workspaceIdentity,
    focused,
    onAutoOpenAssistantPptx,
    snapshot,
    autoOpenedAssistantPptxKeysRef,
    assistantPreviewPptxGateRef,
    setAssistantPreviewPptxAutoOpenTarget,
    workspaceKey,
  } = params;

  const workspaceConfigOptions = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).configOptions,
  );
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      !snapshot.config.provider.trim() ||
      !snapshot.config.model.trim() ||
      !workspaceConfigOptions?.length
    ) {
      return;
    }
    // Bug 原因：V4 session 配置只存在 ConversationSnapshot，legacy task 配置桶一直为空；
    // 用户从 custom model 会话新建任务时，startDraft 只能继承 workspace 默认模型。
    // 这里仅把权威配置叠到完整目录并按 task 缓存，不改变 session 或 workspace 事实源。
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(
        workspacePath,
        sessionId,
        projectSessionConfigToTaskConfigOptions(workspaceConfigOptions, snapshot.config),
        workspaceIdentity,
      );
  }, [
    sessionId,
    snapshot?.config.mode,
    snapshot?.config.model,
    snapshot?.config.provider,
    snapshot?.config.thought,
    snapshot?.sessionId,
    workspaceConfigOptions,
    workspaceIdentity,
    workspacePath,
  ]);
  useEffect(() => {
    const scopeKey = `${workspaceKey}\u0000${sessionId ?? "draft"}`;
    const enabled = Boolean(onAutoOpenAssistantPptx && focused && sessionId);
    const result = advanceAssistantPreviewPptxAutoOpenGate(assistantPreviewPptxGateRef.current, {
      enabled,
      scopeKey,
      logEpoch: snapshot?.logEpoch,
      phase: snapshot?.control.phase,
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(snapshot?.rows.window ?? []),
    });
    assistantPreviewPptxGateRef.current = result.state;
    if (result.target !== undefined) {
      setAssistantPreviewPptxAutoOpenTarget(result.target);
    }
  }, [
    focused,
    onAutoOpenAssistantPptx,
    sessionId,
    snapshot?.control.phase,
    snapshot?.logEpoch,
    snapshot?.rows.window,
    workspaceKey,
  ]);
  useEffect(() => {
    // 防止切换 workspace/session/logEpoch 后沿用旧 key；key 本身已隔离，清理仅是
    // 生命周期边界，避免长时间 workbench 中 Set 随会话数增长。
    autoOpenedAssistantPptxKeysRef.current.clear();
  }, [sessionId, snapshot?.logEpoch, workspaceKey]);
  const composerTextInsertRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest,
  );
  const timelineBottomRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).timelineBottomRequest,
  );
  const draftRuntimeInvalidationVersion = useZCodeSessionStore(
    (store) =>
      store.getWorkspaceState(workspacePath, workspaceIdentity).draftRuntimeInvalidationVersion,
  );
  const handleExternalTextInsertApplied = useCallback(
    (requestId: number) => {
      useZCodeSessionStore
        .getState()
        .clearComposerTextInsertRequest(workspacePath, requestId, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );
  const composerBindingRef = useRef({ sessionId, workspaceKey });
  composerBindingRef.current = { sessionId, workspaceKey };
  const configCommandBarrier = useMemo(() => createConfigCommandBarrier(), []);
  // 软审核不是阻塞交互，不能隐藏 Composer 或禁用选区引用。
  const blockingInteractionId =
    snapshot?.pendingInteractions.find(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    )?.interactionId ?? null;
  const panePresentation = useConversationPanePresentation();
  const isFloatingPresentation = panePresentation.presentation === "floating";
  const isRunning = Boolean(snapshot?.control.canStop);
  const { reportFloatingStatus } = panePresentation;
  const floatingOwnerKey = sessionId ?? "__draft__";
  // 浮窗形态下由时间线上报最后一个回合（同一个 render unit 的运行状态、时长与最终回答）；
  // 记录带上 owner，切换会话后旧会话的摘要不会混进新会话。
  const [floatingLatestTurn, setFloatingLatestTurn] = useState<{
    ownerKey: string;
    summary: ConversationLatestTurnSummary;
  } | null>(null);
  const handleFloatingLatestTurnSummaryChange = useCallback(
    (summary: ConversationLatestTurnSummary) =>
      setFloatingLatestTurn({ ownerKey: floatingOwnerKey, summary }),
    [floatingOwnerKey],
  );
  const floatingLatestTurnSummary =
    isFloatingPresentation && floatingLatestTurn?.ownerKey === floatingOwnerKey
      ? floatingLatestTurn.summary
      : null;
  const floatingTurnKey = floatingLatestTurnSummary?.turnKey ?? null;
  const floatingTurnRunning = floatingLatestTurnSummary?.running ?? false;
  const floatingTurnAnswer = floatingLatestTurnSummary?.answer ?? null;
  const hasFloatingLatestTurn = floatingLatestTurnSummary !== null;
  useEffect(() => {
    // 完整视图浮窗只展示焦点 pane 的状态；docked 时 reportFloatingStatus 为 noop。
    if (!focused) return;
    reportFloatingStatus({
      running: isRunning,
      blockingInteractionId,
      ownerKey: floatingOwnerKey,
      latestTurn: hasFloatingLatestTurn
        ? { turnKey: floatingTurnKey, running: floatingTurnRunning, answer: floatingTurnAnswer }
        : null,
    });
  }, [
    blockingInteractionId,
    floatingOwnerKey,
    floatingTurnAnswer,
    floatingTurnKey,
    floatingTurnRunning,
    focused,
    hasFloatingLatestTurn,
    isRunning,
    reportFloatingStatus,
  ]);
  const selectionSideChatKey = sessionId
    ? buildSelectionSideChatKey(workspaceKey, sessionId)
    : null;
  const selectionSideActionBlocked = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () =>
      activeSelectionSideChatSessionId
        ? isSelectionSideChatBlocked(activeSelectionSideChatSessionId)
        : false,
    () => false,
  );
  const timelineScrollMemoryKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId,
    taskId: null,
  });

  return {
    composerTextInsertRequest,
    timelineBottomRequest,
    draftRuntimeInvalidationVersion,
    handleExternalTextInsertApplied,
    composerBindingRef,
    configCommandBarrier,
    blockingInteractionId,
    panePresentation,
    isFloatingPresentation,
    handleFloatingLatestTurnSummaryChange,
    floatingLatestTurnSummary,
    floatingTurnRunning,
    selectionSideChatKey,
    selectionSideActionBlocked,
    timelineScrollMemoryKey,
  };
}

export interface UseSessionPaneDraftGatesParams {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  compactForRemoteControl: boolean;
  provider: "glm" | undefined;
  focused: boolean;
  remoteAvailable: boolean;
  modelSelectionService: IModelSelectionService;
  intl: IntlInstance;
  snapshot: ConversationSnapshot | null;
  runtimeReady: boolean;
  activeHighspeedCard: HighspeedCardSnapshot | null;
  invalidateActiveHighspeedCard: (cardId: string, failureKey: string) => void;
}

export function useSessionPaneDraftGates(params: UseSessionPaneDraftGatesParams) {
  const {
    sessionId,
    workspacePath,
    workspaceIdentity,
    compactForRemoteControl,
    provider,
    focused,
    remoteAvailable,
    modelSelectionService,
    intl,
    snapshot,
    runtimeReady,
    activeHighspeedCard,
    invalidateActiveHighspeedCard,
  } = params;

  const {
    agentStartupAllowed: providerAgentStartupAllowed,
    error: draftModelReadinessError,
    dismissError: dismissDraftModelReadinessError,
    ensureReadyForSend: ensureDraftModelReadyForSend,
    markProviderNotReady: markDraftProviderNotReady,
  } = useDraftModelReadinessGate({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    modelSelectionService,
  });

  const { settings: sharedSettings } = useSettings();
  // OpenCode CLI не требует ZCode API-провайдера, но новой переписке всё равно нужен
  // обычный draft-session для идентичности, admission и журнала чата.
  const draftAgentStartupAllowed =
    (providerAgentStartupAllowed || sharedSettings?.openCodeCliEnabled === true) && remoteAvailable;

  // Composer 保存下一次 Submission 的 renderer intent；prewarm session 仅承载草稿预热。
  const {
    composerDraft,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    replaceComposerDraft,
    updateComposerContent,
    setComposerOrchestrationMode,
  } = useDraftConfigControl({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig: runtimeReady && snapshot?.sessionId === sessionId ? snapshot.config : null,
    agentStartupAllowed: draftAgentStartupAllowed,
    modelSelectionService,
  });
  // Bug 根因：部分 SessionPane 测试和重建中的旧草稿可能暂时没有 Composer intent，
  // 直接读取会在渲染阶段崩溃；缺少 intent 按普通 Provider 路由处理，不能阻断聊天界面。
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      snapshot.control.phase !== "error" ||
      !snapshot.control.lastError ||
      activeHighspeedCard?.taskId !== sessionId
    ) {
      return;
    }
    const lastError = snapshot.control.lastError;
    const attribution = lastError.attribution;
    if (attribution?.highspeedCardId !== undefined) {
      // 新 Agent 用 string/null 明确表达本轮是否使用 Highspeed，并在创建期或请求期失败命中退回声明、
      // 却没有任何退回目标可创建时发布 highspeedFallbackUnavailable（spec §2.2 失败即退卡）。
      // Bug 根因：这里曾只认 provider_not_found / model_not_found 两个目录错误码。请求期 3402 或网络
      // 失败无处可退时没有 fallback 事件，TurnError 的 code 是 provider 错误码 "3402"，白名单漏掉它，
      // 卡一直锁住模型选择器、下一轮继续复用已失效的卡。退卡只看 Core 发布的结构化事实，不再按错误码
      // 推断：超窗、本地 runtime 失败等不参与退回的错误不带该字段，不会误作废卡。
      if (
        attribution.highspeedCardId !== activeHighspeedCard.cardId ||
        attribution.highspeedFallbackUnavailable !== true
      ) {
        return;
      }
    } else if (
      !["provider_not_found", "model_not_found"].includes(lastError.code) ||
      lastError.at < activeHighspeedCard.issuedAt
    ) {
      // 兼容旧 Agent（无 highspeedCardId 字段）：只接受模型目录错误作为恢复边界，避免工具或本地运行时
      // 错误误作废卡；错误终态在下一轮开始前一直留在投影里，而抽卡发生在发送之前，时间下界保证上一轮的
      // 目录错误不清掉刚抽到的新卡（claim key 含新 cardId，去重防不住）。
      return;
    }
    // 仍由 Service owner 按 cardId 作废，保留 nextDrawAt 冷却。
    invalidateActiveHighspeedCard(
      activeHighspeedCard.cardId,
      `turn-error:${sessionId}:${lastError.at}:${activeHighspeedCard.cardId}`,
    );
  }, [activeHighspeedCard, invalidateActiveHighspeedCard, sessionId, snapshot]);

  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const now = Date.now();
    for (const row of snapshot.rows.window) {
      if (
        row.kind !== "userInput" ||
        !row.sourceCommandId ||
        row.highspeed?.fallbackAt === undefined
      ) {
        continue;
      }
      const sourceCommandId = row.sourceCommandId;
      if (
        !compactForRemoteControl &&
        activeHighspeedCard?.taskId === sessionId &&
        activeHighspeedCard.cardId === row.highspeed.cardId
      ) {
        // Bug 根因：历史 fallback 行曾无条件作废“当前卡”，旧卡事件会误清新卡，手机端还会调用
        // 未开放的写 RPC。权益写操作只接受 Service 当前卡的精确身份；Toast 仍独立展示历史事实。
        invalidateActiveHighspeedCard(
          row.highspeed.cardId,
          `fallback:${sourceCommandId}:${row.highspeed.cardId}`,
        );
      }
      if (
        focused &&
        now - row.highspeed.fallbackAt >= -5_000 &&
        now - row.highspeed.fallbackAt <= 15_000 &&
        claimHighspeedFallbackToast(sourceCommandId)
      ) {
        // 卡过期与加速服务不可用分别提示；旧数据没有 fallbackReason，按卡过期文案处理。
        toast(
          intl.formatMessage({
            id:
              row.highspeed.fallbackReason === "highspeed_card_expired" ||
              row.highspeed.fallbackReason === undefined
                ? "chat.highspeed.cardExpiredFallback"
                : "chat.highspeed.requestFailedFallback",
          }),
        );
      }
    }
  }, [
    activeHighspeedCard,
    compactForRemoteControl,
    focused,
    intl,
    invalidateActiveHighspeedCard,
    sessionId,
    snapshot,
  ]);

  return {
    draftModelReadinessError,
    dismissDraftModelReadinessError,
    ensureDraftModelReadyForSend,
    markDraftProviderNotReady,
    sharedSettings,
    draftAgentStartupAllowed,
    composerDraft,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    replaceComposerDraft,
    updateComposerContent,
    setComposerOrchestrationMode,
  };
}
