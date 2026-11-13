import "./desktopEarlyDataBaseDirBootstrap.js";
import "./desktopEarlyChromiumHardwareAccelerationBootstrap.js";
import { app, BrowserWindow, powerSaveBlocker, session } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOCALE,
  HostMessageTypes,
  PlatformChannels,
  ZCODE_AUTO_UPDATE_ENABLED,
  ZCODE_PRODUCT_FLAVOR,
  type Locale,
  type appSettingsPatchSchema,
} from "@zcode/shared";
import {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  getConversationWorkspaceDir,
  normalizeRuntimeProcessEnv,
} from "@zcode/services/node";
import { logger } from "./logger.js";
import {
  initAutoUpdater,
  refreshAutoUpdaterReleaseChannel,
  resolveUpdateFeedSourceFromStartupConfig,
  syncAutoUpdaterStateToWindow,
  syncPostUpdateReleaseNotesToWindow,
  syncReadyUpdateToWindow,
} from "./autoUpdater.js";
import { BroadcastHub } from "./broadcastHub.js";
import { TaskRealtimeBus } from "./taskRealtimeBus.js";
import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
  type AppShutdownKind,
} from "./appShutdownPolicy.js";
import { createPrimaryWindowCoordinator } from "./primaryWindowCoordinator.js";
import { flushMainE2ECoverage } from "./e2eCoverage.js";
import { resolveStartupWindowBootstrap } from "./startupWorkspace.js";
import { createCloseToTrayCapabilityMonitor } from "./desktopTraySupport.js";
import { createWindowsCuaOperationIndicator } from "./windowsCuaOperationIndicator.js";
import { createCuaPipFocusRouter } from "./cuaPipFocusRouter.js";
import { syncApplicationUnreadBadge } from "./desktopWindowLifecycle.js";
import {
  getCredentialsDir,
  loadHostProcessEnvFromLocalFiles,
  resolveRemoteAssetDirs,
  resolveZCodeEndpointEnvBaseOrigin,
  runtimeApplicationName,
  runtimeHomePath,
  runtimeSessionDataPath,
  runtimeUserDataPath,
  shouldUseElectronDefaultUserDataPath,
} from "./desktopRuntimeEnv.js";
import { disposeHostProcessAndWait, listDisposingHostProcesses } from "./desktopHostProcess.js";
import type { CronSchedulerHandle } from "./desktopCronScheduler.js";
import { createRemoteWorkspaceSessionManager } from "./desktopRemoteSessions.js";
import {
  reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnectToArms,
  stopRemoteUsageArmsPeriodicSampling,
} from "./desktopRemoteUsageArmsTelemetry.js";
import { resolveCanonicalWslTarget } from "./desktopWslTargetResolver.js";
import {
  getStabilityLifecycleScene,
  notifyStabilityAppExit,
  notifyStabilityLifecycle,
} from "./desktopStabilityTelemetry.js";
import { stopDesktopResourceTelemetry } from "./desktopResourceTelemetry.js";
import { stopDesktopZCodeDataSizeTelemetry } from "./desktopZCodeDataSizeTelemetry.js";
import { stopDesktopNetworkTelemetry } from "./desktopNetworkTelemetry.js";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";
import {
  createDesktopBrowserLifecycle,
  createLocalMediaPreviewRuntime,
} from "./lifecycle/browser.js";
import { createAppMenuLifecycle } from "./lifecycle/appMenu.js";
import { createDeepLinkLifecycle, resolveExplicitStartupWorkspace } from "./lifecycle/deepLinks.js";
import { registerAppIpcHandlers } from "./lifecycle/ipc.js";
import { createMainServices, type MainServices } from "./lifecycle/services.js";
import {
  createShutdownSupport,
  prepareWindowsProcessesForUpdateInstall,
} from "./lifecycle/shutdown.js";
import {
  installReadyRuntime,
  launchPrimaryApplication,
  prepareAppRuntime,
} from "./lifecycle/startup.js";
import { createTrayLifecycle } from "./lifecycle/tray.js";
import { createUpdaterLifecycle } from "./lifecycle/updater.js";
import { createWindowLifecycle } from "./lifecycle/windows.js";

const mainDirname = import.meta.dirname;
const localMediaPreviewPathRegistry = createLocalMediaPreviewRuntime();

