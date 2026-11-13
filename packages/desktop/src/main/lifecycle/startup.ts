import { app, nativeImage, powerMonitor, session } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_VERSION,
  mapZCodeEnvToArmsRumEnv,
  desktopMenuMessageIds,
  type AppSettings,
  type Locale,
} from "@zcode/shared";
import { getDataBaseDir, getZCodeDataRootDir, setDataBaseDir } from "@zcode/services/node";
import { logger } from "../logger.js";
import { applyDesktopProcessPath } from "../loginShellPath.js";
import { markMainLaunchAppReady } from "../desktopLaunchMarks.js";
import { installRequestSecurityDiagnostics } from "../request-security-edition/index.js";
import { setDesktopTelemetryAllowed } from "../desktopTelemetryGate.js";
import {
  onLocalDatabaseStartupReady,
  configureDatabaseStartupQuit,
} from "../databaseStartupRelay.js";
import { armsInitPromise } from "../appARMSBootstrap.js";
import { installPluginSandboxHost } from "../pluginSandbox/index.js";
import { installBrowserRestoreBootstrapProtocol } from "../browserView/browserRestoreBootstrapProtocol.js";
import { EMBEDDED_BROWSER_PARTITION } from "../browserDataManager.js";
import { applyDesktopChromiumNetworkPolicies } from "../desktopNetworkPolicy.js";
import { applyEmbeddedBrowserPermissionPolicy } from "../embeddedBrowserPermissionPolicy.js";
import { createEmbeddedBrowserSitePermissionStore } from "../embeddedBrowserSitePermissionStore.js";
import {
  createEmbeddedBrowserPermissionUiBridge,
  setActiveEmbeddedBrowserPermissionUiBridge,
} from "../embeddedBrowserPermissionUiBridge.js";
import { hydratePendingPostUpdateReleaseNotes } from "../autoUpdater.js";
import { applyAppIcon } from "../desktopWindowChrome.js";
import { clampDesktopZoomLevel } from "../desktopZoom.js";
import { resolveWindowsAppUserModelIdForFlavor } from "../../../scripts/desktop-product-identity.mjs";
import {
  resolveCloseToTrayBootstrapValue,
  resolveCloseToTrayRuntimeValue,
} from "../desktopTraySupport.js";
import { spawnCronScheduler, type CronSchedulerHandle } from "../desktopCronScheduler.js";
import { installFinderOpenFolderWorkflow } from "../desktopFinderOpenFolderWorkflow.js";
import { installWindowsOpenFolderContextMenu } from "../desktopWindowsOpenFolderContextMenu.js";
import { configureDockMenu, showCurrentWindowFromDock } from "../desktopWindowLifecycle.js";
import {
  getDesktopMenuLabel as getDesktopMenuLabelByLocale,
  resolveSystemApplicationLocale,
} from "../desktopApplicationMenu.js";
import {
  configureDesktopStabilityTelemetry,
  registerDesktopStabilityMonitors,
  scheduleReportPerfAppStartAfterMainViewReady,
} from "../desktopStabilityTelemetry.js";
import {
  configureDesktopResourceTelemetry,
  registerDesktopResourceTelemetry,
  resolveResourceUsageScene,
} from "../desktopResourceTelemetry.js";
import { registerRendererHeapSampleIpc } from "../processResourceRendererHeapSource.js";
import { registerDesktopZCodeDataSizeTelemetry } from "../desktopZCodeDataSizeTelemetry.js";
import { configureDesktopMcpTelemetry } from "../desktopMcpTelemetry.js";
import {
  configureDesktopNetworkTelemetry,
  registerDesktopNetworkTelemetry,
} from "../desktopNetworkTelemetry.js";
import { maybeBlockStartupForForceUpdate } from "../forceUpdateGuard.js";
import { maybeWarnArchitectureMismatch } from "../desktopArchitectureGuard.js";
import { crashCapturePaths } from "../appCrashCaptureBootstrap.js";
import { desktopRuntimeEnv } from "../desktopRuntimeEnv.js";
import { logWindowsBundledRuntimeIntegrityDiagnostic } from "./shutdown.js";
import {
  installLocalMediaPreviewSessionProtocol,
  type LocalMediaPreviewPathRegistry,
} from "./browser.js";
import type { AppMenuLifecycle } from "./appMenu.js";
import type { DeepLinkLifecycle } from "./deepLinks.js";
import type { MainServices } from "./services.js";
import type { TrayLifecycle } from "./tray.js";

