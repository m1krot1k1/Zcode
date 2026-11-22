import type { Locale, UpdateCheckResultPayload, UpdateStatePayload } from "@zcode/shared";
import {
  PlatformChannels,
  desktopMenuMessageIds,
  formatDesktopMenuMessage,
  getDesktopMenuMessage,
} from "@zcode/shared";
import { BrowserWindow, Menu } from "electron";
import { logger } from "../logger.js";
import {
  clearPendingPostUpdateReleaseNotes,
  isPendingReleaseNotesForFutureVersion,
  shouldDiscardStalePendingReleaseNotes,
} from "./releaseNotes.js";
import {
  CHECK_FOR_UPDATE_MENU_ID,
  buildUpdateDownloadedState,
  getCurrentAppVersionForUpdate,
  resolveAutoUpdatePollInterval,
  updaterState,
  type AutoUpdaterMenuState,
  type SettingServiceLike,
} from "./state.js";

function updateMenuItemLabel(label: string, enabled: boolean) {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(CHECK_FOR_UPDATE_MENU_ID);
  if (item) {
    item.label = label;
    item.enabled = enabled;
  }
}

function getMenuItemLabel(state: AutoUpdaterMenuState): string {
  const { locale } = updaterState.menu;
  switch (state.kind) {
    case "checking":
      return getDesktopMenuMessage(locale, desktopMenuMessageIds.helpCheckingForUpdates);
    case "update-available":
      return formatDesktopMenuMessage(locale, desktopMenuMessageIds.helpUpdateAvailableVersion, {
        version: state.version,
      });
    case "download-progress":
      return formatDesktopMenuMessage(locale, desktopMenuMessageIds.helpDownloadingUpdateProgress, {
        progress: state.progress,
      });
    case "update-downloaded":
      return formatDesktopMenuMessage(locale, desktopMenuMessageIds.helpRestartToUpdate, {
        version: state.version,
      });
    case "idle":
    default:
      return getDesktopMenuMessage(locale, desktopMenuMessageIds.helpCheckForUpdates);
  }
}

function syncMenuItemState() {
  const { state } = updaterState.menu;
  updateMenuItemLabel(getMenuItemLabel(state), state.enabled);
}

function isSameAutoUpdaterMenuState(left: AutoUpdaterMenuState, right: AutoUpdaterMenuState) {
  if (left.kind !== right.kind || left.enabled !== right.enabled) {
    return false;
  }

  switch (left.kind) {
    case "update-available":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "update-downloaded":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "download-progress":
      return (
        right.kind === left.kind &&
        right.progress === left.progress &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "idle":
    case "checking":
    default:
      return true;
  }
}

function broadcastAutoUpdaterState() {
  const { state } = updaterState.menu;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.UpdateStateChanged, state);
    }
  }
}

export function onAutoUpdaterStateChanged(listener: (state: UpdateStatePayload) => void) {
  updaterState.listeners.stateListeners.add(listener);
  return () => {
    updaterState.listeners.stateListeners.delete(listener);
  };
}

export function setAutoUpdaterMenuState(nextState: AutoUpdaterMenuState) {
  const { menu } = updaterState;
  if (isSameAutoUpdaterMenuState(menu.state, nextState)) {
    return;
  }

  menu.state = nextState;
  syncMenuItemState();
  broadcastAutoUpdaterState();
  ensureAutoUpdatePollInterval();
  for (const listener of updaterState.listeners.stateListeners) {
    listener(menu.state);
  }
}

export function ensureAutoUpdatePollInterval() {
  const { menu, poll, runtime } = updaterState;
  if (menu.state.kind === "download-progress") {
    if (poll.timer) {
      clearInterval(poll.timer);
      poll.timer = null;
      poll.intervalMs = null;
    }
    return;
  }
  const nextInterval = resolveAutoUpdatePollInterval(menu.state);
  if (poll.timer && poll.intervalMs === nextInterval) {
    return;
  }
  if (poll.timer) {
    clearInterval(poll.timer);
  }
  poll.intervalMs = nextInterval;
  poll.timer = setInterval(() => {
    runtime.recheckAfterDownload?.("poll");
  }, nextInterval);
  poll.timer.unref?.();
}

function findLiveWindowByWebContentsId(webContentsId: number | null) {
  if (webContentsId == null) {
    return null;
  }

  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
    ) ?? null
  );
}

export function sendManualCheckResult(payload: UpdateCheckResultPayload) {
  const { runtime } = updaterState;
  const webContentsId = runtime.manualCheckWebContentsId;
  if (webContentsId == null) return;
  runtime.manualCheckWebContentsId = null;

  const win = findLiveWindowByWebContentsId(webContentsId);
  if (!win) {
    logger.info(
      `[auto-update] manual check result dropped, target webContents ${webContentsId} gone`,
    );
    return;
  }
  logger.info(`[auto-update] manual check result → wc=${webContentsId}: ${payload.kind}`);
  win.webContents.send(PlatformChannels.UpdateCheckResult, payload);
}

