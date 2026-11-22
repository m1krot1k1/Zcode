import type { BrowserGuestContext } from "./browserGuestContext.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type {
  BrowserRecordingJob,
  BrowserRecordingOptions,
  BrowserViewportSize,
  BrowserRecordingAction,
  BrowserCommand,
} from "@zcode/shared";
import { DEFAULT_AGENT_BROWSER_VIEWPORT } from "@zcode/shared";
import type { ControlledView } from "./browserCommandExecutor.js";
import { executeBrowserCommandOnView } from "./browserCommandExecutor.js";
import { executeIabPlaywrightLocator } from "./browserPlaywrightLocatorExecutor.js";
import { recordBrowserVideo } from "./browserVideoRecorder.js";
import type { BrowserScreenshotSurfaceLease } from "./browserScreenshotSurfaceCoordinator.js";
import type {
  InternalExecutionContext,
  ManagedTab,
  BrowserRecordingEntry,
  GuestWebContents,
} from "./browserGuestTypes.js";
import { RECORDING_RESULT_TTL_MS } from "./browserGuestTypes.js";
import {
  assertViewportOverride,
  readScreenshotSurfaceInvalidation,
  safeBool,
  waitForDelay,
  abortError,
  isBrowserPointValue,
} from "./browserGuestUtils.js";

export function createBrowserGuestRecording(
  ctx: BrowserGuestContext,
): Pick<
  BrowserGuestContext,
  | "recordingNow"
  | "createRecordingEntry"
  | "snapshotRecording"
  | "setRecordingPhase"
  | "setRecordingTerminal"
  | "abortRecordings"
  | "runRecording"
  | "restoreRecordingViewport"
  | "executeRecordingActions"
  | "executeRecordingAction"
  | "executeRecordingBrowserCommand"
  | "resolveRecordingSelectorPoint"
  | "resolveRecordingSelectorScrollTarget"
  | "moveRecordingPointer"
  | "installRecordingCursorOverlay"
  | "removeRecordingCursorOverlay"
  | "animateRecordingScroll"