// e2e 由 Chromedriver 管理远程调试端口；如果这里继续固定到 9229，
// 会和开发态已打开的 ZCode Dev 抢端口，导致 WebDriver session 创建前白屏超时。
// 仅本地开发运行默认开启远程调试端口，并允许 e2e 通过环境变量交给 Chromedriver 接管。
if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9229");
}

app.setName(runtimeApplicationName);
if (runtimeHomePath) {
  app.setPath("home", runtimeHomePath);
}
if (!shouldUseElectronDefaultUserDataPath) {
  if (!runtimeUserDataPath || !runtimeSessionDataPath) {
    throw new Error(
      "Desktop runtime data paths are required when Electron default userData is disabled",
    );
  }
  app.setPath("userData", runtimeUserDataPath);
  app.setPath("sessionData", runtimeSessionDataPath);
}
process.title = runtimeApplicationName;

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection:", reason);
});

const iconPath =
  process.platform === "win32"
    ? app.isPackaged
      ? join(process.resourcesPath, "icon_windows.png")
      : join(mainDirname, "../../build/icon_windows.png")
    : app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(mainDirname, "../../build/icon.png");
const linuxDesktopIntegrationIconPath =
  process.platform === "linux"
    ? app.isPackaged
      ? join(process.resourcesPath, "icon_512x512.png")
      : join(mainDirname, "../../build/icons/512x512.png")
    : iconPath;
let currentApplicationLocale: Locale = DEFAULT_LOCALE;
let closeToTrayOnWindows = true;
// CR-01：托盘实例创建结果（模块级，关窗分支读取）。DBus 能力探测通过不等于 Electron
// Tray 创建成功；隐藏窗口前必须确认最终用户入口真实存在，否则隐藏即失联。
let desktopTrayReady = false;
// 关闭驻留托盘能力 monitor（spec：docs/desktop/linux-close-to-tray.md）。
// Linux 关窗分支是同步回调，只能读缓存；启动后首次探测完成前按"不可用"安全默认。
const closeToTrayCapabilityMonitor = createCloseToTrayCapabilityMonitor({
  platform: process.platform,
});
// keep-awake：全局开关 keepAwakeWhileRunning。打开后主进程持有
// powerSaveBlocker("prevent-app-suspension")，阻止系统闲置休眠（防不了合盖/手动睡眠）。
// 不再绑定闲时任务活跃计数——设置页「常规」与 Automations 入口镜像同一配置。
let keepAwakeWhileRunning = false;
let powerSaveBlockerId: number | null = null;
function reconcileKeepAwakeBlocker(): void {
  const shouldBlock = keepAwakeWhileRunning;
  if (shouldBlock && powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    logger.info(`[keep-awake] powerSaveBlocker started id=${powerSaveBlockerId}`);
  } else if (!shouldBlock && powerSaveBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId);
    } catch {
      // 忽略：id 可能已失效。
    }
    logger.info(`[keep-awake] powerSaveBlocker stopped id=${powerSaveBlockerId}`);
    powerSaveBlockerId = null;
  }
}

const preloadPath = join(mainDirname, "../preload/index.cjs");
const settingsFile = join(homedir(), ".zcode", "v2", "setting.json");
let currentDesktopZoomLevel = 0;
let currentDesktopWindowSize: import("./desktopWindowSize.js").DesktopWindowSize | undefined;
let activeAppShutdownPolicy = resolveAppShutdownPolicy("normal", process.platform);
let activeAppShutdownKind: AppShutdownKind | null = null;

const broadcastHub = new BroadcastHub();
const taskRealtimeBus = new TaskRealtimeBus({ logger });
const windowWorkspaceMap = new Map<number, Set<string>>();
const windowTaskRealtimeHostIdMap = new Map<number, string>();
const windowUnreadCountMap = new Map<number, number>();
const windowHostProcessMap = new Map<number, ElectronUtilityProcess>();
const hostRunningTaskCountMap = new Map<ElectronUtilityProcess, number>();
const forceQuitRef = { current: false };
const explicitQuitRef = { current: false };
let appQuitPreparationInFlight: Promise<void> | null = null;
let hasPreparedAppQuit = false;
let forceUpdateMainWindowCreationBlocked = false;
let primaryWindowCoordinator: ReturnType<typeof createPrimaryWindowCoordinator>;
let cronScheduler: CronSchedulerHandle | null = null;
const disposingHostProcessTimers = new WeakMap<
  ElectronUtilityProcess,
  ReturnType<typeof setTimeout>
>();
const hostProcessLocalEnv = loadHostProcessEnvFromLocalFiles();

