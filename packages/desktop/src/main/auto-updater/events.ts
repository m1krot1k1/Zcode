import { PlatformChannels, type UpdateCheckResultPayload } from "@zcode/shared";
import { BrowserWindow, app, ipcMain } from "electron";
import pkg from "electron-updater";
import { logger } from "../logger.js";
import {
  ensureAutoUpdatePollInterval,
  sendManualCheckResult,
  setAutoUpdaterMenuState,
} from "./channels.js";
import {
  cancelDownloadingUpdate,
  downloadAvailableUpdate,
  publishDownloadedUpdate,
  shouldIgnoreCancelledDownloadError,
  skipAvailableUpdateVersion,
} from "./download.js";
import { handleAutoUpdateFailure, quitAndInstallUpdate } from "./install.js";
import {
  applyManifestUpdateProvider,
  beginAutoUpdateCheck,
  finishAutoUpdateCheck,
  settleAutoUpdateCheckResult,
  shouldIgnoreStaleAvailableUpdate,
  syncAutoUpdateCheckChannelFromSettings,
} from "./manifest.js";
import {
  clearSkippedUpdateVersionForManualCheck,
  isSkippedUpdateVersion,
  shouldAutoDownloadAndInstallUpdates,
} from "./preferences.js";
import { toPostUpdateReleaseNotesPayload } from "./releaseNotes.js";
import {
  applyDevAutoUpdateRuntimeOverrides,
  buildDownloadProgressState,
  buildUpdateAvailableState,
  buildUpdateDownloadedState,
  canPollForUpdatesFromState,
  canUseAutoUpdaterInCurrentRuntime,
  clearAvailableUpdateState,
  clearDownloadingUpdateState,
  clearReadyUpdateState,
  getAutoUpdaterReleaseChannelForCurrentState,
  getCurrentAppVersionForUpdate,
  getForceAutoUpdateNoUpdateMessage,
  hasVisibleUpdateTarget,
  isReadyUpdateCurrentTarget,
  isUpdateTargetLocked,
  logForceAutoUpdateProgress,
  normalizeProgressPercent,
  notifyForceAutoUpdate,
  readUpdateInfoReleaseChannel,
  shouldDownloadAvailableUpdate,
  updaterState,
  type ForceAutoUpdateState,
  type InitAutoUpdaterOptions,
  type UpdateDownloadedInfoLike,
} from "./state.js";

const { autoUpdater } = pkg;

