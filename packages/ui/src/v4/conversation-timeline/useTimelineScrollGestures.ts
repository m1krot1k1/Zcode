/**
 * Пользовательские жесты и учёт scrollTop: намерение прокрутки, follow-состояние,
 * программные кадры и маска сообщений под composer dock.
 */
import {
  useCallback,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { TimelineDom } from "@/v4/conversation-timeline/useTimelineDomRefs.js";
import {
  COMPOSER_MESSAGE_MASK_FADE_PX,
  COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
  isEditableScrollTarget,
  LAYOUT_SCROLL_GUARD_MS,
  USER_SCROLL_INTENT_TTL_MS,
} from "@/v4/conversation-timeline/timelineUtils.js";
import {
  isAtBottom,
  shouldShowBackToBottom,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";

export function useTimelineScrollGestures({
  dom,
  unitsRef,
}: {
  dom: TimelineDom;
  unitsRef: RefObject<readonly ConversationTurnRenderUnit[]>;
}) {
  const {
    programmaticScrollFrameRef,
    followingRef,
    setBackToBottomVisible,
    userScrollIntentRef,
    touchClientYRef,
    scrollbarPointerIdRef,
    layoutScrollGuardUntilRef,
    scrollRef,
    messageLayerRef,
    floatingComposerDockRef,
  } = dom;
  const markProgrammaticScroll = useCallback(() => {
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = null;
    });
  }, []);

  const commitFollowing = useCallback((following: boolean) => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    setBackToBottomVisible(shouldShowBackToBottom(following, unitsRef.current.length));
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
    scrollbarPointerIdRef.current = null;
  }, []);

  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const current = userScrollIntentRef.current;
    const interactionActive =
      touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ? current.intent : "none";
  }, []);

  const markLayoutScrollGuard = useCallback(() => {
    layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
  }, []);

  const markUserScrollIntent = useCallback(
    (intent: TimelineUserScrollIntent) => {
      if (intent === "none") return;
      userScrollIntentRef.current = { intent, observedAt: Date.now() };
      const element = scrollRef.current;
      // running -> terminal 会在同一帧迁移 live tail、折叠工作历史并触发
      // virtualizer 测高。向上滚动必须在 scroll 事件之前先拿走滚动权，否则终态
      // layout effect 会拿过期的 following=true 把用户重新拽到底部。
      if (intent === "awayFromBottom" && element && element.scrollHeight > element.clientHeight) {
        commitFollowing(false);
      }
    },
    [commitFollowing],
  );

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      markUserScrollIntent(timelineWheelScrollIntent(event.deltaY));
    },
    [markUserScrollIntent],
  );

  const handleTouchStartCapture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    touchClientYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMoveCapture = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const nextClientY = event.touches[0]?.clientY;
      const previousClientY = touchClientYRef.current;
      if (nextClientY === undefined || previousClientY === null) return;
      markUserScrollIntent(timelineTouchScrollIntent(previousClientY, nextClientY));
      touchClientYRef.current = nextClientY;
    },
    [markUserScrollIntent],
  );

  const handleTouchEndCapture = useCallback(() => {
    touchClientYRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      markUserScrollIntent(
        timelineKeyboardScrollIntent({
          key: event.key,
          shiftKey: event.shiftKey,
          editableTarget: isEditableScrollTarget(event.target),
        }),
      );
    },
    [markUserScrollIntent],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 内容区点击（尤其 composer 发送）不是滚动意图；只有 scrollbar/空白命中
      // scroll container 自身时才登记未知方向，随后由真实 scroll 落点裁决。
      if (event.target !== event.currentTarget) return;
      scrollbarPointerIdRef.current = event.pointerId;
      markUserScrollIntent("unknown");
    },
    [markUserScrollIntent],
  );

  const handlePointerEndCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrollbarPointerIdRef.current === event.pointerId) {
      scrollbarPointerIdRef.current = null;
    }
  }, []);

  const syncMessageLayerMask = useCallback((element: HTMLDivElement) => {
    const messageLayer = messageLayerRef.current;
    if (!messageLayer) return;

    if (
      // 浮窗形态下输入区不在滚动视口内，消息不会经过输入框，底部遮罩只会吃掉消息。
      floatingComposerDockRef.current ||
      isAtBottom({
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      })
    ) {
      // 贴底时消息已经位于正常文档流末尾，不会经过 sticky composer；
      // 继续保留 mask 会无意义地淡出最后一条消息，只有离底滚动时才需要遮罩。
      messageLayer.style.maskImage = "none";
      messageLayer.style.webkitMaskImage = "none";
      return;
    }

    const viewportHeight = element.clientHeight;
    const transparentStart = Math.max(
      0,
      viewportHeight - COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
    );
    const opaqueEnd = Math.max(0, transparentStart - COMPOSER_MESSAGE_MASK_FADE_PX);
    const viewportTopInLayer = Math.max(0, element.scrollTop - messageLayer.offsetTop);
    const maskImage = `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`;

    // dock 的透明 padding 能保留分屏 focus ring，但消息会从留白透出；
    // mask 必须随 scroll viewport 对齐且只裁消息层，不能裁掉 sticky composer 与按钮。
    messageLayer.style.maskImage = maskImage;
    messageLayer.style.webkitMaskImage = maskImage;
    messageLayer.style.maskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.webkitMaskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.maskSize = `100% ${viewportHeight}px`;
    messageLayer.style.webkitMaskSize = `100% ${viewportHeight}px`;
  }, []);

  return {
    markProgrammaticScroll,
    commitFollowing,
    clearUserScrollIntent,
    getActiveUserScrollIntent,
    markLayoutScrollGuard,
    syncMessageLayerMask,
    handleWheelCapture,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleTouchEndCapture,
    handleKeyDownCapture,
    handlePointerDownCapture,
    handlePointerEndCapture,
  };
}
