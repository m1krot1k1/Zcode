import { memo, useRef, type ReactNode } from "react";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  QueueItem,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_TIMELINE } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AssistantFeedbackHandler } from "@/v4/ConversationRowView.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationBackToBottomButton } from "@/v4/conversation-timeline/ConversationBackToBottomButton.js";
import { ConversationScrollMemoryScopeCapture } from "@/v4/conversation-timeline/scrollMemoryScope.js";
import { EMPTY_PENDING_GUIDES } from "@/v4/conversation-timeline/timelineUtils.js";
import { useTimelineDomRefs } from "@/v4/conversation-timeline/useTimelineDomRefs.js";
import { useTimelineMessageMask } from "@/v4/conversation-timeline/useTimelineMessageMask.js";
import {
  useTimelineNavigatorHydration,
  useTimelineSidePanels,
} from "@/v4/conversation-timeline/useTimelinePanels.js";
import { useTimelineRenderData } from "@/v4/conversation-timeline/useTimelineRenderData.js";
import { useTimelineScrollPersistence } from "@/v4/conversation-timeline/useTimelineScrollPersistence.js";
import { useTimelineScrollGestures } from "@/v4/conversation-timeline/useTimelineScrollGestures.js";
import { useTimelineScrollMemory } from "@/v4/conversation-timeline/useTimelineScrollMemory.js";
import { useTimelineScrollRestoration } from "@/v4/conversation-timeline/useTimelineScrollRestoration.js";
import { useTimelineVirtualizer } from "@/v4/conversation-timeline/useTimelineVirtualizer.js";
import type { ConversationLatestTurnSummary } from "@/v4/conversationTimelineLiveTail.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { ConversationTurnNavigatorHydrationResult } from "@/v4/conversationTurnNavigatorHelpers.js";

interface ConversationTimelineProps {
  rows: readonly ConversationRow[];
  /** 手机远控窄屏允许整条会话 flex 链按抽屉宽度收缩；桌面布局保持原样。 */
  compactForRemoteControl?: boolean;
  /** CLI 权威 queue 中等待 model-step 注入的 guide；只改变 renderer 落位。 */
  pendingGuides?: readonly QueueItem[];
  /** runtime memory 状态，只交给当前 live turn，不进入历史虚拟列表。 */
  apiRetry?: ApiRetryState | null;
  /** 投影全序行数（rows.totalCount；窗口截断后大于 rows.length，仅用于滚动条估计/诊断）。 */
  totalCount: number;
  /**
   * 会话身份键（sessionId ?? "draft"）。切换时重置滚动锚定与测高缓存——
   * rowId 在不同 session 间会重复，测高缓存禁止跨会话串号。
   */
  sessionKey: string;
  /** renderer-local 滚动记忆 key；draft 为 null，不参与保存或恢复。 */
  scrollMemoryKey?: string | null;
  /** 行渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  rowContext: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /** 还有更早历史可拉（窗口首行 > 全序首行）。 */
  canLoadOlder?: boolean;
  /** loadOlder 在途，抑制重复触发。 */
  loadingOlder?: boolean;
  /** 拉取更早一窗历史（接近顶部时自动预取）。 */
  onLoadOlder?: () => Promise<void> | void;
  /** 宽屏问题目录挂载后一次补齐当前有效分支的全部历史。 */
  onLoadAllOlder?: () => Promise<ConversationTurnNavigatorHydrationResult>;
  /**
   * 问题导航目录失效代际（store turnNavigatorDirectoryRevision）。
   * real-user query 增删后终态必须失效重探测；组件 hydration key
   * 追加此 revision，避免同一 logEpoch 内永久拦截。
   */
  turnNavigatorDirectoryRevision?: number;
  /** 与旧 ChatView 对齐：composer dock 属于同一个滚动视口，sticky 到滚动容器底部。 */
  bottomDock?: ReactNode;
  /** 分享选择面板所在的共享父容器；用于把 dock 的真实位置写入同一坐标系。 */
  selectionPanelLayoutContainerRef?: { current: HTMLElement | null };
  /**
   * 锁定背景滚动。
   *
   * 分享选择面板只用 scrim 隔离了正文指针事件，滚动容器仍是 overflow-y-auto，
   * 原生滚动条拖拽和键盘 PageUp/Down 仍能改变 scrollTop，勾选目标会在面板下方漂走。
   */
  backgroundScrollLocked?: boolean;
  /** rows 为空时的可选内容；正式空 session 传空，草稿态传问候语。 */
  emptyState?: ReactNode;
  /**
   * 滚动容器内、消息层之上的常驻内容（分享导入的只读块 + 分割线）。
   *
   * 必须在容器内而不是做成固定横幅，才能与实时对话一起滚动；rows 为空时也要渲染，
   * 所以它落在 emptyState 分支之外。
   */
  headerSlot?: ReactNode;
  /** 草稿态让 emptyState 与同一个 bottomDock 作为整体居中，不重挂 composer。 */
  centerEmptyStateWithDock?: boolean;
  /** 窄屏/粗指针视口保留紧凑居中布局，不复用桌面草稿安全间距。 */
  compactEmptyStateWithDock?: boolean;
  /**
   * Side Pane 完整视图浮窗形态：底部输入区不留内边距，输入框外壳即浮窗最外层；
   * 输入区脱离滚动流贴在时间线底部，滚动容器（含滚动条）止于输入框上方。
   */
  floatingComposerDock?: boolean;
  /** 浮窗形态下上报底部输入区实测高度，宿主据此裁剪收起态。 */
  onComposerDockHeightChange?: (heightPx: number) => void;
  /**
   * 浮窗形态下上报最后一个回合的运行状态、运行时长与最终回答（同一个 render unit），
   * 供输入框占位「工作中 N 秒」与回答气泡使用；值变化时才回调。
   */
  onLatestTurnSummaryChange?: (summary: ConversationLatestTurnSummary) => void;
  /** 右侧状态面板对消息列的布局模式；auto 由 conversation container query 裁决。 */
  summaryPanelLayout?: "none" | "auto" | "inline";
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  sessionPhase?: SessionPhase;
  /** 宿主可调用的一次性“滚动到底部”动作；不持有 conversation 或跨 renderer 状态。 */
  scrollToBottomActionRef?: { current: (() => void) | null };
  /** 宿主可调用的一次性 query 定位动作；不改变分享面板 view。 */
  scrollToQueryActionRef?: {
    current: ((target: { unitIndex: number; rowId: number }) => void) | null;
  };
  selectionActions?: {
    enabled: boolean;
    sideActionDisabled?: boolean;
    onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
    onAskInSideChat: (reference: ConversationSelectionReference) => void;
  };
  /** 范围编辑时，左侧 rail 由分享选择面板独占。 */
  hideTurnNavigator?: boolean;
}

