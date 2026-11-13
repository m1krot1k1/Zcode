/**
 * Renderer-local память прокрутки: снимок текущего состояния, кэш последнего
 * значения, мгновенное закрепление у низа и пересчёт измеренной раскладки.
 */
import { useCallback, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import {
  saveChatSessionScrollMemoryState,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import type { ConversationScrollMemoryScopeSnapshot } from "@/v4/conversation-timeline/scrollMemoryScope.js";
import type { TimelineDom } from "@/v4/conversation-timeline/useTimelineDomRefs.js";
import {
  anchorActionAfterContentChange,
  reconcileFollowingForContentAnchor,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { TimelineVirtualizer } from "@/v4/conversation-timeline/useTimelineVirtualizer.js";
import {
  CONTENT_WIDTH_RESIZE_SETTLE_MS,
  getUnitHeightCacheKey,
  measureRowHeight,
  scheduleMicrotask,
} from "@/v4/conversation-timeline/timelineUtils.js";

interface UseTimelineScrollMemoryOptions {
  dom: TimelineDom;
  scrollMemoryKey: string | null;
  responsiveCenteredEmptyLayout: boolean;
  renderUnitsEmpty: boolean;
  markProgrammaticScroll: () => void;
  syncTurnNavigatorViewport: (element: HTMLDivElement) => void;
  commitFollowing: (following: boolean) => void;
  getActiveUserScrollIntent: () => TimelineUserScrollIntent;
  markLayoutScrollGuard: () => void;
  measureElement: (element: Element, entry: ResizeObserverEntry | undefined) => number;
  virtualizer: TimelineVirtualizer;
  commitMeasuredLayout: (updater: (revision: number) => number) => void;
  liveUnit: ConversationTurnRenderUnit | null;
  isContentWidthChanging: () => boolean;
}
export function useTimelineScrollMemory({
  dom,
  scrollMemoryKey,
  responsiveCenteredEmptyLayout,
  renderUnitsEmpty,
  markProgrammaticScroll,
  syncTurnNavigatorViewport,
  commitFollowing,
  getActiveUserScrollIntent,
  markLayoutScrollGuard,
  measureElement,
  virtualizer,
  commitMeasuredLayout,
  liveUnit,
  isContentWidthChanging,
}: UseTimelineScrollMemoryOptions) {
  const {
    scrollRef,
    virtualHistoryRef,
    stableContentWidthRef,
    contentWidthResizeActiveRef,
    contentWidthResizeSettleTimerRef,
    committingMeasuredLayoutRef,
    messageLayerRef,
    messageLayerMaskObserverRef,
    liveTailRef,
    heightCacheRef,
    followingRef,
    lastObservedScrollTopRef,
    userAdjustedScrollSinceRestoreRef,
    latestScrollMemoryStateRef,
    pendingDetachedScrollRestoreRef,
  } = dom;
  const buildCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const metrics = {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      };
      const wasPinnedToBottom = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics,
        lastObservedScrollTop: lastObservedScrollTopRef.current,
      });
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        wasPinnedToBottom,
        updatedAt: Date.now(),
      };
    },
    [],
  );

  const cacheCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const state = buildCurrentScrollMemoryState(element);
      if (scrollMemoryKey) {
        latestScrollMemoryStateRef.current = { key: scrollMemoryKey, state };
      }
      return state;
    },
    [buildCurrentScrollMemoryState, scrollMemoryKey],
  );

  const notifyScrollObserversAfterCommit = useCallback((element: HTMLDivElement) => {
    scheduleMicrotask(() => {
      if (scrollRef.current !== element) return;
      element.dispatchEvent(new Event("scroll"));
    });
  }, []);

  const captureScrollMemoryBeforeScopeMutation = useCallback(
    (previousKey: string | null): ConversationScrollMemoryScopeSnapshot | null => {
      const pendingRestore = pendingDetachedScrollRestoreRef.current;
      if (pendingRestore?.key === previousKey) {
        // 会话数据尚未到达时 DOM 只能读到被钳制的 scrollTop=0；此时切换
        // 任务不能用空时间线覆盖原记忆，必须保留尚未落地的 detached 恢复意图。
        return pendingRestore;
      }
      const element = scrollRef.current;
      if (!previousKey || !element) return null;
      return {
        key: previousKey,
        state: buildCurrentScrollMemoryState(element),
      };
    },
    [buildCurrentScrollMemoryState],
  );

  const commitCapturedScrollMemory = useCallback(
    (snapshot: ConversationScrollMemoryScopeSnapshot | null) => {
      if (!snapshot) return;
      latestScrollMemoryStateRef.current = snapshot;
      saveChatSessionScrollMemoryState(snapshot.key, snapshot.state);
    },
    [],
  );

  // 贴底必须 instant（scrollTop 赋值）：smooth 的中间帧会被 scroll 判定误读为「离底」。
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    markProgrammaticScroll();
    // 草稿安全居中允许内容在低高度下向下溢出；若沿用真实会话吸底，
    // 顶部安全留白会被滚走。草稿始终展示顶部，真实会话继续吸底。
    element.scrollTop = responsiveCenteredEmptyLayout ? 0 : element.scrollHeight;
    // 回读取钳制后的落点入账（浏览器会把赋值钳到最大可滚动距离）。
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    userAdjustedScrollSinceRestoreRef.current = false;
    cacheCurrentScrollMemoryState(element);
    notifyScrollObserversAfterCommit(element);
  }, [
    cacheCurrentScrollMemoryState,
    responsiveCenteredEmptyLayout,
    markProgrammaticScroll,
    notifyScrollObserversAfterCommit,
    syncTurnNavigatorViewport,
  ]);

  useLayoutEffect(() => {
    const contentColumn = virtualHistoryRef.current;
    if (!contentColumn || typeof ResizeObserver === "undefined") return;

    stableContentWidthRef.current = contentColumn.clientWidth;
    let observedViewportHeight = scrollRef.current?.clientHeight ?? 0;
    let observeContentFrame: number | null = null;
    let disposed = false;
    const observer = new ResizeObserver(() => {
      const nextWidth = contentColumn.clientWidth;
      const element = scrollRef.current;
      if (!element) return;
      const viewportHeightChanged = observedViewportHeight !== element.clientHeight;
      observedViewportHeight = element.clientHeight;
      if (nextWidth === stableContentWidthRef.current && !viewportHeightChanged) return;
      markLayoutScrollGuard();
      commitFollowing(
        reconcileFollowingForContentAnchor({
          following: followingRef.current,
          metrics: {
            scrollTop: element.scrollTop,
            viewportHeight: element.clientHeight,
            contentHeight: element.scrollHeight,
          },
          lastObservedScrollTop: lastObservedScrollTopRef.current,
          userScrollIntent: getActiveUserScrollIntent(),
        }),
      );
      if (followingRef.current) {
        if (contentWidthResizeSettleTimerRef.current !== null) {
          window.clearTimeout(contentWidthResizeSettleTimerRef.current);
          contentWidthResizeSettleTimerRef.current = null;
        }
        // 本批次统一提交布局与吸底，其间其他内容 effect 不得按中间高度吸底。
        observer.unobserve(contentColumn);
        const messageLayer = messageLayerRef.current;
        const maskObserver = messageLayerMaskObserverRef.current;
        // 同步占位高度也会改变父消息层的高度；其蒙层观察器需要一起暂停，
        // 否则在更深层的 RO 通知中改变父层，会产生 undelivered notifications。
        if (messageLayer) maskObserver?.unobserve(messageLayer);
        committingMeasuredLayoutRef.current = true;
        try {
          // virtualizer 的 ResizeObserver 默认异步提交 React；先吸底会使用旧占位高度，
          // 下一帧测高提交后再跳一次。仅在 observer 内批量测高并同步提交，避免跨帧追赶。
          const measurements = Array.from(
            contentColumn.querySelectorAll(":scope > [data-index]"),
            (node) => ({
              index: Number(node.getAttribute("data-index")),
              height: measureElement(node, undefined),
            }),
          );
          flushSync(() => {
            for (const item of measurements) virtualizer.resizeItem(item.index, item.height);
            // 缓存可能已经更新且没有差量，仍需明确提交，不能依赖空回调冲刷旧任务。
            commitMeasuredLayout((revision) => revision + 1);
          });
        } finally {
          committingMeasuredLayoutRef.current = false;
          // 暂停的是本批次会写入高度的观察目标，不推迟测高或吸底。下一帧继续
          // 观察内容列宽度，以覆盖视口停止后仍在进行的 CSS 宽度过渡。
          if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
          if (!disposed) {
            observeContentFrame = window.requestAnimationFrame(() => {
              observeContentFrame = null;
              observer.observe(contentColumn);
              if (
                messageLayer &&
                messageLayerRef.current === messageLayer &&
                messageLayerMaskObserverRef.current === maskObserver
              )
                maskObserver?.observe(messageLayer);
            });
          }
        }
        if (disposed) return;
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        // 同步提交可能触发其他布局处理；用户上滚或定位始终优先。
        if (followingRef.current && getActiveUserScrollIntent() !== "awayFromBottom")
          scrollToBottom();
        return;
      }
      if (nextWidth === stableContentWidthRef.current) return;

      // 宽度变化会让虚拟行分批重新测高；逐行补偿或逐批追底都会
      // 连续改写 scrollTop。resize 期间暂停两者，稳定后只执行一次最终贴底。
      contentWidthResizeActiveRef.current = true;
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
      }
      contentWidthResizeSettleTimerRef.current = window.setTimeout(() => {
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        contentWidthResizeSettleTimerRef.current = null;
        if (followingRef.current) {
          scrollToBottom();
        }
      }, CONTENT_WIDTH_RESIZE_SETTLE_MS);
    });
    observer.observe(contentColumn);
    if (scrollRef.current) observer.observe(scrollRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
        contentWidthResizeSettleTimerRef.current = null;
      }
      contentWidthResizeActiveRef.current = false;
    };
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    markLayoutScrollGuard,
    measureElement,
    renderUnitsEmpty,
    scrollToBottom,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const element = liveTailRef.current;
    const cacheKey = getUnitHeightCacheKey(liveUnit ?? undefined);
    if (!element || cacheKey === undefined) return;

    const cacheHeight = (entry?: ResizeObserverEntry) => {
      const height = measureRowHeight(element, entry);
      heightCacheRef.current?.set(cacheKey, height);
      return height;
    };
    let observedHeight = cacheHeight();
    if (typeof ResizeObserver === "undefined") return;

    // projection revision 的父 layout effect 可能早于 Markdown 子树最终测高；
    // 旧 observer 只缓存高度，正文会先把 loading 槽顶下去，后续 commit 才补 scrollTop。
    // ResizeObserver 在绘制前拿到真实高度，这里仅在仍拥有 following 滚动权时同步吸底；
    // 用户已经上滚（包括 scroll event 尚未入账的竞态）则只缓存，不夺回阅读位置。
    const observer = new ResizeObserver((entries) => {
      const nextHeight = cacheHeight(entries[0]);
      if (nextHeight === observedHeight) return;
      observedHeight = nextHeight;

      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      markLayoutScrollGuard();
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: scrollElement.scrollTop,
          viewportHeight: scrollElement.clientHeight,
          contentHeight: scrollElement.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
      if (anchorActionAfterContentChange(following, isContentWidthChanging()) === "stickToBottom") {
        scrollToBottom();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    isContentWidthChanging,
    liveUnit?.key,
    markLayoutScrollGuard,
    scrollToBottom,
  ]);

  return {
    captureScrollMemoryBeforeScopeMutation,
    commitCapturedScrollMemory,
    scrollToBottom,
    cacheCurrentScrollMemoryState,
    notifyScrollObserversAfterCommit,
  };
}