interface RuntimeProcessEnvPreparation {
  patchPromise: Promise<Record<string, string>>;
  fallbackPatch: Record<string, string>;
}
let runtimeProcessEnvPrewarmSequence = 0;
function createRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  const prewarmId = ++runtimeProcessEnvPrewarmSequence;
  const startedAt = Date.now();
  // Windows process.env 保留 Path 的原始大小写，展开到普通对象后不再大小写不敏感。
  // dotenv 先合并、真实进程环境后合并，再统一成唯一 PATH，保持旧 Host 继承的优先级语义。
  const baseEnv = normalizeRuntimeProcessEnv(
    {
      ...hostProcessLocalEnv,
      ...process.env,
    },
    process.platform,
  );
  const fallbackPatch = buildRuntimeProcessEnvPatch(baseEnv, null, {
    platform: process.platform,
  });
  const patchPromise = captureLoginShellEnvSnapshot({
    baseEnv,
    platform: process.platform,
  }).then(
    (snapshot) => {
      const patch = buildRuntimeProcessEnvPatch(baseEnv, snapshot, {
        platform: process.platform,
      });
      if (process.platform !== "win32" && !snapshot) {
        logger.warn(
          `[startup] login shell env unavailable id=${prewarmId}; using shell-free fallback after ${Date.now() - startedAt}ms`,
        );
        return patch;
      }
      logger.info(
        `[startup] runtime process env prepared asynchronously id=${prewarmId} in ${Date.now() - startedAt}ms`,
      );
      return patch;
    },
    (error) => {
      logger.warn(
        `[startup] runtime process env prewarm failed id=${prewarmId}; using shell-free fallback`,
        error,
      );
      return fallbackPatch;
    },
  );
  return { patchPromise, fallbackPatch };
}
let initialRuntimeProcessEnvPreparation: RuntimeProcessEnvPreparation | null =
  createRuntimeProcessEnvPreparation();
function takeRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  const initialPreparation = initialRuntimeProcessEnvPreparation;
  if (initialPreparation) {
    initialRuntimeProcessEnvPreparation = null;
    return initialPreparation;
  }
  return createRuntimeProcessEnvPreparation();
}

const cuaPipFocusRouter = createCuaPipFocusRouter({
  send: (windowId, event) => {
    windowHostProcessMap.get(windowId)?.postMessage({
      type: HostMessageTypes.CuaPipFocusChanged,
      event,
    });
  },
});
const windowsCuaOperationIndicator = createWindowsCuaOperationIndicator({
  platform: process.platform,
  getLocale: () => currentApplicationLocale,
  logger,
});
function getApplicationWindowsExcludingCuaIndicator(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !windowsCuaOperationIndicator.ownsWindow(win),
  );
}
const browserLifecycle = createDesktopBrowserLifecycle({
  iconPath,
  getApplicationLocale: () => currentApplicationLocale,
});
const browserScreenshotSurfaceCoordinator = browserLifecycle.browserScreenshotSurfaceCoordinator;
const browserGuestManager = browserLifecycle.browserGuestManager;
mainMemoryDiagnosticsRegistry.register("taskBus", () => taskRealtimeBus.collectMemoryDiagnostics());
mainMemoryDiagnosticsRegistry.register("broadcast", () => broadcastHub.collectMemoryDiagnostics());
mainMemoryDiagnosticsRegistry.register("guest", () =>
  browserGuestManager.collectMemoryDiagnostics(),
);
mainMemoryDiagnosticsRegistry.register("app", () => ({
  windows: BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length,
  willDownloadListeners: session.defaultSession.listenerCount("will-download"),
}));

const webRemoteControlManagerRef: { current: MainServices["webRemoteControlManager"] | null } = {
  current: null,
};
const remoteSessionManager = createRemoteWorkspaceSessionManager({
  logger,
  windowHostProcessMap,
  resolveRemoteAssetDirs: () =>
    resolveRemoteAssetDirs({ locale: currentApplicationLocale }, hostProcessLocalEnv),
  resolveWslTarget: resolveCanonicalWslTarget,
  reportRemoteConnectionStateChanged: reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnect: reportRemoteDisconnectToArms,
  webRemoteControlManagerRef,
});
const services = createMainServices({
  hostProcessLocalEnv,
  windowHostProcessMap,
  getApplicationLocale: () => currentApplicationLocale,
  getApplicationWindows: getApplicationWindowsExcludingCuaIndicator,
  remoteSessionManager,
  webRemoteControlManagerRef,
});
const {
  mainSettingService,
  appTelemetryCore,
  deviceMid,
  readHelpConfig,
  webRemoteControlManager,
  rendererActionTraceBroker,
  localTtftExporter,
  resolveCurrentZCodeEndpointOrigin,
  resolveDesktopContextPromptEnabledForHost,
  awaitFirstHostSpawnDecision,
  syncAppTelemetryInteractiveState,
} = services;

