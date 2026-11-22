import { randomUUID } from "node:crypto";
import { app, BrowserWindow, MessageChannelMain } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  HostMessageTypes,
  InternalChannels,
  PlatformChannels,
  ZCODE_VERSION,
  desktopMenuMessageIds,
  mapZCodeEnvToArmsRumEnv,
  shouldEnableE2ETestBridge,
  type Locale,
  type appSettingsPatchSchema,
} from "@zcode/shared";
import { logger } from "../logger.js";
import {
  configureDockMenu,
  focusWorkspaceInExistingWindow,
  showCurrentWindowFromDock,
} from "../desktopWindowLifecycle.js";
import {
  getDesktopMenuLabel as getDesktopMenuLabelByLocale,
  resolveSystemApplicationLocale,
} from "../desktopApplicationMenu.js";
import { registerRendererActionTraceIpc } from "../rendererActionTraceIpc.js";
import { registerPlatformIpcHandlers } from "../desktopMainIpcPlatform.js";
import { registerRemoteIpcHandlers } from "../desktopMainIpcRemote.js";
import { installFinderOpenFolderWorkflow } from "../desktopFinderOpenFolderWorkflow.js";
import { installWindowsOpenFolderContextMenu } from "../desktopWindowsOpenFolderContextMenu.js";
import {
  desktopRuntimeEnv,
  isDockerDaemonAvailable,
  listAvailableDockerContainers,
  listAvailableWSLDistros,
  listSSHConfigAliases,
} from "../desktopRuntimeEnv.js";
import { acknowledgePostUpdateReleaseNotes, getAutoUpdaterState } from "../autoUpdater.js";
import type { createPrimaryWindowCoordinator } from "../primaryWindowCoordinator.js";
import type { createCuaPipFocusRouter } from "../cuaPipFocusRouter.js";
import type { createWindowsCuaOperationIndicator } from "../windowsCuaOperationIndicator.js";
import type { TaskRealtimeBus } from "../taskRealtimeBus.js";
import type { AppMenuLifecycle } from "./appMenu.js";
import type { DesktopBrowserLifecycle } from "./browser.js";
import type { MainServices } from "./services.js";
import type { RemoteWorkspaceSessionManager } from "./services.js";
import type { TrayLifecycle } from "./tray.js";
import type { UpdaterLifecycle } from "./updater.js";

export interface AppIpcOptions {
  services: MainServices;
  remoteSessionManager: RemoteWorkspaceSessionManager;
  browserLifecycle: DesktopBrowserLifecycle;
  appMenu: AppMenuLifecycle;
  updater: UpdaterLifecycle;
  tray: TrayLifecycle;
  primaryWindowCoordinator: ReturnType<typeof createPrimaryWindowCoordinator>;
  windowsCuaOperationIndicator: ReturnType<typeof createWindowsCuaOperationIndicator>;
  cuaPipFocusRouter: ReturnType<typeof createCuaPipFocusRouter>;
  getApplicationWindows: () => BrowserWindow[];
  getApplicationLocale: () => Locale;
  setApplicationLocale: (locale: Locale) => void;
  windowWorkspaceMap: Map<number, Set<string>>;
  windowTaskRealtimeHostIdMap: Map<number, string>;
  windowUnreadCountMap: Map<number, number>;
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  taskRealtimeBus: TaskRealtimeBus;
  syncImmediateAppSettings: (patch: ReturnType<typeof appSettingsPatchSchema.parse>) => void;
  getRunningAgentSessionCount: () => number;
  setShortcutRecordingActive: (active: boolean, ownerWebContentsId?: number | null) => void;
}

