import type { ElectronReleaseChannel } from "@zcode/shared";
import { BrowserWindow } from "electron";
import pkg, { CancellationToken } from "electron-updater";
import { logger } from "../logger.js";
import { setAutoUpdaterMenuState, syncReadyUpdateToWindow } from "./channels.js";
import { handleAutoUpdateFailure, quitAndInstallUpdate } from "./install.js";
import {
  clearPendingPostUpdateReleaseNotes,
  persistPendingPostUpdateReleaseNotes,
  toPostUpdateReleaseNotesPayload,
} from "./releaseNotes.js";
import {
  buildUpdateAvailableState,
  buildUpdateDownloadedState,
  canUseAutoUpdaterInCurrentRuntime,
  clearAvailableUpdateState,
  clearDownloadingUpdateState,
  crossModuleActions,
  isUpdateTargetLocked,
  notifyForceAutoUpdate,
  updaterState,
  type SettingServiceLike,
  type UpdateDownloadedInfoLike,
} from "./state.js";

const { autoUpdater } = pkg;

function isCancelledDownload(cancellationToken: CancellationToken, error: unknown): boolean {
  return (
    updaterState.runtime.cancelledDownloadTokens.has(cancellationToken) ||
    (cancellationToken.cancelled && isDownloadCancellationError(error))
  );
}

function isDownloadCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === "cancelled";
}

function markCancelledDownload(cancellationToken: CancellationToken) {
  const { runtime } = updaterState;
  runtime.cancelledDownloadTokens.add(cancellationToken);
  runtime.pendingCancelledDownloadErrorCount += 1;
}

export function shouldIgnoreCancelledDownloadError(error: unknown): boolean {
  const { runtime } = updaterState;
  if (runtime.pendingCancelledDownloadErrorCount <= 0 || !isDownloadCancellationError(error)) {
    return false;
  }

  runtime.pendingCancelledDownloadErrorCount -= 1;
  return true;
}

export function publishDownloadedUpdate(info: UpdateDownloadedInfoLike): void {
  const { runtime, ready, available, downloading, listeners } = updaterState;
  ready.version = info.version;
  ready.restoredFromPendingReleaseNotes = false;
  ready.channel = downloading.channel ?? available.channel;
  ready.releaseNotes = toPostUpdateReleaseNotesPayload(info) ?? downloading.releaseNotes;
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  logger.info(
    `[auto-update] downloaded: ${info.version}, ${process.platform === "win32" ? "waiting for explicit install" : "ready to install on quit or explicit install"}`,
  );
  setAutoUpdaterMenuState(buildUpdateDownloadedState(info.version));
  notifyForceAutoUpdate({ kind: "ready", version: info.version });
  if (!listeners.force) {
    runtime.recheckAfterDownload?.("download-finished");
  }

  if (listeners.force) {
    notifyForceAutoUpdate({ kind: "installing" });
    void quitAndInstallUpdate();
  }

  if (runtime.settingService) {
    const releaseNotesPayload = ready.releaseNotes;
    const persistTask = releaseNotesPayload
      ? persistPendingPostUpdateReleaseNotes(
          runtime.settingService,
          releaseNotesPayload,
          "update-downloaded",
        )
      : clearPendingPostUpdateReleaseNotes(
          runtime.settingService,
          "update-downloaded-without-release-notes",
        );

    void persistTask.catch((error) => {
      logger.error("[auto-update] persist post-update release notes failed:", error);
    });
  }

  for (const win of BrowserWindow.getAllWindows()) {
    syncReadyUpdateToWindow(win);
  }
}