function markForceQuit(reason: string) {
  if (forceQuitRef.current) {
    return;
  }

  forceQuitRef.current = true;
  logger.info(`[app-quit] forceQuit enabled (${reason})`);
}

function markExplicitQuit(reason: string) {
  explicitQuitRef.current = true;
  logger.info(`[app-quit] explicit quit requested (${reason})`);
}

function syncCloseToTrayOnWindows(value: unknown) {
  if (typeof value !== "boolean") {
    return;
  }

  closeToTrayOnWindows = value;
  logger.info(`[settings] closeToTrayOnWindows=${value}`);
}

function syncImmediateAppSettings(patch: ReturnType<typeof appSettingsPatchSchema.parse>) {
  syncCloseToTrayOnWindows(patch.closeToTrayOnWindows);

  if (typeof patch.keepAwakeWhileRunning === "boolean") {
    keepAwakeWhileRunning = patch.keepAwakeWhileRunning;
    reconcileKeepAwakeBlocker();
  }

  if (typeof patch.receivePreviewUpdates === "boolean") {
    // receivePreviewUpdates 由 renderer host 写入 setting.json。
    // main 进程的自动更新器不会订阅 host 设置变化，必须借 syncAppSettings 这条即时通道刷新 manifest channel。
    refreshAutoUpdaterReleaseChannel(
      patch.receivePreviewUpdates,
      "settings receivePreviewUpdates changed",
    );
  }

  if (patch.shortcutBindings !== undefined) {
    // 快捷键改绑：
    // 落盘已完成（useSettings.update 先 await settingService.update 再走本通道），
    // 这里重建应用菜单 accelerator，并通知所有窗口刷新设置快照 —— 其他窗口的
    // useAppKeyboard 生效表与设置页跟随更新。先例：setAutoDownloadAndInstallUpdates 的全窗口广播。
    rebuildMenu();
    for (const win of getApplicationWindowsExcludingCuaIndicator()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PlatformChannels.SettingsChanged);
      }
    }
  }
}

const appMenu = createAppMenuLifecycle({
  mainSettingService,
  readHelpConfig,
  getApplicationLocale: () => currentApplicationLocale,
  getApplicationWindows: getApplicationWindowsExcludingCuaIndicator,
  setDesktopZoomLevel: (zoomLevel) => {
    currentDesktopZoomLevel = zoomLevel;
  },
  resolveCurrentZCodeEndpointOrigin,
  webRemoteControlManagerRef,
  prepareAppQuit: (reason) => prepareAppQuit(reason),
  hostProcessLocalEnv,
  getCredentialsDir,
  resolveZCodeEndpointEnvBaseOrigin,
});
const {
  rebuildMenu,
  executeDesktopCommandForApp,
  setShortcutRecordingActive,
  resetShortcutRecordingForWebContents,
} = appMenu;

const updater = createUpdaterLifecycle({
  iconPath,
  preloadPath,
  deviceMid,
  forceQuitRef,
  getApplicationLocale: () => currentApplicationLocale,
  getApplicationWindows: getApplicationWindowsExcludingCuaIndicator,
  mainSettingService,
  syncImmediateAppSettings,
});

const tray = createTrayLifecycle({
  getApplicationLocale: () => currentApplicationLocale,
  ensurePrimaryWindow: async (reason) => {
    await primaryWindowCoordinator.ensurePrimaryWindow(reason);
  },
  executeDesktopCommand: executeDesktopCommandForApp,
  markExplicitQuit,
  quitApp: () => app.quit(),
  getTrayReady: () => desktopTrayReady,
  setTrayReady: (ready) => {
    desktopTrayReady = ready;
  },
  closeToTrayCapabilityMonitor,
  windowUnreadCountMap,
  syncApplicationUnreadBadge,
});

function getRunningAgentSessionCount() {
  return [...hostRunningTaskCountMap.values()].reduce((total, count) => total + count, 0);
}
const { shouldConfirmAppQuit, confirmAppQuit } = createShutdownSupport({
  iconPath,
  getApplicationLocale: () => currentApplicationLocale,
  getApplicationWindows: getApplicationWindowsExcludingCuaIndicator,
  getRunningAgentSessionCount,
});

