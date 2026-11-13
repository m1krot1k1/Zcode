import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import type { ILinkHandler, ITheme } from "@xterm/xterm";
import type { IDisposable } from "@zcode/rpc";
import { logger } from "@/logger.js";
import { normalizePowerShellReadlineRedraw } from "@/terminal/terminalDataTransform.js";
import { mergeTerminalTheme } from "@/terminal/terminalTheme.js";
import {
  createPendingTerminalInputFallback,
  consumeTerminalInputFallbackHandledData,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
} from "@/terminal/terminalComposedInputFallback.js";
import { attachCopyPasteKeyHandler } from "./terminalKeyHandler.js";
import { registerTerminalHttpLinkProvider } from "./terminalLinkProvider.js";
import type { TerminalSessionContext } from "./terminalSessionContext.js";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS,
  TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
  TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
  formatShellLabel,
  isHttpTerminalUrl,
  normalizeTerminalFontSize,
  normalizeWindowsPtyOption,
  type TerminalSize,
} from "./terminalSessionModel.js";

/**
 * 普通（下侧）终端挂载路径：xterm + PTY 所有权都在本次 effect 生命周期内，
 * 卸载时 dispose。persistentKey 路径见 TerminalSession.tsx（registry 常驻，不 dispose）。
 */
export function mountStandardTerminalSession({
  sessionId,
  services,
  cwd,
  isWindowsDesktop,
  onShellLabelChange,
  containerRef,
  termRef,
  fitAddonRef,
  terminalIdRef,
  isVisibleRef,
  exitedMessageRef,
  exitHandlerRef,
  openBrowserUrlRef,
  terminalProfileThemeRef,
  pendingInputFallbacksRef,
  inputFallbackKeydownCandidateRef,
  recentInputFallbackHandledDataRef,
  resizeRAFRef,
  resizeRequestStatsRef,
  lastSentTerminalSizeRef,
  pendingTerminalSizeRef,
  resizeInFlightRef,
  focusRAFRef,
  clearResizeThrottleTimer,
  flushTerminalServiceResize,
  scheduleFitAndResize,
  requestFocus,
}: TerminalSessionContext): () => void {
  const el = containerRef.current;
  if (!el) {
    return () => {};
  }

  let disposed = false;
  terminalProfileThemeRef.current = undefined;

  const term = new XTerm({
    fontSize: 13,
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    theme: mergeTerminalTheme(terminalProfileThemeRef.current),
    linkHandler: {
      allowNonHttpProtocols: false,
      activate(event, text) {
        if (!isHttpTerminalUrl(text)) {
          return;
        }
        event.preventDefault();
        logger.debug("[Terminal] open OSC 8 http link", { url: text });
        openBrowserUrlRef.current(text);
      },
    } satisfies ILinkHandler,
  });
  termRef.current = term;

  const fitAddon = new FitAddon();
  fitAddonRef.current = fitAddon;
  term.loadAddon(fitAddon);
  // 接入 ClipboardAddon 以支持 OSC 52，并让 xterm 的 copy 事件把选区写入系统剪贴板。
  term.loadAddon(new ClipboardAddon());
  term.open(el);
  let initialTerminalSize: TerminalSize | null = null;
  if (isVisibleRef.current && el.clientWidth > 0 && el.clientHeight > 0) {
    try {
      // side pane 终端挂载时如果先用 xterm 默认列数创建 PTY，
      // 启动输出会在随后 fit/resize 时按错误宽度重排，zsh 可能显示反白的 PROMPT_EOL_MARK。
      // 首次可见时先同步 fit，再用真实 cols/rows 启动 PTY，避免启动输出和尺寸校正竞态。
      resizeRequestStatsRef.current.fit += 1;
      fitAddon.fit();
      initialTerminalSize = { cols: term.cols, rows: term.rows };
      lastSentTerminalSizeRef.current = initialTerminalSize;
      logger.debug("[Terminal] initial fit before create", {
        cols: initialTerminalSize.cols,
        rows: initialTerminalSize.rows,
        terminalTabId: sessionId,
      });
    } catch (error) {
      logger.warn("[Terminal] initial fit failed:", error);
    }
  }
  if (isVisibleRef.current) {
    requestFocus();
  }

  attachCopyPasteKeyHandler(term, inputFallbackKeydownCandidateRef);

  // 监听主题切换，实时更新 terminal 配色
  const observer = new MutationObserver(() => {
    term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  const disposables: IDisposable[] = [];
  const { terminalService } = services;
  disposables.push(registerTerminalHttpLinkProvider(term, openBrowserUrlRef));

  // 优先使用 workspace 路径作为 terminal 工作目录，未设置时后端回退到 HOME
  const initialCreateSize = initialTerminalSize ?? {
    cols: term.cols,
    rows: term.rows,
  };
  terminalService
    .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
    .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
      if (disposed) {
        terminalService.dispose({ id });
        return;
      }

      terminalIdRef.current = id;
      // 首次 fit 或 ResizeObserver 可能早于 terminal id ready，先把 resize
      // 暂存在 pendingTerminalSizeRef；id ready 后必须主动 flush，否则相同尺寸会被去重逻辑跳过。
      flushTerminalServiceResize();
      // Windows ConPTY 在 resize 增高时不会像传统 Unix PTY 一样把 scrollback 拉回 viewport，
      // 不开启 xterm 的 windowsPty 兼容会让 PSReadLine 后续按旧坐标重绘输入，覆盖到上一条命令输出行。
      term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
      term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
      const nextFontSize = normalizeTerminalFontSize(fontSize);
      if (nextFontSize) {
        term.options.fontSize = nextFontSize;
      }
      terminalProfileThemeRef.current = theme as ITheme | undefined;
      term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
      const nextShellLabel = formatShellLabel(shell);
      logger.info("[Terminal] shell resolved:", {
        cwd,
        fontFamilySource,
        shell,
        shellLabel: nextShellLabel,
        terminalId: id,
        terminalTabId: sessionId,
      });
      onShellLabelChange(sessionId, nextShellLabel);
      scheduleFitAndResize("init");
      if (isVisibleRef.current) {
        requestFocus();
      }

      disposables.push(
        terminalService.onDynamicData(id)((data) => {
          term.write(normalizePowerShellReadlineRedraw(data, shell));
        }),
      );

      disposables.push(
        terminalService.onDynamicExit(id)((exitCode) => {
          const exitHandler = exitHandlerRef.current;
          logger.info("[Terminal] terminal session exited", {
            autoClose: Boolean(exitHandler),
            exitCode,
            terminalId: id,
            terminalTabId: sessionId,
          });
          if (exitHandler) {
            exitHandler(sessionId, exitCode);
            return;
          }

          // side pane Terminal 不属于底部 tab registry，未传 onExit 时继续保留退出提示。
          term.write(`\r\n${exitedMessageRef.current}\r\n`);
        }),
      );

      disposables.push(
        term.onData((data) => {
          const now = performance.now();
          const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
          const handledData = recordTerminalInputFallbackHandledData({
            candidate: inputFallbackKeydownCandidate,
            data,
            history: recentInputFallbackHandledDataRef.current,
            maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
            now,
          });
          recentInputFallbackHandledDataRef.current = handledData.usedCandidate
            ? handledData.history
            : recordTerminalInputFallbackRecentData({
                data,
                history: handledData.history,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                now,
              });
          if (handledData.usedCandidate) {
            inputFallbackKeydownCandidateRef.current = null;
          }
          markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
          terminalService.write({ id, data });
        }),
      );

      // Windows desktop 下某些输入法会把 composed text 留在 textarea 里，
      // xterm 可能只处理到一半；这里保留兜底。但 Linux Wayland 已确认会和 xterm 的
      // onData 路径重复写入，所以必须显式收窄到 Windows，避免把正常链路误伤。
      const textarea =
        isWindowsDesktop &&
        (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
      if (textarea) {
        const handleInput = (e: InputEvent) => {
          // 只处理组合文本的 insertText
          if (e.inputType !== "insertText" || !e.data || !e.composed) return;
          const insertedText = e.data;
          const now = performance.now();
          const pendingFallback = createPendingTerminalInputFallback(insertedText);
          pendingInputFallbacksRef.current.push(pendingFallback);
          // 普通空格会先经 keydown 被 xterm onData 写入 PTY，随后浏览器才派发 composed input。
          // 搜狗输入法也会在没有稳定 keydown candidate 的情况下先触发 xterm onData、后触发 composed input。
          // 这里消费同一次输入附近的未消费 onData，避免把同一段组合文本再兜底写入一次。
          consumeTerminalInputFallbackHandledData({
            history: recentInputFallbackHandledDataRef.current,
            inputEventTimeStamp: e.timeStamp,
            maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
            maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
            now,
            pending: pendingFallback,
          });

          // 延迟检查：等 xterm 的 onData 先认领 pending，再判断是否需要兜底写入。
          setTimeout(() => {
            pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
              (item) => item !== pendingFallback,
            );
            if (disposed) {
              return;
            }
            const fallbackAction = resolveTerminalInputFallbackAction({
              pending: pendingFallback,
              textareaValue: textarea.value,
            });
            if (fallbackAction.shouldWrite) {
              // 普通空格也会触发 composed input，且 xterm 已经通过 onData 写入 PTY。
              // 只看 textarea.value 会把空格再手动写一次；这里必须确认 onData 没处理过才兜底。
              logger.debug("[Terminal] flush composed input fallback", {
                length: insertedText.length,
                terminalId: id,
                terminalTabId: sessionId,
              });
              terminalService.write({ id, data: insertedText });
            }
            if (fallbackAction.shouldClearTextarea) {
              textarea.value = "";
            }
          }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
        };

        textarea.addEventListener("input", handleInput, true);
        disposables.push({
          dispose: () => textarea.removeEventListener("input", handleInput, true),
        } as IDisposable);
      }
    })
    .catch((error) => {
      // 之前没有接住 create() 的拒绝态，终端启动失败会直接变成 Uncaught Promise。
      // 这里显式记录错误，并在终端区域提示用户，方便定位到底是 shell 还是 cwd 出了问题。
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Terminal] failed to create terminal:", error);
      term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
    });

  let resizeRAF = 0;
  const resizeObserver = new ResizeObserver(() => {
    if (!isVisibleRef.current) return;
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
  });
  resizeObserver.observe(el);

  return () => {
    disposed = true;
    observer.disconnect();
    resizeObserver.disconnect();
    clearResizeThrottleTimer();
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
    if (focusRAFRef.current) cancelAnimationFrame(focusRAFRef.current);
    pendingInputFallbacksRef.current = [];
    inputFallbackKeydownCandidateRef.current = null;
    recentInputFallbackHandledDataRef.current = [];
    pendingTerminalSizeRef.current = null;
    lastSentTerminalSizeRef.current = null;
    resizeInFlightRef.current = false;
    for (const d of disposables) d.dispose();
    if (terminalIdRef.current) {
      terminalService.dispose({ id: terminalIdRef.current });
    }
    terminalIdRef.current = undefined;
    fitAddonRef.current = null;
    term.dispose();
    termRef.current = null;
  };
}
