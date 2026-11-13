import type { BrowserGuestContext } from "./browserGuestContext.js";
import type { BrowserDialog } from "@zcode/shared";
import type { ControlledView } from "./browserCommandExecutor.js";
import type { ManagedTab, GuestWebContents } from "./browserGuestTypes.js";
import { DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS } from "./browserGuestTypes.js";
import {
  safeBool,
  safeStr,
  normalizeDialogType,
  buildViewportMetricsOverride,
} from "./browserGuestUtils.js";

export function createBrowserGuestCdp(
  ctx: BrowserGuestContext,
): Pick<
  BrowserGuestContext,
  | "setupCdpCrashGuard"
  | "setupDialogTracking"
  | "ensureGuestCdpAttached"
  | "runGuestCdpSessionRestore"
  | "rollbackGuestCdpRestore"
  | "sendGuestCdpCommandRaw"
  | "sendGuestCdpCommand"
  | "toControlledView"
  | "releaseGuestCdpAfterIdle"
  | "scheduleGuestCdpIdleRelease"
  | "clearGuestCdpIdleRelease"
  | "waitForGuestCdpIdle"
  | "detachGuestBeforeReplacement"
  | "beginGuestTeardown"
  | "runGuestTeardown"
  | "detachGuest"
> {
  return {
    releaseGuestCdpAfterIdle(tab: ManagedTab, reason: string): void {
      const guest = tab.guest;
      if (!guest || tab.guestLifecycle !== "attached") return;
      void (async () => {
        // 在途 CDP 命令（playwright cdp.send / viewport override / dialog 处理）结束后再断开，
        // 避免中途拆掉正在使用的管线；超时兜底与 runGuestTeardown 共用同一预算。
        const settled = await ctx.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
        if (!settled) {
          ctx.warn(
            `browser guest cdp release pending timeout tabId=${tab.tabId} ` +
              `pending=${tab.pendingCdpCommands} reason=${reason}`,
          );
        }
        // 等待期间 tab 可能已换代/关闭/再次进入命令期，此时放弃本轮释放。
        if (ctx.tabs.get(tab.tabId) !== tab || tab.guest !== guest) return;
        if (tab.guestLifecycle !== "attached") return;
        if (tab.pendingCdpCommands > 0) return;
        if (safeBool(() => guest.isDestroyed(), true)) return;
        try {
          if (!guest.debugger.isAttached()) {
            tab.cdpAttached = false;
            return;
          }
          guest.debugger.detach();
          tab.cdpAttached = false;
          ctx.log?.(`[browser-use] cdp released after ${reason} tabId=${tab.tabId}`);
        } catch (error) {
          ctx.warn(`browser guest cdp release failed tabId=${tab.tabId} reason=${reason}`, error);
        }
      })();
    },

    /**
     * 命令级空闲释放：每次 CDP 命令完成后重置计时，超过 cdpIdleReleaseMs 无新命令即主动
     * detach。guest renderer 被 Chromium 杀且 render-process-gone 丢失（Electron 已知缺口，
     * 实测 destroyed 直达 + CDP attached → 主进程 UAF）的崩溃窗口集中在 turn 内命令间隙，
     * turnEnded 级释放覆盖不到；密集命令流间隔远小于阈值，不会被误打断。
     */
    scheduleGuestCdpIdleRelease(tab: ManagedTab): void {
      if (tab.guestCdpIdleTimer) clearTimeout(tab.guestCdpIdleTimer);
      tab.guestCdpIdleTimer = setTimeout(() => {
        tab.guestCdpIdleTimer = undefined;
        ctx.releaseGuestCdpAfterIdle(tab, "cdp idle");
      }, ctx.cdpIdleReleaseMs);
    },

    clearGuestCdpIdleRelease(tab: ManagedTab): void {
      if (tab.guestCdpIdleTimer) {
        clearTimeout(tab.guestCdpIdleTimer);
        tab.guestCdpIdleTimer = undefined;
      }
    },

    /**
     * guest renderer 崩溃/被杀时立即断开 CDP。
     *
     * 崩溃链条（主进程 UAF，minidump 落在 DevToolsSession::DispatchProtocolNotification，
     * client_ 的 vptr 为 0）：
     *   Chromium 在内存压力下杀掉 guest renderer
     *     → render-process-gone：WebContents 仍存活，CDP 仍 attached
     *     → renderer 侧递增 webviewGeneration，React 卸载旧 <webview>
     *     → 旧 WebContents 此刻才销毁，api::Debugger 走隐式析构
     *     → DevToolsSession 仍持 client_ 派发在途通知 → UAF → 主进程崩溃 → 整个 app 退出
     *
     * 实测（Electron 41.0.3 / forcefullyCrashRenderer，带毫秒时间戳的对照实验）：
     *   - render-process-gone 时 isDestroyed()=false、isCrashed()=true、isAttached()=true，
     *     detach() 成功且随后 isAttached()=false；
     *   - destroyed 时 isCrashed()/isAttached() 全抛 "Object has been destroyed"，
     *     那里已经不可能 detach —— 所以 destroyed 兜底修不了这个 UAF；
     *   - 崩溃后若不卸载 <webview>，WebContents 无限期停在 crashed 态（10s destroyed 未到）；
     *     一旦 renderer 卸载 <webview>，destroyed 在 ~5ms 内到达。即销毁时机由 renderer 决定，
     *     native detach 的安全窗口只存在于 WebContents 销毁之前。
     * main 的 render-process-gone 是第一道守卫；renderer 重建前的显式 detach ACK 是第二道屏障，
     * 用来覆盖 main 事件未到达的现场。两者都不改变销毁时机，只保证销毁时 CDP 已经断开。
     */
    setupCdpCrashGuard(tab: ManagedTab, guest: GuestWebContents): void {
      tab.crashGuardCleanup?.();
      if (!guest.on || !guest.removeListener) return;
      const tabId = tab.tabId;
      const onRenderProcessGone = (...args: unknown[]): void => {
        const reason = safeStr(
          () => String((args[1] as { reason?: string } | undefined)?.reason ?? "unknown"),
          "unknown",
        );
        const guestId = safeStr(() => String(guest.id), "?");
        // 不校验 tab.guest === guest：断开一个已换代 guest 的 CDP 同样正确且必要，
        // 而漏掉它就等于把 UAF 窗口留着。
        try {
          if (ctx.tabs.get(tabId)?.guest === guest) tab.guestLifecycle = "detaching";
          if (!guest.debugger.isAttached()) return;
          guest.debugger.detach();
          ctx.log?.(
            `[browser-use] cdp detached on render-process-gone tabId=${tabId} ` +
              `guestId=${guestId} reason=${reason}`,
          );
        } catch (error) {
          // 这里失败意味着 UAF 窗口没能关上，必须留痕以便与后续崩溃关联。
          ctx.warn(
            `browser guest cdp detach on render-process-gone failed tabId=${tabId} ` +
              `guestId=${guestId} reason=${reason}`,
            error,
          );
        } finally {
          if (ctx.tabs.get(tabId)?.guest === guest) tab.cdpAttached = false;
        }
      };
      guest.on("render-process-gone", onRenderProcessGone);
      tab.crashGuardCleanup = () => {
        guest.removeListener?.("render-process-gone", onRenderProcessGone);
      };
    },

    setupDialogTracking(tab: ManagedTab, guest: GuestWebContents): void {
      const tabId = tab.tabId;
      void ctx.sendGuestCdpCommand(tab, guest, "Page.enable").catch((error: unknown) => {
        ctx.log?.(`[browser-use] Page.enable failed tabId=${tabId}: ${String(error)}`);
      });
      const onMessage = (_event: unknown, method: string, params: unknown): void => {
        const current = ctx.tabs.get(tabId);
        if (!current || current.guest !== guest || current.lifecycle === "closed") return;
        if (method === "Page.javascriptDialogOpening") {
          // 打点：dialog 事件到达 main 的时刻，用于区分「事件黑洞」与「dialog 已被 detach
          // 清理」两种 getDialog=null 成因。
          ctx.log?.(`[browser-use] dialog opening event received tabId=${tabId}`);
          const data = (params ?? {}) as {
            type?: string;
            message?: string;
            defaultPrompt?: string;
          };
          const dialog: BrowserDialog = {
            type: normalizeDialogType(data.type),
            message: typeof data.message === "string" ? data.message : "",
            ...(typeof data.defaultPrompt === "string"
              ? { defaultPrompt: data.defaultPrompt }
              : {}),
          };
          ctx.pendingDialogs.set(tabId, dialog);
        } else if (method === "Page.javascriptDialogClosed") {
          ctx.pendingDialogs.delete(tabId);
        }
      };
      guest.debugger.on("message", onMessage);
      tab.cdpMessageCleanup = () => {
        guest.debugger.removeListener("message", onMessage);
      };
    },

    /**
     * CDP session 态恢复式 attach：idle/turn 结束释放后再次进入命令期时调用，
     * 返回可等待的 flight——Page.enable 与 viewport override 重放完成后业务命令才允许派发。
     *
     * Page 域 enable 与 Emulation.setDeviceMetricsOverride 都是 per-session 的，
     * detach 时已被 Chromium 清空；
     * 裸 attach("1.3") 得到的是干净 session——dialog 事件黑洞（getDialog 恒 null、evaluate
     * 遇 JS dialog 挂到超时实测 62s）、viewport 仿真与 manager 缓存分叉。且 fire-and-forget
     * 重放没有等待屏障：业务命令（截图/evaluate）可能在恢复完成前执行，重放在首命令场景
     * 失效。恢复命令经 raw 发送（不走 ensure，避免自等待）；viewport 重放走既有串行队列，
     * 队列内触发恢复时直接重放，避免二次入队与当前 flight 互相等待死锁。
     */
    async ensureGuestCdpAttached(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
      if (!tab.guestCdpRestoreFlight) {
        const flight = ctx.runGuestCdpSessionRestore(tab, guest).finally(() => {
          if (tab.guestCdpRestoreFlight === flight) tab.guestCdpRestoreFlight = undefined;
        });
        tab.guestCdpRestoreFlight = flight;
      }
      await tab.guestCdpRestoreFlight;
    },

    async runGuestCdpSessionRestore(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
      if (!safeBool(() => guest.debugger.isAttached(), false)) {
        guest.debugger.attach("1.3");
        tab.cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
        if (!tab.cdpAttached) {
          throw new Error(`browser guest cdp restore attach failed tabId=${tab.tabId}`);
        }
      }
      // 恢复失败必须上抛：屏障契约是「Page.enable 与 viewport 状态就绪后才
      // 允许业务命令派发」。吞掉异常会让后续命令见 attached 即跳过恢复——Page.enable
      // 丢失把 dialog 事件黑洞延长到整个 attach 期，且 "replayed" 日志误导排障。异常上抛
      // 前先 rollback 到 detached：半途 session 不可用，还原释放态后下一次命令才会重建
      // 恢复 flight（否则 attached=true 会让 lazy attach 跳过恢复，失败被永久固化）。
      try {
        await ctx.sendGuestCdpCommandRaw(tab, guest, "Page.enable");
      } catch (error) {
        ctx.warn(`browser guest Page.enable replay failed tabId=${tab.tabId}`, error);
        ctx.rollbackGuestCdpRestore(tab, guest);
        throw error;
      }
      const viewport = tab.viewportOverride ?? tab.backgroundViewportFallback;
      if (viewport) {
        try {
          const replayViewport = async () => {
            if (tab.guest !== guest || tab.lifecycle === "closed") return;
            await ctx.sendGuestCdpCommandRaw(
              tab,
              guest,
              "Emulation.setDeviceMetricsOverride",
              buildViewportMetricsOverride(viewport),
            );
          };
          // 截图也占用 viewport 队列，但并不重设 metrics。若把队列内 re-attach
          // 一律当作等效恢复而跳过，首张图会读到宿主缩放后的自然尺寸。
          // 已在临界区时直接重放；再次入队并等待自己会死锁。
          if (tab.insideViewportMutation) await replayViewport();
          else await ctx.enqueueViewportMutation(tab, replayViewport);
        } catch (error) {
          ctx.warn(`browser guest viewport replay failed tabId=${tab.tabId}`, error);
          ctx.rollbackGuestCdpRestore(tab, guest);
          throw error;
        }
      }
      ctx.log?.(`[browser-use] cdp session state replayed tabId=${tab.tabId} pageEnable=1`);
    },

    /** 恢复失败时把半途 session 还原为释放态；rollback 自身的失败不得掩盖原始错误。 */
    rollbackGuestCdpRestore(tab: ManagedTab, guest: GuestWebContents): void {
      try {
        if (guest.debugger.isAttached()) guest.debugger.detach();
      } catch {
        // session 可能已销毁；cdpAttached 复位仍需完成。
      }
      tab.cdpAttached = false;
    },

    /** 恢复命令专用发送：只做 pending 计数与下发，不触发 ensure（避免自等待死锁）。 */
    async sendGuestCdpCommandRaw(
      tab: ManagedTab,
      guest: GuestWebContents,
      method: string,
      params?: unknown,
      sessionId?: string,
    ): Promise<unknown> {
      tab.pendingCdpCommands += 1;
      try {
        const result = await guest.debugger.sendCommand(method, params, sessionId);
        if (!sessionId && tab.guest === guest) {
          // renderer 的归一化回调可能被 Electron 后续 page zoom 传播覆盖。
          // 固定 viewport 的设置和 CDP 重连都必须在同一执行边界恢复 guest zoom。
          if (method === "Emulation.setDeviceMetricsOverride" && guest.getZoomFactor() !== 1) {
            guest.setZoomFactor(1);
          }
        }
        return result;
      } finally {
        tab.pendingCdpCommands = Math.max(0, tab.pendingCdpCommands - 1);
        ctx.scheduleGuestCdpIdleRelease(tab);
      }
    },

    async sendGuestCdpCommand(
      tab: ManagedTab,
      guest: GuestWebContents,
      method: string,
      params?: unknown,
      sessionId?: string,
      assertCurrentGuest?: () => void,
    ): Promise<unknown> {
      assertCurrentGuest?.();
      if (tab.guest !== guest || tab.guestLifecycle !== "attached") {
        throw new Error("browser guest is detaching");
      }
      // turnEnded/closeSession/命令空闲后 CDP 已主动释放（防 guest
      // 销毁时的主进程 UAF），命令路径在此恢复式 re-attach 并 await 会话态重放完成（显式
      // 串行屏障：Page.enable / viewport override 先于本命令被 Chromium 处理）。
      if (!safeBool(() => guest.debugger.isAttached(), false) || tab.guestCdpRestoreFlight) {
        await ctx.ensureGuestCdpAttached(tab, guest);
      }
      return ctx.sendGuestCdpCommandRaw(tab, guest, method, params, sessionId);
    },

    toControlledView(
      guest: GuestWebContents,
      normalizeScreenshotToCssPixels = false,
      captureViewportScreenshot: ControlledView["captureViewportScreenshot"] | undefined,
      assertCurrentGuest: () => void,
      sendCdpCommand: ControlledView["cdp"]["send"],
    ): ControlledView {
      const assertCurrent = () => assertCurrentGuest();
      return {
        webContents: {
          loadURL: (url) => {
            assertCurrent();
            return guest.loadURL(url);
          },
          getURL: () => {
            assertCurrent();
            return guest.getURL();
          },
          getTitle: () => {
            assertCurrent();
            return guest.getTitle();
          },
          canGoBack: () => {
            assertCurrent();
            return guest.navigationHistory.canGoBack();
          },
          canGoForward: () => {
            assertCurrent();
            return guest.navigationHistory.canGoForward();
          },
          goBack: () => {
            assertCurrent();
            return guest.navigationHistory.goBack();
          },
          goForward: () => {
            assertCurrent();
            return guest.navigationHistory.goForward();
          },
          reload: () => {
            assertCurrent();
            return guest.reload();
          },
          executeJavaScript: (script) => {
            assertCurrent();
            return guest.executeJavaScript(script, true);
          },
        },
        cdp: {
          send: (method, params, sessionId) => {
            try {
              assertCurrent();
              return sendCdpCommand(method, params, sessionId);
            } catch (error) {
              // CDP consumer 会在 abort/terminate 路径上直接调用 .catch；生命周期守卫必须
              // 返回 rejected Promise，不能同步 throw 破坏该清理链路。
              return Promise.reject(error);
            }
          },
        },
        captureViewportScreenshot,
        normalizeScreenshotToCssPixels,
        resizeScreenshotToCssPixels: ctx.resizeScreenshotToCssPixels,
      };
    },

    /**
     * renderer 即将用 React key 替换 `<webview>` 时，先关闭旧 guest 的 native CDP 通路。
     *
     * Electron 的 `render-process-gone` 并非每次都会先到达 main 的 WebContents
     * 监听；renderer 若直接卸载节点，`destroyed` 才到达时已无法调用 debugger.detach()，
     * DevToolsSession 仍可能向已析构 client 派发在途通知并触发主进程 UAF。这里把 DOM 销毁
     * 变成 main ACK 之后的第二阶段，并用 sender window + 当前 guest id 双重校验，避免迟到
     * 的旧代事件断开刚接管 tab 的新 guest。
     */
    async detachGuestBeforeReplacement(
      tabId: string,
      webContentsId: number,
      windowId: number,
    ): Promise<boolean> {
      const tab = ctx.tabs.get(tabId);
      if (!tab) return true;
      if (tab.owner.windowId !== windowId) {
        ctx.log?.(
          `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
            `guestId=${webContentsId} reason=window-mismatch`,
        );
        return false;
      }

      const guest = tab.guest;
      if (!guest) return true;
      const guestIdMatches = safeBool(() => guest.id === webContentsId, false);
      if (!guestIdMatches) {
        ctx.log?.(
          `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
            `guestId=${webContentsId} reason=guest-mismatch`,
        );
        return false;
      }
      if (safeBool(() => guest.isDestroyed(), true)) {
        // destroyed 后 native detach 已经没有安全窗口；只有先前确认过 CDP 已断开才允许换代。
        if (tab.cdpAttached) {
          ctx.log?.(
            `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
              `guestId=${webContentsId} reason=destroyed-with-cdp`,
          );
          return false;
        }
        ctx.detachGuest(tab);
        return true;
      }

      return ctx.beginGuestTeardown(tab, guest, "renderer replacement");
    },

    beginGuestTeardown(tab: ManagedTab, guest: GuestWebContents, reason: string): Promise<boolean> {
      const existing = tab.guestTeardownFlight;
      if (existing) return existing;
      const flight = ctx.runGuestTeardown(tab, guest, reason);
      tab.guestTeardownFlight = flight;
      const clearFlight = () => {
        if (tab.guestTeardownFlight === flight) tab.guestTeardownFlight = undefined;
      };
      void flight.then(clearFlight, clearFlight);
      return flight;
    },

    async runGuestTeardown(
      tab: ManagedTab,
      guest: GuestWebContents,
      reason: string,
    ): Promise<boolean> {
      if (tab.guest !== guest) return !tab.cdpAttached;
      tab.guestLifecycle = "detaching";

      // 先停止新的 request/recording 进入 CDP；已经下发的请求仍由 pendingCdpCommands
      // 计数保护，直到真实 Promise settle。这样外层取消不会把 native command 误判成已结束。
      for (const request of ctx.runningRequests.values()) {
        if (request.tabId !== tab.tabId) continue;
        request.controller.abort(new DOMException(`browser guest ${reason}`, "AbortError"));
      }
      ctx.abortRecordings((entry) => entry.tabId === tab.tabId, `browser guest ${reason}`);

      const pendingAtStart = tab.pendingCdpCommands;
      const settled = await ctx.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
      if (!settled) {
        ctx.warn(
          `browser guest teardown cdp pending timeout tabId=${tab.tabId} ` +
            `pending=${tab.pendingCdpCommands} started=${pendingAtStart} reason=${reason}`,
        );
      }

      // destroyed 事件可能在等待期间先到达；此时 detachGuest 已经完成了 JS 侧收口，但 native
      // detach 只有在 cdpAttached=false 时才可认为安全。
      if (tab.guest !== guest) return !tab.cdpAttached;
      if (safeBool(() => guest.isDestroyed(), true)) {
        if (tab.cdpAttached) {
          ctx.log?.(
            `[browser-use] guest teardown rejected on destroyed guest tabId=${tab.tabId} ` +
              `guestId=${safeStr(() => String(guest.id), "?")}`,
          );
          return false;
        }
        ctx.detachGuest(tab);
        return true;
      }

      try {
        if (guest.debugger.isAttached()) guest.debugger.detach();
        if (guest.debugger.isAttached()) {
          ctx.warn(
            `browser guest replacement cdp detach not confirmed tabId=${tab.tabId} ` +
              `guestId=${safeStr(() => String(guest.id), "?")}`,
          );
          return false;
        }
      } catch (error) {
        // fail closed：detach 失败时保留旧节点，不能用“继续重建”重新打开已知的 native UAF 窗口。
        ctx.warn(
          `browser guest replacement cdp detach failed tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
          error,
        );
        if (tab.guest === guest && !safeBool(() => guest.isDestroyed(), true)) {
          tab.guestLifecycle = "attached";
        }
        return false;
      }

      ctx.log?.(
        `[browser-use] cdp detached before guest replacement tabId=${tab.tabId} ` +
          `guestId=${safeStr(() => String(guest.id), "?")}`,
      );
      tab.cdpAttached = false;
      tab.guestLifecycle = "detached";
      ctx.detachGuest(tab);
      return true;
    },

    async waitForGuestCdpIdle(tab: ManagedTab, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (tab.pendingCdpCommands > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(10, deadline - Date.now())),
        );
      }
      return tab.pendingCdpCommands === 0;
    },

    detachGuest(tab: ManagedTab): void {
      const guest = tab.guest;
      const guestDestroyed = guest ? safeBool(() => guest.isDestroyed(), true) : true;
      if (guest && !ctx.guestRecoveryFlights.has(tab.tabId)) {
        tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
        tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
      }
      ctx.pendingDialogs.delete(tab.tabId);
      try {
        // Electron 会在 renderer 卸载 <webview> 时先销毁 guest；此时 listener 已随对象释放，
        // 再调用 session.removeListener 只会产生无意义的 "Object has been destroyed" 日志。
        if (!guestDestroyed) tab.downloadCleanup?.();
      } catch (error) {
        // guest renderer 被 Chromium 杀死后，旧 session 的 removeListener 也会抛
        // "Object has been destroyed"；清理失败不能阻断替代 guest 的 CDP 重新绑定。
        ctx.log?.(
          `[browser-use] detachGuest download cleanup failed tabId=${tab.tabId} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        tab.downloadCleanup = undefined;
      }
      try {
        if (!guestDestroyed) tab.activityCleanup?.();
      } catch {
        // guest 已销毁时 listener cleanup 可能失败；residency 状态仍需继续收口。
      } finally {
        tab.activityCleanup = undefined;
        tab.loading = false;
        tab.mediaActive = false;
      }
      // 崩溃守卫的注销不能受 guestDestroyed 约束：removeListener 是纯 JS 侧操作，
      // 而这里的 guest 引用在换代场景下往往还活着，漏掉就会让监听随代际累积。
      try {
        tab.crashGuardCleanup?.();
      } catch {
        // guest 已销毁时 removeListener 可能抛 "Object has been destroyed"，不影响收口。
      } finally {
        tab.crashGuardCleanup = undefined;
      }
      // JS 层监听清理：guest 换代/销毁后旧 "message" 监听不该继续挂着。这一步与 native 侧的
      // CDP 断开无关（DevToolsSession 派发不查 JS 监听），纯粹是防止监听随 guest 代际累积。
      const cdpWasAttached = tab.cdpAttached;
      try {
        tab.cdpMessageCleanup?.();
      } catch (error) {
        ctx.log?.(
          `[browser-use] detachGuest cdp message cleanup failed tabId=${tab.tabId} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        tab.cdpMessageCleanup = undefined;
      }
      if (guest) {
        const guestId = safeStr(() => String(guest.id), "?");
        if (guestDestroyed) {
          // guest 先于 detach 被销毁（destroyed 回调 / renderer 卸载 webview）。此时 detach()
          // 必抛且无意义：native DevToolsAgentHost 已随 WebContents 一起收口，主进程只能被动
          // 接受这个结果。而崩溃现场（DevToolsSession::DispatchProtocolNotification 里 client_
          // vptr=0）正落在「CDP 未经主动 detach 就走隐式析构」之后，所以这条路径必须留痕 ——
          // 否则日志里完全看不到它发生过，无法把崩溃与具体 tab 生命周期对上。
          if (cdpWasAttached) {
            ctx.log?.(
              `[browser-use] detachGuest cdp still attached on destroyed guest ` +
                `tabId=${tab.tabId} guestId=${guestId}`,
            );
          }
        } else {
          try {
            if (guest.debugger.isAttached()) guest.debugger.detach();
          } catch (error) {
            // 这里不能静默吞掉：detach 失败与成功在日志上无法区分 —— 而「本该能主动 detach
            // 却失败了」正是需要与崩溃关联的信号。
            ctx.warn(
              `browser guest cdp detach failed tabId=${tab.tabId} guestId=${guestId}`,
              error,
            );
          }
        }
      }
      ctx.clearGuestCdpIdleRelease(tab);
      tab.guest = undefined;
      tab.cdpAttached = false;
      tab.guestLifecycle = guestDestroyed ? "destroyed" : "detached";
      tab.backgroundViewportFallback = undefined;
      tab.viewportMutation = undefined;
      ctx.residencyCoordinator.markDetached(tab.tabId);
      ctx.refreshRuntimeProtection(tab.tabId);
    },
  };
}
