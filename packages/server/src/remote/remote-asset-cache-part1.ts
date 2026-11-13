import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  type Dirent,
} from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileExists } from "@zcode/server/remote/deployShared.js";
import { extractTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import {
  assertRemoteCdnBaseVersionMatches,
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  normalizeRemoteAssetRelativePath,
  resolveRemoteCdnBaseUrls,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";

// Часть 1/3 модуля remote-asset-cache: вынесено по лимиту строк.

export const MANIFEST_FILE_NAME_PREFIX = "manifest-";

export const REMOTE_ASSET_READY_MARKER = ".ready";

export const LEGACY_REMOTE_ASSET_READY_MARKER = ".remote-assets-ready";

export const remoteAssetReleaseLocks = new Map<string, Promise<string>>();

export const remoteAssetComponentLocks = new Map<string, Promise<string>>();

export const remoteAssetReleaseMaterializeLocks = new Map<string, Promise<void>>();

export const DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS = 10_000;

export const REMOTE_ASSET_PROGRESS_INTERVAL_MS = 1_000;

export const REMOTE_ASSET_PROGRESS_PERCENT_STEP = 5;

export const CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS: Record<string, string> = {
  "server-bundle": "server-content",
  glm: "glm-content",
};

export const REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS = [
  50, 100, 200, 400, 800, 1_600, 3_200,
] as const;

export interface RemoteAssetManifestComponent {
  id: string;
  version: string;
  sha256: string;
  artifactPath: string;
  mount: string;
}

export interface ComponentMountRule {
  platformScoped: boolean;
  resolveExpectedMount: (platformArch: string) => string;
}

export interface RemoteAssetCacheLoggers {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
}

export function normalizeRequestedComponentIds(componentIds: string[] | undefined): Set<string> | null {
  if (!componentIds) {
    return null;
  }

  const normalizedIds = componentIds.map((componentId) => componentId.trim()).filter(Boolean);
  if (normalizedIds.length === 0) {
    return null;
  }

  for (const componentId of normalizedIds) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(componentId)) {
      throw new Error(`[remote-assets] component id is invalid: ${componentId}`);
    }
  }

  return new Set(normalizedIds);
}

export function normalizeRequiredReleasePaths(requiredReleasePaths: string[] | undefined): string[] {
  if (!requiredReleasePaths) {
    return [];
  }

  return Array.from(
    new Set(
      requiredReleasePaths
        .map((relativePath) =>
          normalizeRemoteAssetRelativePath(relativePath, "requiredReleasePath"),
        )
        .filter(Boolean),
    ),
  );
}

export function resolveReleaseBaseByAssetUrl(
  assetUrl: string,
  releaseBaseCandidates: string[],
): string | null {
  const matchedReleaseBases = releaseBaseCandidates
    .map((releaseBase) => releaseBase.replace(/\/+$/, ""))
    .filter((releaseBase) => releaseBase.length > 0 && assetUrl.startsWith(`${releaseBase}/`))
    .sort((left, right) => right.length - left.length);
  return matchedReleaseBases[0] ?? null;
}

export async function fetchFirstAvailableUrl(
  candidates: string[],
  fileLabel: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ response: Response; url: string }> {
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate);
      if (response.ok) {
        return { response, url: candidate };
      }
      errors.push(`${candidate} -> HTTP ${response.status}`);
    } catch (error) {
      errors.push(`${candidate} -> ${String(error)}`);
    }
  }

  throw new Error(`[remote-assets] failed to fetch ${fileLabel}: ${errors.join("; ")}`);
}

export function shouldFallbackToCopy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "EMLINK";
}

export function resolvePathWithinBase(baseDir: string, relativePath: string, label: string): string {
  const normalizedRelativePath = normalizeRemoteAssetRelativePath(relativePath, label);
  const targetPath = resolve(baseDir, ...normalizedRelativePath.split("/"));
  const normalizedBaseDir = resolve(baseDir);
  if (targetPath !== normalizedBaseDir && !targetPath.startsWith(`${normalizedBaseDir}${sep}`)) {
    throw new Error(`[remote-assets] ${label} escapes base dir: ${relativePath}`);
  }
  return targetPath;
}