export function setAutoUpdaterMenuLocale(locale: Locale) {
  updaterState.menu.locale = locale;

  // 检查更新菜单项会被 updater 的异步状态流反复改写。
  // 如果只在创建菜单时翻译一次，后续 checking/downloading 阶段又会退回英文。
  // 这里把 locale 和当前 updater 状态一起保存，确保每次重建菜单或切语言后都能按最新状态重新渲染。
  syncMenuItemState();
}

export function syncReadyUpdateToWindow(win: BrowserWindow) {
  const { ready } = updaterState;
  if (!ready.version || win.isDestroyed()) {
    return;
  }

  // update-downloaded 可能发生在 renderer React effect 还没挂好之前，
  // 甚至发生在窗口 reload / 新开窗口之前。这里把“已有可安装更新”视为一份持久状态，
  // 在窗口后续就绪时补发一次，避免按钮只靠那次瞬时事件而丢失。
  logger.info(`[auto-update] sync ready update to window ${win.webContents.id}: ${ready.version}`);
  win.webContents.send(PlatformChannels.UpdateReady, ready.version);
}

export function getAutoUpdaterState(): UpdateStatePayload {
  return updaterState.menu.state;
}

export function syncAutoUpdaterStateToWindow(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }

  win.webContents.send(PlatformChannels.UpdateStateChanged, updaterState.menu.state);
}

export function syncPostUpdateReleaseNotesToWindow(win: BrowserWindow) {
  const { notes } = updaterState;
  if (!notes.pending || win.isDestroyed()) {
    return;
  }

  if (isPendingReleaseNotesForFutureVersion(notes.pending)) {
    // pending release notes 是下载完成时写入的；若版本仍高于当前 app，
    // 说明更新尚未安装，不能提前作为“安装后说明”发给 renderer 静默 ack。
    return;
  }

  const assignedWindow = findLiveWindowByWebContentsId(notes.deliveredWebContentsId);
  if (assignedWindow && assignedWindow.webContents.id !== win.webContents.id) {
    return;
  }

  notes.deliveredWebContentsId = win.webContents.id;
  logger.info(
    `[auto-update] sync post-update release notes to window ${win.webContents.id}: ${notes.pending.version}`,
  );
  win.webContents.send(PlatformChannels.PostUpdateReleaseNotes, notes.pending);
}

export async function acknowledgePostUpdateReleaseNotes(
  version: string,
  settingService: SettingServiceLike,
) {
  const { notes } = updaterState;
  if (!notes.pending) {
    logger.info(
      `[auto-update] ignore release notes ack without pending payload version=${version}`,
    );
    return;
  }

  if (notes.pending.version !== version) {
    logger.warn(
      `[auto-update] ignore release notes ack version mismatch expected=${notes.pending.version} actual=${version}`,
    );
    return;
  }

  notes.acknowledgedVersions.add(version);
  await clearPendingPostUpdateReleaseNotes(settingService, "renderer-acknowledged");
}

export async function hydratePendingPostUpdateReleaseNotes(settingService: SettingServiceLike) {
  const { notes, ready } = updaterState;
  const settings = await settingService.get();
  notes.pending = settings.pendingPostUpdateReleaseNotes ?? null;
  notes.deliveredWebContentsId = null;

  if (notes.pending) {
    logger.info(
      `[auto-update] hydrated pending post-update release notes version=${notes.pending.version}`,
    );
  }

  if (
    notes.pending &&
    shouldDiscardStalePendingReleaseNotes(notes.pending.version, getCurrentAppVersionForUpdate())
  ) {
    logger.info(
      `[auto-update] discard stale post-update release notes pending=${notes.pending.version} app=${getCurrentAppVersionForUpdate()}`,
    );
    await clearPendingPostUpdateReleaseNotes(
      settingService,
      "hydrate-pending-older-than-installed-app",
    );
  }

  if (notes.pending && isPendingReleaseNotesForFutureVersion(notes.pending)) {
    // 用户下载完成但尚未安装时重启应用，electron-updater 的内存 ready 状态会丢失，
    // 但本地 pending 包和版本说明仍在。这里用“pending 版本高于当前版本”恢复待安装状态，
    // 避免已有缓存时仍提示“下载更新”，点击后又被 dev staging 错误打回 idle。
    ready.version = notes.pending.version;
    ready.releaseNotes = notes.pending;
    ready.restoredFromPendingReleaseNotes = true;
    setAutoUpdaterMenuState(buildUpdateDownloadedState(ready.version));
    logger.info(
      `[auto-update] restored ready update from pending release notes version=${ready.version}`,
    );
  }
}
