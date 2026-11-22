import type { ILink, Terminal as XTerm } from "@xterm/xterm";
import type { RefObject } from "react";
import type { IDisposable } from "@zcode/rpc";
import { logger } from "@/logger.js";
import { getHttpLinksForTerminalBufferLine } from "@/terminal/terminalLinks.js";

/**
 * plain URL 不属于 React DOM，必须通过 xterm link provider 从 buffer
 * 计算可点击区域，再统一交给右侧 browser pane，避免在终端层直接碰平台 API。
 */
export function registerTerminalHttpLinkProvider(
  term: XTerm,
  openBrowserUrlRef: RefObject<(url: string) => void>,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const links = getHttpLinksForTerminalBufferLine(
        term.buffer.active,
        bufferLineNumber,
        term.cols,
      )?.map(
        (link): ILink => ({
          ...link,
          activate(event, text) {
            event.preventDefault();
            logger.debug("[Terminal] open plain http link", { url: text });
            openBrowserUrlRef.current(text);
          },
        }),
      );

      callback(links);
    },
  });
}
