/**
 * Обёртка над @tanstack/react-virtual: ключи, оценка высоты, измерение строк и
 * производные списки для каталога вопросов.
 */
import { useCallback, useMemo, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationTurnNavigatorVirtualItem } from "@/v4/conversationTurnNavigatorHelpers.js";
import type { TimelineDom } from "@/v4/conversation-timeline/useTimelineDomRefs.js";
import {
  getUnitHeightCacheKey,
  measureRowHeight,
  ROW_OVERSCAN,
} from "@/v4/conversation-timeline/timelineUtils.js";
import { shouldAdjustVirtualizerForItemSizeChange } from "@/v4/timelineScrollAnchor.js";
import { DEFAULT_ROW_HEIGHT_ESTIMATE_PX } from "@/v4/timelineRowHeightCache.js";

interface UseTimelineVirtualizerOptions {
  dom: TimelineDom;
  virtualizedUnits: readonly ConversationTurnRenderUnit[];
  virtualizedUnitsRef: RefObject<readonly ConversationTurnRenderUnit[]>;
  liveUnit: ConversationTurnRenderUnit | null;
  liveUnitIndex: number | null;
  headerSlotHeight: number;
}

export function useTimelineVirtualizer({
  dom,
  virtualizedUnits,
  virtualizedUnitsRef,
  liveUnit,
  liveUnitIndex,
  headerSlotHeight,
}: UseTimelineVirtualizerOptions) {
  const {
    scrollRef,
    heightCacheRef,
    suppressVirtualizerAdjustmentDuringRestoreRef,
    followingRef,
    isContentWidthChanging,
  } = dom;
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback(
    (index: number) => virtualizedUnitsRef.current[index]?.key ?? index,
    [],
  );
  // 测高缓存兜底：行卸载重挂（甚至 virtualizer 重建）时用上次真实测量代替固定估计。
  const estimateSize = useCallback(
    (index: number) =>
      heightCacheRef.current?.estimate(
        getUnitHeightCacheKey(virtualizedUnitsRef.current[index]),
        DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
      ) ?? DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
    [],
  );
  // 动态测高：virtualizer 对窗口内元素挂 ResizeObserver，流式行长高即回调此处；
  // 同时把真实高度写入稳定的 turnId 缓存。
  const measureElement = useCallback((element: Element, entry: ResizeObserverEntry | undefined) => {
    const height = measureRowHeight(element, entry);
    const indexAttr = element.getAttribute("data-index");
    const unit = indexAttr === null ? undefined : virtualizedUnitsRef.current[Number(indexAttr)];
    const cacheKey = getUnitHeightCacheKey(unit);
    if (cacheKey !== undefined) {
      heightCacheRef.current?.set(cacheKey, height);
    }
    return height;
  }, []);

  const [, commitMeasuredLayout] = useState(0);
  const virtualizer = useVirtualizer({
    count: virtualizedUnits.length,
    getScrollElement,
    estimateSize,
    overscan: ROW_OVERSCAN,
    getItemKey,
    measureElement,
    // headerSlot（分享导入的只读块）与虚拟列表同处一个滚动容器，
    // 且高度可观。不告知这段偏移，虚拟窗口会按 scrollTop 直接索引 item，
    // 渲染窗口整体偏移一个 header 高度，用户滚到的区域会是空白。
    scrollMargin: headerSlotHeight,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    return shouldAdjustVirtualizerForItemSizeChange({
      suppressAdjustment: suppressVirtualizerAdjustmentDuringRestoreRef.current,
      following: followingRef.current,
      contentWidthChanging: isContentWidthChanging(),
      itemEnd: item.end,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
    });
  };
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const turnNavigatorVirtualItems: ConversationTurnNavigatorVirtualItem[] = useMemo(() => {
    const historyItems = virtualRows.map((row) => ({
      index: row.index,
      size: row.size,
      start: row.start,
    }));
    if (liveUnitIndex === null) return historyItems;
    return [
      ...historyItems,
      {
        index: liveUnitIndex,
        start: totalSize,
        // live tail 不参与 virtualizer 测高；覆盖剩余滚动区即可供目录判定当前轮次。
        size: Number.MAX_SAFE_INTEGER - totalSize,
      },
    ];
  }, [liveUnitIndex, totalSize, virtualRows]);
  const mountedRowsKey = useMemo(
    () =>
      [
        ...virtualRows.map((row) => String(row.key)),
        ...(liveUnit === null ? [] : [String(liveUnit.key)]),
      ].join(":"),
    [liveUnit, virtualRows],
  );

  return {
    virtualizer,
    virtualRows,
    totalSize,
    turnNavigatorVirtualItems,
    mountedRowsKey,
    measureElement,
    commitMeasuredLayout,
  };
}

export type TimelineVirtualizer = ReturnType<typeof useTimelineVirtualizer>["virtualizer"];