export function isRetryableRemoteAssetDirectoryCommitError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function parseContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) {
    return null;
  }

  const parsed = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

export function extractContentHashPrefixFromComponentVersion(version: string): string | null {
  const plusIndex = version.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === version.length - 1) {
    return null;
  }

  const suffix = version.slice(plusIndex + 1).toLowerCase();
  return /^[a-f0-9]{12,64}$/u.test(suffix) ? suffix : null;
}

export async function isDirectoryPath(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return pathStat.isDirectory();
  } catch {
    return false;
  }
}

export async function hashFileContent(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  hash.update(`file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`);
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function assertExtractedArchiveNotEmpty(
  extractRoot: string,
  errorMessage: string,
): Promise<void> {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error(errorMessage);
  }
}

export async function isValidReleaseDir(releaseDir: string, platformArch: string): Promise<boolean> {
  try {
    const dirStat = await stat(releaseDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  if (!(await fileExists(releaseDir, "server", "zcode-server.cjs"))) {
    return false;
  }

  // 分平台归档落地后，继续硬编码校验 linux 目录会把 darwin 包误判为无效。
  // 这里改成按目标 platformArch 校验 node runtime，确保 cache 判断与下载策略一致。
  if (!(await fileExists(releaseDir, "node", platformArch, "node"))) {
    return false;
  }

  return true;
}

export async function writeReadyMarker(baseDir: string, markerFileName: string): Promise<void> {
  await writeFile(join(baseDir, markerFileName), `${Date.now()}\n`, "utf8");
}

export function resolveFallbackRemoteAssetCacheDir(): string {
  return join(tmpdir(), "zcode-remote-assets-cache");
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRequiredString(value: Record<string, unknown>, key: string, context: string): string {
  const fieldValue = value[key];
  if (typeof fieldValue !== "string") {
    throw new Error(`[remote-assets] ${context}.${key} must be string`);
  }
  const trimmed = fieldValue.trim();
  if (!trimmed) {
    throw new Error(`[remote-assets] ${context}.${key} is empty`);
  }
  return trimmed;
}

export function readRequiredNumber(value: Record<string, unknown>, key: string, context: string): number {
  const fieldValue = value[key];
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`[remote-assets] ${context}.${key} must be finite number`);
  }
  return fieldValue;
}

export function assertSafePathSegment(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`[remote-assets] ${label} is empty`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`[remote-assets] ${label} must be a single path segment: ${value}`);
  }
  if (value === "." || value === "..") {
    throw new Error(`[remote-assets] ${label} is invalid: ${value}`);
  }
}

export const READY_MARKER_CANDIDATES = [REMOTE_ASSET_READY_MARKER, LEGACY_REMOTE_ASSET_READY_MARKER];

export interface RemoteAssetManifest {
  schemaVersion: number;
  appVersion: string;
  platformArch: string;
  components: RemoteAssetManifestComponent[];
}

