import { useEffect, useRef } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import type { IServiceAccessor } from "./contract.ts";
import { useTerminalFocus } from "./useTerminalFocus.js";
import { useTerminalResizeController } from "./useTerminalResizeController.js";
import type { TerminalSessionContext } from "./terminalSessionContext.js";
import type {
  PendingTerminalInputFallback,
  TerminalInputFallbackHandledData,
  TerminalInputFallbackKeydownCandidate,
} from "@/terminal/terminalComposedInputFallback.js";

export type TerminalSessionRuntimeInput = {
  sessionId: string;
  services: IServiceAccessor;
  cwd?: string;
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  onExit?: (sessionId: string, exitCode: number) => void;
  onOpenBrowserUrl: (url: string) => void;
  persistentKey?: string;
  workspaceKey?: string;
  exitedMessage: string;
};

/**
 * 会话的 refs、resize 调度、焦点与可见性联动集中在这里，
 * 挂载函数（persistent / 普通）只消费返回的上下文。
 */
export function useTerminalSessionRuntime({
  sessionId,
  services,
  cwd,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onShellLabelChange,
  onExit,
  onOpenBrowserUrl,
  persistentKey,
  workspaceKey,
  exitedMessage,
}: TerminalSessionRuntimeInput): TerminalSessionContext {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const isVisibleRef = useRef(isVisible);
  const isPanelResizingRef = useRef(isPanelResizing);
  const exitedMessageRef = useRef("");
  const exitHandlerRef = useRef(onExit);
  const openBrowserUrlRef = useRef(onOpenBrowserUrl);
  const terminalProfileThemeRef = useRef<ITheme | undefined>(undefined);
  const pendingInputFallbacksRef = useRef<PendingTerminalInputFallback[]>([]);
  const inputFallbackKeydownCandidateRef = useRef<TerminalInputFallbackKeydownCandidate | null>(
    null,
  );
  const recentInputFallbackHandledDataRef = useRef<TerminalInputFallbackHandledData[]>([]);

  exitedMessageRef.current = exitedMessage;
  exitHandlerRef.current = onExit;
  openBrowserUrlRef.current = onOpenBrowserUrl;

  const {
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
  } = useTerminalResizeController({
    services,
    sessionId,
    containerRef,
    termRef,
    fitAddonRef,
    terminalIdRef,
    isVisibleRef,
    isPanelResizingRef,
  });

  const { focusRAFRef, requestFocus } = useTerminalFocus({
    sessionId,
    termRef,
    terminalIdRef,
    isVisibleRef,
  });

  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible) {
      scheduleFitAndResize("visible");
      requestFocus();
    }
  }, [isVisible, requestFocus, scheduleFitAndResize]);

  useEffect(() => {
    const wasResizing = isPanelResizingRef.current;
    isPanelResizingRef.current = isPanelResizing;
    if (wasResizing && !isPanelResizing && isVisibleRef.current) {
      scheduleFitAndResize("final");
    }
  }, [isPanelResizing, scheduleFitAndResize]);

  return {
    sessionId,
    services,
    cwd,
    isWindowsDesktop,
    onShellLabelChange,
    persistentKey,
    workspaceKey,
    containerRef,
    termRef,
    fitAddonRef,
    terminalIdRef,
    isVisibleRef,
    isPanelResizingRef,
    exitedMessageRef,
    exitHandlerRef,
    openBrowserUrlRef,
    terminalProfileThemeRef,
    pendingInputFallbacksRef,
    inputFallbackKeydownCandidateRef,
    recentInputFallbackHandledDataRef,
    resizeRAFRef,
    resizeThrottleTimerRef,
    resizeRequestStatsRef,
    lastSentTerminalSizeRef,
    pendingTerminalSizeRef,
    resizeInFlightRef,
    focusRAFRef,
    flushTerminalServiceResize,
    queueTerminalServiceResize,
    clearResizeThrottleTimer,
    requestFitAndResize,
    scheduleFitAndResize,
    requestFocus,
  };
}
