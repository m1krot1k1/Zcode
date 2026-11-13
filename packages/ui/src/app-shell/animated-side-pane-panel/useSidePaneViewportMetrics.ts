import { useEffect, useRef, useState, type RefObject } from "react";

const PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS = 220;

function readViewportInlineIntersectionSize(element: HTMLElement | null) {
  if (!element || typeof window === "undefined") {
    return null;
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  if (viewportWidth <= 0) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const visibleLeft = Math.max(0, rect.left);
  const visibleRight = Math.min(viewportWidth, rect.right);
  return Math.max(0, Math.round(visibleRight - visibleLeft));
}

function useViewportInlineIntersectionSize<TElement extends HTMLElement>(
  elementRef: RefObject<TElement | null>,
  enabled: boolean,
) {
  const [visibleInlineSizePx, setVisibleInlineSizePx] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setVisibleInlineSizePx(null);
      return;
    }

    const element = elementRef.current;
    if (!element) {
      setVisibleInlineSizePx(null);
      return;
    }

    let frameId: number | null = null;
    const update = () => {
      frameId = null;
      const next = readViewportInlineIntersectionSize(element);
      setVisibleInlineSizePx((current) => (current === next ? current : next));
    };
    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }

      if (typeof window.requestAnimationFrame !== "function") {
        update();
        return;
      }

      frameId = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    window.addEventListener("scroll", scheduleUpdate, {
      capture: true,
      passive: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, { capture: true });
      resizeObserver?.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [elementRef, enabled]);

  return visibleInlineSizePx;
}

function useWindowResizeSettling(enabled: boolean) {
  const [isResizeSettling, setIsResizeSettling] = useState(false);
  const resizeSettleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setIsResizeSettling(false);
      return;
    }

    const finishSettling = () => {
      resizeSettleTimerRef.current = null;
      setIsResizeSettling(false);
    };

    const markSettling = () => {
      // 窗口 resize 期间，大文件 PreviewPane 的千行 Shadow DOM 会在每帧参与
      // React commit + Layout。这里只把 resize 视为短暂的不稳定阶段，等尺寸停止抖动后再恢复重内容。
      setIsResizeSettling((current) => (current ? current : true));
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
      }
      resizeSettleTimerRef.current = window.setTimeout(
        finishSettling,
        PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS,
      );
    };

    window.addEventListener("resize", markSettling, { passive: true });
    window.visualViewport?.addEventListener("resize", markSettling, {
      passive: true,
    });

    return () => {
      window.removeEventListener("resize", markSettling);
      window.visualViewport?.removeEventListener("resize", markSettling);
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
        resizeSettleTimerRef.current = null;
      }
    };
  }, [enabled]);

  return isResizeSettling;
}

/**
 * 面板可见性和窗口尺寸共同决定 PreviewPane 的重内容预算：
 * - 侧栏可见宽度用于判断窄条 / 部分遮挡；
 * - 窗口 resize settling 期间暂停重内容提交，避免千行 Shadow DOM 每帧参与布局。
 */
export function useSidePaneViewportMetrics({
  elementRef,
  hasRenderedSidePane,
}: {
  elementRef: RefObject<HTMLDivElement | null>;
  hasRenderedSidePane: boolean;
}) {
  const sidePaneVisibleInlineSizePx = useViewportInlineIntersectionSize(
    elementRef,
    hasRenderedSidePane,
  );
  const isWindowResizeSettling = useWindowResizeSettling(hasRenderedSidePane);

  return { sidePaneVisibleInlineSizePx, isWindowResizeSettling };
}
