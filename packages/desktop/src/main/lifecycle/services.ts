import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { app, BrowserWindow, ipcMain, net, safeStorage } from "electron";
import { hostname } from "node:os";
import armsRum from "@arms/rum-electron";
import {
  createCredentialService,
  createSettingService,
  createTelemetryCore,
  createTelemetryMarketingParamsLoader,
  createTelemetryUserIdLoader,
  createTelemetryAuthorizationLoader,
} from "@zcode/services/node";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  PlatformChannels,
  ZCODE_ENV,
  ZCODE_VERSION,
  buildZCodeEndpointUrls,
  resolveWebRemoteControlRelayWsUrl,
  resolveZCodeEndpointOrigin,
  type Locale,
  type TelemetryEventPayload,
} from "@zcode/shared";
import { logger, webRemoteControlRelayLogger } from "../logger.js";
import { setDesktopTelemetryAllowed } from "../desktopTelemetryGate.js";
import { createDesktopTelemetryFetch } from "../desktopTelemetryFetch.js";
import { createAppLaunchGate } from "../appLaunchGate.js";
import { createAppLaunchCoordinator } from "../appLaunchCoordinator.js";
import { createAppTelemetryRuntime } from "../appTelemetryRuntime.js";
import { createRendererActionTraceBroker } from "../rendererActionTraceBroker.js";
import { createRendererActionTraceExporter } from "../rendererActionTraceExporter.js";
import { createRendererActionTraceRollout } from "../rendererActionTraceRollout.js";
import { ensureDesktopDeviceMidSync } from "../desktopDeviceMid.js";
import { createArmsUserIdentitySync } from "../armsUserIdentity.js";
import { createLocalTtftExporter } from "../localTtftExporter.js";
import {
  createDesktopContextPromptRollout,
  createElectronDesktopContextPromptConfigFetcher,
} from "../desktopContextPromptRollout.js";
import type { createRemoteWorkspaceSessionManager } from "../desktopRemoteSessions.js";
import {
  listAvailableDockerContainers,
  listAvailableWSLDistros,
  listSSHConfigAliases,
  isDockerDaemonAvailable,
  loadHostProcessEnvFromLocalFiles,
  resolveZCodeEndpointEnvBaseOrigin,
} from "../desktopRuntimeEnv.js";
import { createWebRemoteControlSharedHostAttachments } from "../webRemoteControlSharedHostAttachments.js";
import { createDesktopHelpConfigReader } from "../desktopHelpConfig.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "../mcpUserDirectory/index.js";
import { createTempTextAttachment } from "../tempTextAttachment.js";
import { createWebRemoteControlManager } from "../webRemoteControlManager.js";
import { createWebRemoteControlDeviceStorage } from "../web-remote-relay/index.js";
import { createWebRemoteControlFeatureGate } from "../webRemoteControlFeatureGate.js";
import { reconnectWebRemoteControlWorkspaceInRenderer } from "../webRemoteControlRendererReconnect.js";
import { sendWebRemoteControlStatusChangedToWindow } from "../webRemoteControlStatusEvents.js";

const DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS = 2_000;

export type MainSettingService = ReturnType<typeof createSettingService>;
export type WebRemoteControlCredentialService = ReturnType<typeof createCredentialService>;
export type AppTelemetryCore = ReturnType<typeof createTelemetryCore>;
export type AppTelemetryRuntime = ReturnType<typeof createAppTelemetryRuntime>;
export type RemoteWorkspaceSessionManager = ReturnType<typeof createRemoteWorkspaceSessionManager>;
export type WebRemoteControlManager = ReturnType<typeof createWebRemoteControlManager>;
export type DesktopContextPromptRollout = ReturnType<typeof createDesktopContextPromptRollout>;

export interface MainServicesOptions {
  hostProcessLocalEnv: ReturnType<typeof loadHostProcessEnvFromLocalFiles>;
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  getApplicationLocale: () => Locale;
  getApplicationWindows: () => BrowserWindow[];
  remoteSessionManager: RemoteWorkspaceSessionManager;
  webRemoteControlManagerRef: { current: WebRemoteControlManager | null };
}