function forwardCronRunResult(
  result: Parameters<CronSchedulerHandle["handleCronRunResult"]>[0],
): void {
  cronScheduler?.handleCronRunResult(result);
}
function forwardOffPeakRunResult(
  result: Parameters<CronSchedulerHandle["handleOffPeakRunResult"]>[0],
): void {
  cronScheduler?.handleOffPeakRunResult(result);
}
function wakeCronScheduler(automationId: string): void {
  cronScheduler?.wake(automationId);
}
function wakeOffPeakScheduler(offPeakTaskId?: string): void {
  // 复用同一条 scheduler-wake 通道（tick 同时覆盖 cron 与 off-peak 分支），仅日志标签区分。
  cronScheduler?.wake(`offpeak:${offPeakTaskId ?? "sync"}`);
}
// 选一个本地 host 执行派发：本期本地 workspace 由任一本地窗口 host 的 createTask 按 path 拉起/复用 agent。
function resolveCronDispatchHost(): ElectronUtilityProcess | null {
  const first = windowHostProcessMap.values().next();
  return first.done ? null : first.value;
}

const windowLifecycle = createWindowLifecycle({
  iconPath,
  preloadPath,
  forceQuitRef,
  explicitQuitRef,
  getApplicationLocale: () => currentApplicationLocale,
  getCloseToTrayOnWindows: () => closeToTrayOnWindows,
  getDesktopTrayReady: () => desktopTrayReady,
  closeToTrayCapabilityMonitor,
  markForceQuit,
  shouldConfirmAppQuit,
  confirmAppQuit,
  getMainApplicationWindows: updater.getMainApplicationWindows,
  windowHostProcessMap,
  windowWorkspaceMap,
  windowTaskRealtimeHostIdMap,
  windowUnreadCountMap,
  cuaPipFocusRouter,
  windowsCuaOperationIndicator,
  awaitFirstHostSpawnDecision,
  resolveDesktopContextPromptEnabledForHost,
  hostProcessLocalEnv,
  broadcastHub,
  taskRealtimeBus,
  hostRunningTaskCountMap,
  appTelemetryCore,
  localMediaPreviewPathRegistry,
  browserLifecycle,
  onCronRunResult: forwardCronRunResult,
  onOffPeakRunResult: forwardOffPeakRunResult,
  onCronSchedulerWakeRequested: wakeCronScheduler,
  onOffPeakSchedulerWakeRequested: wakeOffPeakScheduler,
  takeRuntimeProcessEnvPreparation,
  mainSettingService,
  remoteSessionManager,
  webRemoteControlManager,
  setDesktopZoomLevel: (zoomLevel) => {
    currentDesktopZoomLevel = zoomLevel;
  },
  getDesktopZoomLevel: () => currentDesktopZoomLevel,
  getDesktopWindowSize: () => currentDesktopWindowSize,
  setDesktopWindowSize: (size) => {
    currentDesktopWindowSize = size;
  },
  disposingHostProcessTimers,
  getActiveAppShutdownForceKillDelayMs: () => activeAppShutdownPolicy.forceKillDelayMs,
  getAgentSpawnFallbackCwd: getConversationWorkspaceDir,
  deviceMid,
  syncAutoUpdaterStateToWindow,
  syncReadyUpdateToWindow,
  syncPostUpdateReleaseNotesToWindow,
});

function focusForceUpdateGateWindow() {
  const gateWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  if (!gateWindow) {
    return;
  }

  if (gateWindow.isMinimized()) {
    gateWindow.restore();
  }
  if (!gateWindow.isVisible()) {
    gateWindow.show();
  }
  gateWindow.focus();
}

