// PreviewPane 拆分（max-lines）：内容滚动位置的记忆与恢复。
// PreviewPane 外层只是 flex 壳，真实滚动发生在内容组件的 overflow 容器；
// 折叠侧边面板卸载重内容前必须保存容器位置，恢复重内容后再还原。
import { useCallback, useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import type { FileTextSlice } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

function readPreviewPaneScrollMetrics(
  container: Pick<HTMLElement, "scrollHeight" | "scrollTop"> | null,
) {
  if (!container) {
    return null;
  }

  return {
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  };
}

export interface PreviewPaneScrollMemoryOptions {
  renderHeavyContent: boolean;
  filePreview: FileTextSlice | null;
  source: CodeViewerSource | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}

export interface PreviewPaneScrollMemory {
  onScroll: () => void;
  /** 折叠重内容期间用旧内容高度占位，避免侧边面板跳动。 */
  deferredBodyStyle: CSSProperties | undefined;
}

export function usePreviewPaneScrollMemory({
  renderHeavyContent,
  filePreview,
  source,
  scrollContainerRef,
}: PreviewPaneScrollMemoryOptions): PreviewPaneScrollMemory {
  const preservedScrollMetricsRef = useRef({
    scrollHeight: 0,
    scrollTop: 0,
  });
  const previousRenderHeavyContentRef = useRef(renderHeavyContent);

  const rememberScrollMetrics = useCallback(() => {
    const metrics = readPreviewPaneScrollMetrics(scrollContainerRef.current);
    if (!metrics) {
      return;
    }

    preservedScrollMetricsRef.current = metrics;
  }, [scrollContainerRef]);

  const handlePreviewContentScroll = useCallback(() => {
    rememberScrollMetrics();
  }, [rememberScrollMetrics]);

  useLayoutEffect(() => {
    if (!renderHeavyContent) {
      return;
    }

    if (!previousRenderHeavyContentRef.current) {
      return;
    }

    rememberScrollMetrics();
  }, [filePreview, rememberScrollMetrics, renderHeavyContent, source]);

  useLayoutEffect(() => {
    const wasRenderingHeavyContent = previousRenderHeavyContentRef.current;
    previousRenderHeavyContentRef.current = renderHeavyContent;

    if (!renderHeavyContent) {
      return;
    }

    if (wasRenderingHeavyContent) {
      return;
    }

    const container = scrollContainerRef.current;
    const preservedScrollTop = preservedScrollMetricsRef.current.scrollTop;
    if (!container || preservedScrollTop <= 0) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      container.scrollTop = Math.min(
        preservedScrollTop,
        Math.max(0, container.scrollHeight - container.clientHeight),
      );
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [renderHeavyContent, scrollContainerRef, source]);

  const deferredBodyStyle: CSSProperties | undefined =
    !renderHeavyContent && preservedScrollMetricsRef.current.scrollHeight > 0
      ? {
          height: `${preservedScrollMetricsRef.current.scrollHeight}px`,
        }
      : undefined;

  return { onScroll: handlePreviewContentScroll, deferredBodyStyle };
}