export interface MainServices {
  mainSettingService: MainSettingService;
  webRemoteControlCredentialService: WebRemoteControlCredentialService;
  appTelemetryCore: AppTelemetryCore;
  appTelemetryRuntime: AppTelemetryRuntime;
  resolveCurrentZCodeEndpointOrigin: () => Promise<string>;
  resolveDesktopContextPromptEnabledForHost: () => boolean;
  awaitFirstHostSpawnDecision: () => Promise<void>;
  webRemoteControlManager: WebRemoteControlManager;
  webRemoteControlSharedHostAttachments: ReturnType<
    typeof createWebRemoteControlSharedHostAttachments
  >;
  deviceMid: string;
  readHelpConfig: ReturnType<typeof createDesktopHelpConfigReader>;
  desktopContextPromptRollout: DesktopContextPromptRollout | undefined;
  rendererActionTraceRollout: ReturnType<typeof createRendererActionTraceRollout>;
  rendererActionTraceBroker: ReturnType<typeof createRendererActionTraceBroker>;
  localTtftExporter: ReturnType<typeof createLocalTtftExporter>;
  armsUserIdentitySync: ReturnType<typeof createArmsUserIdentitySync>;
  disposeRendererActionTraceIpcRef: { current: (() => void) | undefined };
  reportRemoteUsageEventForRenderer: (rendererId: number, event: TelemetryEventPayload) => void;
  syncAppTelemetryInteractiveState: () => void;
}