const deepLinks = createDeepLinkLifecycle({
  iconPath: linuxDesktopIntegrationIconPath,
  getApplicationLocale: () => currentApplicationLocale,
  getApplicationWindows: getApplicationWindowsExcludingCuaIndicator,
  ensurePrimaryWindow: (reason) => primaryWindowCoordinator.ensurePrimaryWindow(reason),
  focusForceUpdateGateWindow,
  isForceUpdateMainWindowCreationBlocked: () => forceUpdateMainWindowCreationBlocked,
});
primaryWindowCoordinator = createPrimaryWindowCoordinator({
  listWindows: getApplicationWindowsExcludingCuaIndicator,
  resolveStartupWindowBootstrap: () => {
    const request = deepLinks.takeStartupOpenWorkspaceRequest();
    if (request) {
      deepLinks.markStartupRequestConsumed(request);
      const explicitBootstrap = resolveExplicitStartupWorkspace(
        request,
        () => currentApplicationLocale,
      );
      if (explicitBootstrap) {
        return Promise.resolve(explicitBootstrap);
      }
    }

    return resolveStartupWindowBootstrap({
      settingsFile,
      // dataBaseDir 可能在 bootstrap 设置阶段被覆盖，必须在真正解析启动工作区时再取值。
      conversationWorkspaceDir: getConversationWorkspaceDir(),
      logger,
    });
  },
  createWindow: (startupBootstrap) => {
    windowLifecycle.createWindowInstance(startupBootstrap);
  },
  canCreateWindow: (reason) => {
    if (!forceUpdateMainWindowCreationBlocked) {
      return true;
    }

    // 强制升级命中后，Dock/托盘/activate/deep link 不能绕过 app-ready gate 创建旧版主界面。
    logger.warn(`[force-update] 已阻止主窗口创建入口：${reason}`);
    focusForceUpdateGateWindow();
    return false;
  },
  logger,
});

windowLifecycle.installWindowSubscriptions({
  syncAppTelemetryInteractiveState,
  rebuildMenu,
  resetShortcutRecordingForWebContents,
});

deepLinks.install();

async function prepareAppQuit(reason: string, kind: AppShutdownKind = "normal"): Promise<void> {
  const selection = selectAppShutdownPolicy(activeAppShutdownKind, kind, process.platform);
  activeAppShutdownKind = selection.kind;
  activeAppShutdownPolicy = selection.policy;
  if (selection.upgraded && (hasPreparedAppQuit || appQuitPreparationInFlight)) {
    // 更新请求可能晚于普通退出屏障。已创建的 4s timer 无法靠修改全局策略延长；
    // 明确保留既有预算，并允许更新继续进入 fail-open 资源扫描和安装器。
    logger.warn(
      `[app-quit] update install joined an existing normal shutdown barrier (${reason}); existing timers keep their original budget`,
    );
  }
  if (hasPreparedAppQuit) {
    return;
  }
  if (appQuitPreparationInFlight) {
    await appQuitPreparationInFlight;
    return;
  }

  markForceQuit(reason);
  windowsCuaOperationIndicator.dispose();
  browserScreenshotSurfaceCoordinator.dispose();
  // Bug 根因：资源样本改为 5 分钟窗口后，退出仍直接 stop 会清空未满窗口的数据。
  // 退出时只排空已存在的角色 / Agent 内存窗口，不启动新采样、目录扫描或外部探针。
  stopDesktopResourceTelemetry({ flushPendingWindows: true });
  stopDesktopZCodeDataSizeTelemetry();
  stopDesktopNetworkTelemetry();
  stopRemoteUsageArmsPeriodicSampling();
  services.disposeRendererActionTraceIpcRef.current?.();
  services.disposeRendererActionTraceIpcRef.current = undefined;
  notifyStabilityAppExit(
    getStabilityLifecycleScene() === "update_install" ? "update_install" : "app_quit",
    logger,
    { exitCode: 0, exitKind: "normal" },
  );

  const cronSchedulerToDispose = cronScheduler;
  cronScheduler = null;

  const hostProcesses = [
    ...new Set([...windowHostProcessMap.values(), ...listDisposingHostProcesses()]),
  ];
  logger.info(
    `[app-quit] waiting for host process cleanup (${reason}), kind=${activeAppShutdownKind}, hosts=${hostProcesses.length}, forceKillDelayMs=${activeAppShutdownPolicy.forceKillDelayMs}, waitTimeoutMs=${activeAppShutdownPolicy.waitTimeoutMs}`,
  );

  appQuitPreparationInFlight = Promise.all([
    // 退出屏障结束后再启动窗口尺寸写入，可能在 app.exit 前留下 setting.json.lock。
    // 尺寸已在 resize 防抖或最大化状态变化时保存，退出屏障不再创建新的尺寸写入。
    // 修复原因：Main 过去不会等待仍在发送的 /event/report，正常退出也会直接丢事件。
    // 与其它 owner 并行进入既有屏障，最多等待 2 秒，避免 telemetry 串行放大退出预算。
    appTelemetryCore.flushPendingReports({ timeoutMs: 2_000 }),
    localTtftExporter.shutdown(),
    rendererActionTraceBroker.shutdown().catch((error) => {
      logger.warn(`[app-quit] renderer action trace shutdown failed (${reason}):`, error);
    }),
    // 旧流程先等待 Cron 的 1.5s deadline，再启动 Host timer，导致声明的
    // 4.5s/9s 退出总预算被串行放大。两类 owner 无关闭依赖，统一并行进入同一屏障。
    (async () => {
      try {
        await cronSchedulerToDispose?.dispose();
      } catch (error) {
        logger.warn(`[app-quit] cron scheduler dispose failed (${reason}):`, error);
      }
    })(),
    // remote session、attachment 和 transport 都由窗口 Host 持有；这里先清理
    // Main 的请求关联，再由下方每窗口唯一 Host 的 shutdown barrier 释放真实连接与 Agent。
    remoteSessionManager.disposeAllAndWaitForAppShutdown(reason),
    ...hostProcesses.map((child, index) =>
      disposeHostProcessAndWait(
        child,
        `${reason}-${index + 1}`,
        disposingHostProcessTimers,
        logger,
        {
          forceKillDelayMs: activeAppShutdownPolicy.forceKillDelayMs,
          waitTimeoutMs: activeAppShutdownPolicy.waitTimeoutMs,
        },
      ),
    ),
  ])
    .then(() => {
      logger.info(`[app-quit] host process cleanup completed (${reason})`);
    })
    .catch((error) => {
      logger.error(`[app-quit] host process cleanup failed (${reason}):`, error);
    })
    .finally(() => {
      // before-quit 是同步事件。只发 Dispose 就继续退出 main 的话，
      // host 还没等到 agent 进程树的 SIGTERM/SIGKILL 兜底完成就被带走，zcode-cli 会被 init 接管成残留进程。
      // 这里先拦截第一次退出，等待 host 清理完成后再放行第二次 app.quit。
      hasPreparedAppQuit = true;
      appQuitPreparationInFlight = null;
    });

  await appQuitPreparationInFlight;
}

