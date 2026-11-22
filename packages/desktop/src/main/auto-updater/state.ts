import type { ISettingService } from "@zcode/services";
import { app } from "electron";
import pkg, { type CancellationToken } from "electron-updater";
import semver from "semver";
import {
  DEFAULT_LOCALE,
  ZCODE_VERSION,
  type ElectronReleaseChannel,
  type Locale,
  type PostUpdateReleaseNotesPayload,
  type UpdateStatePayload,
} from "@zcode/shared";
import { logger } from "../logger.js";

const { autoUpdater } = pkg;

export const CHECK_FOR_UPDATE_MENU_ID = "check-for-update";
export const UPDATE_FEED_URL_ENV = "ZCODE_UPDATE_FEED_URL";
export const UPDATE_FEED_URL_SWITCH = "--zcode-update-feed-url";
const AUTO_UPDATE_POLL_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS = 2 * 60 * 1000;
const DEV_AUTO_UPDATE_ENV = "ZCODE_AUTO_UPDATE_DEV";
const DEV_AUTO_UPDATE_SWITCH = "--zcode-auto-update-dev";
const DEV_AUTO_UPDATE_VERSION_ENV = "ZCODE_AUTO_UPDATE_DEV_VERSION";
const DEV_AUTO_UPDATE_VERSION_SWITCH = "--zcode-auto-update-dev-version";

export type SettingServiceLike = Pick<ISettingService, "get" | "update">;

type ReleaseNoteInfoLike = {
  note?: string | null;
  version?: string | null;
};

export type UpdateDownloadedInfoLike = {
  version: string;
  path?: string | null;
  files?: Array<{ url?: string | null } | null> | null;
  packages?: Record<string, { path?: string | null } | null> | null;
  zcodeReleaseChannel?: ElectronReleaseChannel | null;
  releaseName?: string | null;
  releaseNotes?: string | ReleaseNoteInfoLike[] | null;
  releaseDate?: string | Date | null;
  releaseNotesByLocale?: Partial<
    Record<
      Locale,
      | string
      | {
          title?: string | null;
          markdown?: string | null;
          releaseNotes?: string | ReleaseNoteInfoLike[] | null;
        }
      | null
    >
  > | null;
};

export type RuntimeUpdateFeedSource = { url: string };

export type AutoUpdaterMenuState = UpdateStatePayload;

export type ForceAutoUpdateState =
  | { kind: "checking" }
  | { kind: "downloading"; version?: string; progress?: string }
  | { kind: "ready"; version?: string }
  | { kind: "installing" }
  | { kind: "error"; message: string }
  | { kind: "dev-skipped"; message?: string };

export interface InitAutoUpdaterOptions {
  enabled?: boolean;
  onBeforeQuitAndInstall?: () => void | Promise<void>;
  settingService?: SettingServiceLike;
  locale?: Locale;
  updateFeedSource?: RuntimeUpdateFeedSource;
  deviceMid?: string;
  resolveEndpointOrigin?: () => string | Promise<string>;
}

type QuitAndInstallState = "idle" | "preparing" | "installing" | "recovering";

/**
 * 模块级可变状态集中在这里，子模块只就地修改字段，不重新绑定引用。
 * 拆分成 auto-updater/* 后仍必须共享同一份状态：菜单、检查、下载、安装、
 * 待展示说明和轮询由不同文件写入，任何一处复制状态都会让更新链路分叉。
 */
export const updaterState = {
  menu: {
    state: { kind: "idle", enabled: true } as AutoUpdaterMenuState,
    locale: DEFAULT_LOCALE as Locale,
  },
  listeners: {
    stateListeners: new Set<(state: UpdateStatePayload) => void>(),
    force: null as ((state: ForceAutoUpdateState) => void) | null,
    forceProgressBucket: null as number | null,
  },
  checks: {
    inFlight: false,
    generation: 0,
    activeId: null as number | null,
    activeChannel: null as ElectronReleaseChannel | null,
    settlingId: null as number | null,
    pendingManifestChannelRefresh: null as ElectronReleaseChannel | null,
    pendingFailedDownloadRecheck: false,
  },
  available: {
    releaseNotes: null as PostUpdateReleaseNotesPayload | null,
    channel: "stable" as ElectronReleaseChannel,
  },
  downloading: {
    version: null as string | null,
    releaseNotes: null as PostUpdateReleaseNotesPayload | null,
    channel: null as ElectronReleaseChannel | null,
    cancellationToken: null as CancellationToken | null,
    pendingDownloaded: null as {
      token: CancellationToken;
      info: UpdateDownloadedInfoLike;
    } | null,
  },
  ready: {
    version: null as string | null,
    releaseNotes: null as PostUpdateReleaseNotesPayload | null,
    restoredFromPendingReleaseNotes: false,
    channel: null as ElectronReleaseChannel | null,
  },
  notes: {
    pending: null as PostUpdateReleaseNotesPayload | null,
    deliveredWebContentsId: null as number | null,
    acknowledgedVersions: new Set<string>(),
  },
  poll: {
    timer: null as NodeJS.Timeout | null,
    intervalMs: null as number | null,
  },
  runtime: {
    manualCheckWebContentsId: null as number | null,
    onBeforeQuitAndInstall: undefined as (() => void | Promise<void>) | undefined,
    settingService: undefined as SettingServiceLike | undefined,
    // initAutoUpdater({ enabled: false }) 只清轮询并 return，electron-updater 实例保持未配置
    // （占位 feed、autoDownload 默认值）。任何漏改成按身份判断的入口若仍调用手动检查，
    // 都会对占位 feed 发真实请求。这里记住“本 flavor 已禁用”，让手动检查在模块内部 fail-closed。
    disabledForProductFlavor: false,
    devVersionOverride: null as string | null,
    recheckAfterDownload: null as ((reason: string) => void) | null,
    quitAndInstallState: "idle" as QuitAndInstallState,
    cancelledDownloadTokens: new WeakSet<CancellationToken>(),
    pendingCancelledDownloadErrorCount: 0,
  },
};