export interface AppRuntimePreparationOptions {
  mainDirname: string;
  iconPath: string;
  services: MainServices;
  hostProcessLocalEnv: Record<string, string>;
  localMediaPreviewPathRegistry: LocalMediaPreviewPathRegistry;
  getApplicationLocale: () => Locale;
  setApplicationLocale: (locale: Locale) => void;
  setCloseToTrayOnWindows: (value: boolean) => void;
  setKeepAwakeWhileRunning: (value: boolean) => void;
  reconcileKeepAwakeBlocker: () => void;
  setDesktopZoomLevel: (zoomLevel: number) => void;
  setDesktopWindowSize: (size: AppSettings["desktopWindowSize"]) => void;
  setCronScheduler: (scheduler: CronSchedulerHandle | null) => void;
  resolveCronDispatchHost: () => ElectronUtilityProcess | null;
  requestDatabaseStartupExit: () => void;
}

export interface AppRuntimePreparation {
  bootstrapSettings: AppSettings | undefined;
  desktopPathPromise: ReturnType<typeof applyDesktopProcessPath>;
}

export async function prepareAppRuntime(
  options: AppRuntimePreparationOptions,
): Promise<AppRuntimePreparation> {
  const { services } = options;
  // 与 Cline sidecar 相同：先解析 PATH，再创建会拉起 Host / opencode 的窗口。
  const desktopPathPromise = applyDesktopProcessPath(process.env);
  markMainLaunchAppReady();
  installRequestSecurityDiagnostics(session.defaultSession.webRequest, logger);
  installLocalMediaPreviewSessionProtocol(
    options.localMediaPreviewPathRegistry,
    session.defaultSession,
  );
  // 插件 UI 沙箱：注册表 + renderer 可调 IPC；scheme 的 privileged 注册已随 zcode-media 在 ready 前完成。
  installPluginSandboxHost({
    preloadPath: join(options.mainDirname, "../preload/pluginSandbox.cjs"),
    rendererDir: join(options.mainDirname, "../renderer"),
    aliasDir: join(options.mainDirname, "../plugin-sandbox"),
    // 开发模式 out/renderer 没有 shell 产物，从 renderer dev server 代理（同 cua-permission-panel 的做法）。
    ...(!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]
      ? { devServerUrl: process.env["ELECTRON_RENDERER_URL"] }
      : {}),
    logger: console,
    // e2e L05（配额）：只在 e2e run 里允许缩小注册表容量。
    ...(process.env.ZCODE_E2E_RUN_ID?.trim() &&
    Number.isInteger(Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES)) &&
    Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES) > 0
      ? { registryMaxEntries: Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES) }
      : {}),
  });
  installBrowserRestoreBootstrapProtocol(
    session.fromPartition(EMBEDDED_BROWSER_PARTITION).protocol,
  );
  // Bootstrap: 从设置文件读取自定义数据目录，在所有 host 进程启动前生效
  let loadedBootstrapLocale = false;
  let bootstrapSettings: AppSettings | undefined;
  try {
    bootstrapSettings = await services.mainSettingService.get();
    // Стартовая инициализация ARMS не должна ждать первого HTTP-события.
    setDesktopTelemetryAllowed(bootstrapSettings.telemetryEnabled !== false);
    if (bootstrapSettings.dataBaseDir) {
      setDataBaseDir(bootstrapSettings.dataBaseDir);
    }
    if (bootstrapSettings.locale) {
      loadedBootstrapLocale = true;
      options.setApplicationLocale(bootstrapSettings.locale);
    }
    // Linux 默认值归位迁移（spec：docs/desktop/linux-close-to-tray.md）：shared 迁移无平台
    // 概念、曾把存量 Linux 用户归为 true，但 Linux 此前无设置入口，存量 true 非用户显式
    // 选择；首次启动强制归位为默认关并落标记，之后尊重用户选择。
    const closeToTrayBootstrap = resolveCloseToTrayBootstrapValue({
      platform: process.platform,
      stored: bootstrapSettings.closeToTrayOnWindows,
      linuxMigrationInitialized: bootstrapSettings.closeToTrayLinuxMigrationInitialized,
    });
    // CR-02：必须 await 持久化完成再继续启动，renderer 设置页才不会读到文件旧值。
    // 写失败时不阻断启动，但内存值回退为文件当前值（resolveCloseToTrayRuntimeValue）：
    // 持久层不可写时维持"文件是唯一可信来源"，避免 main 按 false、设置页显示 true 的
    // 双数据源；迁移在下次启动重试，失败期间保持迁移未完成的旧行为。
    let closeToTrayMigrationPersisted = true;
    if (closeToTrayBootstrap.needsLinuxMigration) {
      try {
        await services.mainSettingService.update({
          closeToTrayOnWindows: false,
          closeToTrayLinuxMigrationInitialized: true,
        });
      } catch (error) {
        closeToTrayMigrationPersisted = false;
        logger.warn("[settings] failed to persist linux close-to-tray default migration", error);
      }
    }
    options.setCloseToTrayOnWindows(
      resolveCloseToTrayRuntimeValue({
        platform: process.platform,
        stored: bootstrapSettings.closeToTrayOnWindows,
        linuxMigrationInitialized: bootstrapSettings.closeToTrayLinuxMigrationInitialized,
        migrationPersisted: closeToTrayMigrationPersisted,
      }),
    );
    options.setKeepAwakeWhileRunning(bootstrapSettings.keepAwakeWhileRunning ?? false);
    options.setDesktopZoomLevel(clampDesktopZoomLevel(bootstrapSettings.desktopZoomLevel ?? 0));
    options.setDesktopWindowSize(bootstrapSettings.desktopWindowSize);
    // 全局 keep-awake：启动时若设置已开，立刻持有 powerSaveBlocker，不必等设置变更事件。
    options.reconcileKeepAwakeBlocker();
  } catch {
    // 读取失败不影响启动，使用默认 homedir
  }

  // scheduler 也会打开 tasks-index；等 Host 完成统一准备，避免在启动页出现前抢先迁移。
  configureDatabaseStartupQuit(() => {
    options.requestDatabaseStartupExit();
  });
  onLocalDatabaseStartupReady(() => {
    try {
      options.setCronScheduler(
        spawnCronScheduler({
          hostProcessLocalEnv: options.hostProcessLocalEnv,
          logger,
          resolveDispatchHost: options.resolveCronDispatchHost,
          // keep-awake 已改为纯设置驱动；计数上报保留给后续诊断/配额用途，不再联动 blocker。
          onOffPeakActiveCountChanged: () => {},
        }),
      );
    } catch (error) {
      logger.error("[cron-scheduler] failed to spawn scheduler process:", error);
    }
  });

  if (process.platform === "win32") {
    // 打包态必须与 NSIS 快捷方式使用同一 AUMID，否则 Shell 把它们当成不同应用。
    // 使用构建期产品身份，不依赖用户机器环境；开发态继续保持独立身份。
    app.setAppUserModelId(
      resolveWindowsAppUserModelIdForFlavor(ZCODE_PRODUCT_FLAVOR, { isPackaged: app.isPackaged }),
    );
  }

  applyAppIcon(options.iconPath);
  if (!loadedBootstrapLocale) {
    options.setApplicationLocale(resolveSystemApplicationLocale());
  }
  // Electron 的 net.request 只能在 app ready 后使用；灰度请求仍是旁路预热，不阻塞首个 Host。
  // 预热曾在读取持久化语言之前启动，X-Client-Language 会带默认语言并进入 1 小时缓存；
  // 必须在 currentApplicationLocale 确定之后再启动。
  void services.desktopContextPromptRollout?.refresh();
  installFinderOpenFolderWorkflow({
    platform: process.platform,
    locale: options.getApplicationLocale(),
    homeDir: app.getPath("home"),
    logger,
  });
  await installWindowsOpenFolderContextMenu({
    platform: process.platform,
    executablePath: process.execPath,
    argv: process.argv,
    isDefaultApp: Boolean(process.defaultApp),
    locale: options.getApplicationLocale(),
    logger,
  });
  try {
    await applyDesktopChromiumNetworkPolicies(session, bootstrapSettings ?? {}, logger);
  } catch (error) {
    logger.warn("[desktop-network] Chromium network policy bootstrap failed:", error);
  }

  // 内置浏览器权限闸门（CNVD 未授权访问修复）：必须在任何 guest attach 前完成注册。
  // 弹窗桥把策略决策点接到主窗口 UI；store 落盘「访问此网站时允许/阻止」的站点同意记录。
  const embeddedBrowserPermissionUiBridge = createEmbeddedBrowserPermissionUiBridge({ logger });
  embeddedBrowserPermissionUiBridge.registerResolveListener();
  setActiveEmbeddedBrowserPermissionUiBridge(embeddedBrowserPermissionUiBridge);
  try {
    await applyEmbeddedBrowserPermissionPolicy(session.fromPartition(EMBEDDED_BROWSER_PARTITION), {
      logger,
      prompt: embeddedBrowserPermissionUiBridge.promptPermission,
      devicePicker: embeddedBrowserPermissionUiBridge.devicePicker,
      onDisplayMediaRequest: embeddedBrowserPermissionUiBridge.onDisplayMediaRequest,
      store: createEmbeddedBrowserSitePermissionStore(
        join(app.getPath("userData"), "embedded-browser-site-permissions.json"),
      ),
    });
  } catch (error) {
    logger.warn("[embedded-browser-permission] policy bootstrap failed:", error);
  }

  await hydratePendingPostUpdateReleaseNotes(services.mainSettingService);
  logWindowsBundledRuntimeIntegrityDiagnostic();

  return { bootstrapSettings, desktopPathPromise };
}

