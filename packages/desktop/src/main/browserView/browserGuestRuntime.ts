import type { BrowserGuestContext } from "./browserGuestContext.js";
import { randomUUID } from "node:crypto";
import type {
  ManagedTab,
  GuestWebContents,
  GuestDownloadItem,
  DownloadRecord,
  DownloadWaiter,
} from "./browserGuestTypes.js";
import { safeStr, safeBool } from "./browserGuestUtils.js";

export function createBrowserGuestRuntime(
  ctx: BrowserGuestContext,
): Pick<
  BrowserGuestContext,
  | "setupDownloadTracking"
  | "waitForDownload"
  | "finishDownloadWaiter"
  | "setupActivityTracking"
  | "refreshRuntimeProtection"
  | "hasRunningRequestForTab"
  | "isTabCaptureActive"
  | "hasPendingDownloadForTab"
  | "collectMemoryDiagnostics"
> {
  return {
    setupDownloadTracking(tab: ManagedTab, guest: GuestWebContents): void {
      tab.downloadCleanup?.();
      if (!guest.session) return;
      const listener = (_event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => {
        if (contents !== guest || tab.guest !== guest || tab.lifecycle === "closed") return;
        const downloadId = `iab-download:${randomUUID()}`;
        const record: DownloadRecord = {
          tabId: tab.tabId,
          path: safeStr(() => item.getSavePath(), "") || null,
          state: "pending",
        };
        ctx.downloads.set(downloadId, record);
        ctx.refreshRuntimeProtection(tab.tabId);
        item.once("done", (_event, state) => {
          record.path = safeStr(() => item.getSavePath(), "") || record.path;
          record.state =
            state === "completed"
              ? "completed"
              : state === "cancelled"
                ? "cancelled"
                : "interrupted";
          ctx.refreshRuntimeProtection(tab.tabId);
        });
        const waiters = ctx.downloadWaiters.get(tab.tabId);
        const waiter = waiters?.shift();
        if (waiter) {
          ctx.finishDownloadWaiter(tab.tabId, waiter, downloadId);
        } else {
          const queued = ctx.queuedDownloads.get(tab.tabId) ?? [];
          queued.push(downloadId);
          ctx.queuedDownloads.set(tab.tabId, queued);
        }
      };
      guest.session.on("will-download", listener);
      tab.downloadCleanup = () => guest.session?.removeListener("will-download", listener);
    },

    waitForDownload(tabId: string, timeoutMs: number, signal: AbortSignal): Promise<string | null> {
      const queued = ctx.queuedDownloads.get(tabId);
      const existing = queued?.shift();
      if (existing) return Promise.resolve(existing);
      if (signal.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter = {} as DownloadWaiter;
        waiter.resolve = resolve;
        waiter.signal = signal;
        waiter.timer = setTimeout(() => ctx.finishDownloadWaiter(tabId, waiter, null), timeoutMs);
        waiter.onAbort = () => ctx.finishDownloadWaiter(tabId, waiter, null);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        const waiters = ctx.downloadWaiters.get(tabId) ?? [];
        waiters.push(waiter);
        ctx.downloadWaiters.set(tabId, waiters);
      });
    },

    finishDownloadWaiter(tabId: string, waiter: DownloadWaiter, downloadId: string | null): void {
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      const waiters = ctx.downloadWaiters.get(tabId);
      if (waiters) {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        if (waiters.length === 0) ctx.downloadWaiters.delete(tabId);
      }
      waiter.resolve(downloadId);
    },

    setupActivityTracking(tab: ManagedTab, guest: GuestWebContents): void {
      tab.activityCleanup?.();
      if (!guest.on || !guest.removeListener) return;
      const onLoadingStarted = () => {
        if (tab.guest !== guest) return;
        tab.loading = true;
        ctx.refreshRuntimeProtection(tab.tabId);
      };
      const onLoadingStopped = () => {
        if (tab.guest !== guest) return;
        tab.loading = false;
        if (!ctx.guestRecoveryFlights.has(tab.tabId)) {
          tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
          tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
        }
        ctx.refreshRuntimeProtection(tab.tabId);
        void ctx.persistShell(tab);
      };
      const onAudioChanged = () => ctx.refreshRuntimeProtection(tab.tabId);
      const onMediaStarted = () => {
        if (tab.guest !== guest) return;
        tab.mediaActive = true;
        ctx.refreshRuntimeProtection(tab.tabId);
      };
      const onMediaPaused = () => {
        if (tab.guest !== guest) return;
        tab.mediaActive = false;
        ctx.refreshRuntimeProtection(tab.tabId);
      };
      guest.on("did-start-loading", onLoadingStarted);
      guest.on("did-stop-loading", onLoadingStopped);
      guest.on("audio-state-changed", onAudioChanged);
      guest.on("media-started-playing", onMediaStarted);
      guest.on("media-paused", onMediaPaused);
      tab.activityCleanup = () => {
        guest.removeListener?.("did-start-loading", onLoadingStarted);
        guest.removeListener?.("did-stop-loading", onLoadingStopped);
        guest.removeListener?.("audio-state-changed", onAudioChanged);
        guest.removeListener?.("media-started-playing", onMediaStarted);
        guest.removeListener?.("media-paused", onMediaPaused);
      };
    },

    refreshRuntimeProtection(tabId: string): void {
      const tab = ctx.tabs.get(tabId);
      if (!tab) return;
      ctx.residencyCoordinator.report(tabId, {
        loading: tab.loading,
        operationActive: ctx.hasRunningRequestForTab(tabId),
        captureActive: ctx.isTabCaptureActive(tab),
        audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
        mediaActive: tab.mediaActive,
        downloadActive: ctx.hasPendingDownloadForTab(tabId),
      });
    },

    hasRunningRequestForTab(tabId: string): boolean {
      return [...ctx.runningRequests.values()].some((request) => request.tabId === tabId);
    },

    isTabCaptureActive(tab: ManagedTab): boolean {
      return (
        ctx.inFlightScreenshots.has(tab.tabId) ||
        [...ctx.recordings.values()].some(
          (entry) => entry.tabId === tab.tabId && entry.status === "running",
        ) ||
        safeBool(() => tab.guest?.isBeingCaptured?.() ?? false, false)
      );
    },

    hasPendingDownloadForTab(tabId: string): boolean {
      return [...ctx.downloads.values()].some(
        (record) => record.tabId === tabId && record.state === "pending",
      );
    },

    /** 内存诊断计数器；只读 size。 */
    collectMemoryDiagnostics(): Record<string, number> {
      return { tabs: ctx.tabs.size, closedTabIds: ctx.closedTabIds.size };
    },
  };
}
