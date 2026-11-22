import { app, BrowserWindow } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import type { Locale } from "@zcode/shared";
import { logger } from "../logger.js";
import {
  createWindow,
  handleDesktopWindowCloseRequest,
  syncApplicationUnreadBadge,
} from "../desktopWindowLifecycle.js";
import { disposeHostProcess, spawnHostProcess } from "../desktopHostProcess.js";
import type { StartupWindowBootstrap } from "../startupWorkspace.js";
import type { DesktopWindowSize } from "../desktopWindowSize.js";
import type { CronRunResultPayload, OffPeakRunResultPayload } from "../desktopCronScheduler.js";
import { createCuaPipFocusRouter, resolveCuaPipWindowKey } from "../cuaPipFocusRouter.js";
import type { createWindowsCuaOperationIndicator } from "../windowsCuaOperationIndicator.js";
import type { BroadcastHub } from "../broadcastHub.js";
import type { TaskRealtimeBus } from "../taskRealtimeBus.js";
import { resolveRemoteAssetDirs } from "../desktopRuntimeEnv.js";
import { resolveZCodeBuiltinProviderConfigFilePath } from "../desktopProviderConfig.js";
import {
  reportAgentProcessExitToArms,
  reportAgentProcessReadyToArms,
  reportAgentProcessStartToArms,
  reportAgentProcessSpawnErrorToArms,
  reportAgentProcessExceptionToArms,
  registerStabilityMainWindow,
} from "../desktopStabilityTelemetry.js";
import { reportMcpTelemetryToArms } from "../desktopMcpTelemetry.js";
import { getPluginSandboxHost } from "../pluginSandbox/index.js";
import { clearOAuthRoutesForWindow } from "../desktopOAuthDeepLink.js";
import type { LocalMediaPreviewPathRegistry, DesktopBrowserLifecycle } from "./browser.js";
import type {
  AppTelemetryCore,
  MainSettingService,
  RemoteWorkspaceSessionManager,
  WebRemoteControlManager,
} from "./services.js";
import {
  resolveCloseToTraySupported,
  type createCloseToTrayCapabilityMonitor,
} from "../desktopTraySupport.js";

export interface RuntimeProcessEnvPreparation {
  patchPromise: Promise<Record<string, string>>;
  fallbackPatch: Record<string, string>;
}

export interface WindowLifecycleOptions {
  iconPath: string;
  preloadPath: string;
  forceQuitRef: { current: boolean };
  explicitQuitRef: { current: boolean };
  getApplicationLocale: () => Locale;
  getCloseToTrayOnWindows: () => boolean;
  getDesktopTrayReady: () => boolean;
  closeToTrayCapabilityMonitor: ReturnType<typeof createCloseToTrayCapabilityMonitor>;
  markForceQuit: (reason: string) => void;
  shouldConfirmAppQuit: () => boolean;
  confirmAppQuit: (originWindow?: BrowserWindow | null) => boolean;
  getMainApplicationWindows: () => BrowserWindow[];
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  windowWorkspaceMap: Map<number, Set<string>>;
  windowTaskRealtimeHostIdMap: Map<number, string>;
  windowUnreadCountMap: Map<number, number>;
  cuaPipFocusRouter: ReturnType<typeof createCuaPipFocusRouter>;
  windowsCuaOperationIndicator: ReturnType<typeof createWindowsCuaOperationIndicator>;
  awaitFirstHostSpawnDecision: () => Promise<void>;
  resolveDesktopContextPromptEnabledForHost: () => boolean;
  hostProcessLocalEnv: Record<string, string>;
  broadcastHub: BroadcastHub;
  taskRealtimeBus: TaskRealtimeBus;
  hostRunningTaskCountMap: Map<ElectronUtilityProcess, number>;
  appTelemetryCore: AppTelemetryCore;
  localMediaPreviewPathRegistry: LocalMediaPreviewPathRegistry;
  browserLifecycle: Pick<
    DesktopBrowserLifecycle,
    "browserGuestManager" | "browserScreenshotSurfaceCoordinator" | "runBrowserCommandOnView"
  >;
  onCronRunResult: (result: CronRunResultPayload) => void;
  onOffPeakRunResult: (result: OffPeakRunResultPayload) => void;
  onCronSchedulerWakeRequested: (automationId: string) => void;
  onOffPeakSchedulerWakeRequested: (offPeakTaskId?: string) => void;
  takeRuntimeProcessEnvPreparation: () => RuntimeProcessEnvPreparation;
  mainSettingService: MainSettingService;
  remoteSessionManager: RemoteWorkspaceSessionManager;
  webRemoteControlManager: WebRemoteControlManager;
  setDesktopZoomLevel: (zoomLevel: number) => void;
  getDesktopZoomLevel: () => number;
  getDesktopWindowSize: () => DesktopWindowSize | undefined;
  setDesktopWindowSize: (size: DesktopWindowSize) => void;
  disposingHostProcessTimers: WeakMap<ElectronUtilityProcess, ReturnType<typeof setTimeout>>;
  getActiveAppShutdownForceKillDelayMs: () => number;
  getAgentSpawnFallbackCwd: () => string;
  deviceMid: string;
  syncAutoUpdaterStateToWindow: (win: BrowserWindow) => void;
  syncReadyUpdateToWindow: (win: BrowserWindow) => void;
  syncPostUpdateReleaseNotesToWindow: (win: BrowserWindow) => void;
}