/**
 * download / install 互相需要对方入口；用注册表打断 import 环。
 * 各模块在求值时就地注册自己的实现，函数声明已提升，注册早于任何调用。
 */
export const crossModuleActions = {
  downloadAvailableUpdate: (_reason?: string): void => {},
};

export function isUpdateTargetLocked(): boolean {
  return updaterState.runtime.quitAndInstallState !== "idle";
}

function isTruthyRuntimeFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readCommandLineSwitchValue(name: string): string | null {
  const prefix = `${name}=`;
  for (const arg of process.argv) {
    if (arg === name) {
      return "";
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

export function isDevAutoUpdateEnabled(): boolean {
  return (
    isTruthyRuntimeFlag(process.env[DEV_AUTO_UPDATE_ENV]) ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_SWITCH) !== null
  );
}

export function canUseAutoUpdaterInCurrentRuntime(): boolean {
  return app.isPackaged || isDevAutoUpdateEnabled();
}

export function shouldRelaunchForDevAutoUpdateInstall(): boolean {
  return !app.isPackaged && isDevAutoUpdateEnabled();
}

export function getCurrentAppVersionForUpdate(): string {
  return updaterState.runtime.devVersionOverride ?? app.getVersion();
}

function resolveDevAutoUpdateVersion(): string | null {
  const configuredVersion =
    process.env[DEV_AUTO_UPDATE_VERSION_ENV]?.trim() ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_VERSION_SWITCH)?.trim() ||
    ZCODE_VERSION;
  const parsed = semver.parse(configuredVersion);
  if (!parsed) {
    logger.warn(`[auto-update] ignore invalid dev update version=${configuredVersion}`);
    return null;
  }
  return parsed.format();
}

type MutableAutoUpdaterForDev = typeof autoUpdater & {
  currentVersion?: semver.SemVer;
  forceDevUpdateConfig?: boolean;
};

export function applyDevAutoUpdateRuntimeOverrides(): void {
  updaterState.runtime.devVersionOverride = null;
  if (app.isPackaged || !isDevAutoUpdateEnabled()) {
    return;
  }

  const devVersion = resolveDevAutoUpdateVersion();
  const parsedVersion = devVersion ? semver.parse(devVersion) : null;
  const mutableAutoUpdater = autoUpdater as MutableAutoUpdaterForDev;
  mutableAutoUpdater.forceDevUpdateConfig = true;
  if (parsedVersion) {
    updaterState.runtime.devVersionOverride = parsedVersion.format();
    // Electron 开发态 app.getVersion() 读取的是 desktop 运行壳版本，
    // 不一定跟产品版本一致。验证自动更新时需要显式把 electron-updater 的
    // currentVersion 改成产品版本，否则 3.3.1 -> 3.3.2 这类流程无法复现。
    mutableAutoUpdater.currentVersion = parsedVersion;
  }

  logger.info(
    `[auto-update] dev update enabled version=${updaterState.runtime.devVersionOverride ?? app.getVersion()}`,
  );
}

function normalizeVersionForCompare(version: string): string | null {
  return semver.valid(semver.coerce(version.trim()));
}

export function isVersionGreaterThan(candidateVersion: string, baselineVersion: string): boolean {
  const candidate = normalizeVersionForCompare(candidateVersion);
  const baseline = normalizeVersionForCompare(baselineVersion);
  if (candidate && baseline) {
    return semver.gt(candidate, baseline);
  }

  return candidateVersion.trim() !== baselineVersion.trim();
}

export function shouldDownloadAvailableUpdate(version: string): boolean {
  const { ready } = updaterState;
  if (ready.restoredFromPendingReleaseNotes) {
    return true;
  }

  return !ready.version || isVersionGreaterThan(version, ready.version);
}

export function canPollForUpdatesFromState(state: AutoUpdaterMenuState): boolean {
  return (
    state.kind === "idle" || state.kind === "update-available" || state.kind === "update-downloaded"
  );
}

export function hasVisibleUpdateTarget(state: AutoUpdaterMenuState): boolean {
  return state.kind === "update-available" || state.kind === "update-downloaded";
}

export function resolveAutoUpdatePollInterval(state: AutoUpdaterMenuState): number {
  return hasVisibleUpdateTarget(state)
    ? AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS
    : AUTO_UPDATE_POLL_INTERVAL_MS;
}

export function getAutoUpdaterReleaseChannelForCurrentState(): ElectronReleaseChannel {
  const { menu, available, downloading, ready } = updaterState;
  switch (menu.state.kind) {
    case "update-available":
      return menu.state.channel ?? available.channel;
    case "download-progress":
      return menu.state.channel ?? downloading.channel ?? available.channel;
    case "update-downloaded":
      return menu.state.channel ?? ready.channel ?? available.channel;
    default:
      return available.channel;
  }
}

export function readUpdateInfoReleaseChannel(
  info: UpdateDownloadedInfoLike,
): ElectronReleaseChannel | null {
  return info.zcodeReleaseChannel === "preview" || info.zcodeReleaseChannel === "stable"
    ? info.zcodeReleaseChannel
    : null;
}

export function isReadyUpdateCurrentTarget(): boolean {
  const { ready, menu } = updaterState;
  return Boolean(
    ready.version &&
    menu.state.kind === "update-downloaded" &&
    menu.state.version === ready.version,
  );
}

export function buildUpdateDownloadedState(version: string): AutoUpdaterMenuState {
  const { ready } = updaterState;
  return {
    kind: "update-downloaded",
    enabled: true,
    version,
    ...(ready.channel ? { channel: ready.channel } : {}),
    ...(ready.releaseNotes ? { releaseNotes: ready.releaseNotes } : {}),
  };
}

export function buildUpdateAvailableState(
  version: string,
  releaseNotes: PostUpdateReleaseNotesPayload | null,
  channel: ElectronReleaseChannel,
): AutoUpdaterMenuState {
  return {
    kind: "update-available",
    enabled: true,
    version,
    channel,
    ...(releaseNotes ? { releaseNotes } : {}),
  };
}

export function notifyForceAutoUpdate(state: ForceAutoUpdateState) {
  updaterState.listeners.force?.(state);
}

export function getForceAutoUpdateNoUpdateMessage(): string {
  return updaterState.menu.locale === "zh-CN"
    ? "未找到可安装更新，请使用手动升级。"
    : "No installable update was found. Use manual update instead.";
}

export function normalizeProgressPercent(progress: unknown): string | undefined {
  if (typeof progress !== "object" || progress === null || !("percent" in progress)) {
    return undefined;
  }

  const percent = Number((progress as { percent?: unknown }).percent);
  if (!Number.isFinite(percent)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, percent)).toFixed(0);
}

