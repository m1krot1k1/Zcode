import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { SIDE_PANE_DEFAULT_EXPANDED_RATIO } from "@/app-shell/sidePaneLayout.js";

const SIDE_PANE_CONTENT_WIDTH_LOCK_DURATION_MS = 200;

/**
 * 收起 / 展开过渡期间锁住内容层像素宽度。
 *
 * 动画不变量：
 * - 收起时先锁住当前像素宽度，避免内部 Tabs/Git/Browser 先重新排版再淡出；
 * - 首次展开没有「上次收起前宽度」，用 PanelGroup 真实宽度换算默认展开宽度，
 *   等 200ms 过渡结束后再解除固定宽度，恢复自适应布局。
 */
export function useSidePaneContentWidthLock({
  isVisible,
  panelElementRef,
}: {
  isVisible: boolean;
  panelElementRef: RefObject<HTMLDivElement | null>;
}): CSSProperties | undefined {
  const [lockedContentWidthPx, setLockedContentWidthPx] = useState<number | null>(null);
  const widthUnlockTimerRef = useRef<number | null>(null);
  const previousIsVisibleRef = useRef(isVisible);

  const readInitialExpandedContentWidthPx = () => {
    const panelElement = panelElementRef.current;
    const panelGroupElement = panelElement?.parentElement;
    const panelGroupWidthPx = Math.round(panelGroupElement?.getBoundingClientRect().width ?? 0);

    if (!Number.isFinite(panelGroupWidthPx) || panelGroupWidthPx <= 0) {
      return null;
    }

    return Math.round(panelGroupWidthPx * SIDE_PANE_DEFAULT_EXPANDED_RATIO);
  };

  useEffect(() => {
    const previousIsVisible = previousIsVisibleRef.current;
    previousIsVisibleRef.current = isVisible;

    if (widthUnlockTimerRef.current !== null) {
      window.clearTimeout(widthUnlockTimerRef.current);
      widthUnlockTimerRef.current = null;
    }

    if (previousIsVisible && !isVisible) {
      const currentPanelWidthPx = Math.round(
        panelElementRef.current?.getBoundingClientRect().width ?? 0,
      );
      // side pane 收起时内容层会跟着外层 panel 一起参与过渡，
      // 这里在收起前锁住当前像素宽度，避免内部 Tabs/Git/Browser 先重新排版后再淡出。
      setLockedContentWidthPx(currentPanelWidthPx > 0 ? currentPanelWidthPx : null);
      return;
    }

    if (!previousIsVisible && isVisible) {
      // 首次展开没有“上一次收起前宽度”可复用，内容会先以 0 宽度参与布局再被撑开。
      // 这里用 PanelGroup 的真实像素宽度换算默认展开宽度，先给内容层一个接近最终态的锁宽；
      // 等 200ms 过渡结束后再移除固定宽度，恢复成普通自适应布局。
      setLockedContentWidthPx(
        (currentWidthPx) => currentWidthPx ?? readInitialExpandedContentWidthPx(),
      );
      widthUnlockTimerRef.current = window.setTimeout(() => {
        setLockedContentWidthPx(null);
        widthUnlockTimerRef.current = null;
      }, SIDE_PANE_CONTENT_WIDTH_LOCK_DURATION_MS);
    }
  }, [isVisible, panelElementRef]);

  useEffect(() => {
    return () => {
      if (widthUnlockTimerRef.current !== null) {
        window.clearTimeout(widthUnlockTimerRef.current);
      }
    };
  }, []);

  return lockedContentWidthPx !== null
    ? {
        width: `${lockedContentWidthPx}px`,
      }
    : undefined;
}
