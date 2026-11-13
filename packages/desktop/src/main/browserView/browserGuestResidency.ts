import type { BrowserGuestContext } from "./browserGuestContext.js";
import { randomUUID } from "node:crypto";
import type {
  BrowserViewResidencyReportPayload,
  BrowserViewCloseTabRequest,
  BrowserViewRestoredTabShell,
  BrowserViewResidencyTransitionPayload,
} from "@zcode/shared";
import type { BrowserTabResidencyRecord } from "./browserTabResidencyCoordinator.js";
import type {
  InternalExecutionContext,
  ManagedTab,
  GuestWebContents,
  TabLifecycle,
} from "./browserGuestTypes.js";
import {
  safeBool,
  scopeKey,
  suspendAckKey,
  toRestoredShell,
  waitForPromiseWithSignal,
  safeStr,
} from "./browserGuestUtils.js";

export function createBrowserGuestResidency(
  ctx: BrowserGuestContext,
): Pick<
  BrowserGuestContext,
  | "reportResidency"
  | "acknowledgeSuspend"
  | "whenRecoveryIdle"
  | "ensureResidentFromRenderer"
  | "restoreTabs"
  | "registerTabResidency"
  | "closeTabForLimit"
  | "restoreSuspendedGuest"
  | "runRestoreSuspendedGuest"
  | "restoreGuestState"
  | "restoreReboundGuest"