export function logForceAutoUpdateProgress(progress: string | undefined) {
  if (!progress) {
    return;
  }

  const bucket = Math.floor(Number(progress) / 10) * 10;
  const { listeners } = updaterState;
  if (bucket === listeners.forceProgressBucket) {
    return;
  }
  listeners.forceProgressBucket = bucket;
  logger.info(`[force-update] 自动升级下载进度 ${progress}%`);
}

export function buildDownloadProgressState(
  progress: string,
  byteProgress?: { transferredBytes: number; totalBytes: number },
): AutoUpdaterMenuState {
  const { downloading } = updaterState;
  return {
    kind: "download-progress",
    enabled: false,
    progress,
    ...(byteProgress ? byteProgress : {}),
    ...(downloading.version ? { version: downloading.version } : {}),
    ...(downloading.channel ? { channel: downloading.channel } : {}),
    ...(downloading.releaseNotes ? { releaseNotes: downloading.releaseNotes } : {}),
  };
}

export function clearAvailableUpdateState() {
  updaterState.available.releaseNotes = null;
}

export function clearDownloadingUpdateState() {
  const { downloading } = updaterState;
  downloading.version = null;
  downloading.releaseNotes = null;
  downloading.channel = null;
}

export function clearReadyUpdateState() {
  const { ready } = updaterState;
  ready.version = null;
  ready.releaseNotes = null;
  ready.channel = null;
  ready.restoredFromPendingReleaseNotes = false;
}