function exitPreparedApp(reason: string): never | void {
  logger.info(`[app-quit] exiting prepared app (${reason})`);
  if (process.env.ZCODE_E2E_RUN_ID?.trim()) {
    flushMainE2ECoverage((error) => {
      logger.warn("[e2e-coverage] main coverage flush failed", error);
    });
    // ChromeDriver 正在执行 deleteSession 时，Electron app.exit(0)
    // 和进程内的 process.kill 都可能被 Electron 生命周期吞掉。这里只在 E2E
    // run 身份明确、且 prepareAppQuit 已完成 host/agent 回收之后，启动独立系统
    // 命令终止当前 PID；不按名称扫描，也不会影响产品退出或下一轮 session。
    const killer =
      process.platform === "win32"
        ? spawn("taskkill", ["/PID", String(process.pid), "/F"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn("kill", ["-9", String(process.pid)], {
            detached: true,
            stdio: "ignore",
          });
    killer.unref();
    return;
  }
  app.exit(0);
}

app.whenReady().then(async () => {
  const preparation = await prepareAppRuntime({
    mainDirname,
    iconPath,
    services,
    hostProcessLocalEnv,
    localMediaPreviewPathRegistry,
    getApplicationLocale: () => currentApplicationLocale,
    setApplicationLocale: (locale) => {
      currentApplicationLocale = locale;
    },
    setCloseToTrayOnWindows: (value) => {
      closeToTrayOnWindows = value;
    },
    setKeepAwakeWhileRunning: (value) => {
      keepAwakeWhileRunning = value;
    },
    reconcileKeepAwakeBlocker,
    setDesktopZoomLevel: (zoomLevel) => {
      currentDesktopZoomLevel = zoomLevel;
    },
    setDesktopWindowSize: (size) => {
      currentDesktopWindowSize = size;
    },
    setCronScheduler: (scheduler) => {
      cronScheduler = scheduler;
    },
    resolveCronDispatchHost,
    requestDatabaseStartupExit: () => {
      markExplicitQuit("database-startup-exit");
      app.quit();
    },
  });

  // 启动自动更新检查（后台执行，不阻塞主界面）
  // Preview 身份无论连接哪个后端都不自动更新：stable feed 上只分发正式 ZCode 安装包，
  // 不向 Preview 渠道提供更新。构建期未启用自动更新时同样不更新
  // （见 docs/desktop/build-time-optional-capabilities.md）。
  void initAutoUpdater({
    enabled: ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED,
    onBeforeQuitAndInstall: async () => {
      notifyStabilityLifecycle("update_install");
      await prepareAppQuit("auto-update quitAndInstall", "update-install");
      if (process.platform === "win32") {
        await prepareWindowsProcessesForUpdateInstall();
      }
    },
    settingService: mainSettingService,
    locale: currentApplicationLocale,
    deviceMid,
    resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
    updateFeedSource: resolveUpdateFeedSourceFromStartupConfig({
      argv: process.argv,
      env: process.env,
    }),
  });

  await installReadyRuntime({
    services,
    appMenu,
    tray,
    primaryWindowCoordinator,
    registerIpc: () => {
      registerAppIpcHandlers({
        services,
        remoteSessionManager,
        browserLifecycle,
        appMenu,
        updater,
        tray,
        primaryWindowCoordinator,
        windowsCuaOperationIndicator,
        cuaPipFocusRouter,
        getApplicationWindows: getApplicationWindowsExcludingCuaIndicator,
        getApplicationLocale: () => currentApplicationLocale,
        setApplicationLocale: (locale) => {
          currentApplicationLocale = locale;
        },
        windowWorkspaceMap,
        windowTaskRealtimeHostIdMap,
        windowUnreadCountMap,
        windowHostProcessMap,
        taskRealtimeBus,
        syncImmediateAppSettings,
        getRunningAgentSessionCount,
        setShortcutRecordingActive,
      });
    },
    getApplicationLocale: () => currentApplicationLocale,
    getRunningAgentSessionCount,
  });

  await launchPrimaryApplication({
    desktopPathPromise: preparation.desktopPathPromise,
    iconPath,
    primaryWindowCoordinator,
    deepLinks,
    getApplicationLocale: () => currentApplicationLocale,
    getApplicationWindows: getApplicationWindowsExcludingCuaIndicator,
    resolveCurrentZCodeEndpointOrigin,
    setForceUpdateMainWindowCreationBlocked: (blocked) => {
      forceUpdateMainWindowCreationBlocked = blocked;
    },
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    // macOS: keep app running when all windows are closed
    return;
  }

  app.quit();
});
app.on("before-quit", (event) => {
  // Windows 最后窗口关闭会在 close 阶段提前确认并标记 forceQuit；
  // macOS 的 Cmd+Q / 菜单退出不会走该窗口关闭确认，必须在 before-quit 保留应用级确认兜底。
  if (!forceQuitRef.current && shouldConfirmAppQuit() && !confirmAppQuit()) {
    event.preventDefault();
    // 托盘退出等显式退出如果被确认框取消，不能继续保留 explicitQuit。
    // 否则用户下一次点 Windows 关闭按钮会绕过“隐藏到托盘”设置，误触发完整退出路径。
    explicitQuitRef.current = false;
    return;
  }

  if (!hasPreparedAppQuit) {
    localMediaPreviewPathRegistry.clear();
    event.preventDefault();
    void prepareAppQuit("app-before-quit").finally(() => {
      const remainingWindows = getApplicationWindowsExcludingCuaIndicator();
      logger.info(
        `[app-quit] preparation finished, resuming quit with windows=${remainingWindows.length}`,
      );
      // ChromeDriver 关闭最后一个 renderer 后才触发 app.quit 时，
      // 第一次 before-quit 会被异步 host 清理拦截；清理完成时窗口可能仍处于
      // closing 状态，此时重入 app.quit 会被 Electron 忽略，ChromeDriver 会等待
      // 约 70 秒。这里把最后一次退出绑定到真实 closed 事件，不依赖超时猜测。
      if (remainingWindows.length === 0) {
        exitPreparedApp("no-windows-after-preparation");
        return;
      }

      let exitRequested = false;
      const exitAfterLastWindowClosed = () => {
        if (exitRequested || getApplicationWindowsExcludingCuaIndicator().length > 0) {
          return;
        }
        exitRequested = true;
        logger.info("[app-quit] all windows closed after preparation, exiting app");
        exitPreparedApp("all-windows-closed-after-preparation");
      };
      for (const win of remainingWindows) {
        win.once("closed", exitAfterLastWindowClosed);
      }
      app.quit();
    });
  }
});
app.on("activate", () => {
  void primaryWindowCoordinator.ensurePrimaryWindow("app-activate");
});