> {
  return {
    async reportResidency(
      payload: BrowserViewResidencyReportPayload & { windowId: number },
    ): Promise<void> {
      const tab = ctx.requireRendererOwnedTab(payload);
      tab.cachedUrl = payload.restoreUrl?.trim() || tab.cachedUrl;
      if (payload.title !== undefined) tab.cachedTitle = payload.title ?? "";
      if (payload.faviconUrl !== undefined) tab.cachedFaviconUrl = payload.faviconUrl;
      tab.loading = payload.loading;
      ctx.residencyCoordinator.report(tab.tabId, {
        selected: payload.selected,
        visible: payload.visible,
        currentTask: payload.currentTask,
        loading: payload.loading,
        audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
        mediaActive: tab.mediaActive,
        operationActive: ctx.hasRunningRequestForTab(tab.tabId),
        captureActive: ctx.isTabCaptureActive(tab),
        downloadActive: ctx.hasPendingDownloadForTab(tab.tabId),
      });
      if (payload.selected) {
        tab.active = true;
        if (!tab.claimable) ctx.selectTab(tab, false);
        // renderer 前台上报是用户真实在看的信号（面板展开/切 tab），与 claimable 无关，
        // 必须独立于 selectTab 触发恢复。
        ctx.maybeRestoreBackgroundViewport(tab);
      } else {
        tab.active = false;
        const key = scopeKey(tab.owner);
        if (ctx.activeTabByScope.get(key) === tab.tabId) ctx.activeTabByScope.delete(key);
      }
      await ctx.persistShell(tab);
      await ctx.residencyCoordinator.whenIdle();
    },

    acknowledgeSuspend(payload: { tabId: string; generation: number; windowId: number }): void {
      const tab = ctx.tabs.get(payload.tabId);
      if (!tab || tab.owner.windowId !== payload.windowId) return;
      const key = suspendAckKey(payload.tabId, payload.generation);
      ctx.suspendAckWaiters.get(key)?.();
    },

    async whenRecoveryIdle(): Promise<void> {
      await ctx.residencyOptions.recoveryStore?.whenIdle?.();
    },

    async ensureResidentFromRenderer(
      payload: BrowserViewCloseTabRequest & { windowId: number },
    ): Promise<void> {
      const tab = ctx.requireRendererOwnedTab(payload);
      const guest = await ctx.ensureGuest(tab, new AbortController().signal);
      if (!guest) throw new Error(`browser tab '${tab.tabId}' restore failed`);
    },

    async restoreTabs(payload: {
      windowId: number;
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId?: string;
    }): Promise<BrowserViewRestoredTabShell[]> {
      const records =
        (await ctx.residencyOptions.recoveryStore?.listShells({
          workspaceKey: payload.workspaceKey,
          ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        })) ?? [];
      ctx.log?.(
        `[browser-use] restoreTabs windowId=${payload.windowId} workspaceKey=${payload.workspaceKey} remoteSessionId=${payload.remoteSessionId ?? "<local>"} sessionId=${payload.sessionId ?? "<all>"} records=${records.length}`,
      );
      const restored: BrowserViewRestoredTabShell[] = [];
      for (const record of records) {
        if (ctx.closedTabIds.has(record.tabId)) continue;
        const claimedWindowId = ctx.restoredTabClaims.get(record.tabId);
        if (claimedWindowId !== undefined && claimedWindowId !== payload.windowId) continue;
        ctx.restoredTabClaims.set(record.tabId, payload.windowId);

        let tab = ctx.tabs.get(record.tabId);
        if (!tab) {
          const owner: InternalExecutionContext = {
            requestId: `restore:${randomUUID()}`,
            browserId:
              record.browserId ?? (record.origin === "user" ? "unclaimed-iab" : "restored-iab"),
            browserGeneration: record.browserGeneration ?? 0,
            windowId: payload.windowId,
            workspaceKey: record.workspaceKey,
            ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
            sessionId: record.sessionId,
            clientMode: "desktop-continuous",
          };
          tab = {
            tabId: record.tabId,
            owner,
            cdpAttached: false,
            guestLifecycle: "detached",
            pendingCdpCommands: 0,
            guestGeneration: 0,
            hasAttachedGuest: false,
            rebindRequested: false,
            lifecycle: record.lifecycle,
            origin: record.origin,
            claimable: record.origin === "user",
            ...(record.origin === "user" ? { userOwner: { ...owner } } : {}),
            active: false,
            ...(record.viewport ? { viewportOverride: { ...record.viewport } } : {}),
            loading: false,
            mediaActive: false,
            cachedUrl: record.restoreUrl ?? "",
            cachedTitle: record.title ?? "",
            cachedFaviconUrl: record.faviconUrl,
            openedAt: record.openedAt,
            restoredFromStore: true,
          };
          ctx.tabs.set(record.tabId, tab);
          ctx.registerTabResidency(tab, false, "suspended", record.lastSelectedAt);
        } else if (tab.owner.windowId !== payload.windowId) {
          continue;
        }
        restored.push(toRestoredShell(record, tab.owner));
      }
      return restored;
    },

    registerTabResidency(
      tab: ManagedTab,
      visible: boolean,
      residency: BrowserTabResidencyRecord["residency"] = visible
        ? "live-visible"
        : "live-background",
      lastSelectedAt: number | null = null,
    ): void {
      ctx.residencyCoordinator.upsert({
        tabId: tab.tabId,
        windowId: tab.owner.windowId,
        sessionId: tab.owner.sessionId,
        residency,
        guestAttached: Boolean(tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)),
        openedAt: tab.openedAt,
        lastActivityAt: tab.openedAt,
        lastSelectedAt,
        preferred: visible,
        currentTask: false,
        selected: visible,
        visible,
        operationActive: false,
        captureActive: false,
        audible: false,
        mediaActive: false,
        loading: false,
        downloadActive: false,
      });
    },

    async closeTabForLimit(record: BrowserTabResidencyRecord): Promise<boolean> {
      const tab = ctx.tabs.get(record.tabId);
      if (!tab || tab.lifecycle === "closed") return true;
      try {
        // 旧的数量门禁只销毁 WebContents 并保留 suspended logical tab，
        // 因此标签栏会突破 32。必须复用 durable close，按“恢复数据 → guest → renderer tab 壳”
        // 的顺序完整关闭，避免已关闭 tab 在当前 UI 或下次启动时复活。
        await ctx.closeTabDurably(tab);
        ctx.log?.(
          `[browser-use] closed tabId=${tab.tabId} reason=tab-limit windowId=${tab.owner.windowId}`,
        );
        return true;
      } catch (error) {
        ctx.warn(`browser tab limit close failed tabId=${tab.tabId}`, error);
        return false;
      }
    },

    async restoreSuspendedGuest(
      tab: ManagedTab,
      signal: AbortSignal,
    ): Promise<GuestWebContents | null> {
      if (signal.aborted) return null;
      let flight = ctx.restoreFlights.get(tab.tabId);
      if (!flight) {
        // 旧 single-flight 直接采用首个 caller 的 AbortSignal；首个 command 取消会
        // 毒化所有并发 caller，并把 coordinator 留在 restoring。flight 改由 tab 生命周期拥有。
        flight = ctx.runRestoreSuspendedGuest(tab, new AbortController().signal).finally(() => {
          if (ctx.restoreFlights.get(tab.tabId) === flight) ctx.restoreFlights.delete(tab.tabId);
        });
        ctx.restoreFlights.set(tab.tabId, flight);
      }
      const result = await waitForPromiseWithSignal(flight, signal);
      return result.completed ? result.value : null;
    },

    async runRestoreSuspendedGuest(
      tab: ManagedTab,
      signal: AbortSignal,
    ): Promise<GuestWebContents | null> {
      const before = ctx.residencyCoordinator.get(tab.tabId);
      const transition = ctx.residencyCoordinator.markRestoring(tab.tabId);
      if (!transition) return null;
      if (before?.residency === "suspended") {
        const payload: BrowserViewResidencyTransitionPayload = {
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: transition.generation,
          residency: "restoring",
        };
        if (ctx.residencyOptions.onRestoreTabRequested) {
          ctx.residencyOptions.onRestoreTabRequested(payload);
        } else {
          ctx.onOpenTabRequested?.(tab.tabId, tab.owner);
        }
      }

      const guest = await ctx.waitForGuest(tab.tabId, signal);
      if (!guest) {
        const failed = ctx.residencyCoordinator.failRestore(tab.tabId, transition.generation);
        if (failed) {
          // 通知 renderer 回到轻量 shell；新 generation 同时让本轮迟到 attach fail closed。
          ctx.residencyOptions.onSuspendTabRequested?.({
            tabId: tab.tabId,
            workspaceKey: tab.owner.workspaceKey,
            remoteSessionId: tab.owner.remoteSessionId,
            sessionId: tab.owner.sessionId,
            browserId: tab.owner.browserId,
            browserGeneration: tab.owner.browserGeneration,
            generation: failed.generation,
            residency: "suspended",
          });
        }
        return null;
      }
      const restored = await ctx.restoreGuestState(tab, guest);
      if (!restored && tab.restoredFromStore && !tab.cachedUrl) {
        // 仅 forced restore mount 后三类恢复事实全部缺失才清理孤儿；普通 page-state 淘汰
        // 仍会保留 restoreUrl，不得进入这个分支形成 restore/close 循环。
        await ctx.removeTabRecovery(tab);
        ctx.residencyOptions.onRecoveryOrphanCloseRequested?.({
          tabId: tab.tabId,
          reason: "recovery-orphan",
        });
        ctx.closeTab(tab, false);
        return null;
      }
      if (!restored) {
        // 不能只处理“恢复事实全缺失”：history 与 URL 都失败时仍提交 live 的话，
        // bootstrap/about:blank 因而被永久当成成功页面。失败必须销毁本轮 guest 并回到可重试 shell。
        const failed = ctx.residencyCoordinator.failRestore(tab.tabId, transition.generation);
        ctx.detachAndCloseGuest(tab);
        if (failed) {
          ctx.residencyOptions.onSuspendTabRequested?.({
            tabId: tab.tabId,
            workspaceKey: tab.owner.workspaceKey,
            remoteSessionId: tab.owner.remoteSessionId,
            sessionId: tab.owner.sessionId,
            browserId: tab.owner.browserId,
            browserGeneration: tab.owner.browserGeneration,
            generation: failed.generation,
            residency: "suspended",
          });
        }
        return null;
      }
      if (!ctx.residencyCoordinator.completeRestore(tab.tabId, transition.generation)) return null;
      const completed = ctx.residencyCoordinator.get(tab.tabId);
      if (completed) {
        // renderer 原来只收到 restoring 起点，成功后没有终态，会永久保留 restoring shell。
        ctx.residencyOptions.onResidencyChanged?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: completed.generation,
          residency: completed.residency === "live-visible" ? "live-visible" : "live-background",
        });
      }
      tab.restoredFromStore = false;
      await ctx.persistShell(tab);
      return guest;
    },

    async restoreGuestState(tab: ManagedTab, guest: GuestWebContents): Promise<boolean> {
      const pageState = await ctx.residencyOptions.recoveryStore?.getPageState(tab.tabId);
      if (pageState && pageState.entries.length > 0) {
        const activePageState = pageState.entries[pageState.activeIndex];
        if (tab.cachedUrl && activePageState?.url !== tab.cachedUrl) {
          // pageState 只在预算挂起时刷新；恢复后导航会更新 shell，却留下旧快照。
          // 冷启动必须以 logical shell 的当前 URL 为准，不能把 B 回滚成快照里的 A。
          ctx.warn(
            `browser tab stale page-state ignored tabId=${tab.tabId} shellUrl=${tab.cachedUrl} pageStateUrl=${activePageState?.url ?? "missing"}`,
          );
          await ctx.residencyOptions.recoveryStore?.removePageState(tab.tabId);
        } else {
          const acceptRestoredPageState = () => {
            const active = pageState.entries[pageState.activeIndex];
            tab.cachedUrl = active?.url ?? tab.cachedUrl;
            tab.cachedTitle = active?.title ?? tab.cachedTitle;
            return true;
          };
          try {
            ctx.log?.(
              `[browser-use] restore page-state start tabId=${tab.tabId} index=${pageState.activeIndex} entries=${JSON.stringify(pageState.entries.map((entry) => entry.url))}`,
            );
            await guest.navigationHistory.restore({
              entries: pageState.entries.map((entry) => ({ ...entry })),
              index: pageState.activeIndex,
            });
            ctx.log?.(
              `[browser-use] restore page-state complete tabId=${tab.tabId} url=${safeStr(() => guest.getURL(), "")} index=${safeStr(() => String(guest.navigationHistory.getActiveIndex()), "unknown")} entries=${safeStr(() => JSON.stringify(guest.navigationHistory.getAllEntries().map((entry) => entry.url)), "unknown")}`,
            );
            return acceptRestoredPageState();
          } catch (error) {
            const restoreAppliedDespiteAbort =
              String(error).includes("ERR_ABORTED") &&
              safeBool(() => {
                const actualEntries = guest.navigationHistory.getAllEntries();
                return (
                  guest.navigationHistory.getActiveIndex() === pageState.activeIndex &&
                  actualEntries.length === pageState.entries.length &&
                  actualEntries.every((entry, index) => entry.url === pageState.entries[index]?.url)
                );
              }, false);
            if (restoreAppliedDespiteAbort) {
              // Electron 41 会在完整历史已写入后，仍以 ERR_ABORTED 报告默认 about:blank 被取消。
              // 以实际 navigationHistory 为准，避免误删有效 pageState 并发起第二次 URL 导航。
              return acceptRestoredPageState();
            }
            ctx.warn(`browser tab page-state restore failed tabId=${tab.tabId}`, error);
            await ctx.residencyOptions.recoveryStore?.removePageState(tab.tabId);
          }
        }
      }
      if (!tab.cachedUrl) return false;
      try {
        await guest.loadURL(tab.cachedUrl);
        return true;
      } catch (error) {
        ctx.warn(`browser tab URL restore failed tabId=${tab.tabId}`, error);
        return false;
      }
    },

    async restoreReboundGuest(
      tab: ManagedTab,
      guest: GuestWebContents,
    ): Promise<GuestWebContents | null> {
      if (tab.lifecycle === "closed" || tab.guest !== guest) return null;
      const restored = await ctx.restoreGuestState(tab, guest);
      // await 期间 tab 可能被关闭；lifecycle 是可变字段，重新读取以撤销上面的收窄。
      const lifecycleAfterRestore = tab.lifecycle as TabLifecycle;
      if (!restored || lifecycleAfterRestore === "closed" || tab.guest !== guest) {
        if (lifecycleAfterRestore !== "closed" && tab.guest === guest) {
          ctx.warn(`browser tab guest rebind restore failed tabId=${tab.tabId}`);
        }
        return null;
      }
      ctx.log?.(
        `[browser-use] guest rebind restore complete tabId=${tab.tabId} url=${tab.cachedUrl}`,
      );
      await ctx.persistShell(tab);
      return guest;
    },
  };
}
