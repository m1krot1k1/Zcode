import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  type Dirent,
} from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileExists } from "@zcode/server/remote/deployShared.js";
import {
  normalizeRemoteAssetRelativePath,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";
import { READY_MARKER_CANDIDATES, REMOTE_ASSET_READY_MARKER, REMOTE_COMPONENT_MOUNT_RULES, assertExtractedArchiveNotEmpty, assertSafePathSegment, createRemoteAssetManifestRequestSignal, createRemoteAssetProgressReporter, extractContentHashPrefixFromComponentVersion, findMissingLocalRelativePaths, hashDirectoryContent, hashFileContent, isDirectoryPath, isObjectRecord, isValidReleaseDir, linkOrCopyFile, normalizeRequestedComponentIds, parseContentLength, pathExists, readRequiredNumber, readRequiredString, removeRemoteAssetDirectoryBestEffort, renameRemoteAssetDirectoryWithRetry, resolvePathWithinBase, resolveReleaseBaseByAssetUrl, resolveRemoteAssetComponentCacheVersion, selectManifestComponents, usesRemoteAssetContentAddressedCacheIdentity, writeReadyMarker } from "./remote-asset-cache-part1.js";
import type { RemoteAssetCacheLoggers, RemoteAssetManifest, RemoteAssetManifestComponent, RemoteAssetManifestRef } from "./remote-asset-cache-part1.js";

// Часть 2/3 модуля remote-asset-cache: вынесено по лимиту строк.

export async function parseRemoteAssetManifestFromResponse(
  response: Response,
  sourceUrl: string,
  expectedAppVersion: string,
  expectedPlatformArch: string,
): Promise<RemoteAssetManifest> {
  const content = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`[remote-assets] invalid manifest json from ${sourceUrl}: ${String(error)}`);
  }
  if (!isObjectRecord(parsed)) {
    throw new Error(`[remote-assets] invalid manifest payload from ${sourceUrl}: expect object`);
  }

  const schemaVersion = readRequiredNumber(parsed, "schemaVersion", "manifest");
  if (!Number.isInteger(schemaVersion) || schemaVersion !== 1) {
    throw new Error(
      `[remote-assets] unsupported manifest schemaVersion=${schemaVersion} from ${sourceUrl}`,
    );
  }

  const appVersion = readRequiredString(parsed, "appVersion", "manifest");
  if (appVersion !== expectedAppVersion) {
    throw new Error(
      `[remote-assets] manifest appVersion mismatch from ${sourceUrl}: expected=${expectedAppVersion}, actual=${appVersion}`,
    );
  }

  const platformArch = readRequiredString(parsed, "platformArch", "manifest");
  if (platformArch !== expectedPlatformArch) {
    throw new Error(
      `[remote-assets] manifest platformArch mismatch from ${sourceUrl}: expected=${expectedPlatformArch}, actual=${platformArch}`,
    );
  }

  const rawComponents = parsed.components;
  if (!Array.isArray(rawComponents)) {
    throw new Error(`[remote-assets] manifest.components must be array from ${sourceUrl}`);
  }
  if (rawComponents.length === 0) {
    throw new Error(`[remote-assets] manifest.components is empty from ${sourceUrl}`);
  }

  const components: RemoteAssetManifestComponent[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawComponent] of rawComponents.entries()) {
    const context = `manifest.components[${index}]`;
    if (!isObjectRecord(rawComponent)) {
      throw new Error(`[remote-assets] ${context} must be object`);
    }

    const id = readRequiredString(rawComponent, "id", context);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error(`[remote-assets] ${context}.id is invalid: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`[remote-assets] duplicate component id in manifest: ${id}`);
    }
    seenIds.add(id);

    const mountRule = REMOTE_COMPONENT_MOUNT_RULES[id];
    if (!mountRule) {
      // 旧 release manifest 可能仍包含已退役的三方 agent 组件。
      // 当前客户端只认识 ZCode Agent 与基础运行时，未知组件应跳过，不能阻断当前组件下载。
      continue;
    }

    const version = readRequiredString(rawComponent, "version", context);
    assertSafePathSegment(version, `${context}.version`);

    const sha256 = readRequiredString(rawComponent, "sha256", context).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error(`[remote-assets] ${context}.sha256 is invalid`);
    }

    const artifactPath = normalizeRemoteAssetRelativePath(
      readRequiredString(rawComponent, "artifactPath", context),
      `${context}.artifactPath`,
    );
    const mount = normalizeRemoteAssetRelativePath(
      readRequiredString(rawComponent, "mount", context),
      `${context}.mount`,
    );
    const expectedMount = normalizeRemoteAssetRelativePath(
      mountRule.resolveExpectedMount(expectedPlatformArch),
      `expected mount for ${id}`,
    );
    if (mount !== expectedMount) {
      throw new Error(
        `[remote-assets] ${context}.mount mismatch for ${id}: expected=${expectedMount}, actual=${mount}`,
      );
    }

    components.push({
      id,
      version,
      sha256,
      artifactPath,
      mount,
    });
  }

  return {
    schemaVersion,
    appVersion,
    platformArch,
    components,
  };
}

export function resolveComponentCacheRootDir(
  remoteCacheDir: string,
  component: RemoteAssetManifestComponent,
  platformArch: string,
): string {
  const mountRule = REMOTE_COMPONENT_MOUNT_RULES[component.id];
  if (!mountRule) {
    throw new Error(`[remote-assets] component id is not in local whitelist: ${component.id}`);
  }
  return mountRule.platformScoped
    ? join(remoteCacheDir, "components", component.id, platformArch)
    : join(remoteCacheDir, "components", component.id);
}

export async function materializeDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (READY_MARKER_CANDIDATES.includes(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`[remote-assets] symlink is not allowed in component cache: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await materializeDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await linkOrCopyFile(sourcePath, targetPath);
      continue;
    }

    throw new Error(`[remote-assets] unsupported component entry type: ${sourcePath}`);
  }
}

