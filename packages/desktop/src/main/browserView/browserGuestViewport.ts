import type { BrowserGuestContext } from "./browserGuestContext.js";
import type { BrowserViewportSize } from "@zcode/shared";
import type { ManagedTab } from "./browserGuestTypes.js";
import {
  assertViewportOverride,
  buildViewportMetricsOverride,
  isBrowserViewportSize,
} from "./browserGuestUtils.js";

export function createBrowserGuestViewport(
  ctx: BrowserGuestContext,
): Pick<
  BrowserGuestContext,
  | "updateViewportFromRenderer"
  | "applyViewportOverride"
  | "setTabViewport"
  | "resetTabViewport"
  | "applyBackgroundViewportFallback"
  | "maybeRestoreBackgroundViewport"
  | "restoreNaturalViewportAfterBackground"
  | "enqueueViewportMutation"
> {
  return {
    /** Renderer 自由尺寸交互回写；发送方窗口由 IPC 层绑定，不能跨窗口修改其它 tab。 */
    async updateViewportFromRenderer(
      tabId: string,
      viewport: BrowserViewportSize | null,
      windowId: number,
    ): Promise<void> {
      const tab = ctx.tabs.get(tabId);
      if (!tab || tab.lifecycle === "closed" || tab.owner.windowId !== windowId) {
        throw new Error(`browser tab '${tabId}' is unavailable for viewport update`);
      }
      if (viewport) {
        assertViewportOverride(viewport);
        await ctx.setTabViewport(tab, viewport);
        return;
      }
      await ctx.resetTabViewport(tab);
    },

    applyViewportOverride(tab: ManagedTab): void {
      const viewport = tab.viewportOverride;
      if (!viewport) return;
      void ctx.setTabViewport(tab, viewport).catch((error: unknown) => {
        ctx.log?.(`[browser-use] viewport apply failed tabId=${tab.tabId}: ${String(error)}`);
      });
    },

    async setTabViewport(tab: ManagedTab, viewport: BrowserViewportSize): Promise<void> {
      assertViewportOverride(viewport);
      if (tab.lifecycle === "closed") return;
      tab.backgroundViewportFallback = undefined;
      tab.viewportOverride = { ...viewport };
      if (!tab.guest) return;
      const guest = tab.guest;
      await ctx.enqueueViewportMutation(tab, async () => {
        if (tab.guest !== guest || tab.lifecycle === "closed") return;
        await ctx.sendGuestCdpCommand(
          tab,
          guest,
          "Emulation.setDeviceMetricsOverride",
          buildViewportMetricsOverride(viewport),
        );
      });
    },

    async resetTabViewport(tab: ManagedTab): Promise<void> {
      if (tab.lifecycle === "closed") return;
      tab.viewportOverride = undefined;
      tab.backgroundViewportFallback = undefined;
      if (!tab.guest) return;
      const guest = tab.guest;
      await ctx.enqueueViewportMutation(tab, async () => {
        if (tab.guest !== guest || tab.lifecycle === "closed") return;
        await ctx.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
      });
    },

    async applyBackgroundViewportFallback(
      tab: ManagedTab,
      viewport: BrowserViewportSize,
    ): Promise<void> {
      const guest = tab.guest;
      if (!guest || tab.lifecycle === "closed") {
        throw new Error(`browser tab '${tab.tabId}' has no readable viewport`);
      }
      const fallback = { ...viewport };
      tab.backgroundViewportFallback = fallback;
      try {
        await ctx.enqueueViewportMutation(tab, async () => {
          if (
            tab.guest !== guest ||
            tab.lifecycle === "closed" ||
            tab.backgroundViewportFallback !== fallback ||
            tab.viewportOverride
          ) {
            return;
          }
          await ctx.sendGuestCdpCommand(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(fallback),
          );
        });
      } catch (error) {
        if (tab.backgroundViewportFallback === fallback) {
          tab.backgroundViewportFallback = undefined;
        }
        throw error;
      }
    },

    /**
     * 前台激活路径的统一收口：后台 fallback viewport 不能在 tab 回到前台后残留。
     * 仅在 attachGuest({active:true}) 时清除是不够的：guest 存活期间的前台切换
     * （activateTab / claim / renderer residency 上报）不会重新 attach，页面就永久钉死在
     * 后台尺寸。restoreNaturalViewportAfterBackground 自带幂等守卫与串行 mutation 队列，
     * 多个前台信号重复触发是安全的。
     */
    maybeRestoreBackgroundViewport(tab: ManagedTab): void {
      if (tab.lifecycle === "closed" || !tab.backgroundViewportFallback) return;
      ctx.restoreNaturalViewportAfterBackground(tab);
    },

    restoreNaturalViewportAfterBackground(tab: ManagedTab): void {
      const fallback = tab.backgroundViewportFallback;
      const guest = tab.guest;
      if (!fallback || tab.viewportOverride || !guest) return;
      void ctx
        .enqueueViewportMutation(tab, async () => {
          if (
            tab.guest !== guest ||
            tab.lifecycle === "closed" ||
            tab.backgroundViewportFallback !== fallback ||
            tab.viewportOverride
          ) {
            return;
          }
          await ctx.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
          if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
          const value = await guest.executeJavaScript(
            "({ width: window.innerWidth, height: window.innerHeight })",
          );
          if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
          if (isBrowserViewportSize(value)) {
            ctx.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
            tab.backgroundViewportFallback = undefined;
            return;
          }
          // active=true 已到达但 Chromium 尚未完成可见布局时，继续保留 transient；下一次
          // renderer 可见 attach 或 viewport 读取仍可恢复，不能短暂退回 0×0。
          await ctx.sendGuestCdpCommand(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(fallback),
          );
        })
        .catch((error: unknown) => {
          ctx.log?.(
            `[browser-use] background viewport restore failed tabId=${tab.tabId}: ${String(error)}`,
          );
        });
    },

    enqueueViewportMutation(tab: ManagedTab, mutation: () => Promise<void>): Promise<void> {
      const previous = tab.viewportMutation ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(async () => {
          // CDP 恢复据此在当前临界区直接重放，避免二次入队后等待自己。
          tab.insideViewportMutation = true;
          try {
            await mutation();
          } finally {
            tab.insideViewportMutation = false;
          }
        });
      tab.viewportMutation = current;
      current.then(
        () => {
          if (tab.viewportMutation === current) tab.viewportMutation = undefined;
        },
        () => {
          if (tab.viewportMutation === current) tab.viewportMutation = undefined;
        },
      );
      return current;
    },
  };
}