export function createMainServices(options: MainServicesOptions): MainServices {
  const {
    hostProcessLocalEnv,
    windowHostProcessMap,
    getApplicationLocale,
    remoteSessionManager,
    webRemoteControlManagerRef,
  } = options;
  const mainSettingService = createSettingService();
  const webRemoteControlCredentialService = createCredentialService({ safeStorage });
  const appLaunchGate = createAppLaunchGate();
  const appLaunchCoordinator = createAppLaunchCoordinator(appLaunchGate);
  const appTelemetryCredentialService = createCredentialService({ safeStorage });

  async function resolveCurrentZCodeEndpointOrigin() {
    return resolveZCodeEndpointOrigin({
      env: ZCODE_ENV,
      envBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
      overrideOrigin: (await mainSettingService.get()).zcodeEndpointOrigin,
    });
  }

  let desktopContextPromptRollout: DesktopContextPromptRollout | undefined;
  function resolveDesktopContextPromptEnabledForHost(): boolean {
    const rollout = desktopContextPromptRollout;
    if (!rollout) {
      return false;
    }
    // Host 创建时顺便触发过期刷新，但只读取当前快照；网络请求不能阻塞 Local/Remote Host。
    void rollout.refresh();
    return rollout.getSnapshot().enabled;
  }

  // 首个 Host 创建前的有界灰度裁决门。Host/Agent 的 presentation surface 在进程启动时
  // 冻结（services/node.ts 顶层 const + CLI --surface），而灰度请求是旁路、不阻塞 Host。若首个
  // Host fork 早于请求 resolve，成功结果（enabled:true）对已冻结的 Host/Agent 无可达生效路径。
  // 这里给"成功结果"一条有界的生效路径：首 Host fork 前 await 一次裁决（≤2s），失败/超时仍按当前
  // 快照继续（desktopContextPrompt fail-open）。first-only 永久
  // latch——后续 Host fork await 已 resolve 的 promise（近乎 0ms），且各 resolve*ForHost()
  // 同步读取已被刷新的 live 快照。
  let firstHostSpawnDecisionPromise: Promise<void> | null = null;
  function awaitFirstHostSpawnDecision(): Promise<void> {
    if (firstHostSpawnDecisionPromise) {
      return firstHostSpawnDecisionPromise;
    }
    firstHostSpawnDecisionPromise = (async () => {
      const rollout = desktopContextPromptRollout;
      if (!rollout) {
        return;
      }
      try {
        const decision = await rollout.awaitFirstDecision(
          DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS,
        );
        logger.info("[desktop-context-prompt] first host spawn decision resolved", {
          enabled: decision.enabled,
          configVersion: decision.configVersion,
        });
      } catch (error) {
        // awaitFirstDecision 永不 reject（refresh 内部已 catch + timeout 回退快照），此处仅兜底。
        logger.warn("[desktop-context-prompt] first host spawn decision failed, fail-open", {
          error,
        });
      }
    })();
    return firstHostSpawnDecisionPromise;
  }

  const appTelemetryCore = createTelemetryCore({
    loadUserId: createTelemetryUserIdLoader(appTelemetryCredentialService),
    loadAuthorization: createTelemetryAuthorizationLoader(appTelemetryCredentialService),
    loadMarketingParams: createTelemetryMarketingParamsLoader(appTelemetryCredentialService),
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
    isEnabled: async () => {
      const enabled = (await mainSettingService.get()).telemetryEnabled !== false;
      // ARMS-очередь читает значение синхронно; держим его в том же месте, где решается HTTP-отправка.
      setDesktopTelemetryAllowed(enabled);
      return enabled;
    },
    fetchImpl: createDesktopTelemetryFetch({
      fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
    }),
  });
  const appTelemetryRuntime = createAppTelemetryRuntime({
    telemetryCore: appTelemetryCore,
    appLaunchCoordinator,
  });

  function reportRemoteUsageEventForRenderer(
    rendererId: number,
    event: TelemetryEventPayload,
  ): void {
    const context =
      appTelemetryRuntime.getRendererContext(rendererId) ??
      appTelemetryRuntime.getLatestRendererContext();
    if (!context) {
      logger.warn("[remote-usage-telemetry] renderer context unavailable", {
        elementName: event.elementName,
        rendererId,
      });
      return;
    }
    // 最终失败由 TelemetryCore 统一记录一条脱敏告警；这里仅隔离远程连接主链路。
    void appTelemetryCore.reportEvent({ context, ...event }).catch(() => {});
  }

  // 复用既有只读账号入口；HTTP 由 main 的 Node fetch 执行，不触发 host OAuth 登出。
  const loadRemoteControlUserId = createTelemetryUserIdLoader(webRemoteControlCredentialService);
  const loadRemoteControlAuthorization = createTelemetryAuthorizationLoader(
    webRemoteControlCredentialService,
  );
  const webRemoteControlSharedHostAttachments = createWebRemoteControlSharedHostAttachments({
    windowHostProcessMap,
    attachRemoteWorkspaceSessionHost: remoteSessionManager.attachRemoteWorkspaceSessionHost,
    logger,
  });
  const deviceMid = ensureDesktopDeviceMidSync();
  // 帮助配置是公开读取，不能复用下面附带账号鉴权的灰度响应缓存。
  const readHelpConfig = createDesktopHelpConfigReader({
    appVersion: ZCODE_VERSION || app.getVersion(),
    deviceMid,
    getClientLanguage: getApplicationLocale,
    resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  // 同一个 /api/v1/client/configs fetcher 供两个灰度 rollout 共用（请求参数与鉴权完全一致，
  // 各自独立缓存/去重，服务端按 data.configs.<key> 区分功能）。
  const electronClientConfigsFetcher = createElectronDesktopContextPromptConfigFetcher({
    appVersion: ZCODE_VERSION || app.getVersion(),
    deviceMid,
    getClientLanguage: getApplicationLocale,
    resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  desktopContextPromptRollout = createDesktopContextPromptRollout({
    fetchConfig: electronClientConfigsFetcher,
    logger,
  });
  const rendererActionTraceRollout = createRendererActionTraceRollout({
    fetchConfig: electronClientConfigsFetcher,
    logger,
  });
  const localTtftExporter = createLocalTtftExporter({
    env: { ...hostProcessLocalEnv, ...process.env },
    version: ZCODE_VERSION || app.getVersion(),
    logger,
  });
  ipcMain.on(PlatformChannels.ReportLocalTtftBatch, (_event, batch: unknown) =>
    localTtftExporter.enqueue(batch),
  );
  const rendererActionTraceBroker = createRendererActionTraceBroker({
    exporter: createRendererActionTraceExporter({
      ...hostProcessLocalEnv,
      ...process.env,
    }),
    logger,
  });
  const disposeRendererActionTraceIpcRef: { current: (() => void) | undefined } = {
    current: undefined,
  };
  const armsUserIdentitySync = createArmsUserIdentitySync({
    deviceMid,
    setUser: (user) => armsRum.setConfig("user", user),
  });

  const webRemoteControlAppVersion = ZCODE_VERSION || app.getVersion();
  const defaultZCodeEndpointUrls = buildZCodeEndpointUrls(DEFAULT_ZCODE_ENDPOINT_ORIGIN, {
    appVersion: webRemoteControlAppVersion,
  });
  const webRemoteControlRelayWsEnvOverride =
    process.env["ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL"]?.trim();
  const webRemoteControlUrlEnvOverride = process.env["ZCODE_WEB_REMOTE_CONTROL_URL"]?.trim();

  const webRemoteControlManager = createWebRemoteControlManager({
    getEndpointUrls: async () => {
      const derived = buildZCodeEndpointUrls(await resolveCurrentZCodeEndpointOrigin(), {
        appVersion: webRemoteControlAppVersion,
      });
      return {
        ...derived,
        relayWsUrl: resolveWebRemoteControlRelayWsUrl({
          endpointOrigin: derived.origin,
          overrideUrl: webRemoteControlRelayWsEnvOverride,
        }),
        remoteUrl: webRemoteControlUrlEnvOverride || derived.remoteUrl,
      };
    },
    relayWsUrl: resolveWebRemoteControlRelayWsUrl({
      endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
      overrideUrl: webRemoteControlRelayWsEnvOverride,
    }),
    mobileRemoteControlUrl: webRemoteControlUrlEnvOverride || defaultZCodeEndpointUrls.remoteUrl,
    deviceMid,
    deviceName: hostname(),
    appVersion: webRemoteControlAppVersion,
    getLogin: async () => {
      const userId = await loadRemoteControlUserId();
      const authorization = await loadRemoteControlAuthorization(userId);
      return authorization ? { userId, jwt: authorization.slice("Bearer ".length) } : undefined;
    },
    deviceStorage: createWebRemoteControlDeviceStorage({
      deleteLegacyCredential: () =>
        webRemoteControlCredentialService.delete("web-remote-control:external-relay:pass_hash"),
      loadSettings: () => mainSettingService.get(),
      patchSettings: async (patch) => {
        await mainSettingService.update(patch);
        // update() не возвращает снимок: значение для синхронного ARMS-гейта берём из патча.
        if (patch.telemetryEnabled !== undefined) {
          setDesktopTelemetryAllowed(patch.telemetryEnabled !== false);
        }
      },
    }),
    startupRestoreStorageProvider: {
      load: async () => (await mainSettingService.get()).webRemoteControlLastEnabledContext,
      save: async (context) => {
        await mainSettingService.update({
          webRemoteControlLastEnabledContext: {
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
            initialTaskId: context.initialTaskId,
          },
        });
      },
      clear: async () => {
        await mainSettingService.update({
          webRemoteControlLastEnabledContext: undefined,
        });
      },
    },
    featureGate: createWebRemoteControlFeatureGate(),
    logger,
    relayMessageLogger: webRemoteControlRelayLogger,
    platformHandlers: {
      isDockerAvailable: () => isDockerDaemonAvailable(),
      listWSLDistros: () => listAvailableWSLDistros(),
      listDockerContainers: () => listAvailableDockerContainers(),
      listSSHConfigAliases: () => listSSHConfigAliases(),
      createTempTextAttachment: (payload) => createTempTextAttachment(payload),
      loadMcpFromUserDirectory: (payload) => loadCliMcpFromUserDirectory(payload),
      saveMcpToUserDirectory: async (payload) => {
        try {
          await saveCliMcpToUserDirectory(payload);
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("[web-remote-control] MCP save failed", message);
          return { success: false, error: message };
        }
      },
      migrateLegacyCommonMcp: (payload) => migrateLegacyCommonMcp(payload),
    },
    reconnectWorkspace: reconnectWebRemoteControlWorkspaceInRenderer,
    prepareProjectWorkspace: async (windowId, project, requestId) => {
      const win = BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) throw new Error("项目导航窗口已关闭");
      return remoteSessionManager.prepareProjectWorkspace(win, project, requestId);
    },
    cancelProjectPreparation: (windowId, requestId) => {
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed())
        remoteSessionManager.cancelPendingRemoteWorkspaceSessionsForWindow(
          win.webContents.id,
          "mobile-navigation-superseded",
          requestId,
        );
    },
    reportRendererTelemetryEvent: (event) => {
      void appTelemetryCore.reportEvent(event).catch(() => {});
    },
    reportRemoteUsageEvent: (windowId, event) => {
      const win = BrowserWindow.fromId(windowId);
      if (!win || win.webContents.isDestroyed()) {
        return;
      }
      reportRemoteUsageEventForRenderer(win.webContents.id, event);
    },
    onStatusChanged: (windowId, status) => {
      sendWebRemoteControlStatusChangedToWindow(BrowserWindow.fromId(windowId), status);
    },
    attachWorkspaceHost: webRemoteControlSharedHostAttachments.attachWorkspaceHost,
    releaseWorkspaceHostAttachment: webRemoteControlSharedHostAttachments.releaseAttachment,
    disposeWorkspaceHostAttachmentsForWindow: (windowId) =>
      webRemoteControlSharedHostAttachments.disposeWindow(windowId),
    disposeWorkspaceHostAttachmentsForRemoteSession: (remoteSessionId) =>
      webRemoteControlSharedHostAttachments.disposeRemoteSession(remoteSessionId),
  });
  webRemoteControlManagerRef.current = webRemoteControlManager;

  function syncAppTelemetryInteractiveState(): void {
    appTelemetryRuntime.setInteractive(
      options
        .getApplicationWindows()
        .some((win) => !win.isDestroyed() && win.isVisible() && win.isFocused()),
    );
    // 登出/切号发生在 host 子进程，主进程无即时信号；窗口聚焦时兜底刷新 ARMS user.name
    void armsUserIdentitySync.refresh();
  }

  return {
    mainSettingService,
    webRemoteControlCredentialService,
    appTelemetryCore,
    appTelemetryRuntime,
    resolveCurrentZCodeEndpointOrigin,
    resolveDesktopContextPromptEnabledForHost,
    awaitFirstHostSpawnDecision,
    webRemoteControlManager,
    webRemoteControlSharedHostAttachments,
    deviceMid,
    readHelpConfig,
    desktopContextPromptRollout,
    rendererActionTraceRollout,
    rendererActionTraceBroker,
    localTtftExporter,
    armsUserIdentitySync,
    disposeRendererActionTraceIpcRef,
    reportRemoteUsageEventForRenderer,
    syncAppTelemetryInteractiveState,
  };
}
