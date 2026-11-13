/**
 * Сохранение/восстановление позиции чтения, обработчик scroll, кнопка «вниз» и
 * переходы к вопросу — всё, что двигает scrollTop по запросу пользователя.
 */
import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";
import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import { logger } from "@/logger.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { TimelineDom } from "@/v4/conversation-timeline/useTimelineDomRefs.js";
import type { TimelineVirtualizer } from "@/v4/conversation-timeline/useTimelineVirtualizer.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import {
  historyPrefetchTriggerPx,
  resolveFollowingAfterScroll,
  shouldShowBackToBottom,
  shouldTriggerLoadOlder,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";

interface UseTimelineScrollPersistenceOptions {
  dom: TimelineDom;
  unitsRef: RefObject<readonly ConversationTurnRenderUnit[]>;
  virtualizedUnitsRef: RefObject<readonly ConversationTurnRenderUnit[]>;
  scrollMemoryKey: string | null;
  sessionKey: string;
  cacheCurrentScrollMemoryState: (element: HTMLDivElement) => ChatSessionScrollMemoryState;
  clearUserScrollIntent: () => void;
  markProgrammaticScroll: () => void;
  syncTurnNavigatorViewport: (element: HTMLDivElement) => void;
  commitFollowing: (following: boolean) => void;
  getActiveUserScrollIntent: () => TimelineUserScrollIntent;
  scrollToBottom: () => void;
  virtualizer: TimelineVirtualizer;
  liveUnitIndex: number | null;
  scrollToBottomActionRef?: { current: (() => void) | null };
  scrollToQueryActionRef?: {
    current: ((target: { unitIndex: number; rowId: number }) => void) | null;
  };
  renderUnits: readonly ConversationTurnRenderUnit[];
  rows: readonly ConversationRow[];
  mountedRowsKey: string;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => Promise<void> | void;
  sessionPhase?: SessionPhase;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}
