/**
 * Общие константы и чистые помощники таймлайна беседы.
 *
 * Вынесены из ConversationTimeline.tsx, чтобы хуки conversation-timeline/
 * не дублировали пороги прокрутки и правила измерения строк.
 */
import type { QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

// memo 组件参数中的 `pendingGuides = []` 会在每次调用时创建新引用，
// 让未传该属性的渲染绕过稳定引用边界；共享只读空数组可保持默认值恒定。
export const EMPTY_PENDING_GUIDES: readonly QueueItem[] = [];

export const ROW_OVERSCAN = 8;
export const RUNNING_WORK_DURATION_TICK_MS = 1000;
export const COMPOSER_MESSAGE_MASK_FADE_PX = 24;
export const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;
export const USER_SCROLL_INTENT_TTL_MS = 1200;
export const LAYOUT_SCROLL_GUARD_MS = 250;
export const CONTENT_WIDTH_RESIZE_SETTLE_MS = 120;
export const SCROLL_MEMORY_RESTORE_TOLERANCE_PX = 1;

export function scheduleMicrotask(callback: () => void): void {
  // 部分 WebView/最小 DOM 运行时没有 window.queueMicrotask；调度能力应从
  // globalThis 注入，并保留 Promise 微任务降级，避免滚动恢复在 commit 阶段直接中断。
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

export function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** tanstack 默认测量的竖向复刻：优先 ResizeObserver entry（不触发同步布局）。 */
export function measureRowHeight(element: Element, entry: ResizeObserverEntry | undefined): number {
  const boxSize = entry?.borderBoxSize?.[0];
  if (boxSize) {
    return Math.round(boxSize.blockSize);
  }
  return Math.round(element.getBoundingClientRect().height);
}

export function getUnitHeightCacheKey(
  unit: ConversationTurnRenderUnit | undefined,
): string | undefined {
  return unit?.key;
}