export async function commitStagingDirectoryAtomically(
  stagingDir: string,
  targetDir: string,
): Promise<void> {
  await mkdir(dirname(targetDir), { recursive: true });

  const targetExists = await pathExists(targetDir);
  const backupDir = targetExists ? `${targetDir}.backup-${process.pid}-${randomUUID()}` : null;

  if (backupDir) {
    await renameRemoteAssetDirectoryWithRetry(targetDir, backupDir);
  }

  try {
    await renameRemoteAssetDirectoryWithRetry(stagingDir, targetDir);
  } catch (error) {
    if (backupDir) {
      try {
        await renameRemoteAssetDirectoryWithRetry(backupDir, targetDir);
      } catch (restoreError) {
        throw new Error(
          `[remote-assets] failed to commit staged directory and failed to restore backup: ` +
            `commit=${String(error)}, restore=${String(restoreError)}`,
        );
      }
    }
    throw error;
  }

  if (backupDir) {
    await removeRemoteAssetDirectoryBestEffort(backupDir);
  }
}

export async function writeResponseBodyToFile(
  response: Response,
  targetPath: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<void> {
  if (!response.body) {
    throw new Error("response body is empty");
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const output = createWriteStream(targetPath, { flags: "w" });
  const reportProgress = createRemoteAssetProgressReporter(
    parseContentLength(response.headers.get("content-length")),
    loggers,
  );
  let transferredBytes = 0;

  const byteMeter = new Transform({
    transform(chunk, _encoding, callback) {
      transferredBytes += chunk.byteLength;
      reportProgress(transferredBytes, false);
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    byteMeter,
    output,
  );
  reportProgress(transferredBytes, true);
}

export async function computePathContentSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const pathStat = await stat(path);

  if (pathStat.isDirectory()) {
    hash.update("root:dir\n");
    await hashDirectoryContent(hash, path);
  } else if (pathStat.isFile()) {
    hash.update("root:file\n");
    await hashFileContent(hash, path, "root-file");
  } else {
    throw new Error(`unsupported path type: ${path}`);
  }

  return hash.digest("hex");
}

export async function hasReadyMarker(baseDir: string): Promise<boolean> {
  for (const readyMarker of READY_MARKER_CANDIDATES) {
    if (await fileExists(baseDir, readyMarker)) {
      return true;
    }
  }
  return false;
}

export async function readCachedRemoteAssetMarker(cacheDir: string): Promise<string | null> {
  for (const readyMarker of READY_MARKER_CANDIDATES) {
    const markerPath = join(cacheDir, readyMarker);
    try {
      return await readFile(markerPath, "utf8");
    } catch {
      // continue
    }
  }
  return null;
}

export type RemoteAssetManifestFetchResult = RemoteAssetManifestRef;

export interface EnsureRemoteReleaseDirOptions {
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  version: string;
  platformArch: string;
  componentIds?: string[];
  requiredReleasePaths?: string[];
  /**
   * 将身份决策与实际物化绑定到同一份 manifest 快照。
   * null 表示本次 transaction 已确认 manifest 缺失，不得再次请求。
   */
  manifestRef?: RemoteAssetManifestRef | null;
  /** 仅用于需要观察同 app 版本制品重发的身份检查。 */
  refreshManifest?: boolean;
  /** 忽略当前内容寻址 cache，重新下载并校验所选组件。 */
  forceRefresh?: boolean;
  /** 单个 manifest CDN 候选请求的超时时间。 */
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export function selectRemoteAssetManifestComponents(
  manifest: RemoteAssetManifest,
  componentIds?: string[],
): RemoteAssetManifestComponent[] {
  return selectManifestComponents(manifest, normalizeRequestedComponentIds(componentIds));
}

export async function materializeComponentIntoReleaseDir(
  component: RemoteAssetManifestComponent,
  componentDir: string,
  releaseDir: string,
  remoteCacheDir: string,
  platformArch: string,
): Promise<void> {
  const stagingBaseDir = join(remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-release-component-${component.id}-${platformArch}-${process.pid}-${randomUUID()}`,
  );
  const componentStagingDir = join(stagingDir, "component");
  await mkdir(componentStagingDir, { recursive: true });

  try {
    await materializeDirectoryContents(componentDir, componentStagingDir);
    await assertExtractedArchiveNotEmpty(
      componentStagingDir,
      `[remote-assets] release component is empty for ${component.id}@${component.version}`,
    );
    const mountDir = resolvePathWithinBase(
      releaseDir,
      component.mount,
      `component ${component.id} mount`,
    );
    await commitStagingDirectoryAtomically(componentStagingDir, mountDir);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function migrateComponentSourceDir(
  sourceDir: string,
  componentDir: string,
  component: RemoteAssetManifestComponent,
  sourceLabel: string,
  platformArch: string,
  remoteCacheDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<void> {
  const stagingBaseDir = join(remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-component-migrate-${component.id}-${platformArch}-${component.version}-${process.pid}-${randomUUID()}`,
  );
  const componentStagingDir = join(stagingDir, "component");
  await mkdir(componentStagingDir, { recursive: true });

  try {
    // 迁移时仍走 staging + ready 原子提交，避免半成品目录被后续连接误判为可用 cache。
    await materializeDirectoryContents(sourceDir, componentStagingDir);
    await assertExtractedArchiveNotEmpty(
      componentStagingDir,
      `[remote-assets] migrated component source is empty for ${component.id}@${component.version}`,
    );
    await writeReadyMarker(componentStagingDir, REMOTE_ASSET_READY_MARKER);
    await commitStagingDirectoryAtomically(componentStagingDir, componentDir);
    loggers.log(
      `[remote-assets] migrated ${component.id}@${component.version} from ${sourceLabel}`,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function fetchFirstAvailableManifestOrNullWhenNotFound(options: {
  candidates: string[];
  fileLabel: string;
  version: string;
  platformArch: string;
  manifestRequestTimeoutMs?: number;
  fetch: typeof globalThis.fetch;
}): Promise<{ manifest: RemoteAssetManifest; url: string } | null> {
  const errors: string[] = [];

  for (const candidate of options.candidates) {
    const signal = createRemoteAssetManifestRequestSignal(options.manifestRequestTimeoutMs);
    let response: Response;
    try {
      response = await options.fetch(candidate, { signal });
    } catch (error) {
      errors.push(`${candidate} -> ${String(error)}`);
      continue;
    }
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      errors.push(`${candidate} -> HTTP ${response.status}`);
      continue;
    }

    try {
      return {
        manifest: await parseRemoteAssetManifestFromResponse(
          response,
          candidate,
          options.version,
          options.platformArch,
        ),
        url: candidate,
      };
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      // fetch 在收到响应头后已经完成，但 response body 仍可能半开；
      // body 超时也属于候选 CDN 的网络失败，应继续尝试下一个候选而不是永久等待。
      errors.push(`${candidate} -> ${String(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`[remote-assets] failed to fetch ${options.fileLabel}: ${errors.join("; ")}`);
  }
  return null;
}

export function resolveComponentCacheDir(
  remoteCacheDir: string,
  component: RemoteAssetManifestComponent,
  platformArch: string,
): string {
  return join(
    resolveComponentCacheRootDir(remoteCacheDir, component, platformArch),
    usesRemoteAssetContentAddressedCacheIdentity(component.id)
      ? component.sha256
      : resolveRemoteAssetComponentCacheVersion(component.version),
  );
}

export async function isReadyReleaseDir(releaseDir: string, platformArch: string): Promise<boolean> {
  if (!(await isValidReleaseDir(releaseDir, platformArch))) {
    return false;
  }

  return hasReadyMarker(releaseDir);
}

export async function isReadyComponentDir(componentDir: string): Promise<boolean> {
  try {
    const dirStat = await stat(componentDir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  return hasReadyMarker(componentDir);
}

export const remoteAssetManifestLocks = new Map<string, Promise<RemoteAssetManifestFetchResult | null>>();

export const remoteAssetManifestRefreshLocks = new Map<
  string,
  Promise<RemoteAssetManifestFetchResult | null>
>();

export async function fetchRemoteAssetManifestInternal(
  options: {
    version: string;
    platformArch: string;
    releaseBaseCandidates: string[];
    manifestUrlCandidates: string[];
    manifestFileName: string;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifestFetchResult | null> {
  const manifestFetchResult = await fetchFirstAvailableManifestOrNullWhenNotFound({
    candidates: options.manifestUrlCandidates,
    fileLabel: options.manifestFileName,
    version: options.version,
    platformArch: options.platformArch,
    manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
    fetch: resolveRemoteAssetFetch(options.remoteAssetNetwork),
  });
  if (!manifestFetchResult) {
    return null;
  }

  loggers.log(`[remote-assets] downloading ${manifestFetchResult.url}`);
  const manifestReleaseBase = resolveReleaseBaseByAssetUrl(
    manifestFetchResult.url,
    options.releaseBaseCandidates,
  );
  // 组件级按需下载后，同一次部署会多次请求 releaseDir。
  // 这里缓存 manifest，并继续优先使用 manifest 命中的 CDN 源，避免重复拉 manifest 和跨源组件不一致。
  const releaseBaseCandidatesForComponents = manifestReleaseBase
    ? [
        manifestReleaseBase,
        ...options.releaseBaseCandidates.filter((candidate) => candidate !== manifestReleaseBase),
      ]
    : options.releaseBaseCandidates;

  return {
    manifest: manifestFetchResult.manifest,
    releaseBaseCandidatesForComponents,
  };
}

export async function tryMigrateComponentDirFromHashVersionComponentCache(
  options: {
    remoteCacheDir: string;
    platformArch: string;
  },
  component: RemoteAssetManifestComponent,
  componentDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<boolean> {
  const cacheVersion = resolveRemoteAssetComponentCacheVersion(component.version);

  const componentRootDir = resolveComponentCacheRootDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  let entries: Dirent[];
  try {
    entries = await readdir(componentRootDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const legacyVersionPrefix = `${cacheVersion}+`;
  const candidates: Array<{ dir: string; version: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(legacyVersionPrefix)) {
      continue;
    }

    const candidateDir = join(componentRootDir, entry.name);
    if (resolve(candidateDir) === resolve(componentDir)) {
      continue;
    }
    if (!(await isReadyComponentDir(candidateDir))) {
      continue;
    }

    const candidateStat = await stat(candidateDir);
    candidates.push({
      dir: candidateDir,
      version: entry.name,
      mtimeMs: candidateStat.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const candidate = candidates[0];
  if (!candidate) {
    return false;
  }

  // 旧版组件 cache 把内容 hash 拼进目录名（如 v0.11.1+abcd）。
  // 新版只按语义版本命中；即使线上旧 manifest 仍带 hash，也要先迁移到纯版本目录，
  // 避免同语义版本因为 hash 后缀不同反复下载。
  await migrateComponentSourceDir(
    candidate.dir,
    componentDir,
    component,
    `legacy component cache ${candidate.version}`,
    options.platformArch,
    options.remoteCacheDir,
    loggers,
  );
  return true;
}

export async function tryMigrateComponentDirFromLegacyReleaseCache(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
  },
  component: RemoteAssetManifestComponent,
  componentDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<boolean> {
  const expectedContentHashPrefix = extractContentHashPrefixFromComponentVersion(component.version);
  if (!expectedContentHashPrefix) {
    return false;
  }

  const releasesRootDir = join(options.remoteCacheDir, "releases");
  let releaseEntries: Dirent[];
  try {
    releaseEntries = await readdir(releasesRootDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const legacyReleaseVersions = releaseEntries
    .filter((entry) => entry.isDirectory() && entry.name !== options.version)
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  for (const legacyVersion of legacyReleaseVersions) {
    const legacyReleaseDir = join(releasesRootDir, legacyVersion, options.platformArch);
    if (!(await isReadyReleaseDir(legacyReleaseDir, options.platformArch))) {
      continue;
    }

    const legacyComponentSourceDir = resolvePathWithinBase(
      legacyReleaseDir,
      component.mount,
      `legacy component ${component.id} mount`,
    );
    if (!(await isDirectoryPath(legacyComponentSourceDir))) {
      continue;
    }

    let legacyContentHash: string;
    try {
      legacyContentHash = await computePathContentSha256(legacyComponentSourceDir);
    } catch (error) {
      loggers.logWarn(
        `[remote-assets] skip legacy component migration for ${component.id}@${component.version} from ${legacyVersion}: ${String(error)}`,
      );
      continue;
    }
    if (!legacyContentHash.startsWith(expectedContentHashPrefix)) {
      continue;
    }

    await migrateComponentSourceDir(
      legacyComponentSourceDir,
      componentDir,
      component,
      `legacy release ${legacyVersion}`,
      options.platformArch,
      options.remoteCacheDir,
      loggers,
    );
    return true;
  }

  return false;
}

export async function isReadyReleaseDirForRequestedPaths(
  releaseDir: string,
  platformArch: string,
  requiredReleasePaths: readonly string[],
): Promise<boolean> {
  if (!(await isReadyReleaseDir(releaseDir, platformArch))) {
    return false;
  }

  return (await findMissingLocalRelativePaths(releaseDir, requiredReleasePaths)).length === 0;
}

export async function findMissingReadyComponentPaths(
  componentDir: string,
  requiredRelativePaths: readonly string[],
): Promise<string[] | null> {
  if (!(await isReadyComponentDir(componentDir))) {
    return null;
  }

  return findMissingLocalRelativePaths(componentDir, requiredRelativePaths);
}
