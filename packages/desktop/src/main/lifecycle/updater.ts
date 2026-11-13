import { BrowserWindow } from "electron";
import { PlatformChannels, type Locale, type appSettingsPatchSchema } from "@zcode/shared";
import { logger } from "../logger.js";
import {
  getAutoUpdaterState,
  onAutoUpdaterStateChanged,
  syncAutoUpdaterStateToWindow,
  syncPostUpdateReleaseNotesToWindow,
  syncReadyUpdateToWindow,
} from "../autoUpdater.js";
import { loadWindow } from "../desktopHostProcess.js";
import type { UpdateStatePayload } from "@zcode/shared";
import type { MainSettingService } from "./services.js";

const UPDATE_STATUS_WINDOW_WIDTH = 512;
const UPDATE_STATUS_WINDOW_COMPACT_HEIGHT = 205;
const UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT = 224;
const UPDATE_STATUS_WINDOW_READY_HEIGHT = UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT - 54;
const UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION = { x: 10, y: 10 } as const;

export interface UpdaterLifecycle {
  openUpdateStatusWindow: () => void;
  getAutoUpdatePreferences: () => Promise<{ autoDownloadAndInstallUpdates: boolean }>;
  setAutoDownloadAndInstallUpdates: (enabled: boolean) => Promise<void>;
  getMainApplicationWindows: () => import("electron").BrowserWindow[];
}

export interface UpdaterLifecycleOptions {
  iconPath: string;
  preloadPath: string;
  deviceMid: string;
  forceQuitRef: { current: boolean };
  getApplicationLocale: () => Locale;
  getApplicationWindows: () => BrowserWindow[];
  mainSettingService: MainSettingService;
  syncImmediateAppSettings: (patch: ReturnType<typeof appSettingsPatchSchema.parse>) => void;
}

