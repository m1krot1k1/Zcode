import type { Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";
import { logger } from "@/logger.js";
import {
  createTerminalInputFallbackKeydownCandidate,
  type TerminalInputFallbackKeydownCandidate,
} from "@/terminal/terminalComposedInputFallback.js";

/**
 * 拦截 Ctrl/Cmd+C、Ctrl/Cmd+V：
 * - Ctrl+C 在 Win/Linux 默认会被当作 SIGINT 传给 PTY，必须在有选区时改走复制；
 * - Ctrl+V 不拦截会被当作 `^V` 字符输入。
 * 同时维护 keydown candidate 去重历史的前半段，供 Windows 输入法兜底消费。
 */
export function attachCopyPasteKeyHandler(
  term: XTerm,
  inputFallbackKeydownCandidateRef: RefObject<TerminalInputFallbackKeydownCandidate | null>,
): void {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    inputFallbackKeydownCandidateRef.current =
      e.metaKey || e.ctrlKey || e.altKey
        ? null
        : createTerminalInputFallbackKeydownCandidate({
            eventTimeStamp: e.timeStamp,
            key: e.key,
            now: performance.now(),
          });
    if (!(e.metaKey || e.ctrlKey)) return true;
    const key = e.key.toLowerCase();
    if (key === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
        logger.warn("[Terminal] copy via shortcut failed:", err);
      });
      return false;
    }
    if (key === "v") {
      // attachCustomKeyEventHandler 返回 false 只阻止 xterm 处理 Ctrl+V，
      // 不会取消浏览器随后派发的原生 paste 事件；这里手动 paste 一次后，
      // 原生 paste 又会被 xterm 的内置监听写入一次，导致快捷键粘贴重复。
      // 因此必须先取消默认事件，再保留手动读取剪贴板的单次写入。
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard
        .readText()
        .then((text) => {
          logger.debug("[Terminal] paste via shortcut", {
            length: text.length,
          });
          if (text) term.paste(text);
        })
        .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
      return false;
    }
    return true;
  });
}