export interface WindowLifecycle {
  createWindowInstance: (startupBootstrap?: StartupWindowBootstrap) => BrowserWindow;
  installWindowSubscriptions: (dependencies: {
    syncAppTelemetryInteractiveState: () => void;
    rebuildMenu: () => void;
    resetShortcutRecordingForWebContents: (webContentsId: number) => void;
  }) => void;
}

export function createWindowLifecycle(options: WindowLifecycleOptions): WindowLifecycle {
  const browserLifecycle = options.browserLifecycle;

  function createWindowInstance(startupBootstrap: StartupWindowBootstrap = {}): BrowserWindow {
    const runtimeProcessEnvPreparation = options.takeRuntimeProcessEnvPreparation();
    const win = createWindow({
      iconPath: options.iconPath,
      preloadPath: options.preloadPath,
      logger,
      forceQuitRef: options.forceQuitRef,
      handleBeforeClose: (win, label) =>
        handleDesktopWindowCloseRequest({
          platform: process.platform,
          forceQuit: options.forceQuitRef.current,
          explicitQuitRequested: options.explicitQuitRef.current,
          closeToTray: options.getCloseToTrayOnWindows(),
          // 空缓存按不可用处理：隐藏前兜底确认托盘真的可渲染，防 GNOME 静默失败失联。
          // CR-01：DBus 探测 ∧ Tray 实例创建成功才可隐藏；任一不满足按不可用走确认退出。
          closeToTraySupported: resolveCloseToTraySupported({
            platform: process.platform,
            desktopTrayReady: options.getDesktopTrayReady(),
            capabilitySupported: options.closeToTrayCapabilityMonitor.getSync()?.supported,
          }),
          isLastWindow: options.getMainApplicationWindows().length === 1,
          label,
          logger,
          shouldConfirmQuit: options.shouldConfirmAppQuit(),
          confirmQuit: () => options.confirmAppQuit(win),
          requestQuit: () => {
            options.markForceQuit(`last-window-close:${label}`);
            app.quit();
          },
          hideWindow: () => win.hide(),
        }),
      windowHostProcessMap: options.windowHostProcessMap,
      onHostProcessReady: (windowKey) => options.cuaPipFocusRouter.refreshWindow(windowKey),
      awaitFirstHostSpawnDecision: options.awaitFirstHostSpawnDecision,
      spawnHostProcess: (win, label, initMessage) =>
        spawnHostProcess(
          win,
          label,
          {
            ...initMessage,
            zcodeBuiltinProviderConfigFilePath: resolveZCodeBuiltinProviderConfigFilePath(),
          },
          {
            hostProcessLocalEnv: options.hostProcessLocalEnv,
            desktopContextPromptEnabled: options.resolveDesktopContextPromptEnabledForHost,
            logger,
            broadcastHub: options.broadcastHub,
            taskRealtimeBus: options.taskRealtimeBus,
            windowHostProcessMap: options.windowHostProcessMap,
            hostRunningTaskCountMap: options.hostRunningTaskCountMap,
            onCuaOperationStateChanged: (source, event) =>
              options.windowsCuaOperationIndicator.handleState(source, event),
            onCuaOperationStateSourceExited: (source) =>
              options.windowsCuaOperationIndicator.clearSource(source),
            onAgentProcessExited: (event) => reportAgentProcessExitToArms(event, logger),
            onAgentProcessError: (event) => reportAgentProcessSpawnErrorToArms(event, logger),
            onAgentProcessException: (event) => reportAgentProcessExceptionToArms(event, logger),
            onAgentProcessReady: (event) => reportAgentProcessReadyToArms(event, logger),
            onAgentProcessSpawned: (event) => reportAgentProcessStartToArms(event, logger),
            onMcpTelemetry: (message) =>
              reportMcpTelemetryToArms(message.event, message.runtimeSurface),
            onPluginTelemetry: (message) => {
              void options.appTelemetryCore.reportEvent(message.event).catch(() => {});
            },
            onSessionCreateTelemetry: (message) => {
              void options.appTelemetryCore.reportEvent(message.event).catch(() => {});
            },
            onCronRunResult: options.onCronRunResult,
            onOffPeakRunResult: options.onOffPeakRunResult,
            onCronSchedulerWakeRequested: options.onCronSchedulerWakeRequested,
            onOffPeakSchedulerWakeRequested: options.onOffPeakSchedulerWakeRequested,
            authorizeLocalMediaPreviewPath: options.localMediaPreviewPathRegistry.authorize,
            registerPluginSandbox: (input) => {
              const host = getPluginSandboxHost();
              if (!host) throw new Error("Plugin UI sandbox host is not installed.");
              const { requestId: _requestId, ...registerInput } = input;
              return host.registerFromHost(registerInput);
            },
            // browser-use：main 用 WebContentsView+CDP 执行命令（替换 T4 占位）。
            handleBrowserExecuteRequest: ({ win: browserWin, ...request }) =>
              browserLifecycle.runBrowserCommandOnView({ win: browserWin, ...request }),
          },
          {
            // 本地窗口 Host 崩溃后必须通知 renderer 并允许一次自愈重启；否则 UI 永久停在加载中。
            respawnOnExit: true,
            taskRealtime: {
              workspaceKeys: options.windowWorkspaceMap.get(win.id) ?? [],
              onHostId: (hostId) => {
                options.windowTaskRealtimeHostIdMap.set(win.id, hostId);
              },
            },
          },
        ),
      disposeHostProcess: (child, label, forceKillDelayMs) =>
        disposeHostProcess(
          child,
          label,
          options.disposingHostProcessTimers,
          logger,
          label.includes("window-closed")
            ? options.getActiveAppShutdownForceKillDelayMs()
            : forceKillDelayMs,
        ),
      syncAutoUpdaterStateToWindow: options.syncAutoUpdaterStateToWindow,
      syncReadyUpdateToWindow: options.syncReadyUpdateToWindow,
      syncPostUpdateReleaseNotesToWindow: options.syncPostUpdateReleaseNotesToWindow,
      webRemoteControlManager: options.webRemoteControlManager,
      disposeRemoteWorkspaceSessionsForWindow:
        options.remoteSessionManager.disposeRemoteWorkspaceSessionsForWindow,
      reattachRemoteWorkspaceSessionsForWindow:
        options.remoteSessionManager.reattachRemoteWorkspaceSessionsForWindow,
      bootstrap: {
        restoreSession: startupBootstrap.restoreSession,
        initialWorkspacePath: startupBootstrap.initialWorkspacePath,
        initialWorkspacePurpose: startupBootstrap.initialWorkspacePurpose,
        unavailableWorkspacePath: startupBootstrap.unavailableWorkspacePath,
      },
      agentWarmupTargets: startupBootstrap.agentWarmupTargets,
      // startupBootstrap 只标记 active workspace 是否可用，但 local Host 会为所有
      // 已恢复 workspace 建立后台索引。始终注入 canonical fallback，才能覆盖非 active 历史目录已删除的情况。
      agentSpawnFallbackCwd: options.getAgentSpawnFallbackCwd(),
      deviceMid: options.deviceMid,
      remoteAssets: resolveRemoteAssetDirs(
        { locale: options.getApplicationLocale() },
        options.hostProcessLocalEnv,
      ),
      runtimeProcessEnvPatchPromise: runtimeProcessEnvPreparation.patchPromise,
      runtimeProcessEnvFallbackPatch: runtimeProcessEnvPreparation.fallbackPatch,
      initialDesktopZoomLevel: options.getDesktopZoomLevel(),
      initialWindowSize: options.getDesktopWindowSize(),
      currentApplicationLocale: options.getApplicationLocale,
      resolveBrowserViewOwner: (webContentsId) =>
        browserLifecycle.browserGuestManager.getTabOwnerByWebContentsId(webContentsId) ?? undefined,
      persistWindowSize: async (state) => {
        options.setDesktopWindowSize(state);
        await options.mainSettingService.update({ desktopWindowSize: state });
      },
    });
    registerStabilityMainWindow(win);
    return win;
  }

  function installWindowSubscriptions(dependencies: {
    syncAppTelemetryInteractiveState: () => void;
    rebuildMenu: () => void;
    resetShortcutRecordingForWebContents: (webContentsId: number) => void;
  }): void {
    app.on("browser-window-focus", (_event, win) => {
      dependencies.syncAppTelemetryInteractiveState();
      dependencies.rebuildMenu();
      // 设置/更新等无 Host 的 ZCode 窗口也算前台：router 会先把旧 workspace Host 清成 null，
      // 再把无 Host 的新窗口事实静默丢弃，避免旧会话 PiP 继续显示。
      options.cuaPipFocusRouter.focusWindow(resolveCuaPipWindowKey(win));
    });
    app.on("browser-window-blur", (_event, win) => {
      dependencies.syncAppTelemetryInteractiveState();
      options.cuaPipFocusRouter.blurWindow(resolveCuaPipWindowKey(win));
    });
    app.on("browser-window-created", (_event, win) => {
      const windowKey = resolveCuaPipWindowKey(win);
      win.once("closed", () => options.cuaPipFocusRouter.removeWindow(windowKey));
    });
    app.on("browser-window-created", (_, win) => {
      const windowWebContentsId = win.webContents.id;
      win.on("closed", () => {
        browserLifecycle.browserScreenshotSurfaceCoordinator.handleWindowDestroyed(win.id);
        browserLifecycle.browserGuestManager.closeWindow(win.id);
        options.windowWorkspaceMap.delete(win.id);
        options.windowTaskRealtimeHostIdMap.delete(win.id);
        if (options.windowUnreadCountMap.delete(win.id)) {
          syncApplicationUnreadBadge(options.windowUnreadCountMap);
        }
        // Electron 进入 closed 回调时，win.webContents 可能已经被销毁。
        // 之前这里现取 win.webContents.id，会在关窗收尾阶段抛出 "Object has been destroyed"。
        // 改为在窗口创建时缓存 webContents id，确保清理 OAuth 路由时不再访问已销毁对象。
        clearOAuthRoutesForWindow(windowWebContentsId);
        // 录制中关窗/崩溃时 renderer 不会发复位 IPC，这里按发起 webContents 复位录制态，
        // 防止菜单 accelerator 被永久摘除。
        dependencies.resetShortcutRecordingForWebContents(windowWebContentsId);
      });
      // 渲染进程崩溃但窗口存活时 closed 不会触发，崩溃路径同样按 owner 复位
      // （owner 不匹配时天然幂等）。
      win.webContents.on("render-process-gone", () => {
        dependencies.resetShortcutRecordingForWebContents(windowWebContentsId);
      });
    });
  }

  return { createWindowInstance, installWindowSubscriptions };
}
