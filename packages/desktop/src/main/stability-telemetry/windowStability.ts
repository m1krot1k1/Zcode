import { BrowserWindow, type WebContents } from "electron";
import { getResourceManagerWindowId } from "../resourceManagerWindow.js";
import { shouldReportAnr, shouldReportFreeze } from "./crashClassification.js";
import { reportStabilityCustom } from "./eventReporter.js";
import type { StabilityLogger, StabilityWindowScene, UnresponsiveWatchState } from "./types.js";

// 修复原因：WebContents.getType() 对所有 BrowserWindow 都返回 window，无法区分主业务窗和
// Resource Manager / 更新 / About。只登记 createWindowInstance 创建的业务窗口，避免辅助窗污染 Crash 率。
const mainWindowIds = new Set<number>();
const unresponsiveByWebContentsId = new Map<number, UnresponsiveWatchState>();

export function resolveRegisteredWindowScene(
  win: BrowserWindow | null | undefined,
): StabilityWindowScene {
  if (!win || win.isDestroyed()) {
    return "other";
  }
  const resourceManagerId = getResourceManagerWindowId();
  if (resourceManagerId != null && win.id === resourceManagerId) {
    return "process_monitor";
  }
  return mainWindowIds.has(win.id) ? "main" : "other";
}

export function resolveWindowScene(win: BrowserWindow | null | undefined): StabilityWindowScene {
  if (win && !win.isDestroyed()) {
    return resolveRegisteredWindowScene(win);
  }
  const focused = BrowserWindow.getFocusedWindow();
  return focused && !focused.isDestroyed() ? resolveRegisteredWindowScene(focused) : "main";
}

export function markWebContentsCrash(webContentsId: number): void {
  const state = unresponsiveByWebContentsId.get(webContentsId);
  if (state) {
    state.crashReported = true;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }
}

function clearUnresponsiveWatch(webContentsId: number): void {
  const state = unresponsiveByWebContentsId.get(webContentsId);
  if (!state) {
    return;
  }
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
  }
  unresponsiveByWebContentsId.delete(webContentsId);
}

function pollUnresponsiveState(state: UnresponsiveWatchState, logger: StabilityLogger): void {
  if (state.crashReported) {
    clearUnresponsiveWatch(state.webContentsId);
    return;
  }

  const elapsedMs = Date.now() - state.startedAt;
  const windowScene = state.windowScene;

  if (shouldReportAnr(elapsedMs, state.anrReported)) {
    state.anrReported = true;
    reportStabilityCustom(
      "perf_anr",
      {
        duration_ms: elapsedMs,
        window_id: state.windowId,
        web_contents_id: state.webContentsId,
      },
      windowScene,
    );
    logger.warn("[stability] perf_anr reported", {
      windowId: state.windowId,
      webContentsId: state.webContentsId,
      durationMs: elapsedMs,
    });
  }

  if (shouldReportFreeze(elapsedMs, state.freezeReported, state.crashReported)) {
    state.freezeReported = true;
    reportStabilityCustom(
      "perf_freeze",
      {
        duration_ms: elapsedMs,
        window_id: state.windowId,
        web_contents_id: state.webContentsId,
      },
      windowScene,
    );
    logger.warn("[stability] perf_freeze reported", {
      windowId: state.windowId,
      webContentsId: state.webContentsId,
      durationMs: elapsedMs,
    });
  }

  if (!state.freezeReported && !state.crashReported) {
    state.pollTimer = setTimeout(() => pollUnresponsiveState(state, logger), 1_000);
    state.pollTimer.unref?.();
  }
}

export function attachWebContentsStabilityWatch(
  win: BrowserWindow,
  webContents: WebContents,
  logger: StabilityLogger,
): void {
  const webContentsId = webContents.id;

  webContents.on("unresponsive", () => {
    clearUnresponsiveWatch(webContentsId);
    const state: UnresponsiveWatchState = {
      windowId: win.id,
      webContentsId,
      windowScene: resolveRegisteredWindowScene(win),
      startedAt: Date.now(),
      anrReported: false,
      freezeReported: false,
      crashReported: false,
      pollTimer: null,
    };
    unresponsiveByWebContentsId.set(webContentsId, state);
    logger.warn("[stability] webContents unresponsive", {
      windowId: win.id,
      webContentsId,
      url: webContents.getURL(),
    });
    pollUnresponsiveState(state, logger);
  });

  webContents.on("responsive", () => {
    logger.info("[stability] webContents responsive", {
      windowId: win.id,
      webContentsId,
    });
    clearUnresponsiveWatch(webContentsId);
  });

  webContents.on("destroyed", () => {
    clearUnresponsiveWatch(webContentsId);
  });
}

export function registerStabilityMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || mainWindowIds.has(win.id)) {
    return;
  }
  mainWindowIds.add(win.id);
  win.once("closed", () => {
    mainWindowIds.delete(win.id);
  });
}