export async function initAutoUpdater(options: InitAutoUpdaterOptions = {}): Promise<void> {
  const { runtime, menu, checks, available, downloading, poll } = updaterState;
  if (options.enabled === false) {
    runtime.disabledForProductFlavor = true;
    if (poll.timer) {
      clearInterval(poll.timer);
      poll.timer = null;
    }
    logger.info("[auto-update] disabled for this desktop product flavor");
    return;
  }
  runtime.disabledForProductFlavor = false;
  if (!canUseAutoUpdaterInCurrentRuntime()) return;

  runtime.onBeforeQuitAndInstall = options.onBeforeQuitAndInstall;
  if (options.locale) {
    menu.locale = options.locale;
  }
  runtime.settingService = options.settingService;

  if (poll.timer) {
    clearInterval(poll.timer);
    poll.timer = null;
  }
  checks.inFlight = false;
  checks.activeId = null;
  checks.activeChannel = null;
  checks.settlingId = null;
  checks.pendingManifestChannelRefresh = null;
  runtime.devVersionOverride = null;
  available.channel = "stable";
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  applyDevAutoUpdateRuntimeOverrides();

  logger.info(`[auto-update] initializing, current version: ${getCurrentAppVersionForUpdate()}`);

  // 已下载旧版本后，feed 继续推进到更高版本时，主进程必须先比较远端版本和 ready 版本，
  // 再决定是否下载。若继续让 electron-updater 自动下载，它只会按当前 app 版本判断，
  // 导致 `3.1.2` 已 ready `3.1.3` 时每次轮询都可能重复下载 `3.1.3`。
  autoUpdater.autoDownload = false;
  // Bugfix: Windows/NSIS 在窗口关闭后会异步启动安装；如果用户紧接着关机，安装器可能被系统中断，
  // 留下半更新状态并导致下次启动失败。macOS/Linux 也先关掉退出即装，只在 ready 包仍等于当前目标时
  // 由 before-quit 主动安装，避免目标已经升高后退出装上旧包。
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = logger;
  applyManifestUpdateProvider(options);

  const triggerCheckForUpdates = (reason: string) => {
    if (runtime.quitAndInstallState !== "idle") return;
    if (checks.inFlight) {
      logger.info(`[auto-update] skip ${reason}: check already in flight`);
      return;
    }

    // 已展示的目标不能被一次复查盖成 checking。下载中也不另起检查，等这次下载结束后再查。
    if (reason === "poll" && !canPollForUpdatesFromState(menu.state)) {
      logger.info(`[auto-update] skip ${reason}: state=${menu.state.kind}`);
      return;
    }

    const checkId = beginAutoUpdateCheck();
    const checkForUpdatesPromise = options.settingService
      ? (async () => {
          await syncAutoUpdateCheckChannelFromSettings(checkId, options.settingService, reason);
          if (isUpdateTargetLocked()) return;
          await autoUpdater.checkForUpdates();
        })()
      : autoUpdater.checkForUpdates();

    checkForUpdatesPromise
      .catch((err) => {
        // 强更弹窗可能复用启动期后台检查；如果 checkForUpdates 直接 reject 且没有后续 error 事件，
        // 只写日志会让弹窗停在 checking。这里复用失败收敛逻辑，把状态恢复并反馈给强更监听。
        handleAutoUpdateFailure(err, `${reason} check failed`);
      })
      .finally(() => {
        finishAutoUpdateCheck(reason, checkId);
        ensureAutoUpdatePollInterval();
      });
  };
  runtime.recheckAfterDownload = (recheckReason: string) => {
    // 下载失败需要等当前检查收口。完成和取消的结果已经被这次检查覆盖，不再排队。
    if (checks.inFlight) {
      if (recheckReason === "download-failed") {
        checks.pendingFailedDownloadRecheck = true;
      }
      return;
    }
    triggerCheckForUpdates(recheckReason);
  };

  autoUpdater.on("checking-for-update", () => {
    if (isUpdateTargetLocked()) return;
    logger.info("[auto-update] checking for update...");
    if (hasVisibleUpdateTarget(menu.state) || menu.state.kind === "download-progress") {
      return;
    }
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  });

  autoUpdater.on("update-available", (info: UpdateDownloadedInfoLike) => {
    if (isUpdateTargetLocked()) return;
    logger.info(`[auto-update] new version available: ${info.version}`);
    const infoChannel = readUpdateInfoReleaseChannel(info);
    if (shouldIgnoreStaleAvailableUpdate(infoChannel)) {
      // 用户切换“接收 preview 版本”时，旧通道的 manifest 请求可能晚于新请求返回。
      // 旧结果如果继续写 menuState，或提前结束当前 generation，会让独立更新弹窗继续显示旧版本/旧 release notes。
      logger.info(
        `[auto-update] ignore stale update channel=${infoChannel} expected=${checks.activeChannel ?? available.channel} version=${info.version}`,
      );
      return;
    }

    void settleAutoUpdateCheckResult("update available", async () => {
      if (!shouldDownloadAvailableUpdate(info.version)) {
        const readyVersion = updaterState.ready.version ?? info.version;
        logger.info(
          `[auto-update] keep downloaded update version=${readyVersion}; remote=${info.version}`,
        );
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyVersion));
        sendManualCheckResult({ kind: "ready", version: readyVersion });
        return;
      }

      const channel = infoChannel ?? available.channel;
      const skipped = await isSkippedUpdateVersion(info.version, channel, options.settingService);
      if (isUpdateTargetLocked()) return;
      if (skipped) {
        logger.info(
          `[auto-update] ignore skipped update channel=${channel} version=${info.version}`,
        );
        clearAvailableUpdateState();
        setAutoUpdaterMenuState({ kind: "idle", enabled: true });
        sendManualCheckResult({
          kind: "up-to-date",
          currentVersion: getCurrentAppVersionForUpdate(),
        });
        return;
      }

      available.releaseNotes = toPostUpdateReleaseNotesPayload(info);
      if (updaterState.ready.restoredFromPendingReleaseNotes) {
        // pendingPostUpdateReleaseNotes 只能证明“曾经下载完成并持久化了版本说明”，
        // 不能恢复当前进程里的 electron-updater downloadedUpdateHelper、Squirrel.Mac proxy server
        // 或 native staged update。遇到 manifest 再次确认同版本可用时必须清掉伪 ready，
        // 重新 downloadUpdate，让缓存命中/重新下载后的 update-downloaded 建立真实安装上下文。
        clearReadyUpdateState();
      }
      setAutoUpdaterMenuState(
        buildUpdateAvailableState(info.version, available.releaseNotes, channel),
      );

      if (updaterState.listeners.force) {
        downloadAvailableUpdate("force-update");
        return;
      }

      const autoDownload = await shouldAutoDownloadAndInstallUpdates(options.settingService);
      if (isUpdateTargetLocked()) return;
      if (autoDownload) {
        // 功能原因：自动下载偏好属于 main 进程更新状态机，不能依赖 renderer 弹窗是否打开。
        // 检测到更新后复用手动下载入口，保持取消、缓存命中、失败恢复等行为完全一致。
        downloadAvailableUpdate("auto-download");
        return;
      }

      sendManualCheckResult({
        kind: "available",
        version: info.version,
        channel,
        ...(available.releaseNotes ? { releaseNotes: available.releaseNotes } : {}),
      });
    }).catch((error) => {
      handleAutoUpdateFailure(error, "update available failed");
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    if (isUpdateTargetLocked()) return;
    void settleAutoUpdateCheckResult("update not available", () => {
      logger.info(
        `[auto-update] already up to date (local=${getCurrentAppVersionForUpdate()}, remote=${info.version})`,
      );
      if (updaterState.ready.version && isReadyUpdateCurrentTarget()) {
        setAutoUpdaterMenuState(buildUpdateDownloadedState(updaterState.ready.version));
        sendManualCheckResult({ kind: "ready", version: updaterState.ready.version });
        return;
      }
      if (hasVisibleUpdateTarget(menu.state)) {
        sendManualCheckResult({
          kind: "available",
          version:
            menu.state.kind === "update-available"
              ? menu.state.version
              : (updaterState.ready.version ?? ""),
          ...("channel" in menu.state && menu.state.channel ? { channel: menu.state.channel } : {}),
        });
        return;
      }

      clearAvailableUpdateState();
      clearDownloadingUpdateState();
      setAutoUpdaterMenuState({ kind: "idle", enabled: true });
      // 强制升级弹窗复用启动期检查时，也必须在无可用更新时给出闭环反馈，避免一直停在 checking。
      notifyForceAutoUpdate({
        kind: "error",
        message: getForceAutoUpdateNoUpdateMessage(),
      });
      sendManualCheckResult({
        kind: "up-to-date",
        currentVersion: getCurrentAppVersionForUpdate(),
      });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    if (isUpdateTargetLocked()) return;
    // 用户快速取消下载后，electron-updater 可能还会补发旧下载流的 progress。
    // 如果继续接收这个陈旧事件，UI 会从“可更新”被重新推回“下载中”，看起来像取消后卡住。
    if (!downloading.cancellationToken || downloading.cancellationToken.cancelled) {
      return;
    }

    if (menu.state.kind !== "download-progress" && menu.state.kind !== "update-available") {
      return;
    }

    const normalizedProgress = normalizeProgressPercent(progress) ?? progress.percent.toFixed(0);
    logger.info(
      `[auto-update] download progress: ${progress.percent.toFixed(1)}% (${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s, ${(progress.transferred / 1024 / 1024).toFixed(1)}/${(progress.total / 1024 / 1024).toFixed(1)} MB)`,
    );
    if (menu.state.kind === "update-available") {
      clearAvailableUpdateState();
    }
    setAutoUpdaterMenuState(
      buildDownloadProgressState(normalizedProgress, {
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
      }),
    );
    logForceAutoUpdateProgress(normalizedProgress);
    notifyForceAutoUpdate({
      kind: "downloading",
      ...(downloading.version ? { version: downloading.version } : {}),
      progress: normalizedProgress,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedInfoLike) => {
    if (isUpdateTargetLocked()) return;
    if (downloading.cancellationToken) {
      // updater 会在 downloadUpdate Promise 收口前同步发 ready；缓存写入仍可能失败并清包。
      // 以下载成功为唯一发布点，避免安装依赖无完成保证的在途下载，也避免失败包被提前安装。
      if (!downloading.cancellationToken.cancelled) {
        downloading.pendingDownloaded = { token: downloading.cancellationToken, info };
      }
      return;
    }
    publishDownloadedUpdate(info);
  });

  autoUpdater.on("error", (err, detail: unknown) => {
    // 锁定依赖中 checkForUpdates 会携带这个来源，Mac 原生错误仅传 Error。
    // 已接受的检查可以迟到失败，不能把它误判成正在安装的原生包失败。
    if (typeof detail === "string" && detail.startsWith("Cannot check for updates:")) {
      handleAutoUpdateFailure(err, "background check failed");
      return;
    }
    if (shouldIgnoreCancelledDownloadError(err)) {
      // electron-updater 在取消下载后可能异步补发 error("cancelled")。
      // 用户取消已经把状态恢复到可重试的 update-available，迟到取消事件不能再清空入口。
      logger.info("[auto-update] ignore delayed error from cancelled download");
      return;
    }

    void settleAutoUpdateCheckResult("error", () => {
      handleAutoUpdateFailure(err, "error");
    });
  });

  ipcMain.handle(PlatformChannels.QuitAndInstallUpdate, () =>
    // renderer 只有在 IPC reject 时才知道安装器没有接管。ready 失效或
    // 退出准备失败不能返回成功 ACK，否则“重启以更新”会永久保持 pending。
    quitAndInstallUpdate(true),
  );
  ipcMain.on(PlatformChannels.QuitAndInstallUpdate, () => {
    void quitAndInstallUpdate();
  });
  ipcMain.handle(PlatformChannels.DownloadUpdate, () => {
    downloadAvailableUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.CancelUpdateDownload, () => {
    cancelDownloadingUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.SkipUpdateVersion, async (_event, version: unknown) => {
    const validatedVersion = typeof version === "string" ? version.trim() : "";
    if (!validatedVersion) {
      logger.warn("[auto-update] ignore empty skipped update version");
      return;
    }
    await skipAvailableUpdateVersion(validatedVersion, options.settingService);
  });

  triggerCheckForUpdates("startup");
  ensureAutoUpdatePollInterval();
  app.on("before-quit", (event) => {
    if (
      process.platform === "win32" ||
      runtime.quitAndInstallState !== "idle" ||
      !isReadyUpdateCurrentTarget()
    ) {
      return;
    }
    event.preventDefault();
    void quitAndInstallUpdate();
  });
}

export function requestForceAutoUpdate(
  onStateChange: (state: ForceAutoUpdateState) => void,
  reason = "force-update",
  _minimumVersion?: string,
) {
  const { runtime, menu, listeners, checks, ready } = updaterState;
  const dispose = () => {
    if (listeners.force === onStateChange) {
      listeners.force = null;
    }
  };

  listeners.force = onStateChange;
  listeners.forceProgressBucket = null;
  logger.info(`[force-update] 自动升级开始 reason=${reason}`);
  if (runtime.quitAndInstallState !== "idle") {
    onStateChange({ kind: "installing" });
    return dispose;
  }
  onStateChange({ kind: "checking" });

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    const message = "not packaged";
    logger.info(`[force-update] 自动升级跳过：${message}`);
    onStateChange({ kind: "dev-skipped", message });
    return dispose;
  }

  if (menu.state.kind === "update-downloaded") {
    onStateChange({ kind: "installing" });
    void quitAndInstallUpdate();
    return dispose;
  }

  if (menu.state.kind === "update-available") {
    downloadAvailableUpdate("force-update");
    return dispose;
  }

  if (menu.state.kind === "download-progress") {
    onStateChange({
      kind: "downloading",
      ...("version" in menu.state && menu.state.version ? { version: menu.state.version } : {}),
      progress: menu.state.progress,
    });
    return dispose;
  }

  if (checks.inFlight) {
    logger.info(`[force-update] 自动升级复用进行中的更新检查`);
    return dispose;
  }

  const checkId = beginAutoUpdateCheck();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      if (isUpdateTargetLocked()) return;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        ready.version ? buildUpdateDownloadedState(ready.version) : { kind: "idle", enabled: true },
      );
      onStateChange({ kind: "error", message });
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });

  return () => {
    if (listeners.force === onStateChange) {
      listeners.force = null;
    }
  };
}

export function requestAutoUpdateCheckWithoutWindow(reason = "force-update") {
  const { runtime, menu, checks, ready } = updaterState;
  if (runtime.quitAndInstallState !== "idle") return;
  logger.info(`[auto-update] ${reason}: user requested update check without renderer window`);

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    return;
  }

  if (menu.state.kind === "update-downloaded") {
    void quitAndInstallUpdate();
    return;
  }
  if (menu.state.kind === "update-available") {
    downloadAvailableUpdate(reason);
    return;
  }
  if (menu.state.kind === "download-progress") {
    logger.info(`[auto-update] skip ${reason}: update already ${menu.state.kind}`);
    return;
  }
  if (checks.inFlight) {
    logger.info(`[auto-update] skip ${reason}: check already in flight`);
    return;
  }

  const checkId = beginAutoUpdateCheck();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      if (isUpdateTargetLocked()) return;
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        ready.version ? buildUpdateDownloadedState(ready.version) : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });
}

