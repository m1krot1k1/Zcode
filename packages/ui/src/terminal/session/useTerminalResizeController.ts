import { useCallback, useRef } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  TERMINAL_RESIZE_DRAG_THROTTLE_MS,
  type TerminalResizeReason,
  type TerminalResizeRequestStats,
  type TerminalSize,
} from "./terminalSessionModel.js";

type TerminalResizeControllerParams = {
  services: IServiceAccessor;
  sessionId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<XTerm | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  terminalIdRef: RefObject<string | undefined>;
  isVisibleRef: RefObject<boolean>;
  isPanelResizingRef: RefObject<boolean>;
};

export type TerminalResizeController = {
  resizeRAFRef: RefObject<number>;
  resizeThrottleTimerRef: RefObject<number | null>;
  resizeRequestStatsRef: RefObject<TerminalResizeRequestStats>;
  lastSentTerminalSizeRef: RefObject<TerminalSize | null>;
  pendingTerminalSizeRef: RefObject<TerminalSize | null>;
  resizeInFlightRef: RefObject<boolean>;
  flushTerminalServiceResize: () => void;
  queueTerminalServiceResize: (size: TerminalSize) => void;
  clearResizeThrottleTimer: () => void;
  requestFitAndResize: (reason?: TerminalResizeReason) => void;
  scheduleFitAndResize: (reason?: TerminalResizeReason) => void;
};

/**
 * resize 调度（fit → 去重 → PTY resize 队列）保留为单一所有者：
 * 拖拽节流、可见性和 in-flight 串行都在这里，挂载函数只调用 scheduleFitAndResize。
 */
export function useTerminalResizeController({
  services,
  sessionId,
  containerRef,
  termRef,
  fitAddonRef,
  terminalIdRef,
  isVisibleRef,
  isPanelResizingRef,
}: TerminalResizeControllerParams): TerminalResizeController {
  const resizeRAFRef = useRef(0);
  const resizeThrottleTimerRef = useRef<number | null>(null);
  const resizeRequestStatsRef = useRef({
    fit: 0,
    queued: 0,
    sent: 0,
    skipped: 0,
  });
  const lastSentTerminalSizeRef = useRef<TerminalSize | null>(null);
  const pendingTerminalSizeRef = useRef<TerminalSize | null>(null);
  const resizeInFlightRef = useRef(false);

  const flushTerminalServiceResize = useCallback(() => {
    if (resizeInFlightRef.current) {
      return;
    }

    const terminalId = terminalIdRef.current;
    const pendingSize = pendingTerminalSizeRef.current;
    if (!terminalId || !pendingSize) {
      return;
    }

    pendingTerminalSizeRef.current = null;
    resizeInFlightRef.current = true;
    resizeRequestStatsRef.current.sent += 1;

    const startedAt = performance.now();
    void services.terminalService
      .resize({
        id: terminalId,
        cols: pendingSize.cols,
        rows: pendingSize.rows,
      })
      .then(() => {
        logger.debug("[Terminal] resize sent", {
          cols: pendingSize.cols,
          durationMs: Math.round(performance.now() - startedAt),
          fitCount: resizeRequestStatsRef.current.fit,
          queuedCount: resizeRequestStatsRef.current.queued,
          rows: pendingSize.rows,
          sentCount: resizeRequestStatsRef.current.sent,
          skippedCount: resizeRequestStatsRef.current.skipped,
          terminalId,
          terminalTabId: sessionId,
        });
      })
      .catch((error) => {
        logger.warn("[Terminal] resize failed:", error);
      })
      .finally(() => {
        resizeInFlightRef.current = false;
        if (pendingTerminalSizeRef.current) {
          flushTerminalServiceResize();
        }
      });
  }, [
    services.terminalService,
    sessionId,
    terminalIdRef,
    pendingTerminalSizeRef,
    resizeInFlightRef,
    resizeRequestStatsRef,
  ]);

  const queueTerminalServiceResize = useCallback(
    (size: TerminalSize) => {
      const lastSentSize = lastSentTerminalSizeRef.current;
      const pendingSize = pendingTerminalSizeRef.current;
      if (
        (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows && !pendingSize) ||
        (pendingSize?.cols === size.cols && pendingSize.rows === size.rows)
      ) {
        resizeRequestStatsRef.current.skipped += 1;
        return;
      }

      pendingTerminalSizeRef.current = size;
      lastSentTerminalSizeRef.current = size;
      resizeRequestStatsRef.current.queued += 1;
      flushTerminalServiceResize();
    },
    [
      flushTerminalServiceResize,
      lastSentTerminalSizeRef,
      pendingTerminalSizeRef,
      resizeRequestStatsRef,
    ],
  );

  const clearResizeThrottleTimer = useCallback(() => {
    if (resizeThrottleTimerRef.current) {
      window.clearTimeout(resizeThrottleTimerRef.current);
      resizeThrottleTimerRef.current = null;
    }
  }, [resizeThrottleTimerRef]);

  const requestFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (resizeRAFRef.current) {
        cancelAnimationFrame(resizeRAFRef.current);
      }

      resizeRAFRef.current = requestAnimationFrame(() => {
        resizeRAFRef.current = 0;
        const el = containerRef.current;
        const term = termRef.current;
        const fitAddon = fitAddonRef.current;
        if (
          !isVisibleRef.current ||
          !el ||
          !term ||
          !fitAddon ||
          el.clientWidth <= 0 ||
          el.clientHeight <= 0
        ) {
          return;
        }

        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] fit failed:", error);
          return;
        }

        logger.debug("[Terminal] fit requested resize", {
          cols: term.cols,
          reason,
          resizing: isPanelResizingRef.current,
          rows: term.rows,
          terminalId: terminalIdRef.current,
          terminalTabId: sessionId,
        });
        queueTerminalServiceResize({ cols: term.cols, rows: term.rows });
      });
    },
    [
      containerRef,
      fitAddonRef,
      isPanelResizingRef,
      isVisibleRef,
      queueTerminalServiceResize,
      resizeRAFRef,
      resizeRequestStatsRef,
      sessionId,
      termRef,
      terminalIdRef,
    ],
  );

  const scheduleFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (!isPanelResizingRef.current || reason === "final") {
        clearResizeThrottleTimer();
        requestFitAndResize(reason);
        return;
      }

      if (resizeThrottleTimerRef.current) {
        return;
      }

      // 拖动终端高度时 ResizeObserver 会按布局帧连续触发。
      // xterm fit + PTY resize 是同步布局和跨进程请求组合，拖拽中只按常量低频预览，松手后再 flush 最终尺寸。
      resizeThrottleTimerRef.current = window.setTimeout(() => {
        resizeThrottleTimerRef.current = null;
        requestFitAndResize("drag");
      }, TERMINAL_RESIZE_DRAG_THROTTLE_MS);
    },
    [clearResizeThrottleTimer, isPanelResizingRef, requestFitAndResize, resizeThrottleTimerRef],
  );

  return {
    resizeRAFRef,
    resizeThrottleTimerRef,
    resizeRequestStatsRef,
    lastSentTerminalSizeRef,
    pendingTerminalSizeRef,
    resizeInFlightRef,
    flushTerminalServiceResize,
    queueTerminalServiceResize,
    clearResizeThrottleTimer,
    requestFitAndResize,
    scheduleFitAndResize,
  };
}