> {
  return {
    recordingNow(): number {
      return ctx.residencyOptions.recording?.now?.() ?? Date.now();
    },

    createRecordingEntry(
      context: InternalExecutionContext,
      tab: ManagedTab,
    ): BrowserRecordingEntry {
      const now = ctx.recordingNow();
      return {
        id: `iab-recording:${randomUUID()}`,
        context: { ...context },
        tabId: tab.tabId,
        controller: new AbortController(),
        status: "running",
        phase: "preparing",
        progress: 0,
        startedAt: now,
        updatedAt: now,
      };
    },

    snapshotRecording(entry: BrowserRecordingEntry): BrowserRecordingJob {
      return {
        id: entry.id,
        status: entry.status,
        phase: entry.phase,
        progress: entry.progress,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        ...(entry.artifact ? { artifact: { ...entry.artifact } } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      };
    },

    setRecordingPhase(
      entry: BrowserRecordingEntry,
      phase: Extract<BrowserRecordingJob["phase"], "capturing" | "finalizing">,
    ): void {
      if (entry.status !== "running") return;
      entry.phase = phase;
      entry.progress = phase === "capturing" ? 0.1 : 0.9;
      entry.updatedAt = ctx.recordingNow();
      ctx.refreshRuntimeProtection(entry.tabId);
    },

    setRecordingTerminal(
      entry: BrowserRecordingEntry,
      status: Extract<BrowserRecordingJob["status"], "completed" | "failed" | "cancelled">,
      error?: string,
    ): void {
      entry.status = status;
      entry.phase = status;
      entry.progress = status === "completed" ? 1 : entry.progress;
      entry.updatedAt = ctx.recordingNow();
      if (error) entry.error = error;
      else delete entry.error;
      if (!entry.cleanupTimer) {
        entry.cleanupTimer = setTimeout(() => {
          ctx.recordings.delete(entry.id);
          if (entry.artifact?.path) {
            void rm(entry.artifact.path, { force: true }).catch(() => undefined);
          }
        }, RECORDING_RESULT_TTL_MS);
        entry.cleanupTimer.unref?.();
      }
      ctx.refreshRuntimeProtection(entry.tabId);
    },

    abortRecordings(predicate: (entry: BrowserRecordingEntry) => boolean, reason: string): void {
      for (const entry of ctx.recordings.values()) {
        if (entry.status !== "running" || !predicate(entry)) continue;
        entry.controller.abort(new DOMException(reason, "AbortError"));
        ctx.setRecordingTerminal(entry, "cancelled");
      }
    },

    async runRecording(
      entry: BrowserRecordingEntry,
      tab: ManagedTab,
      rawOptions?: BrowserRecordingOptions,
    ): Promise<void> {
      const signal = entry.controller.signal;
      const options = rawOptions ?? {};
      const viewport = options.viewport ?? DEFAULT_AGENT_BROWSER_VIEWPORT;
      const fps = options.fps ?? 25;
      const maxDurationMs = options.maxDurationMs ?? 60_000;
      const settleMs = options.settleMs ?? 300;
      assertViewportOverride(viewport);

      const guest = await ctx.ensureGuest(tab, signal);
      if (!guest || guest.isDestroyed()) throw new Error("browser guest unavailable for recording");
      // 录制会临时改写 tab viewport override 去换取 100% surface；先记下录制前的值。
      const previousViewport = tab.viewportOverride ? { ...tab.viewportOverride } : undefined;
      let lease: BrowserScreenshotSurfaceLease | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await ctx.setTabViewport(tab, viewport);
        // 只改 CDP metrics 不会同步 renderer 中承载 WebView 的自由尺寸 frame；自定义录制
        // viewport 会继续使用旧 DOM bounds，最终要么 prepare 超时，要么从缩小表面放大而变模糊。
        ctx.onViewportChanged?.(viewport, tab.owner, tab.tabId);
        const coordinator = ctx.screenshotSurfaceCoordinator;
        if (!coordinator) throw new Error("browser recording surface coordinator is unavailable");
        lease = await coordinator.prepare({
          requestId: `recording:${entry.id}`,
          windowId: entry.context.windowId,
          workspaceKey: entry.context.workspaceKey,
          sessionId: entry.context.sessionId,
          browserId: entry.context.browserId,
          browserGeneration: entry.context.browserGeneration,
          tabId: tab.tabId,
          webContentsId: guest.id,
          viewport,
          surfaceScaleMode: "unscaled",
          signal,
          activityTimeoutMs: maxDurationMs + 30_000,
        });
        if (!lease || lease.webContentsId !== guest.id) {
          throw new Error("browser guest changed while preparing recording surface");
        }
        const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (invalidationError) throw invalidationError;
        const invalidateRecording = () =>
          entry.controller.abort(
            lease?.invalidated?.reason instanceof Error
              ? lease.invalidated.reason
              : new Error("browser recording surface invalidated"),
          );
        lease.invalidated?.addEventListener("abort", invalidateRecording, { once: true });
        timeout = setTimeout(
          () =>
            entry.controller.abort(new DOMException("browser recording timed out", "TimeoutError")),
          maxDurationMs,
        );
        const guestGeneration = tab.guestGeneration;
        const assertCurrentGuest = (): void => {
          if (tab.guestLifecycle === "detaching") {
            throw new Error("browser guest is detaching");
          }
          if (
            tab.guest !== guest ||
            tab.guestGeneration !== guestGeneration ||
            safeBool(() => guest.isDestroyed(), true)
          ) {
            throw new Error("browser guest changed before recording dispatch");
          }
        };
        const view = ctx.toControlledView(
          guest,
          true,
          undefined,
          assertCurrentGuest,
          (method, params, sessionId) =>
            ctx.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest),
        );
        if (options.showCursor !== false) await ctx.installRecordingCursorOverlay(guest);
        const createRecorder = ctx.residencyOptions.recording?.createRecorder;
        if (!createRecorder) throw new Error("browser WebM recorder is unavailable");
        entry.artifact = await recordBrowserVideo({
          targetFrame: guest.mainFrame,
          tempRoot: ctx.residencyOptions.recording?.tempRoot ?? tmpdir(),
          recordingId: entry.id.replace(/[^A-Za-z0-9._-]/gu, "-"),
          viewport,
          fps,
          signal,
          onPhase: (phase) => ctx.setRecordingPhase(entry, phase),
          onCaptureComplete: () => {
            // maxDurationMs 只约束页面取景；编码是收尾阶段，不能把一段已完整拍下的视频误杀掉。
            if (timeout) {
              clearTimeout(timeout);
              timeout = undefined;
            }
            lease?.release();
          },
          executeScenario: async () => {
            if (settleMs > 0 && !(await waitForDelay(settleMs, signal))) throw abortError();
            await ctx.executeRecordingActions(view, options.actions ?? [], signal, viewport);
          },
          createRecorder,
        });
        ctx.setRecordingTerminal(entry, "completed");
      } finally {
        if (timeout) clearTimeout(timeout);
        if (options.showCursor !== false) await ctx.removeRecordingCursorOverlay(guest);
        // lease.release() 只收回瞬时 surface 比例，tab 自己的 viewport override 会
        // 留在录制尺寸上，之后的预览与截图都按录制 viewport 走。录制是临时借用，必须还原。
        await ctx.restoreRecordingViewport(tab, previousViewport).catch(() => undefined);
        lease?.release();
      }
    },

    /** 把录制期间临时改写的 tab viewport 交还给录制前的状态。 */
    async restoreRecordingViewport(
      tab: ManagedTab,
      previous: BrowserViewportSize | undefined,
    ): Promise<void> {
      if (tab.lifecycle === "closed") return;
      if (previous) {
        await ctx.setTabViewport(tab, previous);
        ctx.onViewportChanged?.(previous, tab.owner, tab.tabId);
        return;
      }
      await ctx.resetTabViewport(tab);
      ctx.onViewportChanged?.(null, tab.owner, tab.tabId);
    },

    async executeRecordingActions(
      view: ControlledView,
      actions: BrowserRecordingAction[],
      signal: AbortSignal,
      viewport: BrowserViewportSize,
    ): Promise<void> {
      const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
      for (const action of actions) {
        if (signal.aborted) throw abortError();
        await ctx.executeRecordingAction(view, action, signal, pointer);
        const delayAfterMs = "delayAfterMs" in action ? action.delayAfterMs : undefined;
        if (delayAfterMs && !(await waitForDelay(delayAfterMs, signal))) throw abortError();
      }
    },

    async executeRecordingAction(
      view: ControlledView,
      action: BrowserRecordingAction,
      signal: AbortSignal,
      pointer: { x: number; y: number },
    ): Promise<void> {
      if (action.type === "wait") {
        if (!(await waitForDelay(action.durationMs, signal))) throw abortError();
        return;
      }
      if (action.type === "click" || action.type === "type" || action.type === "waitFor") {
        const locatorAction =
          action.type === "click"
            ? action.selector
              ? {
                  name: "locator" as const,
                  selector: action.selector,
                  operation: action.doubleClick ? ("dblclick" as const) : ("click" as const),
                  ...(action.button ? { button: action.button } : {}),
                }
              : undefined
            : action.type === "type"
              ? {
                  name: "locator" as const,
                  selector: action.selector,
                  operation: "fill" as const,
                  value: action.text,
                }
              : {
                  name: "locator" as const,
                  selector: action.selector,
                  operation: "waitFor" as const,
                  state: action.state ?? "visible",
                };
        if (locatorAction) {
          const result = await executeIabPlaywrightLocator(
            view,
            locatorAction,
            action.type === "waitFor" ? (action.timeoutMs ?? 3_000) : 3_000,
            signal,
          );
          if (result.kind === "cancelled") throw abortError();
          if (result.kind === "timeout")
            throw new Error(`recording action timed out: ${result.reason}`);
          return;
        }
        if (action.type !== "click") {
          throw new Error(`recording ${action.type} requires a selector`);
        }
        if (typeof action.x !== "number" || typeof action.y !== "number") {
          throw new Error("recording click requires selector or (x,y)");
        }
        await ctx.executeRecordingBrowserCommand(view, {
          method: "click",
          x: action.x,
          y: action.y,
          ...(action.button ? { button: action.button } : {}),
          ...(action.doubleClick !== undefined ? { doubleClick: action.doubleClick } : {}),
        });
        pointer.x = action.x;
        pointer.y = action.y;
        return;
      }
      if (action.type === "hover") {
        if (action.selector) {
          const point = await ctx.resolveRecordingSelectorPoint(view, action.selector, signal);
          await ctx.moveRecordingPointer(
            view,
            point.x,
            point.y,
            action.durationMs ?? 0,
            signal,
            pointer,
          );
        } else if (typeof action.x === "number" && typeof action.y === "number") {
          await ctx.moveRecordingPointer(
            view,
            action.x,
            action.y,
            action.durationMs ?? 0,
            signal,
            pointer,
          );
        } else {
          throw new Error("recording hover requires selector or (x,y)");
        }
        return;
      }
      if (action.type === "move") {
        await ctx.moveRecordingPointer(
          view,
          action.x,
          action.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
        return;
      }
      if (action.type === "scroll") {
        await ctx.animateRecordingScroll(
          view,
          action.deltaX ?? 0,
          action.deltaY,
          action.durationMs ?? 0,
          signal,
        );
        return;
      }
      if (action.type === "scrollTo") {
        const current = (await view.webContents.executeJavaScript(
          "({ x: window.scrollX, y: window.scrollY })",
        )) as { x?: unknown; y?: unknown };
        const target = action.selector
          ? await ctx.resolveRecordingSelectorScrollTarget(view, action.selector, signal)
          : { x: action.x ?? Number(current.x ?? 0), y: action.y ?? Number(current.y ?? 0) };
        await ctx.animateRecordingScroll(
          view,
          target.x - Number(current.x ?? 0),
          target.y - Number(current.y ?? 0),
          action.durationMs ?? 0,
          signal,
        );
        return;
      }
      if (action.type === "wheel") {
        const times = action.times ?? 1;
        for (let index = 0; index < times; index += 1) {
          await ctx.executeRecordingBrowserCommand(view, {
            method: "scroll",
            x: action.deltaX ?? 0,
            y: action.deltaY,
          });
          if (action.intervalMs && !(await waitForDelay(action.intervalMs, signal)))
            throw abortError();
        }
        return;
      }
      if (action.type === "drag") {
        const steps = Math.max(1, action.path.length - 1);
        const intervalMs = Math.floor((action.durationMs ?? 0) / steps);
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: action.path[0]!.x,
          y: action.path[0]!.y,
        });
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: action.path[0]!.x,
          y: action.path[0]!.y,
          button: "left",
          clickCount: 1,
        });
        for (const point of action.path.slice(1)) {
          await view.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "left",
            buttons: 1,
          });
          if (intervalMs > 0 && !(await waitForDelay(intervalMs, signal))) throw abortError();
        }
        const last = action.path.at(-1)!;
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: last.x,
          y: last.y,
          button: "left",
          clickCount: 1,
        });
        pointer.x = last.x;
        pointer.y = last.y;
      }
    },

    async executeRecordingBrowserCommand(
      view: ControlledView,
      command: BrowserCommand,
    ): Promise<void> {
      const result = await executeBrowserCommandOnView(view, command);
      if (!result.ok)
        throw new Error(result.error?.message ?? `recording action ${command.method} failed`);
    },

    async resolveRecordingSelectorPoint(
      view: ControlledView,
      selector: string,
      signal: AbortSignal,
    ): Promise<{ x: number; y: number }> {
      const result = await executeIabPlaywrightLocator(
        view,
        {
          name: "locator",
          selector,
          operation: "evaluate",
          expressionKind: "function",
          expression:
            "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
        },
        3_000,
        signal,
      );
      if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
        throw new Error(`recording selector '${selector}' has no visible point`);
      }
      return result.value;
    },

    async resolveRecordingSelectorScrollTarget(
      view: ControlledView,
      selector: string,
      signal: AbortSignal,
    ): Promise<{ x: number; y: number }> {
      const result = await executeIabPlaywrightLocator(
        view,
        {
          name: "locator",
          selector,
          operation: "evaluate",
          expressionKind: "function",
          expression:
            "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
        },
        3_000,
        signal,
      );
      if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
        throw new Error(`recording selector '${selector}' has no scroll target`);
      }
      return result.value;
    },

    async moveRecordingPointer(
      view: ControlledView,
      x: number,
      y: number,
      durationMs: number,
      signal: AbortSignal,
      pointer: { x: number; y: number },
    ): Promise<void> {
      const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
      const startX = pointer.x;
      const startY = pointer.y;
      for (let index = 1; index <= steps; index += 1) {
        if (signal.aborted) throw abortError();
        const progress = index / steps;
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: startX + (x - startX) * progress,
          y: startY + (y - startY) * progress,
        });
        if (durationMs > 0 && index < steps && !(await waitForDelay(durationMs / steps, signal))) {
          throw abortError();
        }
      }
      pointer.x = x;
      pointer.y = y;
    },

    async installRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
      await guest.executeJavaScript(`(() => {
          const id = "__zcode_browser_recording_cursor";
          document.getElementById(id)?.remove();
          const cursor = document.createElement("div");
          cursor.id = id;
          cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity 80ms linear";
          document.documentElement.appendChild(cursor);
          const move = (event) => {
            cursor.style.left = event.clientX + "px";
            cursor.style.top = event.clientY + "px";
            cursor.style.opacity = "1";
          };
          const down = () => {
            cursor.style.transform = "translate(-50%,-50%) scale(.72)";
          };
          const up = () => {
            cursor.style.transform = "translate(-50%,-50%) scale(1)";
          };
          window["__zcodeBrowserRecordingCursorCleanup"]?.();
          window.addEventListener("mousemove", move, true);
          window.addEventListener("mousedown", down, true);
          window.addEventListener("mouseup", up, true);
          window["__zcodeBrowserRecordingCursorCleanup"] = () => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mousedown", down, true);
            window.removeEventListener("mouseup", up, true);
            cursor.remove();
            delete window["__zcodeBrowserRecordingCursorCleanup"];
          };
        })()`);
    },

    async removeRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
      if (guest.isDestroyed()) return;
      await guest
        .executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()')
        .catch(() => undefined);
    },

    async animateRecordingScroll(
      view: ControlledView,
      deltaX: number,
      deltaY: number,
      durationMs: number,
      signal: AbortSignal,
    ): Promise<void> {
      const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
      for (let index = 0; index < steps; index += 1) {
        await ctx.executeRecordingBrowserCommand(view, {
          method: "scroll",
          x: deltaX / steps,
          y: deltaY / steps,
        });
        if (
          durationMs > 0 &&
          index + 1 < steps &&
          !(await waitForDelay(durationMs / steps, signal))
        ) {
          throw abortError();
        }
      }
    },
  };
}
