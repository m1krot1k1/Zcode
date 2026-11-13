import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { ClipboardPaste, Copy } from "lucide-react";
import { useEffect } from "react";
import type { ILinkHandler, ITheme } from "@xterm/xterm";
import type { IServiceAccessor } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  createPendingTerminalInputFallback,
  consumeTerminalInputFallbackHandledData,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
} from "@/terminal/terminalComposedInputFallback.js";
import { normalizePowerShellReadlineRedraw } from "@/terminal/terminalDataTransform.js";
import { mergeTerminalTheme } from "@/terminal/terminalTheme.js";
import {
  sidePaneTerminalSessionRegistry,
  type SidePaneTerminalSessionEntry,
} from "@/terminal/sidePaneTerminalSessionRegistry.js";
import { mountStandardTerminalSession } from "./session/mountStandardTerminalSession.js";
import { attachCopyPasteKeyHandler } from "./session/terminalKeyHandler.js";
import { registerTerminalHttpLinkProvider } from "./session/terminalLinkProvider.js";
import type { TerminalSessionContext } from "./session/terminalSessionContext.js";
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
} from "./session/terminalSessionModel.js";
import { useTerminalSessionRuntime } from "./session/useTerminalSessionRuntime.js";

export function TerminalSession({
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
}: {
  sessionId: string;
  services: IServiceAccessor;
  cwd?: string;
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  onExit?: (sessionId: string, exitCode: number) => void;
  onOpenBrowserUrl: (url: string) => void;
  /**
   * 跨组件生命周期的会话复用 key（仅 side pane terminal 用）。
   * 传入后 xterm 实例 + PTY 所有权上移到 sidePaneTerminalSessionRegistry 模块级单例，
   * 组件卸载只 detach DOM、不 dispose；重挂按 key 复用，scrollback 历史跨 workspace 保活。
   * 不传（下侧 terminal）走原 effect 路径，字节级不变。
   */
  persistentKey?: string;
  /**
   * workspace 身份隔离 key（= workspaceIdentity?.trim() || workspacePath）。
   * 仅 persistentKey 路径用：写入 registry entry.workspaceKey，
   * 供 workspace tab 真正关闭时按 workspaceKey 批量回收 PTY（对称下侧 openWorkspaceKeys 回收）。
   * 不传时 fallback 到 cwd。下侧 terminal 不传 persistentKey，此值不生效。
   */
  workspaceKey?: string;
}) {
  const { intl } = useZCodeIntl();
  const exitedMessage = intl.formatMessage({ id: "terminal.exited" });
  const runtime = useTerminalSessionRuntime({
    sessionId,
    services,
    cwd,
    isVisible,
    isPanelResizing,
    isWindowsDesktop,
    onShellLabelChange,
    onExit,
    onOpenBrowserUrl,
    persistentKey,
    workspaceKey,
    exitedMessage,
  });
  const {
    containerRef,
    termRef,
    clearResizeThrottleTimer,
    flushTerminalServiceResize,
    requestFocus,
    scheduleFitAndResize,
  } = runtime;

  useEffect(() => {
    if (!persistentKey) return;
    return mountPersistentTerminalSession(runtime);
  }, [
    clearResizeThrottleTimer,
    cwd,
    isWindowsDesktop,
    onShellLabelChange,
    requestFocus,
    scheduleFitAndResize,
    flushTerminalServiceResize,
    services,
    sessionId,
    persistentKey,
  ]);

  useEffect(() => {
    if (persistentKey) return;
    return mountStandardTerminalSession(runtime);
  }, [
    clearResizeThrottleTimer,
    cwd,
    isWindowsDesktop,
    onShellLabelChange,
    requestFocus,
    scheduleFitAndResize,
    flushTerminalServiceResize,
    services,
    sessionId,
    persistentKey,
  ]);

  const handleCopy = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
      logger.warn("[Terminal] copy via context menu failed:", err);
    });
  };

  const handlePaste = () => {
    const term = termRef.current;
    if (!term) return;
    navigator.clipboard
      .readText()
      .then((text) => text && term.paste(text))
      .catch((err) => logger.warn("[Terminal] paste via context menu failed:", err));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="terminal-xterm-shell h-full min-h-0 w-full overflow-hidden"
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          <Copy className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.copy" })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.paste" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * persistentKey 路径：side pane terminal 跨 workspace 会话保活。
 * xterm 实例 + PTY 所有权上移到 sidePaneTerminalSessionRegistry 模块级单例，
 * 组件卸载只 detach DOM、不 dispose；重挂按 persistentKey 复用，scrollback 跨 workspace 保活。
 */
function mountPersistentTerminalSession({
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
  exitedMessageRef,
  exitHandlerRef,
  openBrowserUrlRef,
  terminalProfileThemeRef,
  pendingInputFallbacksRef,
  inputFallbackKeydownCandidateRef,
  recentInputFallbackHandledDataRef,
  resizeRequestStatsRef,
  lastSentTerminalSizeRef,
  flushTerminalServiceResize,
  scheduleFitAndResize,
  requestFocus,
}: TerminalSessionContext): (() => void) | undefined {
  const el = containerRef.current;
  const key = persistentKey;
  if (!el || !key) return undefined;

  terminalProfileThemeRef.current = undefined;
  const existingEntry = sidePaneTerminalSessionRegistry.get(key);

  // --- 复用快路径：切回 workspace / 重挂，entry 已在 registry ---
  if (existingEntry) {
    termRef.current = existingEntry.term;
    fitAddonRef.current = existingEntry.fitAddon;
    terminalIdRef.current = existingEntry.terminalId || undefined;
    el.appendChild(existingEntry.hostEl);
    const reuseThemeObserver = new MutationObserver(() => {
      // 从 entry.profileTheme 读：重挂后组件局部 ref 已重置为 undefined，
      // profile theme 只存在于 registry entry，必须从 entry 取（否则丢用户配置的终端颜色）。
      existingEntry.term.options.theme = mergeTerminalTheme(existingEntry.profileTheme);
    });
    reuseThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    let reuseResizeRAF = 0;
    const reuseResizeObserver = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
      reuseResizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
    });
    reuseResizeObserver.observe(el);
    try {
      resizeRequestStatsRef.current.fit += 1;
      existingEntry.fitAddon.fit();
    } catch (error) {
      logger.warn("[Terminal] persistent reuse fit failed:", error);
    }
    if (isVisibleRef.current) {
      requestFocus();
    }
    logger.debug("[Terminal] persistent reuse", {
      terminalTabId: sessionId,
      persistentKey: key,
    });
    return () => {
      reuseThemeObserver.disconnect();
      reuseResizeObserver.disconnect();
      if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
      sidePaneTerminalSessionRegistry.detachDom(key);
      // 不 dispose：term/PTY/订阅都留在 registry 供下次复用
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }

  // --- 首次创建：常驻 hostEl，term open 到 hostEl，资源进 registry ---
  const hostEl = document.createElement("div");
  hostEl.className = "terminal-xterm-shell h-full min-h-0 w-full overflow-hidden";
  el.appendChild(hostEl);

  let ptyCancelled = false;
  const registryDisposers: IDisposable[] = [];
  const localDisposers: IDisposable[] = [];

  const term = new XTerm({
    fontSize: 13,
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    theme: mergeTerminalTheme(terminalProfileThemeRef.current),
    linkHandler: {
      allowNonHttpProtocols: false,
      activate(event, text) {
        if (!isHttpTerminalUrl(text)) return;
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
  term.loadAddon(new ClipboardAddon());
  term.open(hostEl);

  let initialTerminalSize: TerminalSize | null = null;
  if (isVisibleRef.current && hostEl.clientWidth > 0 && hostEl.clientHeight > 0) {
    try {
      resizeRequestStatsRef.current.fit += 1;
      fitAddon.fit();
      initialTerminalSize = { cols: term.cols, rows: term.rows };
      lastSentTerminalSizeRef.current = initialTerminalSize;
      logger.debug("[Terminal] initial fit before create (persistent)", {
        cols: initialTerminalSize.cols,
        rows: initialTerminalSize.rows,
        terminalTabId: sessionId,
      });
    } catch (error) {
      logger.warn("[Terminal] persistent initial fit failed:", error);
    }
  }
  if (isVisibleRef.current) {
    requestFocus();
  }

  // 组件局部：customKeyEventHandler（依赖组件 inputFallback ref）
  attachCopyPasteKeyHandler(term, inputFallbackKeydownCandidateRef);

  // 组件局部：主题 observer
  const themeObserver = new MutationObserver(() => {
    // 从 entry.profileTheme 读：profile theme 所有权在 registry entry，跨重挂常驻；
    // 组件局部 terminalProfileThemeRef 在重挂后会丢失 profile theme，不能作为 observer 数据源。
    term.options.theme = mergeTerminalTheme(entry.profileTheme);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  localDisposers.push({
    dispose: () => themeObserver.disconnect(),
  } as IDisposable);

  // 进 registry：linkProvider（detached 时保留无害）
  registryDisposers.push(registerTerminalHttpLinkProvider(term, openBrowserUrlRef));

  // entry 先占位存入 registry（terminalId 异步填），重挂/回收据此判断
  const entry: SidePaneTerminalSessionEntry = {
    key,
    term,
    fitAddon,
    terminalId: "",
    cwd: cwd ?? "",
    // workspaceKey 用于 workspace tab 真正关闭时按 workspace 批量回收（对称下侧 openWorkspaceKeys）。
    workspaceKey: workspaceKey ?? cwd ?? "",
    hostEl,
    dispose: () => {}, // 紧接着补全
  };
  entry.dispose = () => {
    ptyCancelled = true;
    for (const d of registryDisposers) {
      try {
        d.dispose();
      } catch (error) {
        logger.warn("[Terminal] persistent dispose disposer failed:", error);
      }
    }
    if (entry.terminalId) {
      void services.terminalService.dispose({ id: entry.terminalId });
    }
    try {
      term.dispose();
    } catch (error) {
      logger.warn("[Terminal] persistent term.dispose failed:", error);
    }
  };
  sidePaneTerminalSessionRegistry.register(key, entry);

  // 创建 PTY（异步）
  const initialCreateSize = initialTerminalSize ?? {
    cols: term.cols,
    rows: term.rows,
  };
  void services.terminalService
    .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
    .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
      if (ptyCancelled) {
        // cleanup 已发生：杀掉这个孤儿 PTY，不进 entry
        void services.terminalService.dispose({ id });
        return;
      }
      entry.terminalId = id;
      terminalIdRef.current = id;
      // 与原路径对称：id ready 后立即 flush 创建期间排队的 resize（pendingTerminalSizeRef）。
      // 否则 scheduleFitAndResize("init") 会因 pendingSize 去重跳过，PTY 停在错误 cols/rows。
      flushTerminalServiceResize();
      term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
      term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
      const nextFontSize = normalizeTerminalFontSize(fontSize);
      if (nextFontSize) {
        term.options.fontSize = nextFontSize;
      }
      terminalProfileThemeRef.current = theme as ITheme | undefined;
      // profile theme 所有权上移到 registry entry，
      // 跨组件生命周期复用不丢（原仅写组件局部 ref，重挂后新组件 ref=undefined → 复用 observer 用 undefined 合并 → 丢失）。
      entry.profileTheme = theme as ITheme | undefined;
      term.options.theme = mergeTerminalTheme(entry.profileTheme);
      const nextShellLabel = formatShellLabel(shell);
      logger.info("[Terminal] shell resolved (persistent):", {
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

      // data 订阅 → term.write（进 registry，detached 时仍累积 scrollback）
      registryDisposers.push(
        services.terminalService.onDynamicData(id)((data) => {
          term.write(normalizePowerShellReadlineRedraw(data, shell));
        }),
      );
      // exit 订阅（进 registry，与原路径对称：有 onExit 则回调，否则写退出提示）
      registryDisposers.push(
        services.terminalService.onDynamicExit(id)((exitCode) => {
          const exitHandler = exitHandlerRef.current;
          logger.info("[Terminal] persistent session exited", {
            autoClose: Boolean(exitHandler),
            exitCode,
            terminalId: id,
            terminalTabId: sessionId,
          });
          if (exitHandler) {
            exitHandler(sessionId, exitCode);
            return;
          }
          // side pane Terminal 不传 onExit，保留退出提示。
          term.write(`\r\n${exitedMessageRef.current}\r\n`);
        }),
      );

      // onData（进 registry，随 term 常驻）：
      // 不能放 localDisposers：cleanup(detach) 时会被取消，而复用路径不重绑，
      // 导致切回 workspace 后 scrollback 在但无法输入交互。
      // 输入订阅生命周期必须 = entry 生命周期（随 term 常驻），detach 不取消。
      //
      // 与原路径（下侧 terminal）的 onData 完全一致：维护 keydown candidate 去重历史，
      // 供 Windows 输入法 textarea 兜底消费（IME composition committed text 的三段去重闭环）。
      // 注：本段只处理「已提交 composition 文本」的去重，与 Shift 切换输入法动作无关——
      // Shift 切换是输入法系统级行为（customKeyEventHandler 对 Shift 直接 return true 放行）；
      // 「Shift 切英文后字符丢失」的真根因是 isWindowsDesktop 未透传（已在 WorkspaceShellLayout 修复）。
      registryDisposers.push(
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
          void services.terminalService.write({ id, data });
        }),
      );

      // Windows 输入法兜底（进 registry，随 term 常驻，与 onData 同生命周期）。
      // textarea 元素随 term 实例常驻，监听绑一次即可；detach 不取消，重挂后中文输入法兜底仍生效。
      const textarea =
        isWindowsDesktop &&
        (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
      if (textarea) {
        const handleInput = (e: InputEvent) => {
          if (e.inputType !== "insertText" || !e.data || !e.composed) return;
          const insertedText = e.data;
          const now = performance.now();
          const pendingFallback = createPendingTerminalInputFallback(insertedText);
          pendingInputFallbacksRef.current.push(pendingFallback);
          consumeTerminalInputFallbackHandledData({
            history: recentInputFallbackHandledDataRef.current,
            inputEventTimeStamp: e.timeStamp,
            maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
            maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
            now,
            pending: pendingFallback,
          });
          setTimeout(() => {
            pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
              (item) => item !== pendingFallback,
            );
            // 不检查 ptyCancelled：订阅已随 entry 常驻（registryDisposers），
            // ptyCancelled 是单次 effect 闭包变量，detach 后会变 true 导致 fallback 永久失效。
            // release 时 entry.dispose 会移除本监听；PTY disposed 后 write 为 no-op，安全。
            const fallbackAction = resolveTerminalInputFallbackAction({
              pending: pendingFallback,
              textareaValue: textarea.value,
            });
            if (fallbackAction.shouldWrite) {
              logger.debug("[Terminal] flush composed input fallback (persistent)", {
                length: insertedText.length,
                terminalId: id,
                terminalTabId: sessionId,
              });
              void services.terminalService.write({ id, data: insertedText });
            }
            if (fallbackAction.shouldClearTextarea) {
              textarea.value = "";
            }
          }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
        };
        textarea.addEventListener("input", handleInput, true);
        registryDisposers.push({
          dispose: () => textarea.removeEventListener("input", handleInput, true),
        } as IDisposable);
      }
    })
    .catch((error) => {
      if (ptyCancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Terminal] persistent create failed:", error);
      term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
      // PTY 创建失败必须释放 registry 中本次占位的 entry。
      // entry 在上方以 terminalId="" 占位先 register（line 541），再异步 terminalService.create()。
      // 若失败不释放，terminalId="" 的僵尸 entry 会留在 registry，重挂/切 workspace 时命中
      // 复用快路径（见上方 existingEntry 分支），直接复用已启动失败的 xterm，且永不重新
      // terminalService.create()，该终端永久无法连接 PTY。
      //
      // ownership 校验（稳妥方案）：只有 registry 当前 entry 仍是本次创建的 entry 时才释放。
      // 极端时序：create reject 触发前，组件可能已卸载（cleanup 已 release 半成品，见下方 !entry.terminalId
      // 分支）并重挂、registry 已被新一次创建的 entry 覆盖。此时无脑 release 会误删新 entry。
      // 闭包 entry 引用比较 registry 当前值：每次创建都是新 entry 对象，引用比较天然区分代际。
      const currentEntry = sidePaneTerminalSessionRegistry.get(key);
      if (currentEntry === entry) {
        sidePaneTerminalSessionRegistry.release(key);
      }
    });

  // 组件局部：resize observer
  let resizeRAF = 0;
  const resizeObserver = new ResizeObserver(() => {
    if (!isVisibleRef.current) return;
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
  });
  resizeObserver.observe(el);

  logger.debug("[Terminal] persistent create", {
    terminalTabId: sessionId,
    persistentKey: key,
  });

  return () => {
    ptyCancelled = true;
    themeObserver.disconnect();
    resizeObserver.disconnect();
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    for (const d of localDisposers) {
      try {
        d.dispose();
      } catch (error) {
        logger.warn("[Terminal] persistent cleanup local disposer failed:", error);
      }
    }
    // PTY 未就绪即被卸载（极少见）：回收半成品 entry，避免重挂复用到空 PTY
    if (!entry.terminalId) {
      sidePaneTerminalSessionRegistry.release(key);
    } else {
      sidePaneTerminalSessionRegistry.detachDom(key);
    }
    termRef.current = null;
    fitAddonRef.current = null;
  };
}
