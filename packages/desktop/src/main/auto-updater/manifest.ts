import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  resolveRuntimeZCodeEndpointOrigin,
  type ElectronReleaseChannel,
} from "@zcode/shared";
import pkg from "electron-updater";
import { logger } from "../logger.js";
import { ManifestUpdateProvider, getElectronReleasePlatform } from "../manifestUpdateProvider.js";
import { setAutoUpdaterMenuState } from "./channels.js";
import {
  UPDATE_FEED_URL_ENV,
  UPDATE_FEED_URL_SWITCH,
  buildUpdateDownloadedState,
  canUseAutoUpdaterInCurrentRuntime,
  clearAvailableUpdateState,
  getAutoUpdaterReleaseChannelForCurrentState,
  isUpdateTargetLocked,
  updaterState,
  type InitAutoUpdaterOptions,
  type RuntimeUpdateFeedSource,
  type SettingServiceLike,
} from "./state.js";

const { autoUpdater } = pkg;

function readSwitchValue(argv: readonly string[], switchName: string): string | undefined {
  const equalsPrefix = `${switchName}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length).trim() || undefined;
    }
    if (arg === switchName) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        return next.trim() || undefined;
      }
      return undefined;
    }
  }
  return undefined;
}

export function resolveUpdateFeedSourceFromStartupConfig(
  options: {
    argv?: readonly string[];
    env?: Record<string, string | undefined>;
  } = {},
): RuntimeUpdateFeedSource | undefined {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const feedUrl = readSwitchValue(argv, UPDATE_FEED_URL_SWITCH) ?? env[UPDATE_FEED_URL_ENV]?.trim();
  return feedUrl
    ? {
        url: feedUrl,
      }
    : undefined;
}

function redactUpdateFeedUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) {
      url.search = "?<redacted>";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

async function resolveUpdateReleaseChannel(
  settingService: SettingServiceLike | undefined,
): Promise<ElectronReleaseChannel> {
  if (!settingService) {
    return "stable";
  }

  try {
    const settings = await settingService.get();
    return settings.receivePreviewUpdates === true ? "preview" : "stable";
  } catch (error) {
    logger.warn("[auto-update] read preview update setting failed:", error);
    return "stable";
  }
}

export async function syncAutoUpdateCheckChannelFromSettings(
  checkId: number,
  settingService: SettingServiceLike | undefined,
  reason: string,
): Promise<void> {
  const { checks, available } = updaterState;
  const nextChannel = await resolveUpdateReleaseChannel(settingService);
  if (isUpdateTargetLocked() || checks.activeId !== checkId) {
    return;
  }

  if (available.channel !== nextChannel) {
    logger.info(`[auto-update] ${reason}: check channel ${available.channel} -> ${nextChannel}`);
  }
  // 服务端 manifest provider 会在 checkForUpdates 内部读取 preview 设置。
  // 如果 begin 阶段仍用默认 stable 作为 expected channel，冷启动 preview 结果会被误判为 stale。
  available.channel = nextChannel;
  checks.activeChannel = nextChannel;
}

export function applyManifestUpdateProvider(options: InitAutoUpdaterOptions): void {
  const { available } = updaterState;
  const manifestUrl = options.updateFeedSource?.url.trim();
  autoUpdater.setFeedURL({
    provider: "custom",
    updateProvider: ManifestUpdateProvider,
    endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    ...(manifestUrl ? { manifestUrl } : {}),
    releasePlatform: getElectronReleasePlatform(),
    deviceMid: options.deviceMid,
    resolveEndpointOrigin:
      options.resolveEndpointOrigin ?? (() => resolveRuntimeZCodeEndpointOrigin(process.env)),
    resolveReleaseChannel: async () => {
      const channel = await resolveUpdateReleaseChannel(options.settingService);
      if (!isUpdateTargetLocked()) available.channel = channel;
      return channel;
    },
  });
  logger.info(
    manifestUrl
      ? `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()} manifestUrl=${redactUpdateFeedUrlForLog(manifestUrl)}`
      : `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()}`,
  );
}

export function beginAutoUpdateCheck(): number {
  const { checks, available } = updaterState;
  const checkId = checks.generation + 1;
  checks.inFlight = true;
  checks.generation = checkId;
  checks.activeId = checkId;
  checks.activeChannel = available.channel;
  checks.settlingId = null;
  return checkId;
}

function completeAutoUpdateCheck(reason: string, checkId: number | null): void {
  const { checks, listeners, runtime } = updaterState;
  if (checkId !== null && checks.activeId !== checkId) {
    return;
  }

  checks.inFlight = false;
  checks.activeId = null;
  checks.activeChannel = null;
  checks.settlingId = null;

  const pendingChannel = checks.pendingManifestChannelRefresh;
  const shouldRecheckFailedDownload = checks.pendingFailedDownloadRecheck;
  checks.pendingFailedDownloadRecheck = false;
  if (shouldRecheckFailedDownload && !pendingChannel && !listeners.force) {
    // 下载失败发生在本次检查收口前。等标记清掉后再查一次，避免复查被进行中的检查直接丢掉。
    queueMicrotask(() => runtime.recheckAfterDownload?.("download-failed"));
  }
  if (!pendingChannel) {
    return;
  }

  checks.pendingManifestChannelRefresh = null;
  refreshAutoUpdaterReleaseChannel(
    pendingChannel === "preview",
    `${reason} pending release channel refresh`,
  );
}

export function finishAutoUpdateCheck(reason: string, checkId: number | null): void {
  const { checks } = updaterState;
  if (checkId !== null && checks.activeId === checkId && checks.settlingId === checkId) {
    return;
  }

  completeAutoUpdateCheck(reason, checkId);
}

export function settleAutoUpdateCheckResult(
  reason: string,
  work: () => Promise<void> | void,
): Promise<void> {
  const { checks } = updaterState;
  const checkId = checks.activeId;
  if (!checks.inFlight || checkId === null) {
    return Promise.resolve(work());
  }

  checks.settlingId = checkId;
  try {
    return Promise.resolve(work()).finally(() => {
      // electron-updater 的 checkForUpdates() Promise 只代表请求返回，
      // 不会等待 update-available 里读取设置、跳过版本、自动下载等异步状态处理。
      // 这里让一次 check 的互斥范围覆盖“请求 + 结果处理”，避免通道刷新或手动检查抢在旧结果写状态前启动。
      completeAutoUpdateCheck(reason, checkId);
    });
  } catch (error) {
    completeAutoUpdateCheck(reason, checkId);
    return Promise.reject(error);
  }
}

export function shouldIgnoreStaleAvailableUpdate(
  infoChannel: ElectronReleaseChannel | null,
): boolean {
  const { checks, available } = updaterState;
  const expectedChannel = checks.activeChannel ?? available.channel;
  return Boolean(infoChannel && infoChannel !== expectedChannel);
}

export function refreshAutoUpdaterReleaseChannel(
  receivePreviewUpdates: boolean,
  reason = "settings receivePreviewUpdates changed",
) {
  const { runtime, available, menu, checks, ready } = updaterState;
  if (runtime.quitAndInstallState !== "idle") return;
  const nextChannel: ElectronReleaseChannel = receivePreviewUpdates ? "preview" : "stable";

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    return;
  }

  if (menu.state.kind === "download-progress" || menu.state.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason}: state=${menu.state.kind} channel=${nextChannel}`);
    return;
  }

  if (checks.inFlight) {
    // 用户可能在启动检查尚未完成时切换 preview 开关。
    // 不能立刻改 availableUpdateChannel，否则旧请求返回时会把旧通道的版本标成新通道；
    // 这里只记录待刷新通道，等当前 check 收口后再重新请求 manifest。
    checks.pendingManifestChannelRefresh = nextChannel;
    logger.info(
      `[auto-update] defer ${reason}: check already in flight, next channel=${nextChannel}`,
    );
    return;
  }

  const currentChannel = getAutoUpdaterReleaseChannelForCurrentState();
  if (currentChannel === nextChannel) {
    logger.info(`[auto-update] skip ${reason}: channel unchanged (${nextChannel})`);
    return;
  }

  logger.info(
    `[auto-update] ${reason}: refresh manifest channel ${currentChannel} -> ${nextChannel}`,
  );
  available.channel = nextChannel;
  clearAvailableUpdateState();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  const checkId = beginAutoUpdateCheck();
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
