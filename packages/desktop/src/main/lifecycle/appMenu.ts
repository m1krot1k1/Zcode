import { app, BrowserWindow } from "electron";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, ZCODE_ENV, type Locale } from "@zcode/shared";
import { logger } from "../logger.js";
import {
  rebuildApplicationMenu,
  updateZCodeStdioTapDevMenuState,
} from "../desktopApplicationMenu.js";
import { executeDesktopCommand } from "../desktopCommandHandlers.js";
import { clampDesktopZoomLevel, resolveDesktopZoomLevelFromFactor } from "../desktopZoom.js";
import { updateWindowsDesktopTrayMenu } from "../desktopTray.js";
import type { MainSettingService } from "./services.js";
import type { WebRemoteControlManager } from "./services.js";

export interface AppMenuLifecycleOptions {
  mainSettingService: MainSettingService;
  readHelpConfig: Parameters<typeof executeDesktopCommand>[0]["fetchHelpConfig"];
  getApplicationLocale: () => Locale;
  getApplicationWindows: () => BrowserWindow[];
  setDesktopZoomLevel: (zoomLevel: number) => void;
  resolveCurrentZCodeEndpointOrigin: () => Promise<string>;
  webRemoteControlManagerRef: { current: WebRemoteControlManager | null };
  prepareAppQuit: (reason: string) => Promise<void>;
  hostProcessLocalEnv: Record<string, string>;
  getCredentialsDir: () => string;
  resolveZCodeEndpointEnvBaseOrigin: (env: Record<string, string>) => string | undefined;
}

export interface AppMenuLifecycle {
  rebuildMenu: () => void;
  executeDesktopCommandForApp: (
    command: Parameters<typeof executeDesktopCommand>[0]["command"],
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  setShortcutRecordingActive: (active: boolean, ownerWebContentsId?: number | null) => void;
  resetShortcutRecordingForWebContents: (webContentsId: number) => void;
}

export function createAppMenuLifecycle(options: AppMenuLifecycleOptions): AppMenuLifecycle {
  /** 快捷键设置页录制态（renderer 经 SetShortcutRecordingActive 同步）；true 时菜单摘除可配置 accelerator。 */
  let shortcutRecordingActive = false;
  /** 发起录制的 webContents id；窗口关闭/崩溃时 renderer 不会发复位 IPC，main 侧据此收口。 */
  let shortcutRecordingOwnerWebContentsId: number | null = null;

  async function resolveZCodeEndpointSelection(): Promise<"production" | "test" | "custom"> {
    if (ZCODE_ENV === "production") {
      return "production";
    }
    const origin = await options.resolveCurrentZCodeEndpointOrigin();
    if (origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
      return "production";
    }
    if (origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
      return "test";
    }
    return "custom";
  }

  async function handleZCodeEndpointChanged() {
    rebuildMenu();
    for (const win of options.getApplicationWindows()) {
      await options.webRemoteControlManagerRef.current?.suspend(win.id, "endpoint-changed");
    }
  }

  async function executeDesktopCommandForApp(
    command: Parameters<typeof executeDesktopCommand>[0]["command"],
    senderWindow?: BrowserWindow | null,
  ) {
    return executeDesktopCommand({
      fetchHelpConfig: options.readHelpConfig,
      command,
      senderWindow,
      logger,
      updateZCodeStdioTapDevMenuState,
      onDesktopZoomChanged: (zoomLevel) => {
        options.setDesktopZoomLevel(clampDesktopZoomLevel(zoomLevel));
        rebuildMenu();
      },
      settingService: options.mainSettingService,
      onZCodeEndpointChanged: handleZCodeEndpointChanged,
      zcodeEndpointEnvBaseOrigin: options.resolveZCodeEndpointEnvBaseOrigin(
        options.hostProcessLocalEnv,
      ),
      onRelaunchApp: async () => {
        await options.prepareAppQuit("desktop-command-relaunch");
        app.relaunch();
        app.quit();
      },
      credentialsDir: options.getCredentialsDir(),
      currentApplicationLocale: options.getApplicationLocale(),
    });
  }

  function resolveFocusedDesktopZoomLevel(): number {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (!focusedWindow || focusedWindow.isDestroyed()) {
      return 0;
    }
    return resolveDesktopZoomLevelFromFactor(focusedWindow.webContents.getZoomFactor());
  }

  function rebuildMenu() {
    void Promise.all([resolveZCodeEndpointSelection(), options.mainSettingService.get()]).then(
      ([zcodeEndpointSelection, settings]) => {
        rebuildApplicationMenu({
          currentApplicationLocale: options.getApplicationLocale(),
          zcodeEndpointSelection,
          executeDesktopCommand: executeDesktopCommandForApp,
          currentZoomLevel: resolveFocusedDesktopZoomLevel(),
          // 菜单 accelerator 跟随用户快捷键设置（shortcutBindings 用户覆盖）
          shortcutBindings: settings.shortcutBindings,
          // 快捷键录制态：摘掉可配置 accelerator，防止录制 menu 通道命令时按键直接触发原命令
          // （macOS 系统菜单先于 renderer 吃掉按键，renderer 侧 preventDefault 拦不住）。
          disableShortcutAccelerators: shortcutRecordingActive,
        });
      },
    );
    updateWindowsDesktopTrayMenu();
  }

  function setShortcutRecordingActive(active: boolean, ownerWebContentsId: number | null = null) {
    if (active) {
      shortcutRecordingOwnerWebContentsId = ownerWebContentsId;
    }
    if (shortcutRecordingActive === active) {
      return;
    }
    shortcutRecordingActive = active;
    if (!active) {
      shortcutRecordingOwnerWebContentsId = null;
    }
    rebuildMenu();
  }

  /**
   * 录制态是跨进程的临时全局状态，收口不能依赖 renderer 合作——录制中关窗
   * 或渲染进程崩溃时 React cleanup 与复位 IPC 都不会执行，标志会永久为 true，之后所有
   * rebuildMenu（切语言/zoom/设置同步）都建出无 accelerator 的菜单且波及全部窗口。
   * 在既有窗口销毁清理里按发起 webContents 复位。
   */
  function resetShortcutRecordingForWebContents(webContentsId: number) {
    if (!shortcutRecordingActive || shortcutRecordingOwnerWebContentsId !== webContentsId) {
      return;
    }
    shortcutRecordingOwnerWebContentsId = null;
    shortcutRecordingActive = false;
    rebuildMenu();
  }

  return {
    rebuildMenu,
    executeDesktopCommandForApp,
    setShortcutRecordingActive,
    resetShortcutRecordingForWebContents,
  };
}