export interface ReadyRuntimeOptions {
  services: MainServices;
  appMenu: AppMenuLifecycle;
  tray: TrayLifecycle;
  primaryWindowCoordinator: ReturnType<
    typeof import("../primaryWindowCoordinator.js").createPrimaryWindowCoordinator
  >;
  registerIpc: () => void;
  getApplicationLocale: () => Locale;
  getRunningAgentSessionCount: () => number;
}

export async function installReadyRuntime(options: ReadyRuntimeOptions): Promise<void> {
  if (process.platform === "darwin" || process.platform === "win32") {
    app.clearRecentDocuments();
  }

  options.appMenu.rebuildMenu();
  configureDockMenu(
    () =>
      getDesktopMenuLabelByLocale(
        options.getApplicationLocale(),
        desktopMenuMessageIds.dockShowCurrentWindow,
      ),
    () => showCurrentWindowFromDock(options.primaryWindowCoordinator),
  );
  options.tray.initializeTray();
  if (process.platform === "linux") {
    void options.tray.ensureLinuxDesktopTray().catch((error: unknown) => {
      logger.warn("[desktop-tray] linux tray capability probe failed", error);
    });
  }

  options.registerIpc();

  // 等待 ARMS 完成 init（含渲染进程注入监听），避免首窗 dom-ready 早于 SDK 注册导致无上报
  await armsInitPromise;

  // ARMS init 完成后首次写入 user.name（落 device_mid）
  void options.services.armsUserIdentitySync.refresh();

  configureDesktopStabilityTelemetry({
    deviceMid: options.services.deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopResourceTelemetry({
    deviceMid: options.services.deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopMcpTelemetry({
    deviceMid: options.services.deviceMid,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopNetworkTelemetry({
    deviceMid: options.services.deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  registerDesktopStabilityMonitors(logger, crashCapturePaths);
  registerDesktopResourceTelemetry(logger);
  // 主窗口 renderer 的 60 秒 heap 样本入口；随 App 生命周期常驻，只注册一次。
  registerRendererHeapSampleIpc();
  const defaultDataBaseDir = process.env.HOME?.trim() || homedir();
  registerDesktopZCodeDataSizeTelemetry({
    context: {
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
      dataRootKind:
        resolve(getDataBaseDir()) === resolve(defaultDataBaseDir) ? "default" : "custom",
      deviceMid: options.services.deviceMid,
      platform: process.platform,
    },
    getSystemIdleTimeSeconds: () => powerMonitor.getSystemIdleTime(),
    isAppBackground: () => resolveResourceUsageScene() === "background",
    isZCodeBusy: () => options.getRunningAgentSessionCount() > 0,
    logger,
    rootPath: getZCodeDataRootDir(),
    stateFile: join(app.getPath("userData"), "zcode-data-size-telemetry.json"),
  });
  registerDesktopNetworkTelemetry(logger);
}

export interface PrimaryApplicationLaunchOptions {
  desktopPathPromise: ReturnType<typeof applyDesktopProcessPath>;
  iconPath: string;
  primaryWindowCoordinator: ReturnType<
    typeof import("../primaryWindowCoordinator.js").createPrimaryWindowCoordinator
  >;
  deepLinks: DeepLinkLifecycle;
  getApplicationLocale: () => Locale;
  getApplicationWindows: () => import("electron").BrowserWindow[];
  resolveCurrentZCodeEndpointOrigin: () => Promise<string>;
  setForceUpdateMainWindowCreationBlocked: (blocked: boolean) => void;
}

export async function launchPrimaryApplication(
  options: PrimaryApplicationLaunchOptions,
): Promise<void> {
  // 本地未打包 dev 构建（app.isPackaged === false）必须跳过远端强制升级 gate。
  // 原因：force-update gate 只看 ZCODE_ENV === "production"，但 dev 构建（如 dev:desktop:cua
  // 连真实后端测 computer use）虽指向 production 后端，版本号却滞后于线上 release（feature
  // 分支不 bump 版本），会被 release minimalVersion 误判为"需强制升级"而启动秒退。force-update
  // 是面向打包发布客户端的安全门，对未打包 dev 运行时无意义。打包版 app.isPackaged === true，
  // gate 照常生效，对真实用户零影响。
  const skipForceUpdateForLocalDevRuntime = !app.isPackaged;
  const forceUpdateGuardResult =
    ZCODE_PRODUCT_FLAVOR === "production" && !skipForceUpdateForLocalDevRuntime
      ? await maybeBlockStartupForForceUpdate({
          locale: options.getApplicationLocale(),
          logger,
          endpointOrigin: await options.resolveCurrentZCodeEndpointOrigin(),
          onBlocked: () => {
            options.setForceUpdateMainWindowCreationBlocked(true);
          },
        })
      : { blocked: false };
  if (ZCODE_PRODUCT_FLAVOR !== "production") {
    logger.info("[force-update] Preview 跳过远端强制升级检查");
  } else if (skipForceUpdateForLocalDevRuntime) {
    logger.info("[force-update] 本地 dev 构建（未打包）跳过远端强制升级检查");
  }
  if (forceUpdateGuardResult.blocked) {
    return;
  }

  const desktopPath = await options.desktopPathPromise;
  logger.info("[startup] process PATH", desktopPath);
  logger.info("[startup] 创建主窗口");
  await options.primaryWindowCoordinator.ensurePrimaryWindow("app-ready");

  const primaryWindow = options.getApplicationWindows()[0];
  if (primaryWindow) {
    scheduleReportPerfAppStartAfterMainViewReady(primaryWindow.webContents, logger);
  }

  // 启动后检测 CPU 架构是否匹配（如 Apple 芯片误装 x64 版本经 Rosetta 转译运行），
  // 命中后异步弹框提示安装原生架构版本，不阻塞主界面。
  void maybeWarnArchitectureMismatch({
    locale: options.getApplicationLocale(),
    logger,
    parentWindow: options.getApplicationWindows()[0] ?? null,
    icon: nativeImage.createFromPath(options.iconPath),
  }).catch((error) => {
    logger.warn("[architecture] 架构检测弹框失败:", error);
  });

  options.deepLinks.handleReadyProtocolUrl();
}