export function createUpdaterLifecycle(options: UpdaterLifecycleOptions): UpdaterLifecycle {
  const { forceQuitRef } = options;
  let updateStatusWindow: BrowserWindow | null = null;

  function getMainApplicationWindows(): BrowserWindow[] {
    return options.getApplicationWindows().filter((win) => win !== updateStatusWindow);
  }

  function isUpdateStatusWindowCloseLocked(state: UpdateStatePayload) {
    return state.kind === "download-progress" || state.kind === "update-downloaded";
  }

  function syncUpdateStatusWindowClosePolicy(win: BrowserWindow) {
    if (win.isDestroyed()) {
      return;
    }
    const closeLocked = isUpdateStatusWindowCloseLocked(getAutoUpdaterState());
    win.setClosable(!closeLocked || forceQuitRef.current);
    win.setMinimizable(true);
  }

  function syncUpdateStatusWindowChrome(win: BrowserWindow) {
    if (win.isDestroyed() || process.platform !== "darwin") {
      return;
    }
    // 独立更新窗口的红绿灯位置不能只依赖 BrowserWindow 构造参数。
    // macOS 在窗口 show / resize 后可能继续沿用 hidden titlebar 的默认坐标，
    // 因此每次同步布局时都显式写入更靠上的按钮位置。
    win.setWindowButtonPosition(UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION);
  }

  function resolveUpdateStatusWindowHeight(state: UpdateStatePayload) {
    if (state.kind === "download-progress") {
      return UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT;
    }
    if (state.kind === "update-downloaded") {
      return UPDATE_STATUS_WINDOW_READY_HEIGHT;
    }
    return UPDATE_STATUS_WINDOW_COMPACT_HEIGHT;
  }

  function shouldUseUpdateStatusWindowContentSize(): boolean {
    return process.platform === "linux";
  }

  function syncUpdateStatusWindowLayout(win: BrowserWindow) {
    if (win.isDestroyed()) {
      return;
    }
    const state = getAutoUpdaterState();
    const height = resolveUpdateStatusWindowHeight(state);
    const bounds = shouldUseUpdateStatusWindowContentSize()
      ? win.getContentBounds()
      : win.getBounds();
    if (!shouldUseUpdateStatusWindowContentSize()) {
      win.setMinimumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
      win.setMaximumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    }
    if (bounds.width !== UPDATE_STATUS_WINDOW_WIDTH || bounds.height !== height) {
      // 独立更新窗口复用页内 Dialog 的 240px 高度后，普通状态只有两行内容，
      // footer 会吃掉剩余网格行形成大块空白；按状态收紧窗口高度，让内容贴合实际密度。
      // 取消下载会从 download-progress 回到 update-available；这里同步 min/max 再 setSize，
      // 避免 macOS 在非 resizable BrowserWindow 上沿用下载态高度，导致弹窗没有收回。
      if (shouldUseUpdateStatusWindowContentSize()) {
        // Linux 的系统标题栏会占用 BrowserWindow 外框高度。
        // 如果继续用 setSize 锁外框，WebContents 实际高度会少一截，底部按钮被裁掉。
        win.setContentSize(UPDATE_STATUS_WINDOW_WIDTH, height);
      } else {
        win.setSize(UPDATE_STATUS_WINDOW_WIDTH, height);
      }
    }
    syncUpdateStatusWindowChrome(win);
  }

  function openUpdateStatusWindow() {
    if (updateStatusWindow && !updateStatusWindow.isDestroyed()) {
      if (updateStatusWindow.isMinimized()) {
        updateStatusWindow.restore();
      }
      updateStatusWindow.show();
      updateStatusWindow.focus();
      syncAutoUpdaterStateToWindow(updateStatusWindow);
      syncReadyUpdateToWindow(updateStatusWindow);
      syncPostUpdateReleaseNotesToWindow(updateStatusWindow);
      syncUpdateStatusWindowClosePolicy(updateStatusWindow);
      syncUpdateStatusWindowLayout(updateStatusWindow);
      return;
    }

    const parentWindow =
      getMainApplicationWindows().find((candidate) => candidate.isFocused()) ??
      getMainApplicationWindows()[0] ??
      undefined;
    const win = new BrowserWindow({
      width: UPDATE_STATUS_WINDOW_WIDTH,
      height: resolveUpdateStatusWindowHeight(getAutoUpdaterState()),
      useContentSize: shouldUseUpdateStatusWindowContentSize(),
      ...(shouldUseUpdateStatusWindowContentSize()
        ? {}
        : {
            minWidth: UPDATE_STATUS_WINDOW_WIDTH,
            minHeight: UPDATE_STATUS_WINDOW_READY_HEIGHT,
            maxWidth: UPDATE_STATUS_WINDOW_WIDTH,
            maxHeight: UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT,
          }),
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // 更新状态已经从页内 Dialog 改成独立 BrowserWindow。
      // 独立窗口应保留系统窗口控件，不能沿用页内弹窗时期的无边框透明窗口配置。
      frame: true,
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hidden" as const,
            trafficLightPosition: UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION,
          }
        : process.platform === "win32"
          ? {
              titleBarStyle: "hidden" as const,
              titleBarOverlay: true,
            }
          : {}),
      transparent: false,
      backgroundColor: "#ffffff",
      title: "",
      icon: options.iconPath,
      parent: parentWindow,
      modal: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        additionalArguments: [`--device-id=${options.deviceMid}`],
      },
    });
    // 更新窗口要保留系统窗口控件，但不能允许缩放或全屏。
    // 构造参数之外再显式锁定一次，避免不同平台对标题栏控件能力的默认处理不一致。
    win.setResizable(false);
    win.setMinimizable(true);
    win.setMaximizable(false);
    win.setFullScreenable(false);
    if (process.platform === "darwin") {
      syncUpdateStatusWindowChrome(win);
    }
    syncUpdateStatusWindowClosePolicy(win);
    syncUpdateStatusWindowLayout(win);

    updateStatusWindow = win;
    const disposeAutoUpdaterStateListener = onAutoUpdaterStateChanged(() => {
      syncUpdateStatusWindowClosePolicy(win);
      syncUpdateStatusWindowLayout(win);
    });
    const showUpdateStatusWindow = () => {
      if (win.isDestroyed()) {
        return;
      }
      if (!win.isVisible()) {
        win.center();
        syncUpdateStatusWindowChrome(win);
        win.show();
        syncUpdateStatusWindowChrome(win);
      }
      win.moveTop();
      win.focus();
      win.setAlwaysOnTop(true, "floating");
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.setAlwaysOnTop(false);
        }
      }, 250);
      logger.info(
        `[auto-update] update status window shown visible=${win.isVisible()} focused=${win.isFocused()} bounds=${JSON.stringify(win.getBounds())}`,
      );
    };
    win.webContents.on("dom-ready", () => {
      logger.info("[auto-update] update status window dom-ready");
      syncAutoUpdaterStateToWindow(win);
      syncReadyUpdateToWindow(win);
      syncPostUpdateReleaseNotesToWindow(win);
      // 更新窗口在开发态或部分 macOS 渲染路径下不一定稳定触发 ready-to-show。
      // 加载完成后也尝试显示，避免窗口已加载却保持隐藏，让更新入口看起来无响应。
      setTimeout(showUpdateStatusWindow, 0);
    });
    win.once("ready-to-show", () => {
      showUpdateStatusWindow();
    });
    win.on("close", (event) => {
      if (forceQuitRef.current || !isUpdateStatusWindowCloseLocked(getAutoUpdaterState())) {
        return;
      }
      // 下载开始后更新窗口承担安装状态反馈，用户仍可最小化，但不能误关闭窗口。
      // close 事件兜底拦截 native close / 快捷键路径，setClosable(false) 只负责系统控件状态。
      event.preventDefault();
      if (win.isMinimized()) {
        win.restore();
      }
      win.show();
      win.focus();
    });
    win.on("closed", () => {
      disposeAutoUpdaterStateListener();
      if (updateStatusWindow === win) {
        updateStatusWindow = null;
      }
    });

    loadWindow(win, "index", {
      restoreSession: false,
      supportsSettings: false,
      windowKind: "update-status",
      locale: options.getApplicationLocale(),
    });
  }

  async function getAutoUpdatePreferences() {
    const settings = await options.mainSettingService.get();
    return {
      autoDownloadAndInstallUpdates: settings.autoDownloadAndInstallUpdates ?? false,
    };
  }

  async function setAutoDownloadAndInstallUpdates(enabled: boolean) {
    await options.mainSettingService.update({
      autoDownloadAndInstallUpdates: enabled,
    });
    options.syncImmediateAppSettings({
      autoDownloadAndInstallUpdates: enabled,
    });
    for (const win of options.getApplicationWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PlatformChannels.SettingsChanged);
      }
    }
  }

  return {
    openUpdateStatusWindow,
    getAutoUpdatePreferences,
    setAutoDownloadAndInstallUpdates,
    getMainApplicationWindows,
  };
}