export function registerAppIpcHandlers(options: AppIpcOptions): void {
  const { services } = options;

  const applyApplicationLocale = async (locale: Locale) => {
    options.setApplicationLocale(locale);
    // Host 的 ZCode endpoint 请求以此为实时语言；setting.json 写入可能滞后或失败，不能作为来源。
    for (const child of options.windowHostProcessMap.values()) {
      child.postMessage({ type: HostMessageTypes.ApplicationLocaleChanged, locale });
    }
    options.windowsCuaOperationIndicator.refreshContent();
    options.appMenu.rebuildMenu();
    for (const win of options.getApplicationWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(
          PlatformChannels.ApplicationLocaleChanged,
          options.getApplicationLocale(),
        );
      }
    }
    installFinderOpenFolderWorkflow({
      platform: process.platform,
      locale: options.getApplicationLocale(),
      homeDir: app.getPath("home"),
      logger,
    });
    // Windows Explorer 右键菜单是注册表持久项，renderer 切换语言不会自动刷新。
    // 这里跟 macOS Finder Service 一样在 locale 变化时重写菜单文案，避免继续显示旧语言。
    await installWindowsOpenFolderContextMenu({
      platform: process.platform,
      executablePath: process.execPath,
      argv: process.argv,
      isDefaultApp: Boolean(process.defaultApp),
      locale: options.getApplicationLocale(),
      logger,
    });
    configureDockMenu(
      () =>
        getDesktopMenuLabelByLocale(
          options.getApplicationLocale(),
          desktopMenuMessageIds.dockShowCurrentWindow,
        ),
      () => showCurrentWindowFromDock(options.primaryWindowCoordinator),
    );
  };

  registerPlatformIpcHandlers({
    fetchHelpConfig: services.readHelpConfig,
    logger,
    // CDP-on-guest pivot：renderer `<webview>` dom-ready 上报 guest webContentsId → attach。
    attachBrowserGuest: (key, webContentsId, attachOptions) => {
      const result = options.browserLifecycle.browserGuestManager.attachGuest(
        key,
        webContentsId,
        attachOptions,
      );
      if (result.ok && attachOptions?.windowId !== undefined) {
        options.browserLifecycle.embeddedBrowserDialogController.bindGuest(
          key,
          webContentsId,
          attachOptions.windowId,
        );
      }
      return result;
    },
    updateBrowserGuestViewport: (tabId, viewport, windowId) =>
      options.browserLifecycle.browserGuestManager.updateViewportFromRenderer(
        tabId,
        viewport,
        windowId,
      ),
    reportBrowserScreenshotSurfaceReady: (windowId, senderWebContentsId, payload) => {
      logger.debug("[browser-screenshot-surface] renderer ready", {
        windowId,
        senderWebContentsId,
        requestId: payload.requestId,
        tabId: payload.tabId,
        webContentsId: payload.webContentsId,
        viewport: payload.viewport,
        surfaceScale: payload.surfaceScale,
      });
      options.browserLifecycle.browserScreenshotSurfaceCoordinator.handleReady({
        windowId,
        senderWebContentsId,
        payload,
      });
    },
    browserViewResidencyHandlers: {
      detachBrowserGuest: (key, webContentsId, windowId) =>
        options.browserLifecycle.browserGuestManager.detachGuestBeforeReplacement(
          key,
          webContentsId,
          windowId,
        ),
      closeBrowserTab: (payload) =>
        options.browserLifecycle.browserGuestManager.closeTabFromRenderer(payload),
      reportBrowserTabResidency: (payload) =>
        options.browserLifecycle.browserGuestManager.reportResidency(payload),
      acknowledgeBrowserTabSuspend: (payload) =>
        options.browserLifecycle.browserGuestManager.acknowledgeSuspend(payload),
      ensureBrowserTabResident: (payload) =>
        options.browserLifecycle.browserGuestManager.ensureResidentFromRenderer(payload),
      restoreBrowserTabs: (payload) =>
        options.browserLifecycle.browserGuestManager.restoreTabs(payload),
    },
    applyApplicationLocale,
    focusWorkspaceInExistingWindow: (path, extra) =>
      focusWorkspaceInExistingWindow(path, options.windowWorkspaceMap, extra),
    windowWorkspaceMap: options.windowWorkspaceMap,
    windowUnreadCountMap: options.windowUnreadCountMap,
    resolveSystemLocale: resolveSystemApplicationLocale,
    currentApplicationLocale: options.getApplicationLocale,
    executeDesktopCommand: options.appMenu.executeDesktopCommandForApp,
    acknowledgePostUpdateReleaseNotes: (version) =>
      acknowledgePostUpdateReleaseNotes(version, services.mainSettingService),
    syncActiveTaskSession: (windowId, sessionId) =>
      options.cuaPipFocusRouter.updateActiveSession(windowId, sessionId),
    syncTaskRealtimeWorkspaceKeys: (windowId, workspaceKeys) => {
      const hostId = options.windowTaskRealtimeHostIdMap.get(windowId);
      if (hostId) {
        options.taskRealtimeBus.updateHostWorkspaceKeys(hostId, workspaceKeys);
      }
    },
    getUpdateState: getAutoUpdaterState,
    openUpdateStatusWindow: options.updater.openUpdateStatusWindow,
    getAutoUpdatePreferences: options.updater.getAutoUpdatePreferences,
    setAutoDownloadAndInstallUpdates: options.updater.setAutoDownloadAndInstallUpdates,
    getDesktopSessionActivity: () => ({
      runningAgentSessionCount: options.getRunningAgentSessionCount(),
    }),
    syncWebRemoteControlWorkspaces: (windowId, workspaces) => {
      services.webRemoteControlManager.syncAvailableWorkspaces(windowId, workspaces);
      void services.webRemoteControlManager.restorePreviouslyEnabled(windowId, workspaces);
    },
    syncAppSettings: options.syncImmediateAppSettings,
    // 设置页置灰查询：monitor 带 stale 缓存，装完 AppIndicator 扩展重开设置页即可刷新。
    // 设置页置灰查询：先确保托盘实例就绪（用户装扩展后首次查询会补建），再返回合并了
    // trayReady 的最终能力，避免设置页显示可开启但关窗实际走确认退出的不一致（CR-01）。
    refreshCloseToTrayCapability: options.tray.refreshCloseToTrayCapability,
    setShortcutRecordingActive: options.setShortcutRecordingActive,
    deviceMid: services.deviceMid,
  });

  services.disposeRendererActionTraceIpcRef.current = registerRendererActionTraceIpc({
    rollout: services.rendererActionTraceRollout,
    broker: services.rendererActionTraceBroker,
    env: process.env,
    logger,
  });

  registerRemoteIpcHandlers({
    logger,
    appTelemetryRuntime: services.appTelemetryRuntime,
    onOAuthCallbackHandledSideEffect: () => {
      void services.armsUserIdentitySync.refresh();
    },
    appTelemetryCore: services.appTelemetryCore,
    reportRemoteUsageEvent: services.reportRemoteUsageEventForRenderer,
    armsCustomContext: {
      deviceMid: services.deviceMid,
      platform: process.platform,
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
    },
    finalArmsCustomEventE2EEnabled: shouldEnableE2ETestBridge(process.env),
    webRemoteControlManager: services.webRemoteControlManager,
    createRemoteWorkspaceSession: options.remoteSessionManager.createRemoteWorkspaceSession,
    getRemoteConnectionStats: options.remoteSessionManager.getRemoteConnectionStats,
    disposeRemoteWorkspaceSession: options.remoteSessionManager.disposeRemoteWorkspaceSession,
    cancelPendingRemoteWorkspaceSessionsForWindow:
      options.remoteSessionManager.cancelPendingRemoteWorkspaceSessionsForWindow,
    bindRemoteWorkspaceSessionContext:
      options.remoteSessionManager.bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady: options.remoteSessionManager.confirmRendererAttachmentReady,
    attachSourceSettings: (sender, sourceServerId) => {
      const child = options.windowHostProcessMap.get(sender.id);
      if (!child) throw new Error("Desktop Window Host is unavailable");
      const { port1, port2 } = new MessageChannelMain();
      const attachmentId = `source-settings-${randomUUID()}`;
      child.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId,
          clientMode: "desktop-continuous",
          scope: { kind: "source-settings", sourceServerId },
        },
        [port2],
      );
      sender.postMessage(
        InternalChannels.SourceSettingsServicePort,
        { attachmentId, sourceServerId },
        [port1],
      );
      return { attachmentId };
    },
    isDockerDaemonAvailable,
    listAvailableWSLDistros,
    listAvailableDockerContainers,
    listSSHConfigAliases,
  });
}
