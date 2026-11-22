import type { BrowserGuestContext } from "./browserGuestContext.js";
import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import type { ControlledView } from "./browserCommandExecutor.js";
import { executeBrowserCommandOnView } from "./browserCommandExecutor.js";
import type { BrowserScreenshotSurfaceLease } from "./browserScreenshotSurfaceCoordinator.js";
import type { TransparentWindowBootstrap } from "./browserTransparentWindowBootstrap.js";
import {
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  startBrowserScreenshotTransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";
import type {
  InternalExecutionContext,
  ManagedTab,
  GuestWebContents,
  RunningRequest,
  InFlightScreenshot,
} from "./browserGuestTypes.js";
import { HIDDEN_WINDOW_CAPTURE_DEADLINE_MS } from "./browserGuestTypes.js";
import {
  readScreenshotSurfaceInvalidation,
  buildViewportMetricsOverride,
  waitForDelay,
} from "./browserGuestUtils.js";

export function createBrowserGuestScreenshots(
  ctx: BrowserGuestContext,
): Pick<
  BrowserGuestContext,
  | "executeScreenshotWithPreparedSurface"
  | "startHiddenWindowCapturePresentation"
  | "settleScreenshotCapture"
  | "abandonBackendCapture"
  | "releaseAbandonedBackendCapture"
  | "isInFlightScreenshotAlive"
> {
  return {
    /**
     * renderer 的 logical viewport ready 只能证明 CSS 坐标系正确；Windows 负缩放
     * 下 Fit 预览仍可能只有 800×450 raster，CDP 会把它平铺为 1280×720。main 直接读取
     * 已合成的 guest surface，再归一化到逻辑 viewport；这不走曾触发 V8 FATAL 的 renderer
     * `<webview>.capturePage()` 调用，也不改变页面布局、DPR 或交互态 metrics。
     */
    async executeScreenshotWithPreparedSurface(
      context: InternalExecutionContext,
      tab: ManagedTab,
      guest: GuestWebContents,
      command: BrowserCommand,
      running: RunningRequest,
      startedAt: number,
      assertCurrentGuest: () => void,
      sendCdpCommand: ControlledView["cdp"]["send"],
    ): Promise<BrowserCommandResult> {
      let lease: BrowserScreenshotSurfaceLease | undefined;
      try {
        const screenshotSurfaceCoordinator = ctx.screenshotSurfaceCoordinator;
        if (!screenshotSurfaceCoordinator) {
          throw new Error("browser screenshot surface coordinator is unavailable");
        }
        const viewport = await ctx.readTabViewport(tab);
        let result: BrowserCommandResult | undefined;

        // 不能先 acquire activity、再排队 viewport mutation：前序 resize/CDP 卡住时，
        // owner + guest 会在队列外背靠背 capture，最长烧满 35s。surface 准备必须在轮到本次
        // viewport 临界区之后才开始，确保 activity 只覆盖真实 prepare + raster 生命周期。
        await ctx.enqueueViewportMutation(tab, async () => {
          lease = await screenshotSurfaceCoordinator.prepare({
            requestId: context.requestId,
            windowId: context.windowId,
            workspaceKey: context.workspaceKey,
            sessionId: context.sessionId,
            browserId: context.browserId,
            browserGeneration: context.browserGeneration,
            tabId: tab.tabId,
            webContentsId: guest.id,
            viewport,
            // 自然 viewport 未安装 metrics；不能让 renderer 的临时 Fit 扩张 guest 布局并触发网页重排。
            viewportMode:
              tab.viewportOverride || tab.backgroundViewportFallback ? "emulated" : "natural",
            signal: running.controller.signal,
          });
          if (
            running.controller.signal.aborted ||
            tab.guest !== guest ||
            guest.isDestroyed() ||
            lease.webContentsId !== guest.id
          ) {
            throw new Error("browser guest changed while preparing screenshot surface");
          }
          const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
          if (invalidationError) throw invalidationError;
          // 普通 fallback 也使用临时 responsive surface；idle detach 后先在同一 mutation 内重装 metrics。
          if (
            tab.backgroundViewportFallback &&
            (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight)
          ) {
            await ctx.sendGuestCdpCommand(
              tab,
              guest,
              "Emulation.setDeviceMetricsOverride",
              buildViewportMetricsOverride(tab.backgroundViewportFallback),
            );
          }
          const normalizedScreenshot = Boolean(
            tab.viewportOverride || tab.backgroundViewportFallback,
          );
          // Windows 125% 显示缩放 + Desktop 110% 时，renderer 即使上报
          // surfaceScale=1，CDP 仍会把较小的 native raster 周期平铺成目标尺寸。
          // Desktop 放大时的 viewport 截图也读取实际 surface，再统一归一为 CSS px。
          const captureViewportScreenshot =
            normalizedScreenshot &&
            (lease.surfaceScale < 0.999 || (guest.hostWebContents?.getZoomFactor() ?? 1) > 1)
              ? async (): Promise<string | undefined> => {
                  if (!ctx.resizeScreenshotToCssPixels) {
                    throw new Error("browser screenshot CSS pixel normalizer is unavailable");
                  }
                  const surface = await guest.capturePage();
                  const surfacePng = surface.toPNG();
                  if (surfacePng.byteLength === 0) return undefined;
                  return ctx.resizeScreenshotToCssPixels(surfacePng.toString("base64"), viewport);
                }
              : undefined;
          running.dispatched = true;
          // owner 窗口隐藏（关闭到托盘）后 Windows 合成器不再为 guest 合成任何
          // 帧；prepare 阶段的透明 bootstrap 又在 renderer ready 时提前释放，整幅 capture
          // 只能等用户重新打开窗口才拿得到帧（日志里仅在 tray-show 后约 140ms
          // 完成，其余全部 30s watchdog 判死）。capture 生命周期内临时持有透明 presentation
          // （showInactive + opacity 0，用户不可见）主动要帧；同时 capture 结算必须竞速
          // abort/有界 deadline——悬空的 execution 会把 viewport mutation 队列和 in-flight
          // 槽位一起拖死，mutation 绝不能比请求本身活得更久。
          const capturePresentation = ctx.startHiddenWindowCapturePresentation(context, guest);
          try {
            // 与 activity pump 同一约束：showInactive 后 Viz surface 建立前同 turn 读回会抛
            // UnknownVizError。先等统一的有界 presentation grace 再发起 capture——归一化
            // 路径（后台 tab）的 guest.capturePage() 对此同样敏感。
            if (
              capturePresentation &&
              !(await waitForDelay(
                TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
                running.controller.signal,
              ))
            ) {
              throw new Error("browser screenshot capture cancelled during presentation grace");
            }
            // native capture 不经过 sendCdpCommand，也必须等待 idle detach 后的 metrics 恢复。
            if (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight) {
              await ctx.ensureGuestCdpAttached(tab, guest);
            }
            const captureExecution = executeBrowserCommandOnView(
              ctx.toControlledView(
                guest,
                normalizedScreenshot,
                captureViewportScreenshot,
                assertCurrentGuest,
                sendCdpCommand,
              ),
              command,
              { signal: running.controller.signal },
            );
            result = await ctx.settleScreenshotCapture(
              captureExecution,
              running.controller.signal,
              context,
              startedAt,
              tab.tabId,
              capturePresentation ? HIDDEN_WINDOW_CAPTURE_DEADLINE_MS : undefined,
            );
          } finally {
            capturePresentation?.release();
          }
          const lateInvalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
          if (lateInvalidationError) throw lateInvalidationError;
        });
        if (!result) throw new Error("browser screenshot did not produce a result");
        return result;
      } catch (error) {
        const cancelled = running.controller.signal.aborted;
        return {
          ok: false,
          error: {
            code: cancelled ? "cancelled" : "backend_unavailable",
            message: cancelled
              ? "browser screenshot surface preparation cancelled"
              : error instanceof Error
                ? error.message
                : String(error),
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        };
      } finally {
        lease?.release();
      }
    },

    /** 窗口隐藏时为整幅 capture 建立一次性透明 presentation；窗口可见或能力未注入时为 no-op。 */
    startHiddenWindowCapturePresentation(
      context: InternalExecutionContext,
      guest: GuestWebContents,
    ): TransparentWindowBootstrap | undefined {
      if (!ctx.resolveOwnerWindow) return undefined;
      const win = ctx.resolveOwnerWindow(context.windowId);
      if (!win) return undefined;
      return (
        startBrowserScreenshotTransparentWindowBootstrap({
          win,
          enabled: true,
          windowId: context.windowId,
          webContentsId: guest.id,
          requestId: context.requestId,
          hideTaskbarDuringBootstrap: process.platform === "win32",
          log: ctx.log,
        }) || undefined
      );
    },

    /**
     * capture 结算的统一出口：execution、请求 abort、可选的有界 deadline 三者先到先结算。
     * 隐藏窗口等帧、上游 30s cancelRequest 等场景下 execution 可能永不落定；不等它，
     * 保证 viewport mutation 队列和 in-flight 槽位随请求一起释放。abort/deadline 先胜时
     * 底层 CDP command 仍在 Chromium 内 pending，计入 abandonedScreenshotCaptures 硬上限。
     */
    async settleScreenshotCapture(
      execution: Promise<BrowserCommandResult>,
      signal: AbortSignal,
      context: InternalExecutionContext,
      startedAt: number,
      tabId: string,
      deadlineMs?: number,
    ): Promise<BrowserCommandResult> {
      return await new Promise<BrowserCommandResult>((resolve) => {
        let settled = false;
        const finish = (result: BrowserCommandResult): boolean => {
          if (settled) return false;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(result);
          return true;
        };
        const onAbort = () => {
          if (
            finish({
              ok: false,
              error: {
                code: "cancelled",
                message: "browser screenshot capture cancelled",
                sideEffect: "none",
              },
              elapsedMs: Date.now() - startedAt,
            })
          ) {
            ctx.abandonBackendCapture(tabId, execution);
          }
        };
        const timer =
          deadlineMs !== undefined
            ? setTimeout(() => {
                ctx.log?.(
                  `[browser-use] hidden window capture deadline exceeded requestId=${context.requestId} windowId=${context.windowId} deadlineMs=${deadlineMs}`,
                );
                if (
                  finish({
                    ok: false,
                    error: {
                      code: "timeout",
                      message: `browser screenshot capture timed out after ${deadlineMs}ms while the window was hidden`,
                      sideEffect: "none",
                    },
                    elapsedMs: Date.now() - startedAt,
                  })
                ) {
                  ctx.abandonBackendCapture(tabId, execution);
                }
              }, deadlineMs)
            : undefined;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        execution.then(finish, (error: unknown) =>
          finish({
            ok: false,
            error: {
              code: "execution_error",
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: Date.now() - startedAt,
          }),
        );
      });
    },

    /** 记一笔“已放弃等待但底层仍在执行”的 capture；真实落定后名额自动回收。 */
    abandonBackendCapture(tabId: string, execution: Promise<BrowserCommandResult>): void {
      ctx.abandonedScreenshotCaptures.set(
        tabId,
        (ctx.abandonedScreenshotCaptures.get(tabId) ?? 0) + 1,
      );
      execution.then(
        () => ctx.releaseAbandonedBackendCapture(tabId),
        () => ctx.releaseAbandonedBackendCapture(tabId),
      );
    },

    releaseAbandonedBackendCapture(tabId: string): void {
      const count = ctx.abandonedScreenshotCaptures.get(tabId);
      if (count === undefined) return;
      if (count <= 1) ctx.abandonedScreenshotCaptures.delete(tabId);
      else ctx.abandonedScreenshotCaptures.set(tabId, count - 1);
    },

    /**
     * 挂起截图是否仍存活：对应命令还在执行中（runningRequests 里有未 abort 的条目）。
     * 条目已消失说明命令早已返回（典型为 30s watchdog 判死）而 execution 悬空——死槽位。
     */
    isInFlightScreenshotAlive(tracked: InFlightScreenshot): boolean {
      const running = ctx.runningRequests.get(tracked.requestId);
      return running !== undefined && !running.controller.signal.aborted;
    },
  };
}