export const REMOTE_COMPONENT_MOUNT_RULES: Record<string, ComponentMountRule> = {
  "server-bundle": {
    platformScoped: false,
    resolveExpectedMount: () => "server",
  },
  "node-runtime": {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `node/${platformArch}`,
  },
  "node-pty": {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `node-pty/${platformArch}`,
  },
  glm: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `glm/${platformArch}`,
  },
  bfs: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/bfs`,
  },
  ripgrep: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/ripgrep`,
  },
  ugrep: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/ugrep`,
  },
};

export function createRemoteAssetManifestRequestSignal(
  timeoutMs = DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS,
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `[remote-assets] manifest request timeout must be a positive safe integer: ${String(timeoutMs)}`,
    );
  }
  // manifest 是 server-bundle/GLM SHA 跳过判断的前置输入；网络半开时若不主动取消，
  // 已完整部署的远端也会永久卡在初始化，且 single-flight 会把后续连接绑到同一 pending 请求。
  return AbortSignal.timeout(timeoutMs);
}

export async function runWithReleaseMaterializeLock(
  releaseDir: string,
  task: () => Promise<void>,
): Promise<void> {
  const lockKey = resolve(releaseDir);
  const previousTask = remoteAssetReleaseMaterializeLocks.get(lockKey);

  const currentTask = (async () => {
    if (previousTask) {
      await previousTask.catch(() => {
        // 前一个写入失败不能阻塞后续重试；当前任务会重新物化自己的组件。
      });
    }
    await task();
  })();

  remoteAssetReleaseMaterializeLocks.set(lockKey, currentTask);
  try {
    await currentTask;
  } finally {
    if (remoteAssetReleaseMaterializeLocks.get(lockKey) === currentTask) {
      remoteAssetReleaseMaterializeLocks.delete(lockKey);
    }
  }
}

export function buildRemoteManifestFileCandidates(platformArch: string): string[] {
  return [`${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`];
}

export function usesRemoteAssetContentAddressedCacheIdentity(componentId: string): boolean {
  return componentId in CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS;
}

export function resolveContentAddressedReleaseSegments(
  components: readonly RemoteAssetManifestComponent[],
  requestedComponentIds: ReadonlySet<string> | null,
): string[] {
  const segments: string[] = [];
  for (const componentId of Object.keys(CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS)) {
    // 兼容历史全量 release：未指定组件时只沿用原有 GLM 内容目录；server
    // 安装始终显式请求 server-bundle，因此仍会进入独立 SHA release。
    if (
      requestedComponentIds === null
        ? componentId !== "glm"
        : !requestedComponentIds.has(componentId)
    ) {
      continue;
    }
    const component = components.find((item) => item.id === componentId);
    const releaseDirName = CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS[componentId];
    if (component && releaseDirName) {
      segments.push(releaseDirName, component.sha256);
    }
  }
  return segments;
}

export function resolveRemoteAssetComponentCacheVersion(version: string): string {
  const contentHashPrefix = extractContentHashPrefixFromComponentVersion(version);
  if (!contentHashPrefix) {
    return version;
  }

  // 已发布 manifest 里的 component.version 仍是 vX+hash。
  // cache key 只看语义版本，因此在落盘目录层剥掉 hash；artifactPath/sha256 仍按 manifest 校验下载内容。
  return version.slice(0, -contentHashPrefix.length - 1);
}

export function resolveRequiredComponentPaths(
  component: RemoteAssetManifestComponent,
  requiredReleasePaths: readonly string[],
): string[] {
  if (requiredReleasePaths.length === 0) {
    return [];
  }

  const mount = component.mount.replace(/\/+$/u, "");
  const requiredComponentPaths: string[] = [];
  for (const requiredReleasePath of requiredReleasePaths) {
    if (requiredReleasePath === mount) {
      continue;
    }
    if (requiredReleasePath.startsWith(`${mount}/`)) {
      requiredComponentPaths.push(requiredReleasePath.slice(mount.length + 1));
    }
  }
  return requiredComponentPaths;
}

export async function linkOrCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await link(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!shouldFallbackToCopy(error)) {
      throw error;
    }
  }
  await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
}

export async function removeRemoteAssetDirectoryBestEffort(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryDelayMs = REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableRemoteAssetDirectoryCommitError(error)) {
        return;
      }
      await sleep(retryDelayMs);
    }
  }
}

export async function renameRemoteAssetDirectoryWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryDelayMs = REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableRemoteAssetDirectoryCommitError(error)) {
        throw error;
      }

      // Windows 上 AppData remote-assets-cache 目录 rename 可能被 Defender、索引器
      // 或另一个刚退出的 host 进程短暂占用，表现为 EPERM/EBUSY/EACCES/ENOTEMPTY。
      // 提权不能释放这些文件句柄，因此这里对目录提交做有限退避重试，避免缓存已下载完成却连接 WSL 失败。
      await sleep(retryDelayMs);
    }
  }
}

export async function findMissingLocalRelativePaths(
  baseDir: string,
  requiredRelativePaths: readonly string[],
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const requiredRelativePath of requiredRelativePaths) {
    const absolutePath = resolvePathWithinBase(
      baseDir,
      requiredRelativePath,
      "required cache path",
    );
    if (!(await pathExists(absolutePath))) {
      missingPaths.push(absolutePath);
    }
  }
  return missingPaths;
}

export function createRemoteAssetProgressReporter(
  totalBytes: number | null,
  loggers: RemoteAssetCacheLoggers | undefined,
): (transferredBytes: number, force: boolean) => void {
  const startedAt = Date.now();
  let lastLoggedAt = 0;
  let lastLoggedPercent = 0;
  let lastLoggedTransferredBytes = -1;

  return (transferredBytes: number, force: boolean) => {
    if (!loggers) {
      return;
    }

    const now = Date.now();
    const elapsedSeconds = Math.max((now - startedAt) / 1_000, 0.001);
    const speedMBPerSecond = bytesToMB(transferredBytes) / elapsedSeconds;
    const transferredMB = bytesToMB(transferredBytes);
    const totalMB = totalBytes ? bytesToMB(totalBytes) : null;
    const percent = totalBytes ? Math.min((transferredBytes / totalBytes) * 100, 100) : null;

    const byInterval = now - lastLoggedAt >= REMOTE_ASSET_PROGRESS_INTERVAL_MS;
    const byPercent =
      percent != null && percent - lastLoggedPercent >= REMOTE_ASSET_PROGRESS_PERCENT_STEP;
    const reachedEnd = percent != null && percent >= 100;

    if (!force && !byInterval && !byPercent && !reachedEnd) {
      return;
    }
    if (
      force &&
      transferredBytes === lastLoggedTransferredBytes &&
      (percent == null || percent <= lastLoggedPercent)
    ) {
      return;
    }

    // 之前生产态下载阶段只打印 "downloading URL"，慢网用户无法判断是否卡死。
    // 这里改成输出节流后的进度快照（百分比/MB/速度），让 SSH 连接日志可观测下载进展。
    if (totalMB != null && percent != null) {
      loggers.log(
        `[remote-assets] download progress: ${percent.toFixed(1)}% (${transferredMB.toFixed(1)}/${totalMB.toFixed(1)} MB, ${speedMBPerSecond.toFixed(2)} MB/s)`,
      );
    } else {
      loggers.log(
        `[remote-assets] download progress: ${transferredMB.toFixed(1)} MB (total unknown, ${speedMBPerSecond.toFixed(2)} MB/s)`,
      );
    }

    lastLoggedAt = now;
    lastLoggedTransferredBytes = transferredBytes;
    if (percent != null) {
      lastLoggedPercent = percent;
    }
  };
}

export async function hashDirectoryContent(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativeDir = "",
): Promise<void> {
  const entries = (await readdir(rootDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    const entryRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const dirStat = await stat(entryPath);
      hash.update(`dir:${entryRelativePath}:${dirStat.mode & 0o777}\n`);
      await hashDirectoryContent(hash, entryPath, entryRelativePath);
      continue;
    }
    if (entry.isFile()) {
      await hashFileContent(hash, entryPath, entryRelativePath);
      continue;
    }

    throw new Error(`unsupported entry type: ${entryPath}`);
  }
}

export interface RemoteAssetManifestRef {
  manifest: RemoteAssetManifest;
  releaseBaseCandidatesForComponents: string[];
}

export function selectManifestComponents(
  manifest: RemoteAssetManifest,
  requestedComponentIds: Set<string> | null,
): RemoteAssetManifestComponent[] {
  if (!requestedComponentIds) {
    return manifest.components;
  }

  const selectedComponents = manifest.components.filter((component) =>
    requestedComponentIds.has(component.id),
  );
  const foundIds = new Set(selectedComponents.map((component) => component.id));
  const missingIds = Array.from(requestedComponentIds).filter(
    (componentId) => !foundIds.has(componentId),
  );
  if (missingIds.length > 0) {
    throw new Error(
      `[remote-assets] manifest is missing requested components: ${missingIds.join(", ")}`,
    );
  }

  return selectedComponents;
}

export function buildRemoteAssetManifestFileCandidates(platformArch: string): string[] {
  return buildRemoteManifestFileCandidates(platformArch);
}
