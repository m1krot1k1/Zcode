/**
 * Геометрия composer во floating-окне и маска сообщений, а также снимок видимости
 * каталога вопросов для текущего scrollTop.
 */
import { useCallback, useLayoutEffect, type RefObject } from "react";
import {
  resolveConversationTurnNavigatorActiveQueryRowId,
  type ConversationTurnNavigatorQueryPosition,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import type { TimelineDom } from "@/v4/conversation-timeline/useTimelineDomRefs.js";

interface UseTimelineMessageMaskOptions {
  dom: TimelineDom;
  floatingComposerDock: boolean;
  hasBottomDock: boolean;
  renderUnitsEmpty: boolean;
  turnNavigatorQueryRowIdsRef: RefObject<ReadonlySet<number>>;
  syncMessageLayerMask: (element: HTMLDivElement) => void;
}

export function useTimelineMessageMask({
  dom,
  floatingComposerDock,
  hasBottomDock,
  renderUnitsEmpty,
  turnNavigatorQueryRowIdsRef,
  syncMessageLayerMask,
}: UseTimelineMessageMaskOptions) {
  const {
    timelineRootRef,
    composerDockRef,
    scrollRef,
    messageLayerRef,
    messageLayerMaskObserverRef,
    setTurnNavigatorViewport,
  } = dom;
  useLayoutEffect(() => {
    // 修复原因：浮窗展开态输入区曾是滚动容器内的 sticky 层，滚动条一直延伸到输入框后面。
    // 浮窗形态下输入区改为相对时间线根节点贴底（同一 DOM，不重挂载），滚动容器底边让出输入区高度。
    const root = timelineRootRef.current;
    const dock = composerDockRef.current;
    if (!floatingComposerDock || !root || !dock) return;
    const sync = () =>
      root.style.setProperty(
        "--v4-floating-composer-dock-height",
        `${dock.getBoundingClientRect().height}px`,
      );
    sync();
    if (scrollRef.current) syncMessageLayerMask(scrollRef.current);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    resizeObserver?.observe(dock);
    return () => {
      resizeObserver?.disconnect();
      root.style.removeProperty("--v4-floating-composer-dock-height");
    };
  }, [floatingComposerDock, hasBottomDock, syncMessageLayerMask]);

  const syncTurnNavigatorViewport = useCallback(
    (element: HTMLDivElement) => {
      syncMessageLayerMask(element);
      const viewportRect = element.getBoundingClientRect();
      const queryPositions: ConversationTurnNavigatorQueryPosition[] = [];
      for (const rowElement of element.querySelectorAll<HTMLElement>("[data-row-id]")) {
        const rowId = Number(rowElement.dataset.rowId);
        if (!Number.isSafeInteger(rowId) || !turnNavigatorQueryRowIdsRef.current.has(rowId)) {
          continue;
        }
        const rowRect = rowElement.getBoundingClientRect();
        const start = element.scrollTop + rowRect.top - viewportRect.top;
        queryPositions.push({ rowId, start, end: start + rowRect.height });
      }
      const nextViewport = {
        scrollOffsetPx: element.scrollTop,
        viewportHeightPx: element.clientHeight,
        // turn 级 active 只能命中同 turn 的第一条 query。这里从已挂载
        // 的稳定 row anchor 推导当前 query；虚拟 turn 尚未挂载时组件再回退 unit。
        activeQueryRowId: resolveConversationTurnNavigatorActiveQueryRowId({
          positions: queryPositions,
          scrollOffsetPx: element.scrollTop,
          viewportHeightPx: element.clientHeight,
        }),
      };
      setTurnNavigatorViewport((current) =>
        current.scrollOffsetPx === nextViewport.scrollOffsetPx &&
        current.viewportHeightPx === nextViewport.viewportHeightPx &&
        current.activeQueryRowId === nextViewport.activeQueryRowId
          ? current
          : nextViewport,
      );
    },
    [syncMessageLayerMask],
  );

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const messageLayer = messageLayerRef.current;
    if (!scrollElement || !messageLayer) return;

    const sync = () => syncMessageLayerMask(scrollElement);
    sync();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(sync);
      messageLayerMaskObserverRef.current = observer;
      observer.observe(scrollElement);
      observer.observe(messageLayer);
      return () => {
        observer.disconnect();
        if (messageLayerMaskObserverRef.current === observer)
          messageLayerMaskObserverRef.current = null;
      };
    }

    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [syncMessageLayerMask, renderUnitsEmpty]);

  return { syncTurnNavigatorViewport };
}