export function useTimelineScrollPersistence({
  dom,
  unitsRef,
  virtualizedUnitsRef,
  scrollMemoryKey,
  sessionKey,
  cacheCurrentScrollMemoryState,
  clearUserScrollIntent,
  markProgrammaticScroll,
  syncTurnNavigatorViewport,
  commitFollowing,
  getActiveUserScrollIntent,
  scrollToBottom,
  virtualizer,
  liveUnitIndex,
  scrollToBottomActionRef,
  scrollToQueryActionRef,
  renderUnits,
  rows,
  mountedRowsKey,
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
}: UseTimelineScrollPersistenceOptions) {
  const {
    scrollRef,
    liveTailRef,
    lastObservedScrollTopRef,
    latestScrollMemoryStateRef,
    pendingDetachedScrollRestoreRef,
    userAdjustedScrollSinceRestoreRef,
    turnNavigatorJumpFrameRef,
    programmaticScrollFrameRef,
    layoutScrollGuardUntilRef,
    suppressVirtualizerAdjustmentDuringRestoreRef,
    loadOlderRef,
    pendingPrependVirtualAnchorRef,
    followingRef,
    setBackToBottomVisible,
  } = dom;
  const saveCurrentScrollMemory = useCallback(() => {
    const key = scrollMemoryKey;
    const element = scrollRef.current;
    if (!key) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const cached = latestScrollMemoryStateRef.current;
    const cachedState = cached?.key === key ? cached.state : null;
    const state =
      pendingRestore?.key === key
        ? pendingRestore.state
        : element
          ? cacheCurrentScrollMemoryState(element)
          : cachedState;
    if (state) saveChatSessionScrollMemoryState(key, state);
  }, [cacheCurrentScrollMemoryState, scrollMemoryKey]);

  const restoreScrollMemory = useCallback(
    (state: ChatSessionScrollMemoryState) => {
      const element = scrollRef.current;
      if (!element) return;
      clearUserScrollIntent();
      markProgrammaticScroll();
      element.scrollTop = resolveChatSessionScrollRestoreTop(state, element);
      lastObservedScrollTopRef.current = element.scrollTop;
      followingRef.current = false;
      setBackToBottomVisible(shouldShowBackToBottom(false, unitsRef.current.length));
      syncTurnNavigatorViewport(element);
      userAdjustedScrollSinceRestoreRef.current = false;
      cacheCurrentScrollMemoryState(element);
    },
    [
      cacheCurrentScrollMemoryState,
      clearUserScrollIntent,
      markProgrammaticScroll,
      syncTurnNavigatorViewport,
    ],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const programmaticScroll =
      programmaticScrollFrameRef.current !== null &&
      Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const userScrollIntent = getActiveUserScrollIntent();
    // 用户输入优先；其余 scroll 若落在内容/测高 guard 内视为布局补偿，guard 外的
    // 未分类事件继续按真实用户滚动处理，兼容原生滚动条和辅助技术。
    const scrollSource =
      userScrollIntent !== "none"
        ? "user"
        : programmaticScroll
          ? "programmatic"
          : Date.now() <= layoutScrollGuardUntilRef.current
            ? "layout"
            : "user";
    // virtualizer 的原生 offset observer 会先于 React onScroll 入账；到这里即可确认它
    // 已看见恢复后的真实 scrollTop。用户滚动也应立即结束保护窗，把滚动权交还用户。
    if (scrollSource !== "layout") {
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    }
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    const following = resolveFollowingAfterScroll({
      following: followingRef.current,
      source: scrollSource,
      metrics: {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      },
    });
    commitFollowing(following);
    if (scrollSource === "user") {
      pendingDetachedScrollRestoreRef.current = null;
      userAdjustedScrollSinceRestoreRef.current = true;
      saveCurrentScrollMemory();
    }
    // 只在 64px 顶边才补页时，用户会先撞到窗口边界再看到内容跳入；提前两个
    // 视口预取，让桌面和手机 Web 共用的 renderer 在用户抵达边界前完成补页。
    const loadOlder = loadOlderRef.current;
    const triggerPx = historyPrefetchTriggerPx(element.clientHeight);
    if (
      shouldTriggerLoadOlder({
        scrollTop: element.scrollTop,
        canLoadOlder: loadOlder.canLoadOlder,
        loadingOlder: loadOlder.loadingOlder,
        triggerPx,
      })
    ) {
      // 前插超过 viewport + overscan 后旧可见 turn 会被卸载，DOM 不能作为跨
      // commit 锚点；这里保存 virtualizer 按稳定 turn key 维护的 measurement 起点。
      const anchorMeasurement = virtualizer.getVirtualItemForOffset(element.scrollTop);
      const anchorUnit = anchorMeasurement
        ? virtualizedUnitsRef.current[anchorMeasurement.index]
        : undefined;
      pendingPrependVirtualAnchorRef.current =
        anchorMeasurement && anchorUnit?.key === anchorMeasurement.key
          ? {
              key: anchorUnit.key,
              offsetTop: anchorMeasurement.start - element.scrollTop,
              start: anchorMeasurement.start,
            }
          : null;
      logger.debug("[v4-timeline] 接近历史窗口顶部，自动预取更早行", {
        scrollTop: element.scrollTop,
        triggerPx,
      });
      loadOlder.onLoadOlder?.();
    }
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    saveCurrentScrollMemory,
    syncTurnNavigatorViewport,
    virtualizer,
  ]);

  const handleBackToBottom = useCallback(() => {
    pendingDetachedScrollRestoreRef.current = null;
    clearUserScrollIntent();
    commitFollowing(true);
    scrollToBottom();
    // scrollToBottom 只更新组件内 ref；若用户点击后立刻切任务，scope
    // cleanup/scroll 事件可能还没运行，旧 Map 会把下次恢复重新带回中部甚至顶部。
    saveCurrentScrollMemory();
  }, [clearUserScrollIntent, commitFollowing, saveCurrentScrollMemory, scrollToBottom]);

  useLayoutEffect(() => {
    if (!scrollToBottomActionRef) return;
    scrollToBottomActionRef.current = handleBackToBottom;
    return () => {
      // 只清理本实例登记的动作，避免切 pane 时旧 cleanup 覆盖新 timeline。
      if (scrollToBottomActionRef.current === handleBackToBottom) {
        scrollToBottomActionRef.current = null;
      }
    };
  }, [handleBackToBottom, scrollToBottomActionRef]);

  const scrollToQuery = useCallback(
    (target: { unitIndex: number; rowId: number }, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }

      const scrollMountedQuery = (element: HTMLDivElement): boolean => {
        const rowElement = element.querySelector<HTMLElement>(`[data-row-id="${target.rowId}"]`);
        if (!rowElement) return false;
        const targetTop =
          element.scrollTop +
          rowElement.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        logger.debug("[v4-turn-navigator] 定位用户 query", {
          behavior,
          rowId: target.rowId,
          unitIndex: target.unitIndex,
        });
        return true;
      };

      const element = scrollRef.current;
      if (!element || scrollMountedQuery(element)) return;

      // product turn 是虚拟列表的最小挂载单元，steer query 是单元内锚点。目标未挂载时
      // 先无动画挂载所属 turn，再按用户 motion 偏好精确滚到 row，不能退回 turn 开头。
      if (target.unitIndex === liveUnitIndex) {
        const liveTail = liveTailRef.current;
        if (liveTail) {
          element.scrollTop =
            element.scrollTop +
            liveTail.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
        }
      } else {
        virtualizer.scrollToIndex(target.unitIndex, {
          align: "start",
          behavior: "auto",
        });
      }

      let remainingAttempts = 12;
      const alignMountedQuery = () => {
        turnNavigatorJumpFrameRef.current = null;
        const currentElement = scrollRef.current;
        if (currentElement && scrollMountedQuery(currentElement)) return;
        remainingAttempts -= 1;
        if (remainingAttempts <= 0) {
          logger.warn("[v4-turn-navigator] query 锚点挂载超时", {
            rowId: target.rowId,
            unitIndex: target.unitIndex,
          });
          return;
        }
        turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
      };
      turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useLayoutEffect(() => {
    if (!scrollToQueryActionRef) return;
    const action = (target: { unitIndex: number; rowId: number }) => {
      scrollToQuery(target);
    };
    scrollToQueryActionRef.current = action;
    return () => {
      if (scrollToQueryActionRef.current === action) {
        scrollToQueryActionRef.current = null;
      }
    };
  }, [scrollToQuery, scrollToQueryActionRef]);

  useEffect(
    () => () => {
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }
    },
    [sessionKey],
  );

  const scrollToUnit = useCallback(
    (unitIndex: number, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (unitIndex === liveUnitIndex) {
        const element = scrollRef.current;
        const liveTail = liveTailRef.current;
        if (!element || !liveTail) return;
        const targetTop =
          element.scrollTop +
          liveTail.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        return;
      }
      virtualizer.scrollToIndex(unitIndex, { align: "start", behavior });
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useConversationTimelineFind({
    rootRef: scrollRef,
    renderUnits,
    rows,
    mountedRowsKey,
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
    scrollToUnit,
  });

  return {
    saveCurrentScrollMemory,
    restoreScrollMemory,
    handleScroll,
    handleBackToBottom,
    scrollToQuery,
  };
}