export function checkForUpdateMenuClick(originWindow?: BrowserWindow | null) {
  const { runtime, menu, checks, downloading, ready } = updaterState;
  if (runtime.quitAndInstallState !== "idle") return;
  logger.info("[auto-update] user clicked Check for Updates");

  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      ? originWindow
      : (BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
        null);

  if (!targetWindow) {
    logger.warn("[auto-update] manual check: no target window to report to");
    return;
  }

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info("[auto-update] skip manual check: not packaged");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (runtime.disabledForProductFlavor) {
    // 入口本应已按产品身份隐藏；这里是最后一道闸，不让未初始化的 updater 实例向占位 feed 发请求。
    logger.info("[auto-update] skip manual check: updater disabled for this product flavor");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (menu.state.kind === "update-downloaded" && isReadyUpdateCurrentTarget()) {
    // 菜单文案已经是“重启以更新”。只有 ready 包仍等于当前目标时才安装；
    // 目标已经更高时落到下面的重新检查，避免装上旧包。
    void quitAndInstallUpdate();
    return;
  }
  if (menu.state.kind === "download-progress") {
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "already-downloading",
      version: downloading.version ?? ready.version ?? "",
      progress: menu.state.progress,
    } satisfies UpdateCheckResultPayload);
    return;
  }
  if (checks.inFlight) {
    logger.info("[auto-update] skip manual check: check already in flight");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "error",
      message: "Update check already in progress.",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  runtime.manualCheckWebContentsId = targetWindow.webContents.id;
  const manualCheckChannel = getAutoUpdaterReleaseChannelForCurrentState();
  // 已发现的版本继续显示，检查结果回来后再替换，避免菜单先闪成“正在检查”。
  if (!hasVisibleUpdateTarget(menu.state)) {
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  }
  const checkId = beginAutoUpdateCheck();
  (async () => {
    await clearSkippedUpdateVersionForManualCheck(manualCheckChannel, runtime.settingService);
    if (isUpdateTargetLocked()) return;
    await autoUpdater.checkForUpdates();
  })()
    .catch((err) => {
      if (isUpdateTargetLocked()) return;
      logger.error("[auto-update] manual check failed:", err);
      sendManualCheckResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      finishAutoUpdateCheck("manual check", checkId);
    });
}
