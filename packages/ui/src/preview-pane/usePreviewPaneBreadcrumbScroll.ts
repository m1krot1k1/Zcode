// PreviewPane 拆分（max-lines）：顶部路径面包屑的横向滚动与遮罩状态。
// 交互约定：内容变更后只初始化滚到最右侧，之后用户的滚动不再被强行回弹。
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { BreadcrumbMaskState, CodeViewerBreadcrumbData } from "./constants.js";

export interface PreviewPaneBreadcrumbScroll {
  breadcrumbScrollRef: RefObject<HTMLDivElement | null>;
  breadcrumbContentRef: RefObject<HTMLDivElement | null>;
  breadcrumbMaskState: BreadcrumbMaskState;
}

export function usePreviewPaneBreadcrumbScroll({
  breadcrumb,
  headerContainer,
}: {
  breadcrumb: CodeViewerBreadcrumbData | null;
  headerContainer?: HTMLElement | null;
}): PreviewPaneBreadcrumbScroll {
  const [breadcrumbMaskState, setBreadcrumbMaskState] = useState<BreadcrumbMaskState>("none");
  const breadcrumbScrollRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbContentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const viewport = breadcrumbScrollRef.current;
    if (!viewport) {
      return;
    }

    // 交互说明：长路径首次打开时，用户最关心的是末尾文件名。
    // 这里在 breadcrumb 内容变更后只初始化滚到最右侧，后续用户手动滚动不再强行回弹。
    const frameId = requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [breadcrumb, headerContainer]);

  useLayoutEffect(() => {
    const viewport = breadcrumbScrollRef.current;
    const content = breadcrumbContentRef.current;
    if (!viewport || !content) {
      setBreadcrumbMaskState("none");
      return;
    }

    const updateMaskState = () => {
      const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
      if (maxScrollLeft <= 1) {
        setBreadcrumbMaskState("none");
        return;
      }

      const hasHiddenLeft = viewport.scrollLeft > 1;
      const hasHiddenRight = viewport.scrollLeft < maxScrollLeft - 1;
      setBreadcrumbMaskState(
        hasHiddenLeft && hasHiddenRight
          ? "both"
          : hasHiddenLeft
            ? "left"
            : hasHiddenRight
              ? "right"
              : "none",
      );
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateMaskState;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateMaskState();
    viewport.addEventListener("scroll", updateMaskState, { passive: true });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateMaskState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateMaskState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      viewport.removeEventListener("scroll", updateMaskState);
      resizeObserver.disconnect();
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [breadcrumb, headerContainer]);

  return { breadcrumbScrollRef, breadcrumbContentRef, breadcrumbMaskState };
}
