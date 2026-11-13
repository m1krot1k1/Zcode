/**
 * Боковые панели и фоновые синхронизации таймлайна: геометрия панели выбора,
 * высота composer dock, рабочие часы и гидратация каталога вопросов.
 */
import { useCallback, useEffect, useLayoutEffect, type ReactNode } from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { armHighspeedFooterExpiryClock } from "@/highspeed/highspeedFooterExpiryClock.js";
import { logger } from "@/logger.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import {
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  shouldHydrateConversationTurnNavigatorDirectory,
  type ConversationTurnNavigatorHydrationResult,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import { syncConversationShareSelectionPanelLayout } from "@/v4/conversationShareSelectionPanelLayout.js";
import type { TimelineDom } from "@/v4/conversation-timeline/useTimelineDomRefs.js";
import { RUNNING_WORK_DURATION_TICK_MS } from "@/v4/conversation-timeline/timelineUtils.js";

interface UseTimelineSidePanelsOptions {
  dom: TimelineDom;
  backgroundScrollLocked: boolean;
  selectionPanelLayoutContainerRef?: { current: HTMLElement | null };
  onComposerDockHeightChange?: (heightPx: number) => void;
  bottomDock?: ReactNode;
  hasRunningUnit: boolean;
  setLiveNowMs: (value: number) => void;
  nextHighspeedExpiryMs: number | undefined;
}

export function useTimelineSidePanels({
  dom,
  backgroundScrollLocked,
  selectionPanelLayoutContainerRef,
  onComposerDockHeightChange,
  bottomDock,
  hasRunningUnit,
  setLiveNowMs,
  nextHighspeedExpiryMs,
}: UseTimelineSidePanelsOptions) {
  const { composerDockRef, shareSelectionPanelLayoutRef, timelineRootRef, scrollRef } = dom;
  const syncShareSelectionPanelLayout = useCallback(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    // 选择面板是 SessionPane 的兄弟节点，不能把 CSS 变量写在 Timeline
    // 自身，否则面板拿不到 dock 的真实边界；统一写入共享父容器供两者使用。
    const layout = syncConversationShareSelectionPanelLayout(container, dock);
    const previous = shareSelectionPanelLayoutRef.current;
    if (previous?.centerYPx === layout.centerYPx && previous.maxHeightPx === layout.maxHeightPx) {
      return;
    }
    shareSelectionPanelLayoutRef.current = layout;
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef]);

  useLayoutEffect(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    syncShareSelectionPanelLayout();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncShareSelectionPanelLayout);
      resizeObserver.observe(container);
      resizeObserver.observe(timelineRootRef.current ?? container);
      if (scrollRef.current) resizeObserver.observe(scrollRef.current);
      resizeObserver.observe(dock);
    }

    // ResizeObserver 在部分 Electron flex 布局中可能晚于窗口尺寸变化回调，
    // 因此窗口 resize 也始终触发一次几何同步，保证面板随窗口放大/缩小。
    window.addEventListener("resize", syncShareSelectionPanelLayout);
    return () => {
      window.removeEventListener("resize", syncShareSelectionPanelLayout);
      resizeObserver?.disconnect();
    };
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef, syncShareSelectionPanelLayout]);

  const hasBottomDock = Boolean(bottomDock);
  useLayoutEffect(() => {
    // 完整视图浮窗收起态只露出底部输入区：由 dock 自身测量并上报高度（权限/问答卡片
    // 替换输入框时高度随之变化），宿主不去猜 SessionPane 内部结构。
    const dock = composerDockRef.current;
    if (!onComposerDockHeightChange || !dock || !hasBottomDock) return;
    const report = () => onComposerDockHeightChange(dock.getBoundingClientRect().height);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(dock);
    return () => resizeObserver.disconnect();
  }, [hasBottomDock, onComposerDockHeightChange]);

  useEffect(() => {
    if (!hasRunningUnit) {
      return;
    }

    // 运行中的 assistant work 状态文案要显示“工作中 N 秒”并随时间推进；
    // 完成态耗时由协议事实固定，builder 会拒绝把这个 UI 时钟用于已结束轮次。
    setLiveNowMs(Date.now());
    const timer = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, RUNNING_WORK_DURATION_TICK_MS);

    return () => window.clearInterval(timer);
  }, [hasRunningUnit]);

  useEffect(() => {
    if (nextHighspeedExpiryMs === undefined) return;

    // Bug 根因：会话完成后工作时钟会停止；若 Highspeed 卡稍后才到期，footer 不会自行出现。
    // 单独订阅最近的卡片到期边界，避免为了等待倒计时持续刷新整个历史列表。
    // spec §9.3：到期唤醒基于 renderer setTimeout，窗口隐藏/被遮挡时会被 Chromium 冻结停摆；
    // helper 额外监听窗口恢复可见/获得焦点并即时追平 liveNowMs，footer 才能不依赖用户再发
    // 消息就出现。与 SessionPane 的 highspeedAutoShareClock 窗口唤醒补偿分工：那条刷新分享
    // 入口/查看按钮的完成态数据，这条刷新组尾 footer 的显隐时钟。
    return armHighspeedFooterExpiryClock(nextHighspeedExpiryMs, () => setLiveNowMs(Date.now()));
  }, [nextHighspeedExpiryMs]);

  return { hasBottomDock };
}

