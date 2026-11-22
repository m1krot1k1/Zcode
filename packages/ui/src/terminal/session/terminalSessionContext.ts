import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";
import type { IServiceAccessor } from "./contract.ts";
import type {
  PendingTerminalInputFallback,
  TerminalInputFallbackHandledData,
  TerminalInputFallbackKeydownCandidate,
} from "@/terminal/terminalComposedInputFallback.js";
import type {
  TerminalResizeReason,
  TerminalResizeRequestStats,
  TerminalSize,
} from "./terminalSessionModel.js";

/**
 * 会话挂载所需的共享运行时：refs 常驻组件生命周期，
 * resize/focus 回调由 useTerminalSessionRuntime 统一创建，
 * 挂载函数（persistent / 普通）只读取该上下文，避免两套状态。
 */
export type TerminalSessionContext = {
  sessionId: string;
  services: IServiceAccessor;
  cwd?: string;
  isWindowsDesktop: boolean;
  onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  persistentKey?: string;
  workspaceKey?: string;
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<XTerm | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  terminalIdRef: RefObject<string | undefined>;
  isVisibleRef: RefObject<boolean>;
  isPanelResizingRef: RefObject<boolean>;
  exitedMessageRef: RefObject<string>;
  exitHandlerRef: RefObject<((sessionId: string, exitCode: number) => void) | undefined>;
  openBrowserUrlRef: RefObject<(url: string) => void>;
  terminalProfileThemeRef: RefObject<ITheme | undefined>;
  pendingInputFallbacksRef: RefObject<PendingTerminalInputFallback[]>;
  inputFallbackKeydownCandidateRef: RefObject<TerminalInputFallbackKeydownCandidate | null>;
  recentInputFallbackHandledDataRef: RefObject<TerminalInputFallbackHandledData[]>;
  resizeRAFRef: RefObject<number>;
  resizeThrottleTimerRef: RefObject<number | null>;
  resizeRequestStatsRef: RefObject<TerminalResizeRequestStats>;
  lastSentTerminalSizeRef: RefObject<TerminalSize | null>;
  pendingTerminalSizeRef: RefObject<TerminalSize | null>;
  resizeInFlightRef: RefObject<boolean>;
  focusRAFRef: RefObject<number>;
  flushTerminalServiceResize: () => void;
  queueTerminalServiceResize: (size: TerminalSize) => void;
  clearResizeThrottleTimer: () => void;
  requestFitAndResize: (reason?: TerminalResizeReason) => void;
  scheduleFitAndResize: (reason?: TerminalResizeReason) => void;
  requestFocus: () => void;
};
