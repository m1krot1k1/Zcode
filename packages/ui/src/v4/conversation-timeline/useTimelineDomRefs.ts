/**
 * DOM-ссылки, изменяемые ref-состояния и производные классы раскладки таймлайна.
 *
 * Все поля — стабильные ref/state из прежнего ConversationTimeline: хуки
 * прокрутки читают их через ref, чтобы не пересоздавать обработчики на каждом
 * стриминговом дельте.
 */
import { useCallback, useRef, useState, type RefObject } from "react";
import type { ChatSessionScrollMemoryState } from "@/lib/chatSessionScrollMemory.js";
import {
  getConversationContentWidthClassName,
  getConversationStatusPanelOffsetClassName,
} from "@/v4/conversationLayout.js";
import type { PendingScrollMemoryRestore } from "@/v4/conversation-timeline/scrollMemoryScope.js";
import {
  initialFollowing,
  type PrependVirtualAnchor,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";
import { TimelineRowHeightCache } from "@/v4/timelineRowHeightCache.js";

interface UseTimelineDomRefsOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  floatingComposerDock: boolean;
  summaryPanelLayout: "none" | "auto" | "inline";
  centeredEmptyLayout: boolean;
  canLoadOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void> | void;
}

export type TimelineDom = ReturnType<typeof useTimelineDomRefs>;

export function useTimelineDomRefs({
  scrollRef,
  floatingComposerDock,
  summaryPanelLayout,
  centeredEmptyLayout,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: UseTimelineDomRefsOptions) {
  const liveTailRef = useRef<HTMLDivElement>(null);
  const messageLayerRef = useRef<HTMLDivElement>(null);
  const virtualHistoryRef = useRef<HTMLDivElement>(null);
  const stableContentWidthRef = useRef<number | null>(null);
  const contentWidthResizeActiveRef = useRef(false);
  const contentWidthResizeSettleTimerRef = useRef<number | null>(null);
  const committingMeasuredLayoutRef = useRef(false);
  const messageLayerMaskObserverRef = useRef<ResizeObserver | null>(null);
  const isContentWidthChanging = useCallback(() => {
    const currentContentWidth = virtualHistoryRef.current?.clientWidth ?? null;
    const stableContentWidth = stableContentWidthRef.current;
    return (
      committingMeasuredLayoutRef.current ||
      contentWidthResizeActiveRef.current ||
      (currentContentWidth !== null &&
        stableContentWidth !== null &&
        currentContentWidth !== stableContentWidth)
    );
  }, []);
  // loadOlder 相关值经 ref 读取，保持 handleScroll 稳定引用。
  const loadOlderRef = useRef({ canLoadOlder, loadingOlder, onLoadOlder });
  loadOlderRef.current = { canLoadOlder, loadingOlder, onLoadOlder };
  const followingRef = useRef(initialFollowing());
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<{
    intent: TimelineUserScrollIntent;
    observedAt: number;
  }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const layoutScrollGuardUntilRef = useRef(0);
  const userAdjustedScrollSinceRestoreRef = useRef(false);
  const suppressVirtualizerAdjustmentDuringRestoreRef = useRef(false);
  const latestScrollMemoryStateRef = useRef<{
    key: string;
    state: ChatSessionScrollMemoryState;
  } | null>(null);
  const pendingDetachedScrollRestoreRef = useRef<PendingScrollMemoryRestore | null>(null);
  // 组件「已账目」的 scrollTop——scroll 事件读取值或组件自身
  // 程序化写入（贴底/prepend 平移）后的回读值。贴底 effect 拿它对账未观察滚动
  // （滚动已发生、scroll 事件未派发），防止过期 following=true 把用户/测试的上滚拽回底部。
  const lastObservedScrollTopRef = useRef(0);
  // prepend 锚定基线（上一 commit 的首行/总高度），见下方对账效应。
  const prependAnchorRef = useRef<{
    firstRowId: number | null;
    totalSize: number;
  }>({ firstRowId: null, totalSize: 0 });
  const pendingPrependVirtualAnchorRef = useRef<PrependVirtualAnchor | null>(null);
  const heightCacheRef = useRef<TimelineRowHeightCache | null>(null);
  if (heightCacheRef.current === null) {
    heightCacheRef.current = new TimelineRowHeightCache();
  }
  const [backToBottomVisible, setBackToBottomVisible] = useState(false);
  const [turnNavigatorViewport, setTurnNavigatorViewport] = useState({
    scrollOffsetPx: 0,
    viewportHeightPx: 0,
    activeQueryRowId: undefined as number | undefined,
  });
  const [turnNavigatorContainerWidthPx, setTurnNavigatorContainerWidthPx] = useState(0);
  const turnNavigatorJumpFrameRef = useRef<number | null>(null);
  const turnNavigatorHydrationAttemptRef = useRef<{
    attemptCount: number;
    key: string | null;
    retryTimer: number | null;
    status: "idle" | "in-flight" | "waiting" | "terminal";
  }>({ attemptCount: 0, key: null, retryTimer: null, status: "idle" });
  const [turnNavigatorHydrationRetryRevision, setTurnNavigatorHydrationRetryRevision] = useState(0);
  const timelineRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const floatingComposerDockRef = useRef(floatingComposerDock);
  floatingComposerDockRef.current = floatingComposerDock;
  const shareSelectionPanelLayoutRef = useRef<{
    centerYPx: number;
    maxHeightPx: number;
  } | null>(null);
  // 右侧状态面板完整 inline 展开时，中间消息列和输入 dock 必须使用同一偏移；
  // 否则面板会覆盖正文，而不是并排布局。
  const summaryPanelInlineOffsetClassName =
    getConversationStatusPanelOffsetClassName(summaryPanelLayout);
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout,
    statusPanelLayout: summaryPanelLayout,
  });

  return {
    scrollRef,
    liveTailRef,
    messageLayerRef,
    virtualHistoryRef,
    stableContentWidthRef,
    contentWidthResizeActiveRef,
    contentWidthResizeSettleTimerRef,
    committingMeasuredLayoutRef,
    messageLayerMaskObserverRef,
    isContentWidthChanging,
    loadOlderRef,
    followingRef,
    programmaticScrollFrameRef,
    userScrollIntentRef,
    touchClientYRef,
    scrollbarPointerIdRef,
    layoutScrollGuardUntilRef,
    userAdjustedScrollSinceRestoreRef,
    suppressVirtualizerAdjustmentDuringRestoreRef,
    latestScrollMemoryStateRef,
    pendingDetachedScrollRestoreRef,
    lastObservedScrollTopRef,
    prependAnchorRef,
    pendingPrependVirtualAnchorRef,
    heightCacheRef,
    backToBottomVisible,
    setBackToBottomVisible,
    turnNavigatorViewport,
    setTurnNavigatorViewport,
    turnNavigatorContainerWidthPx,
    setTurnNavigatorContainerWidthPx,
    turnNavigatorJumpFrameRef,
    turnNavigatorHydrationAttemptRef,
    turnNavigatorHydrationRetryRevision,
    setTurnNavigatorHydrationRetryRevision,
    timelineRootRef,
    composerDockRef,
    floatingComposerDockRef,
    shareSelectionPanelLayoutRef,
    summaryPanelInlineOffsetClassName,
    contentWidthClassName,
  };
}