/**
 * 虚拟滚动 timeline：动态测高（ResizeObserver 驱动 remeasure）+ 底部锚定 +
 * 「回到底部」。滚动位置/跟随态/测高缓存全部为组件实例状态——多 pane（同会话或
 * 异会话）各自独立，互不干扰；数据订阅共享经 sessionDataLayer lease 处理。
 *
 * React 性能：rows 高频变化（流式 delta），滚动相关回调全部经 ref 读取最新值，
 * 保持稳定引用；跟随态存 ref（每帧变化不触发渲染），仅「回到底部」可见性走 state。
 */
function ConversationTimelineImpl({
  rows,
  compactForRemoteControl = false,
  pendingGuides = EMPTY_PENDING_GUIDES,
  apiRetry = null,
  totalCount,
  sessionKey,
  scrollMemoryKey = null,
  rowContext,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadAllOlder,
  turnNavigatorDirectoryRevision = 0,
  bottomDock,
  selectionPanelLayoutContainerRef,
  backgroundScrollLocked = false,
  emptyState,
  headerSlot,
  centerEmptyStateWithDock = false,
  compactEmptyStateWithDock = false,
  floatingComposerDock = false,
  onComposerDockHeightChange,
  onLatestTurnSummaryChange,
  summaryPanelLayout = "none",
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  sessionPhase,
  scrollToBottomActionRef,
  scrollToQueryActionRef,
  selectionActions,
  hideTurnNavigator = false,
}: ConversationTimelineProps) {
  const { intl } = useZCodeIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const renderData = useTimelineRenderData({
    rows,
    sessionKey,
    sessionPhase,
    headerSlot,
    onLatestTurnSummaryChange,
    centerEmptyStateWithDock,
    compactEmptyStateWithDock,
  });
  const dom = useTimelineDomRefs({
    scrollRef,
    floatingComposerDock,
    summaryPanelLayout,
    centeredEmptyLayout: renderData.centeredEmptyLayout,
    canLoadOlder,
    loadingOlder,
    onLoadOlder,
  });
  const { hasBottomDock } = useTimelineSidePanels({
    dom,
    backgroundScrollLocked,
    selectionPanelLayoutContainerRef,
    onComposerDockHeightChange,
    bottomDock,
    hasRunningUnit: renderData.hasRunningUnit,
    setLiveNowMs: renderData.setLiveNowMs,
    nextHighspeedExpiryMs: renderData.nextHighspeedExpiryMs,
  });
  useTimelineNavigatorHydration({
    dom,
    canLoadOlder,
    loadingOlder,
    onLoadAllOlder,
    rowContext,
    rows,
    sessionKey,
    totalCount,
    turnNavigatorDirectoryRevision,
  });
  const virtual = useTimelineVirtualizer({
    dom,
    virtualizedUnits: renderData.virtualizedUnits,
    virtualizedUnitsRef: renderData.virtualizedUnitsRef,
    liveUnit: renderData.liveUnit,
    liveUnitIndex: renderData.liveUnitIndex,
    headerSlotHeight: renderData.headerSlotHeight,
  });
  const gestures = useTimelineScrollGestures({ dom, unitsRef: renderData.unitsRef });
  const { syncTurnNavigatorViewport } = useTimelineMessageMask({
    dom,
    floatingComposerDock,
    hasBottomDock,
    renderUnitsEmpty: renderData.renderUnits.length === 0,
    turnNavigatorQueryRowIdsRef: renderData.turnNavigatorQueryRowIdsRef,
    syncMessageLayerMask: gestures.syncMessageLayerMask,
  });
  const memory = useTimelineScrollMemory({
    dom,
    scrollMemoryKey,
    responsiveCenteredEmptyLayout: renderData.responsiveCenteredEmptyLayout,
    renderUnitsEmpty: renderData.renderUnits.length === 0,
    markProgrammaticScroll: gestures.markProgrammaticScroll,
    syncTurnNavigatorViewport,
    commitFollowing: gestures.commitFollowing,
    getActiveUserScrollIntent: gestures.getActiveUserScrollIntent,
    markLayoutScrollGuard: gestures.markLayoutScrollGuard,
    measureElement: virtual.measureElement,
    virtualizer: virtual.virtualizer,
    commitMeasuredLayout: virtual.commitMeasuredLayout,
    liveUnit: renderData.liveUnit,
    isContentWidthChanging: dom.isContentWidthChanging,
  });
  const persistence = useTimelineScrollPersistence({
    dom,
    unitsRef: renderData.unitsRef,
    virtualizedUnitsRef: renderData.virtualizedUnitsRef,
    scrollMemoryKey,
    sessionKey,
    cacheCurrentScrollMemoryState: memory.cacheCurrentScrollMemoryState,
    clearUserScrollIntent: gestures.clearUserScrollIntent,
    markProgrammaticScroll: gestures.markProgrammaticScroll,
    syncTurnNavigatorViewport,
    commitFollowing: gestures.commitFollowing,
    getActiveUserScrollIntent: gestures.getActiveUserScrollIntent,
    scrollToBottom: memory.scrollToBottom,
    virtualizer: virtual.virtualizer,
    liveUnitIndex: renderData.liveUnitIndex,
    scrollToBottomActionRef,
    scrollToQueryActionRef,
    renderUnits: renderData.renderUnits,
    rows,
    mountedRowsKey: virtual.mountedRowsKey,
    canLoadOlder,
    loadingOlder,
    onLoadOlder,
    sessionPhase,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
  });
  useTimelineScrollRestoration({
    dom,
    unitsRef: renderData.unitsRef,
    rowsRef: renderData.rowsRef,
    rows,
    renderUnits: renderData.renderUnits,
    pendingGuides,
    scrollMemoryKey,
    sessionKey,
    canLoadOlder,
    totalCount,
    totalSize: virtual.totalSize,
    headerSlotHeight: renderData.headerSlotHeight,
    saveCurrentScrollMemory: persistence.saveCurrentScrollMemory,
    restoreScrollMemory: persistence.restoreScrollMemory,
    scrollToBottom: memory.scrollToBottom,
    syncTurnNavigatorViewport,
    cacheCurrentScrollMemoryState: memory.cacheCurrentScrollMemoryState,
    notifyScrollObserversAfterCommit: memory.notifyScrollObserversAfterCommit,
    clearUserScrollIntent: gestures.clearUserScrollIntent,
    markLayoutScrollGuard: gestures.markLayoutScrollGuard,
    getActiveUserScrollIntent: gestures.getActiveUserScrollIntent,
    commitFollowing: gestures.commitFollowing,
    isContentWidthChanging: dom.isContentWidthChanging,
    virtualizer: virtual.virtualizer,
  });

  const {
    renderUnits,
    liveUnit,
    liveUnitIndex,
    liveNowMs,
    headerSlotHeight,
    headerSlotRef,
    virtualizedUnits,
    turnNavigatorQueryRowIds,
    centeredEmptyLayout,
    responsiveCenteredEmptyLayout,
  } = renderData;
  const { virtualizer, virtualRows, turnNavigatorVirtualItems, totalSize } = virtual;
  const {
    timelineRootRef,
    messageLayerRef,
    virtualHistoryRef,
    liveTailRef,
    composerDockRef,
    backToBottomVisible,
    summaryPanelInlineOffsetClassName,
    contentWidthClassName,
    turnNavigatorViewport,
  } = dom;
  const { scrollToQuery, handleScroll, handleBackToBottom } = persistence;
  const { captureScrollMemoryBeforeScopeMutation, commitCapturedScrollMemory } = memory;
  const {
    handleKeyDownCapture,
    handlePointerDownCapture,
    handlePointerEndCapture,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleTouchEndCapture,
    handleWheelCapture,
  } = gestures;

  // raw projection row 与按 turn 合并后的 render unit 不是同一计量单位；
  // 分开暴露才能让恢复/分页验证不再把可见 unit 误当成持久 row。
  return (
    <div
      ref={timelineRootRef}
      className={cn("relative flex min-h-0 flex-1 flex-col", compactForRemoteControl && "min-w-0")}
    >
      {selectionActions ? (
        <ConversationSelectionTooltip
          rootRef={scrollRef}
          rows={rows}
          sourceSessionId={sessionKey}
          enabled={selectionActions.enabled}
          sideActionDisabled={selectionActions.sideActionDisabled}
          onAddToCurrentTask={selectionActions.onAddToCurrentTask}
          onAskInSideChat={selectionActions.onAskInSideChat}
        />
      ) : null}
      <ConversationScrollMemoryScopeCapture
        scopeKey={scrollMemoryKey}
        capture={captureScrollMemoryBeforeScopeMutation}
        commit={commitCapturedScrollMemory}
      />
      {/* Bugfix：分享选择流程无论面板展开还是收起，左 rail 都由分享面板或 reopen 按钮独占，
          必须隐藏对话轮导航，避免两个绝对定位控件互相覆盖。退出分享选择后自动恢复。 */}
      {hideTurnNavigator ? null : (
        <ConversationTurnNavigator
          renderUnits={renderUnits}
          isHydratingDirectory={loadingOlder}
          scrollOffsetPx={virtualizer.scrollOffset ?? turnNavigatorViewport.scrollOffsetPx}
          viewportHeightPx={
            virtualizer.scrollRect?.height ?? turnNavigatorViewport.viewportHeightPx
          }
          virtualItems={turnNavigatorVirtualItems}
          activeQueryRowId={turnNavigatorViewport.activeQueryRowId}
          onJumpToQuery={scrollToQuery}
        />
      )}
      <div
        ref={scrollRef}
        data-testid={TID_V4_TIMELINE}
        data-v4-timeline-scroll="true"
        data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}
        data-markdown-table-layout-root="true"
        data-row-count={rows.length}
        data-window-row-count={rows.length}
        data-render-unit-count={renderUnits.length}
        data-total-row-count={totalCount}
        data-following={backToBottomVisible ? "false" : "true"}
        data-loading-older={loadingOlder ? "true" : "false"}
        onKeyDownCapture={handleKeyDownCapture}
        onPointerCancelCapture={handlePointerEndCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onScroll={handleScroll}
        onTouchCancelCapture={handleTouchEndCapture}
        onTouchEndCapture={handleTouchEndCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onWheelCapture={handleWheelCapture}
        className={cn(
          // 原生滚动条按内容高度动态出现时会缩窄会话视口，导致消息与 composer
          // 横向跳动；稳定预留 gutter，让桌面与手机 Web 共用的滚动区宽度保持不变。
          // 只声明 overflow-y-auto 会让浏览器把横轴计算为 auto，宽内容会把
          // 整条 Conversation 撑出横向滚动；表格和代码块应由各自内部容器滚动。
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] [--markdown-table-layout-left-inset:16px] [--markdown-table-layout-right-inset:16px] max-md:[--markdown-table-layout-left-inset:8px] max-md:[--markdown-table-layout-right-inset:8px]",
          // 分享选择面板展开时改为 overflow-hidden：scrollTop 与 scrollbar-gutter 都保持不变，
          // 但原生滚动条、滚轮和键盘翻页都不再能移动背景，勾选目标不会漂走。
          backgroundScrollLocked && "!overflow-y-hidden",
          compactForRemoteControl && "min-w-0",
          // 浮窗形态：滚动容器止于输入框上方 12px，消息底部再留 16px 空白。
          floatingComposerDock &&
            "mb-[calc(var(--v4-floating-composer-dock-height,0px)+12px)] pb-4",
          // 修复原因：Conversation turn map 覆盖 timeline 左侧 48px；表格增强滚动如果仍按
          // 普通 16px 边距借位，会有 32px 落到 turn map 下方，必须把完整占用计入左边界。
          turnNavigatorQueryRowIds.size >= 2 &&
            "@min-[864px]/conversation:[--markdown-table-layout-left-inset:48px]",
        )}
      >
        <div
          className={cn(
            // 固定高度断点会在窗口跨过临界值时让问候语与 composer 整组跳动。
            // 顶部留白按视口高度伸缩，输入框的位置不再受下方推荐列表高度影响；
            // 空间不足时顶部可收缩到底线，底部继续随内容自然排布。
            responsiveCenteredEmptyLayout
              ? // Bugfix 根因：动态修改原生窗口下限会把内容换行反馈到窗口拖动，产生阻尼；
                // 容器保留固有最小高度，由外层 timeline 统一承接受限高度下的溢出内容。
                "flex min-h-full flex-col items-center px-4 before:block before:min-h-[52px] before:w-full before:shrink before:basis-[29dvh] before:content-[''] after:block after:min-h-4 after:w-full after:flex-1 after:content-['']"
              : centeredEmptyLayout
                ? "flex min-h-full flex-col items-center justify-center gap-4 px-4"
                : "flex min-h-full flex-col",
          )}
          // session 切到 draft 时内容高度骤降，Chrome 会把子树里的
          // sticky composer 选作原生 scroll anchor，并在切回后覆盖 layout/RAF 恢复值。
          // V4 已自管 prepend、吸底和记忆锚点；和其它虚拟列表一致，应从内容子树禁用锚点候选。
          style={{ overflowAnchor: "none" }}
        >
          {renderUnits.length === 0 && !headerSlot ? (
            <div
              className={cn(
                centeredEmptyLayout
                  ? "flex w-full max-w-2xl shrink-0 items-center justify-center"
                  : "min-h-0 flex-1",
                !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
              )}
            >
              {emptyState}
            </div>
          ) : (
            <div
              ref={messageLayerRef}
              data-v4-timeline-message-layer="true"
              data-sandbox-page-container="true"
              className="relative w-full flex-1 [mask-repeat:no-repeat] [-webkit-mask-repeat:no-repeat]"
            >
              {/*
               * headerSlot 必须落在被 mask 的消息层内、并套用与实时消息列相同的宽度类：
               * 放在消息层之外会既比正文宽、又从 sticky composer 下方透出来。
               */}
              {headerSlot ? (
                <div
                  ref={headerSlotRef}
                  data-v4-timeline-header-slot="true"
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  {headerSlot}
                </div>
              ) : null}
              <div
                ref={virtualHistoryRef}
                data-v4-timeline-virtual-history="true"
                data-v4-timeline-content-column="true"
                className={cn(
                  // 默认（< 1280px）过渡 width/max-width/transform，让 w-full ↔ max-w-4xl
                  // 的中等宽度切换平滑；≥1280px 触发的面板让位（max-w-6xl + 168px 左移）
                  // 用 @min-[1280px] 降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                  "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  summaryPanelInlineOffsetClassName,
                )}
                style={{ height: totalSize }}
              >
                {virtualRows.map((virtualRow) => {
                  const unit = virtualizedUnits[virtualRow.index];
                  if (!unit) return null;
                  return (
                    <div
                      key={`${virtualRow.key}:${rowContext.logEpoch ?? ""}`}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-v4-turn-unit="true"
                      data-turn-id={unit.turnId}
                      // virtual history 的子项通过 absolute 定位，父级 padding 不会缩小
                      // 它们的 containing block；正文响应式内边距必须落在 turn wrapper 自身。
                      className="absolute left-0 top-0 w-full"
                      style={{ transform: `translateY(${virtualRow.start - headerSlotHeight}px)` }}
                    >
                      <ConversationTurnGroup
                        unit={unit}
                        nowMs={liveNowMs}
                        apiRetry={null}
                        context={rowContext}
                        onFork={onFork}
                        onRetry={onRetry}
                        onFeedbackChange={onFeedbackChange}
                        onEdit={onEdit}
                      />
                    </div>
                  );
                })}
              </div>
              {liveUnit !== null && liveUnitIndex !== null ? (
                <div
                  key={`${liveUnit.key}:${rowContext.logEpoch ?? ""}`}
                  ref={liveTailRef}
                  data-index={liveUnitIndex}
                  data-v4-running-live-tail="true"
                  data-v4-turn-unit="true"
                  data-turn-id={liveUnit.turnId}
                  data-v4-timeline-content-column="true"
                  className={cn(
                    // ≥1280px 面板让位时降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                    "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationTurnGroup
                    unit={liveUnit}
                    nowMs={liveNowMs}
                    apiRetry={apiRetry}
                    context={rowContext}
                    onFork={onFork}
                    onRetry={onRetry}
                    onFeedbackChange={onFeedbackChange}
                    onEdit={onEdit}
                  />
                </div>
              ) : null}
              {pendingGuides.length > 0 ? (
                <div
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationPendingGuideList
                    context={rowContext}
                    items={pendingGuides}
                    turnId={
                      liveUnit?.turnId ??
                      rows.at(-1)?.productTurnId ??
                      rows.at(-1)?.turnId ??
                      "pending-guide"
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
          {bottomDock ? (
            <div
              ref={composerDockRef}
              data-v4-composer-dock="true"
              className={cn(
                // sticky dock 是 z-20 的全宽透明层，过去会盖住 z-10 rail
                // 在 composer 左侧留白内的按钮。外壳不接事件，只让实际内容列恢复命中。
                "pointer-events-none z-20 flex w-full justify-center",
                // 浮窗形态：滚动容器与内容层都没有定位，absolute 的包含块是时间线根节点，
                // 输入区贴在时间线底部、不随消息滚动，也不被滚动容器裁剪。
                floatingComposerDock
                  ? "absolute inset-x-0 bottom-0"
                  : responsiveCenteredEmptyLayout
                    ? "mt-3 shrink-0"
                    : centeredEmptyLayout
                      ? "shrink-0"
                      : "sticky bottom-0",
              )}
            >
              <div
                data-v4-composer-dock-content="true"
                className={cn(
                  // 同 virtual history/live tail，恢复宽度过渡避免硬跳。
                  // ≥1280px 面板让位时降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                  "pointer-events-auto relative z-10 w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  // 浮窗形态下输入框外壳就是浮窗最外层，不留内边距。
                  !centeredEmptyLayout && !floatingComposerDock && "px-4 pb-4",
                  !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
                )}
              >
                <div data-v4-back-to-bottom-anchor="composer-dock" className="relative">
                  {backToBottomVisible ? (
                    <ConversationBackToBottomButton
                      // 分屏下 composer 属于滚动视口内的 sticky dock；按钮若挂在
                      // timeline 外层 absolute bottom，会相对整个 pane 落到 input 下方。
                      //
                      // 圆钮采用自己的居中定位；`pointer-events-auto` 保留：
                      // 它是"按钮点得动"唯一可断言的契约。
                      className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 shadow-sm"
                      label={intl.formatMessage({ id: "chat.scrollToBottom" })}
                      onClick={handleBackToBottom}
                    />
                  ) : null}
                  {bottomDock}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {backToBottomVisible && !bottomDock ? (
        <ConversationBackToBottomButton
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          label={intl.formatMessage({ id: "chat.scrollToBottom" })}
          onClick={handleBackToBottom}
        />
      ) : null}
    </div>
  );
}

export const ConversationTimeline = memo(ConversationTimelineImpl);
