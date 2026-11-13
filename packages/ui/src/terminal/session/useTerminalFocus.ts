import { useCallback, useRef } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";
import { logger } from "@/logger.js";

type TerminalFocusParams = {
  sessionId: string;
  termRef: RefObject<XTerm | null>;
  terminalIdRef: RefObject<string | undefined>;
  isVisibleRef: RefObject<boolean>;
};

export type TerminalFocusController = {
  focusRAFRef: RefObject<number>;
  requestFocus: () => void;
};

export function useTerminalFocus({
  sessionId,
  termRef,
  terminalIdRef,
  isVisibleRef,
}: TerminalFocusParams): TerminalFocusController {
  const focusRAFRef = useRef(0);

  const requestFocus = useCallback(() => {
    if (focusRAFRef.current) {
      cancelAnimationFrame(focusRAFRef.current);
    }

    focusRAFRef.current = requestAnimationFrame(() => {
      focusRAFRef.current = 0;
      const term = termRef.current;
      if (!isVisibleRef.current || !term) {
        return;
      }

      // 打开/新建/切换终端时 React 只更新了可见 tab，焦点仍停在按钮或输入框。
      // xterm 的 textarea 会在 open 后创建，所以要等下一帧确认当前 session 仍可见再聚焦。
      term.focus();
      logger.debug("[Terminal] focused visible terminal", {
        terminalId: terminalIdRef.current,
        terminalTabId: sessionId,
      });
    });
  }, [focusRAFRef, isVisibleRef, sessionId, termRef, terminalIdRef]);

  return { focusRAFRef, requestFocus };
}
