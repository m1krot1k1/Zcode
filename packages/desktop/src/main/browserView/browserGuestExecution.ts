import type { BrowserGuestContext } from "./browserGuestContext.js";
import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import { executeBrowserCommandOnView } from "./browserCommandExecutor.js";
import { normalizePlaywrightTimeout } from "./browserPlaywrightTimeout.js";
import type {
  BrowserGuestExecutionContext,
  RunningRequest,
  InternalExecutionContext,
  InFlightScreenshot,
} from "./browserGuestTypes.js";
import {
  TAB_CONTEXT_RECOVERY_HINT,
  MAX_ABANDONED_SCREENSHOT_CAPTURES,
} from "./browserGuestTypes.js";
import {
  normalizeLegacyContext,
  linkAbortSignal,
  scopeKey,
  sameScope,
  safeBool,
  waitForDelay,
  waitForCondition,
  raceBackendExecution,
  isScreenshotCommand,
} from "./browserGuestUtils.js";

export function createBrowserGuestExecution(
  ctx: BrowserGuestContext,
): Pick<BrowserGuestContext, "execute" | "executeInScope"> {
  return {
    async execute(
      contextOrKey: BrowserGuestExecutionContext | string,
      command: BrowserCommand,
      signal?: AbortSignal,
    ): Promise<BrowserCommandResult> {
      const context =
        typeof contextOrKey === "string" ? normalizeLegacyContext(contextOrKey) : contextOrKey;
      ctx.log?.(
        `[browser-use] execute requestId=${context.requestId} browserId=${context.browserId} generation=${context.browserGeneration} windowId=${context.windowId} sessionId=${context.sessionId} method=${command.method}`,
      );

      if (ctx.runningRequests.has(context.requestId)) {
        // requestId 是取消与 lifecycle cleanup 的 correlation key。同 key 覆盖会让
        // 取消命中错误 scope，且旧 finally 会删除仍在执行的新 entry。重复请求必须在下发前失败。
        return ctx.withMeta(
          {
            ok: false,
            error: {
              code: "duplicate_request_id",
              message: `browser requestId '${context.requestId}' is already running`,
              sideEffect: "none",
            },
            elapsedMs: 0,
          },
          context,
        );
      }

      if (command.method === "cancelRequest") {
        const cancelled = ctx.abortRequest(command.requestId, context);
        return ctx.withMeta({ ok: true, value: { cancelled }, elapsedMs: 0 }, context);
      }
      if (command.method === "turnEnded") {
        ctx.endTurn(context, command.turnId ?? context.turnId);
        return ctx.withMeta({ ok: true, elapsedMs: 0 }, context);
      }
      if (command.method === "closeSession") {
        ctx.closeSession(context);
        if (command.closeTabs === true) await ctx.closeSessionTabs(context);
        return ctx.withMeta({ ok: true, elapsedMs: 0 }, context);
      }

      const controller = new AbortController();
      const unlink = linkAbortSignal(signal, controller);
      const running: RunningRequest = { context, controller, dispatched: false };
      ctx.runningRequests.set(context.requestId, running);
      try {
        return await ctx.executeInScope(context, command, running);
      } finally {
        unlink();
        // 清理必须绑定 entry identity；即使未来其它入口误写同 key，旧请求也不能删除新状态。
        if (ctx.runningRequests.get(context.requestId) === running) {
          ctx.runningRequests.delete(context.requestId);
        }
        if (running.tabId) ctx.refreshRuntimeProtection(running.tabId);
      }
    },

    async executeInScope(
      context: InternalExecutionContext,
      command: BrowserCommand,
      running: RunningRequest,
    ): Promise<BrowserCommandResult> {
      const startedAt = Date.now();
      if (running.controller.signal.aborted) {
        return ctx.cancelledResult(context, false, startedAt);
      }

      if (command.method === "list") {
        const tabs = await Promise.all(ctx.ownedTabs(context).map((tab) => ctx.summary(tab)));
        return ctx.withMeta({ ok: true, tabs, elapsedMs: Date.now() - startedAt }, context);
      }

      if (command.method === "listUserTabs") {
        const userTabs = ctx.openUserTabs(context).map((tab) => ctx.userTabInfo(tab));
        return ctx.withMeta({ ok: true, userTabs, elapsedMs: Date.now() - startedAt }, context);
      }

      if (command.method === "nameSession") {
        ctx.sessionNames.set(scopeKey(context), command.name);
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
      }

      if (command.method === "browserVisibilityGet") {
        return ctx.withMeta(
          {
            ok: true,
            value: ctx.visibilityByScope.get(scopeKey(context)) === true,
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }

      if (command.method === "browserVisibilitySet") {
        const key = scopeKey(context);
        ctx.visibilityByScope.set(key, command.visible);
        const active = ctx.activeTabByScope.get(key);
        const selected = active ? ctx.tabs.get(active) : ctx.ownedTabs(context).at(-1);
        ctx.onVisibilityChanged?.(command.visible, context, selected?.tabId);
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, selected);
      }

      if (command.method === "browserViewportSet") {
        const tab = ctx.resolveTab(context, command.tabId);
        if (!tab) return ctx.unavailableTabResult(context, command.tabId, startedAt);
        const viewport = { width: command.width, height: command.height };
        await ctx.setTabViewport(tab, viewport);
        ctx.selectTab(tab, true);
        ctx.onViewportChanged?.(viewport, tab.owner, tab.tabId);
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
      }

      if (command.method === "browserViewportReset") {
        const tab = ctx.resolveTab(context, command.tabId);
        if (!tab) return ctx.unavailableTabResult(context, command.tabId, startedAt);
        await ctx.resetTabViewport(tab);
        ctx.onViewportChanged?.(null, tab.owner, tab.tabId);
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
      }

      if (command.method === "recordingStatus" || command.method === "recordingCancel") {
        const entry = ctx.recordings.get(command.recordingId);
        if (!entry || !sameScope(entry.context, context)) {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: `browser recording '${command.recordingId}' is unavailable in this context`,
                sideEffect: "none",
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
          );
        }
        if ("tabId" in command && command.tabId && command.tabId !== entry.tabId) {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: `browser recording '${command.recordingId}' does not belong to tab '${command.tabId}'`,
                sideEffect: "none",
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
          );
        }
        if (command.method === "recordingCancel" && entry.status === "running") {
          entry.controller.abort(new DOMException("recording cancelled", "AbortError"));
          ctx.setRecordingTerminal(entry, "cancelled");
        }
        return ctx.withMeta(
          {
            ok: true,
            recording: ctx.snapshotRecording(entry),
            elapsedMs: Date.now() - startedAt,
          },
          context,
          ctx.tabs.get(entry.tabId),
        );
      }

      if (command.method === "activateTab") {
        const tab = ctx.tabs.get(command.tabId);
        if (!tab || tab.lifecycle === "closed" || !sameScope(tab.owner, context)) {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: `browser tab '${command.tabId}' is unavailable for activation. ${TAB_CONTEXT_RECOVERY_HINT}`,
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
          );
        }
        running.tabId = tab.tabId;
        ctx.refreshRuntimeProtection(tab.tabId);
        const guest = await ctx.ensureGuest(tab, running.controller.signal);
        if (!guest || safeBool(() => guest.isDestroyed(), true)) {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: `browser tab '${command.tabId}' could not be restored for activation`,
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
            tab,
          );
        }
        // 旧 tabs.get 只在 agent 内创建 Tab binding，renderer 仍可能展示另一个页面。
        // 激活必须先原子更新 main selected 状态，再通知 origin renderer；renderer 仅在该 scope
        // 正处前台时展开对应 view，后台对话只能记录激活态，不能抢用户当前会话。
        ctx.selectTab(tab, true);
        return ctx.withMeta(
          {
            ok: true,
            tab: await ctx.summary(tab),
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }

      if (command.method === "claimTab") {
        const candidate = ctx.tabs.get(command.tabId);
        if (!candidate || !ctx.canClaimUserTab(candidate, context)) {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: `user browser tab '${command.tabId}' is unavailable or already claimed`,
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
          );
        }
        const tab = ctx.claimTab(candidate, context);
        return ctx.withMeta(
          {
            ok: true,
            tab: await ctx.summary(tab),
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }

      if (command.method === "finalizeTabs") {
        const keep = new Map(command.keep.map((item) => [item.tabId, item.status]));
        const unknown = [...keep.keys()].filter(
          (tabId) => !ctx.ownedTabs(context).some((tab) => tab.tabId === tabId),
        );
        if (unknown.length > 0) {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: `cannot finalize unknown tab(s): ${unknown.join(", ")}`,
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
          );
        }
        ctx.finalizeTabs(context, keep);
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
      }

      if (command.method === "newTab") {
        const tab = ctx.createTab(context);
        running.tabId = tab.tabId;
        ctx.refreshRuntimeProtection(tab.tabId);
        const guest = await ctx.ensureGuest(tab, running.controller.signal);
        if (!guest) {
          const result = ctx.cancelledOrUnavailable(context, running, startedAt, tab);
          // newTab 在 ready ack 前失败时不能留下无 guest 的 provisional tab；否则后续 list/attach
          // 会把一次已取消的创建误当成仍存活的 tab。close 同时给 renderer 发卸载请求并留下 tombstone。
          await ctx.closeTabDurably(tab);
          return ctx.withMeta(result, context, tab, "closed");
        }
        return ctx.withMeta(
          {
            ok: true,
            tab: await ctx.summary(tab),
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }

      const tab = ctx.resolveTab(context, "tabId" in command ? command.tabId : undefined);
      if (!tab) {
        return ctx.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message:
                "tabId" in command && command.tabId
                  ? `browser tab '${command.tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
                  : "browser tab is unavailable",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      running.tabId = tab.tabId;
      ctx.refreshRuntimeProtection(tab.tabId);

      if (command.method === "recordingStart") {
        const active = [...ctx.recordings.values()].find(
          (entry) => entry.tabId === tab.tabId && entry.status === "running",
        );
        if (active) {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "execution_error",
                message: `browser tab '${tab.tabId}' already has active recording '${active.id}'`,
                sideEffect: "none",
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
            tab,
          );
        }
        const entry = ctx.createRecordingEntry(context, tab);
        ctx.recordings.set(entry.id, entry);
        ctx.refreshRuntimeProtection(tab.tabId);
        void ctx.runRecording(entry, tab, command.options).catch((error: unknown) => {
          if (entry.status !== "running") return;
          if (
            entry.controller.signal.aborted &&
            entry.controller.signal.reason instanceof DOMException &&
            entry.controller.signal.reason.name === "TimeoutError"
          ) {
            ctx.setRecordingTerminal(entry, "failed", entry.controller.signal.reason.message);
          } else if (entry.controller.signal.aborted) {
            ctx.setRecordingTerminal(entry, "cancelled");
          } else {
            ctx.setRecordingTerminal(
              entry,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
          }
        });
        return ctx.withMeta(
          {
            ok: true,
            recording: ctx.snapshotRecording(entry),
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }

      if (command.method === "getDialog") {
        return ctx.withMeta(
          {
            ok: true,
            dialog: ctx.pendingDialogs.get(tab.tabId) ?? null,
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      if (command.method === "close") {
        await ctx.closeTabDurably(tab);
        return ctx.withMeta(
          { ok: true, elapsedMs: Date.now() - startedAt },
          context,
          tab,
          "closed",
        );
      }
      if (command.method === "finalize") {
        tab.lifecycle = command.deliverable === false ? "active" : "deliverable";
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
      }
      if (command.method === "markDeliverable") {
        tab.lifecycle = "deliverable";
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
      }
      if (command.method === "markHandoff") {
        tab.lifecycle = "handoff";
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
      }
      if (command.method === "playwrightWaitForTimeout") {
        // 固定等待前先验证 tab；等待本身不触碰页面，也不要求 guest/CDP 已 attach。
        // turn/session/request abort 必须提前结束 timer，避免已取消的 sleep 继续占住生命周期。
        const completed = await waitForDelay(command.timeoutMs, running.controller.signal);
        if (!completed) {
          return ctx.withMeta(ctx.cancelledResult(context, false, startedAt), context, tab);
        }
        return ctx.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
      }
      if (
        command.method === "playwright" &&
        (command.action.name === "fileChooserSetFiles" ||
          (command.action.name === "waitForEvent" && command.action.event === "filechooser"))
      ) {
        // IAB backend 不支持 filechooser；不能伪造成功或把它误当普通 DOM fill。
        return ctx.withMeta(
          {
            ok: false,
            error: {
              code: "capability_unsupported",
              message: "File uploads are not supported by iab",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      if (command.method === "playwright" && command.action.name === "downloadPath") {
        const record = ctx.downloads.get(command.action.downloadId);
        if (!record || record.tabId !== tab.tabId) {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: "download is unavailable for this tab",
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
            tab,
          );
        }
        const status = await waitForCondition(
          // Playwright 的 download.path() 等下载完成后再返回；will-download 阶段已有
          // savePath 不代表文件已经可安全读取，不能提前 resolve。
          () => record.state !== "pending",
          command.action.timeoutMs ?? 30_000,
          running.controller.signal,
        );
        if (status === "cancelled") {
          return ctx.withMeta(ctx.cancelledResult(context, false, startedAt), context, tab);
        }
        if (status === "timeout") {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "timeout",
                message: "Timeout waiting for download path",
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
            tab,
          );
        }
        if (record.state !== "completed") {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "execution_error",
                message: `download ${record.state}`,
                sideEffect: "uncertain",
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
            tab,
          );
        }
        return ctx.withMeta(
          { ok: true, value: record.path, elapsedMs: Date.now() - startedAt },
          context,
          tab,
        );
      }

      const guest = await ctx.ensureGuest(tab, running.controller.signal);
      if (!guest) return ctx.cancelledOrUnavailable(context, running, startedAt, tab);
      if (safeBool(() => guest.isDestroyed(), false)) {
        ctx.detachGuest(tab);
        return ctx.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser guest destroyed",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      if ((tab.viewportOverride || tab.backgroundViewportFallback) && guest.getZoomFactor() !== 1)
        guest.setZoomFactor(1);
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
          throw new Error("browser guest changed before command dispatch");
        }
      };
      const sendCdpCommand = (method: string, params?: unknown, sessionId?: string) =>
        ctx.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest);

      if (
        command.method === "playwright" &&
        command.action.name === "waitForEvent" &&
        command.action.event === "download"
      ) {
        const downloadId = await ctx.waitForDownload(
          tab.tabId,
          // 下载事件默认等待 3s，但允许调用方为真实下载显式扩到最多 120s。
          normalizePlaywrightTimeout(command.action.timeoutMs, 120_000),
          running.controller.signal,
        );
        if (!downloadId) {
          const result = running.controller.signal.aborted
            ? ctx.cancelledResult(context, false, startedAt)
            : {
                ok: false as const,
                error: {
                  code: "timeout" as const,
                  message: "Timeout waiting for download",
                },
                elapsedMs: Date.now() - startedAt,
              };
          return ctx.withMeta(result, context, tab);
        }
        return ctx.withMeta(
          {
            ok: true,
            value: { id: downloadId },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }

      if (command.method === "handleDialog") {
        try {
          assertCurrentGuest();
        } catch {
          return ctx.withMeta(
            {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: "browser guest changed before command dispatch",
                sideEffect: "none",
              },
              elapsedMs: Date.now() - startedAt,
            },
            context,
            tab,
          );
        }
        running.dispatched = true;
        const execution = sendCdpCommand("Page.handleJavaScriptDialog", {
          accept: command.accept,
          ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
        })
          .then<BrowserCommandResult>(() => ({
            ok: true,
            elapsedMs: Date.now() - startedAt,
          }))
          .catch<BrowserCommandResult>((error: unknown) => ({
            ok: false,
            error: {
              code: "execution_error",
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: Date.now() - startedAt,
          }));
        const result = await raceBackendExecution(
          execution,
          running.controller.signal,
          command,
          startedAt,
        );
        if (result.ok) {
          ctx.pendingDialogs.delete(tab.tabId);
        }
        return ctx.withMeta(result, context, tab);
      }

      const screenshotCommand = isScreenshotCommand(command);
      const previousScreenshot = screenshotCommand
        ? ctx.inFlightScreenshots.get(tab.tabId)
        : undefined;
      if (previousScreenshot && ctx.isInFlightScreenshotAlive(previousScreenshot)) {
        const elapsedMs = Date.now() - previousScreenshot.startedAt;
        ctx.log?.(
          `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${elapsedMs}`,
        );
        return ctx.withMeta(
          {
            ok: false,
            error: {
              code: "timeout",
              message:
                "A previous screenshot for this browser tab is still completing after timeout. " +
                "Wait before retrying, or reopen the tab if it does not recover.",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const abandonedCaptures = screenshotCommand
        ? (ctx.abandonedScreenshotCaptures.get(tab.tabId) ?? 0)
        : 0;
      if (screenshotCommand && abandonedCaptures >= MAX_ABANDONED_SCREENSHOT_CAPTURES) {
        // 未结算的底层 capture 已达硬上限：不再叠加新的 pending CDP command，快速失败
        // 并提示重开 tab；旧 capture 落定后名额自动回收，无需人工干预即可恢复。
        ctx.log?.(
          `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} abandonedCaptures=${abandonedCaptures}`,
        );
        return ctx.withMeta(
          {
            ok: false,
            error: {
              code: "timeout",
              message:
                `${abandonedCaptures} previous screenshot captures for this browser tab are still ` +
                "stuck in the backend after timeout. Reopen the tab to recover.",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      if (previousScreenshot) {
        // 整幅 capture 在隐藏窗口等帧时，30s watchdog 判死但底层 execution 永不
        // settle，tracker 无法清理，该 tab 后续截图全部被 0ms 秒拒直至关 tab（生产日志
        // pendingMs 高达 120s）。命令已返回或已被 abort 的挂起截图视为死条目，
        // 由新请求直接取代；清理以 entry identity 幂等，迟到的 settle 不会误删新请求。
        ctx.log?.(
          `[browser-use] screenshot superseded stale pending tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${Date.now() - previousScreenshot.startedAt}`,
        );
      }

      const execution = screenshotCommand
        ? ctx.executeScreenshotWithPreparedSurface(
            context,
            tab,
            guest,
            command,
            running,
            startedAt,
            assertCurrentGuest,
            sendCdpCommand,
          )
        : executeBrowserCommandOnView(
            ctx.toControlledView(
              guest,
              Boolean(tab.viewportOverride || tab.backgroundViewportFallback),
              undefined,
              assertCurrentGuest,
              sendCdpCommand,
            ),
            command,
            { signal: running.controller.signal },
          );
      if (!screenshotCommand) running.dispatched = true;
      if (screenshotCommand) {
        const tracked: InFlightScreenshot = {
          execution,
          requestId: context.requestId,
          startedAt: Date.now(),
        };
        ctx.inFlightScreenshots.set(tab.tabId, tracked);
        ctx.refreshRuntimeProtection(tab.tabId);
        const clearTrackedScreenshot = () => {
          if (ctx.inFlightScreenshots.get(tab.tabId) !== tracked) return;
          ctx.inFlightScreenshots.delete(tab.tabId);
          ctx.refreshRuntimeProtection(tab.tabId);
          ctx.log?.(
            `[browser-use] screenshot backend settled tabId=${tab.tabId} requestId=${context.requestId} elapsedMs=${Date.now() - tracked.startedAt}`,
          );
        };
        // 同时提供 fulfilled/rejected handler，避免仅调用 finally 产生未处理的派生 rejection。
        void execution.then(clearTrackedScreenshot, clearTrackedScreenshot);
      }
      const result = await raceBackendExecution(
        execution,
        running.controller.signal,
        command,
        startedAt,
      );
      return ctx.withMeta(result, context, tab);
    },
  };
}