interface UseTimelineNavigatorHydrationOptions {
  dom: TimelineDom;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadAllOlder?: () => Promise<ConversationTurnNavigatorHydrationResult>;
  rowContext: ConversationRowRenderContext;
  rows: readonly ConversationRow[];
  sessionKey: string;
  totalCount: number;
  turnNavigatorDirectoryRevision: number;
}

export function useTimelineNavigatorHydration({
  dom,
  canLoadOlder,
  loadingOlder,
  onLoadAllOlder,
  rowContext,
  rows,
  sessionKey,
  totalCount,
  turnNavigatorDirectoryRevision,
}: UseTimelineNavigatorHydrationOptions) {
  const {
    turnNavigatorContainerWidthPx,
    turnNavigatorHydrationAttemptRef,
    setTurnNavigatorHydrationRetryRevision,
    turnNavigatorHydrationRetryRevision,
    timelineRootRef,
    setTurnNavigatorContainerWidthPx,
  } = dom;
  useLayoutEffect(() => {
    const element = timelineRootRef.current;
    if (!element) return;

    // rail 改由 CSS container query 隐藏后，完整历史补拉失去了同一宽度
    // 资格边界，手机远控与窄分屏也会请求全部 rows。这里仅同步只读分页资格；
    // rail 的显隐、占位与过渡仍完全由 CSS 裁决，不恢复 composer 几何测量。
    const commitWidth = (width: number) => {
      const normalizedWidth = Math.max(0, Math.round(width));
      setTurnNavigatorContainerWidthPx((current) =>
        current === normalizedWidth ? current : normalizedWidth,
      );
    };
    const readWidth = () => commitWidth(element.clientWidth);
    readWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const borderBox = entry?.borderBoxSize?.[0];
        commitWidth(borderBox?.inlineSize ?? entry?.contentRect.width ?? element.clientWidth);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", readWidth);
    return () => window.removeEventListener("resize", readWidth);
  }, []);

  useEffect(() => {
    if (
      !shouldHydrateConversationTurnNavigatorDirectory({
        canLoadOlder,
        containerWidthPx: turnNavigatorContainerWidthPx,
        hasLoadHandler: Boolean(onLoadAllOlder),
        loadingOlder,
      })
    ) {
      return;
    }
    // terminal key 必须与 store turnNavigatorDirectoryRevision 同步。
    // 仅用 sessionKey + logEpoch 时，real-user query 增删不换 epoch，
    // 组件层 terminal 永久拦截，store 即使失效缓存也无法重新探测。
    const hydrationKey = `${sessionKey}:${rowContext.logEpoch ?? "unknown"}:${turnNavigatorDirectoryRevision}`;
    const attempt = turnNavigatorHydrationAttemptRef.current;
    if (attempt.key !== hydrationKey) {
      if (attempt.retryTimer !== null) window.clearTimeout(attempt.retryTimer);
      Object.assign(attempt, {
        attemptCount: 0,
        key: hydrationKey,
        retryTimer: null,
        status: "idle" as const,
      });
    }
    if (attempt.status !== "idle" || !onLoadAllOlder) return;
    attempt.status = "in-flight";
    logger.debug("[v4-turn-navigator] 目录请求补齐完整历史", {
      attempt: attempt.attemptCount + 1,
      loadedRows: rows.length,
      sessionKey,
      totalRows: totalCount,
    });
    void onLoadAllOlder().then((result) => {
      if (attempt.key !== hydrationKey) return;
      if (result.status === "hydrated" || result.status === "not-enough-queries") {
        attempt.status = "terminal";
        return;
      }
      if (result.status === "stale") {
        attempt.status = "idle";
        return;
      }
      attempt.attemptCount += 1;
      const retryDelayMs = resolveConversationTurnNavigatorHydrationRetryDelayMs(
        attempt.attemptCount,
      );
      if (retryDelayMs === null) {
        attempt.status = "terminal";
        return;
      }
      attempt.status = "waiting";
      attempt.retryTimer = window.setTimeout(() => {
        if (attempt.key !== hydrationKey) return;
        attempt.retryTimer = null;
        attempt.status = "idle";
        setTurnNavigatorHydrationRetryRevision((revision) => revision + 1);
      }, retryDelayMs);
    });
  }, [
    canLoadOlder,
    loadingOlder,
    onLoadAllOlder,
    rowContext.logEpoch,
    rows,
    sessionKey,
    totalCount,
    turnNavigatorContainerWidthPx,
    turnNavigatorDirectoryRevision,
    turnNavigatorHydrationRetryRevision,
  ]);

  useEffect(
    () => () => {
      const timer = turnNavigatorHydrationAttemptRef.current.retryTimer;
      if (timer !== null) window.clearTimeout(timer);
    },
    [],
  );
}