export function downloadAvailableUpdate(reason = "renderer") {
  const { menu, available, downloading } = updaterState;
  if (isUpdateTargetLocked()) return;
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason} download: not packaged`);
    return;
  }

  if (menu.state.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason} download: update already ready`);
    return;
  }

  if (menu.state.kind === "download-progress") {
    logger.info(`[auto-update] skip ${reason} download: download already in progress`);
    return;
  }

  if (downloading.cancellationToken) {
    logger.info(`[auto-update] skip ${reason} download: download already requested`);
    return;
  }

  if (menu.state.kind !== "update-available") {
    logger.info(`[auto-update] skip ${reason} download: state=${menu.state.kind}`);
    return;
  }

  downloading.version = menu.state.version;
  downloading.releaseNotes = menu.state.releaseNotes ?? available.releaseNotes;
  downloading.channel = menu.state.channel ?? available.channel;
  // electron-updater 如果命中本地已下载缓存，会在 downloadUpdate() 内直接触发
  // update-downloaded。这里不能先广播 0% 下载态，否则用户会先看到“下载中”，
  // 再跳到“已下载”；真实下载态改由第一条 download-progress 事件驱动。
  notifyForceAutoUpdate({
    kind: "downloading",
    version: downloading.version,
    progress: "0",
  });

  const cancellationToken = new CancellationToken();
  downloading.cancellationToken = cancellationToken;
  downloading.pendingDownloaded = null;
  autoUpdater
    .downloadUpdate(cancellationToken)
    .then(() => {
      if (downloading.cancellationToken !== cancellationToken) return;
      const downloaded = downloading.pendingDownloaded;
      downloading.pendingDownloaded = null;
      downloading.cancellationToken = null;
      if (
        downloaded?.token === cancellationToken &&
        !cancellationToken.cancelled &&
        !isUpdateTargetLocked()
      ) {
        publishDownloadedUpdate(downloaded.info);
      }
    })
    .catch((error) => {
      if (isCancelledDownload(cancellationToken, error)) {
        logger.info(`[auto-update] ${reason} download cancelled`);
        return;
      }
      // 下载由用户点击或强更 gate 显式触发，Promise reject 也必须立即反馈。
      // 不能只依赖 electron-updater 后续是否额外触发 error 事件，否则 UI 会卡在下载态。
      handleAutoUpdateFailure(error, "download update failed");
    })
    .finally(() => {
      if (downloading.cancellationToken === cancellationToken) {
        downloading.cancellationToken = null;
        downloading.pendingDownloaded = null;
      }
      cancellationToken.dispose();
    });
}

export function cancelDownloadingUpdate(reason = "renderer") {
  const { runtime, menu, available, downloading, ready, listeners } = updaterState;
  if (listeners.force) {
    logger.info(`[auto-update] skip ${reason} cancel download: force update active`);
    return;
  }

  if (menu.state.kind !== "download-progress" || !downloading.cancellationToken) {
    logger.info(`[auto-update] skip ${reason} cancel download: state=${menu.state.kind}`);
    return;
  }

  const version = downloading.version;
  const releaseNotes = downloading.releaseNotes;
  const channel = downloading.channel ?? available.channel;
  const cancellationToken = downloading.cancellationToken;
  markCancelledDownload(cancellationToken);
  cancellationToken.cancel();
  logger.info(
    `[auto-update] ${reason}: cancel download channel=${channel} version=${version ?? "unknown"}`,
  );

  // 取消下载不是跳过版本，只回退到发现更新状态，保留同一份 manifest 信息让用户可以稍后重试。
  clearDownloadingUpdateState();
  if (version) {
    available.releaseNotes = releaseNotes;
    available.channel = channel;
    setAutoUpdaterMenuState(buildUpdateAvailableState(version, releaseNotes, channel));
    runtime.recheckAfterDownload?.("download-finished");
    return;
  }

  setAutoUpdaterMenuState(
    ready.version ? buildUpdateDownloadedState(ready.version) : { kind: "idle", enabled: true },
  );
}

export async function skipAvailableUpdateVersion(
  version: string,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  const { menu, available, downloading, ready, listeners } = updaterState;
  if (listeners.force) {
    logger.info(`[auto-update] ignore skip version=${version}: force update active`);
    return;
  }

  if (
    (menu.state.kind !== "update-available" && menu.state.kind !== "download-progress") ||
    menu.state.version !== version
  ) {
    logger.info(`[auto-update] ignore skip version=${version}: state=${menu.state.kind}`);
    return;
  }

  const channel: ElectronReleaseChannel =
    menu.state.channel ??
    (menu.state.kind === "download-progress" ? downloading.channel : available.channel) ??
    available.channel;
  if (downloading.cancellationToken) {
    markCancelledDownload(downloading.cancellationToken);
    downloading.cancellationToken.cancel();
    logger.info(
      `[auto-update] skipped downloading version; cancel active download channel=${channel} version=${version}`,
    );
  }

  // 下载态弹窗仍需要允许用户跳过当前版本。
  // 如果 main 只接受 update-available，UI 中点击“跳过此版本”会变成 no-op；
  // 这里在持久化跳过前取消当前下载，并清理下载态，避免后台继续拉取已跳过版本。
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  setAutoUpdaterMenuState(
    ready.version ? buildUpdateDownloadedState(ready.version) : { kind: "idle", enabled: true },
  );

  if (!settingService) {
    logger.warn(
      `[auto-update] skipped version not persisted because setting service is missing version=${version}`,
    );
    return;
  }

  try {
    const settings = await settingService.get();
    await settingService.update({
      skippedElectronUpdateVersions: {
        ...settings.skippedElectronUpdateVersions,
        [channel]: version,
      },
    });
    logger.info(`[auto-update] skipped version persisted channel=${channel} version=${version}`);
  } catch (error) {
    logger.error("[auto-update] persist skipped update version failed:", error);
  }
}

// install 模块重排 restored pending 更新后需要重新下载；在此注册实现，避免 download/install 相互 import 成环。
crossModuleActions.downloadAvailableUpdate = downloadAvailableUpdate;
