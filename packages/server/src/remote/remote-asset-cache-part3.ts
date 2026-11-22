import { randomUUID } from "node:crypto";
import {
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import {
  assertRemoteCdnBaseVersionMatches,
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@zcode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@zcode/server/remote/remoteAssetNetwork.js";
import { MANIFEST_FILE_NAME_PREFIX, REMOTE_ASSET_READY_MARKER, assertExtractedArchiveNotEmpty, assertSafePathSegment, buildRemoteManifestFileCandidates, computeFileSha256, fetchFirstAvailableUrl, findMissingLocalRelativePaths, isValidReleaseDir, normalizeRequestedComponentIds, normalizeRequiredReleasePaths, pathExists, remoteAssetComponentLocks, remoteAssetReleaseLocks, resolveContentAddressedReleaseSegments, resolveRequiredComponentPaths, runWithReleaseMaterializeLock, selectManifestComponents, usesRemoteAssetContentAddressedCacheIdentity, writeReadyMarker } from "./remote-asset-cache-part1.js";
import type { RemoteAssetCacheLoggers, RemoteAssetManifest, RemoteAssetManifestComponent, RemoteAssetManifestRef } from "./remote-asset-cache-part1.js";
import { commitStagingDirectoryAtomically, fetchRemoteAssetManifestInternal, findMissingReadyComponentPaths, isReadyReleaseDirForRequestedPaths, materializeComponentIntoReleaseDir, remoteAssetManifestLocks, remoteAssetManifestRefreshLocks, resolveComponentCacheDir, tryMigrateComponentDirFromHashVersionComponentCache, tryMigrateComponentDirFromLegacyReleaseCache, writeResponseBodyToFile } from "./remote-asset-cache-part2.js";
import type { EnsureRemoteReleaseDirOptions, RemoteAssetManifestFetchResult } from "./remote-asset-cache-part2.js";

// Часть 3/3 модуля remote-asset-cache: вынесено по лимиту строк.

export async function fetchRemoteAssetManifest(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    remoteCdnBaseUrls: string[];
    releaseBaseCandidates: string[];
    manifestUrlCandidates: string[];
    manifestFileName: string;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
  shouldRefreshCachedResult?: (result: RemoteAssetManifestFetchResult) => Promise<boolean>,
): Promise<RemoteAssetManifestFetchResult | null> {
  const lockKey = [
    resolve(options.remoteCacheDir),
    options.version,
    options.platformArch,
    String(options.manifestRequestTimeoutMs ?? "default"),
    ...options.remoteCdnBaseUrls,
  ].join("::");
  const lockedTask = remoteAssetManifestLocks.get(lockKey);
  if (lockedTask) {
    const activeRefreshTask = remoteAssetManifestRefreshLocks.get(lockKey);
    if (activeRefreshTask) {
      return activeRefreshTask;
    }
    const cachedResult = await lockedTask;
    const refreshStartedWhileWaiting = remoteAssetManifestRefreshLocks.get(lockKey);
    if (refreshStartedWhileWaiting) {
      return refreshStartedWhileWaiting;
    }
    const shouldRefresh = Boolean(
      cachedResult && shouldRefreshCachedResult && (await shouldRefreshCachedResult(cachedResult)),
    );
    if (!shouldRefresh) {
      return cachedResult;
    }
    const refreshStartedWhileDeciding = remoteAssetManifestRefreshLocks.get(lockKey);
    if (refreshStartedWhileDeciding) {
      return refreshStartedWhileDeciding;
    }
  }

  let task: Promise<RemoteAssetManifestFetchResult | null>;
  task = fetchRemoteAssetManifestInternal(options, loggers).then(
    (result) => {
      if (!result && remoteAssetManifestLocks.get(lockKey) === task) {
        remoteAssetManifestLocks.delete(lockKey);
      }
      return result;
    },
    (error) => {
      if (remoteAssetManifestLocks.get(lockKey) === task) {
        remoteAssetManifestLocks.delete(lockKey);
      }
      throw error;
    },
  );
  remoteAssetManifestLocks.set(lockKey, task);
  if (shouldRefreshCachedResult) {
    // 多个 remote session 可能同时检查内容寻址组件的 SHA。fresh manifest 也必须
    // single-flight，否则同一批会话会重复请求，甚至在发布切换点看到不同快照。
    remoteAssetManifestRefreshLocks.set(lockKey, task);
    void task.then(
      () => {
        if (remoteAssetManifestRefreshLocks.get(lockKey) === task) {
          remoteAssetManifestRefreshLocks.delete(lockKey);
        }
      },
      () => {
        if (remoteAssetManifestRefreshLocks.get(lockKey) === task) {
          remoteAssetManifestRefreshLocks.delete(lockKey);
        }
      },
    );
  }
  return task;
}

export async function ensureRemoteComponentDirFromCdnInternal(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  component: RemoteAssetManifestComponent,
  requiredRelativePaths: readonly string[],
  loggers: RemoteAssetCacheLoggers,
  forceRefresh = false,
): Promise<string> {
  const componentDir = resolveComponentCacheDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  if (forceRefresh) {
    // App 版本变化代表一次新的资源发布边界；即使 GLM SHA cache 命中，
    // 也必须重新下载、校验并原子替换，避免本地上传把旧 cache 再次部署到远端。
    loggers.logWarn(
      `[remote-assets] forced component refresh: component=${component.id} path=${componentDir}`,
    );
  }
  const initialMissingPaths = await findMissingReadyComponentPaths(
    componentDir,
    requiredRelativePaths,
  );
  if (!forceRefresh && initialMissingPaths?.length === 0) {
    return componentDir;
  }
  if (!forceRefresh && initialMissingPaths) {
    // 旧版本只用 .ready 判断 component cache 可用。用户先部署过只含
    // zcode.cjs 的 glm cache 后，再补传 packages 会一直复用残缺 cache。
    // 这里按调用方声明的关键路径校验，缺失时清掉旧 cache 并从 CDN 重下完整组件。
    loggers.logWarn(
      `[remote-assets] local component cache incomplete: component=${component.id} missing=${initialMissingPaths.join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  if (
    !forceRefresh &&
    !usesRemoteAssetContentAddressedCacheIdentity(component.id) &&
    (await tryMigrateComponentDirFromHashVersionComponentCache(
      options,
      component,
      componentDir,
      loggers,
    ))
  ) {
    const migratedMissingPaths = await findMissingReadyComponentPaths(
      componentDir,
      requiredRelativePaths,
    );
    if (migratedMissingPaths?.length === 0) {
      return componentDir;
    }
    loggers.logWarn(
      `[remote-assets] migrated local component cache incomplete: component=${component.id} missing=${(migratedMissingPaths ?? []).join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  if (
    !forceRefresh &&
    !usesRemoteAssetContentAddressedCacheIdentity(component.id) &&
    (await tryMigrateComponentDirFromLegacyReleaseCache(options, component, componentDir, loggers))
  ) {
    const migratedMissingPaths = await findMissingReadyComponentPaths(
      componentDir,
      requiredRelativePaths,
    );
    if (migratedMissingPaths?.length === 0) {
      return componentDir;
    }
    loggers.logWarn(
      `[remote-assets] migrated local component cache incomplete: component=${component.id} missing=${(migratedMissingPaths ?? []).join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  const artifactUrlCandidates = buildComponentArtifactUrlCandidates(
    options.releaseBaseCandidatesForComponents,
    component.artifactPath,
    options.version,
  );

  const stagingBaseDir = join(options.remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-component-${component.id}-${options.platformArch}-${component.version}-${process.pid}-${randomUUID()}`,
  );
  const archivePath = join(stagingDir, "component.tar.gz");
  const extractRoot = join(stagingDir, "extract");
  await mkdir(extractRoot, { recursive: true });

  try {
    const { response: artifactResponse, url: artifactUrl } = await fetchFirstAvailableUrl(
      artifactUrlCandidates,
      `${component.id}@${component.version}`,
      resolveRemoteAssetFetch(options.remoteAssetNetwork),
    );
    loggers.log(`[remote-assets] downloading ${artifactUrl}`);
    await writeResponseBodyToFile(artifactResponse, archivePath, loggers);

    const actualChecksum = await computeFileSha256(archivePath);
    if (actualChecksum !== component.sha256) {
      throw new Error(
        `[remote-assets] sha256 mismatch for ${component.id}@${component.version}: expected=${component.sha256}, actual=${actualChecksum}`,
      );
    }

    await extractTarGzArchive(archivePath, extractRoot);
    await assertExtractedArchiveNotEmpty(
      extractRoot,
      `[remote-assets] extracted component archive is empty for ${component.id}@${component.version}`,
    );
    await writeReadyMarker(extractRoot, REMOTE_ASSET_READY_MARKER);
    await commitStagingDirectoryAtomically(extractRoot, componentDir);
    return componentDir;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function isReadyComponentDirForRequiredPaths(
  componentDir: string,
  requiredRelativePaths: readonly string[],
): Promise<boolean> {
  const missingPaths = await findMissingReadyComponentPaths(componentDir, requiredRelativePaths);
  return missingPaths?.length === 0;
}

export async function fetchRemoteAssetManifestRefFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifestRef | null> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options);
  const remoteCacheDir = options.remoteCacheDir?.trim();
  const platformArch = options.platformArch?.trim();
  const version = options.version?.trim();

  if (remoteCdnBaseUrls.length === 0 || !remoteCacheDir || !platformArch || !version) {
    return null;
  }

  assertSafePathSegment(version, "appVersion");
  assertSafePathSegment(platformArch, "platformArch");
  assertRemoteCdnBaseVersionMatches(remoteCdnBaseUrls, version);

  const releaseBaseCandidates = buildReleaseBaseCandidates(remoteCdnBaseUrls, version);
  const manifestFileCandidates = buildRemoteManifestFileCandidates(platformArch);
  const manifestFileName =
    manifestFileCandidates[0] ?? `${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`;
  const manifestUrlCandidates = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    manifestFileCandidates,
  );

  const result = await fetchRemoteAssetManifest(
    {
      remoteCacheDir,
      version,
      platformArch,
      remoteCdnBaseUrls,
      releaseBaseCandidates,
      manifestUrlCandidates,
      manifestFileName,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
    options.refreshManifest ? async () => true : undefined,
  );
  return result;
}

export async function ensureRemoteComponentDirFromCdn(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  component: RemoteAssetManifestComponent,
  requiredRelativePaths: readonly string[],
  loggers: RemoteAssetCacheLoggers,
  forceRefresh = false,
): Promise<string> {
  const componentDir = resolveComponentCacheDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  if (
    !forceRefresh &&
    (await isReadyComponentDirForRequiredPaths(componentDir, requiredRelativePaths))
  ) {
    return componentDir;
  }

  // 组件锁 key 之前未带 remoteCacheDir，不同缓存目录会被同一组件下载锁串起来。
  // 这里直接使用 componentDir 绝对路径做 key，保证隔离语义与落盘目录一一对应。
  const lockKey = resolve(componentDir);
  while (true) {
    const lockedTask = remoteAssetComponentLocks.get(lockKey);
    if (!lockedTask) {
      break;
    }
    const lockedComponentDir = await lockedTask;
    const missingPaths = await findMissingReadyComponentPaths(
      lockedComponentDir,
      requiredRelativePaths,
    );
    if (missingPaths?.length === 0) {
      return lockedComponentDir;
    }
    // 不同部署调用会共享同一 component cache 锁。等待已有下载后，
    // 仍要用当前调用方的关键路径复检，避免把只满足旧调用的残缺 cache 返回出去。
    loggers.logWarn(
      `[remote-assets] locked component cache still incomplete: component=${component.id} missing=${(missingPaths ?? []).join(",")}; redownloading`,
    );
  }

  const task = ensureRemoteComponentDirFromCdnInternal(
    options,
    component,
    requiredRelativePaths,
    loggers,
    forceRefresh,
  ).finally(() => {
    remoteAssetComponentLocks.delete(lockKey);
  });
  remoteAssetComponentLocks.set(lockKey, task);
  return task;
}

export async function fetchRemoteAssetManifestFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifest | null> {
  return (await fetchRemoteAssetManifestRefFromCdn(options, loggers))?.manifest ?? null;
}

export async function ensureRemoteReleaseDirFromManifest(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    requestedComponentIds: Set<string> | null;
    requiredReleasePaths: string[];
    forceRefresh?: boolean;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  manifest: RemoteAssetManifest,
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const selectedComponents = selectManifestComponents(manifest, options.requestedComponentIds);
  const releaseDir = join(
    options.remoteCacheDir,
    "releases",
    options.version,
    options.platformArch,
    ...resolveContentAddressedReleaseSegments(selectedComponents, options.requestedComponentIds),
  );
  if (
    !options.forceRefresh &&
    (await isReadyReleaseDirForRequestedPaths(
      releaseDir,
      options.platformArch,
      options.requiredReleasePaths,
    ))
  ) {
    return releaseDir;
  }

  // 之前组装 releaseDir 会按 manifest 拉齐全部组件，即使后续远端版本检查会跳过。
  // 这里只落地本次部署明确需要的组件，避免主 server 升级时额外下载已最新的工具包。
  const componentCacheEntries: Array<{
    component: RemoteAssetManifestComponent;
    componentDir: string;
  }> = [];
  for (const component of selectedComponents) {
    const componentDir = await ensureRemoteComponentDirFromCdn(
      options,
      component,
      resolveRequiredComponentPaths(component, options.requiredReleasePaths),
      loggers,
      Boolean(options.forceRefresh),
    );
    componentCacheEntries.push({ component, componentDir });
  }

  await runWithReleaseMaterializeLock(releaseDir, async () => {
    await mkdir(releaseDir, { recursive: true });
    for (const { component, componentDir } of componentCacheEntries) {
      await materializeComponentIntoReleaseDir(
        component,
        componentDir,
        releaseDir,
        options.remoteCacheDir,
        options.platformArch,
      );
    }
    await writeFile(
      join(releaseDir, `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`),
      `${JSON.stringify(manifest)}\n`,
      "utf8",
    );

    if (options.requestedComponentIds) {
      return;
    }

    if (!(await isValidReleaseDir(releaseDir, options.platformArch))) {
      throw new Error("[remote-assets] assembled release directory is invalid");
    }

    await writeReadyMarker(releaseDir, REMOTE_ASSET_READY_MARKER);
  });
  return releaseDir;
}

export async function ensureRemoteReleaseDirFromCdnInternal(
  options: {
    remoteCdnBaseUrls: string[];
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    requestedComponentIds: Set<string> | null;
    requiredReleasePaths: string[];
    manifestRef?: RemoteAssetManifestRef | null;
    forceRefresh?: boolean;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const usesContentAddressedArtifactIdentity =
    options.requestedComponentIds === null ||
    Array.from(options.requestedComponentIds).some((componentId) =>
      usesRemoteAssetContentAddressedCacheIdentity(componentId),
    );
  const releaseDir = join(
    options.remoteCacheDir,
    "releases",
    options.version,
    options.platformArch,
  );
  if (
    !options.forceRefresh &&
    !usesContentAddressedArtifactIdentity &&
    (await isReadyReleaseDirForRequestedPaths(
      releaseDir,
      options.platformArch,
      options.requiredReleasePaths,
    ))
  ) {
    return releaseDir;
  }

  const releaseBaseCandidates = buildReleaseBaseCandidates(
    options.remoteCdnBaseUrls,
    options.version,
  );
  const manifestFileCandidates = buildRemoteManifestFileCandidates(options.platformArch);
  const manifestFileName =
    manifestFileCandidates[0] ?? `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`;
  const manifestUrlCandidates = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    manifestFileCandidates,
  );
  if (options.manifestRef) {
    return ensureRemoteReleaseDirFromManifest(
      {
        remoteCacheDir: options.remoteCacheDir,
        version: options.version,
        platformArch: options.platformArch,
        releaseBaseCandidatesForComponents: options.manifestRef.releaseBaseCandidatesForComponents,
        requestedComponentIds: options.requestedComponentIds,
        requiredReleasePaths: options.requiredReleasePaths,
        forceRefresh: options.forceRefresh,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      options.manifestRef.manifest,
      loggers,
    );
  }
  if (options.manifestRef === null) {
    // 上游已在 deploy lock 内固定“manifest 缺失”结果；
    // 若 release materialize 再请求一次，会破坏单事务快照并翻倍超时上限。
    throw new Error(
      `[remote-assets] manifest not found for ${options.platformArch}: ${manifestFileName}`,
    );
  }

  const manifestFetchResult = await fetchRemoteAssetManifest(
    {
      remoteCacheDir: options.remoteCacheDir,
      version: options.version,
      platformArch: options.platformArch,
      remoteCdnBaseUrls: options.remoteCdnBaseUrls,
      releaseBaseCandidates,
      manifestUrlCandidates,
      manifestFileName,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
    usesContentAddressedArtifactIdentity
      ? async (cachedResult) => {
          const cachedComponents = selectManifestComponents(
            cachedResult.manifest,
            options.requestedComponentIds,
          );
          const contentSegments = resolveContentAddressedReleaseSegments(
            cachedComponents,
            options.requestedComponentIds,
          );
          return contentSegments.length > 0
            ? pathExists(
                join(
                  options.remoteCacheDir,
                  "releases",
                  options.version,
                  options.platformArch,
                  ...contentSegments,
                  `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`,
                ),
              )
            : false;
        }
      : undefined,
  );
  if (manifestFetchResult) {
    return ensureRemoteReleaseDirFromManifest(
      {
        remoteCacheDir: options.remoteCacheDir,
        version: options.version,
        platformArch: options.platformArch,
        releaseBaseCandidatesForComponents: manifestFetchResult.releaseBaseCandidatesForComponents,
        requestedComponentIds: options.requestedComponentIds,
        requiredReleasePaths: options.requiredReleasePaths,
        forceRefresh: options.forceRefresh,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      manifestFetchResult.manifest,
      loggers,
    );
  }

  // 现在生产态只发布 manifest/components。manifest 缺失说明 CDN 发布不完整，
  // 继续探测旧 remote-assets 只会增加无效请求并掩盖真正的发布问题。
  throw new Error(
    `[remote-assets] manifest not found for ${options.platformArch}: ${manifestFileName}`,
  );
}

export async function ensureRemoteReleaseDirFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options);
  const remoteCacheDir = options.remoteCacheDir?.trim();
  const platformArch = options.platformArch?.trim();
  const version = options.version?.trim();

  if (remoteCdnBaseUrls.length === 0 || !remoteCacheDir || !platformArch || !version) {
    throw new Error(
      `[deploy] production remote assets require remoteCdnBaseUrl or remoteCdnBaseUrls, remoteCacheDir and platformArch ` +
        `(remoteCdnBaseUrl=${options.remoteCdnBaseUrl ?? "<empty>"}, remoteCdnBaseUrls=${JSON.stringify(options.remoteCdnBaseUrls ?? [])}, remoteCacheDir=${options.remoteCacheDir ?? "<empty>"}, platformArch=${options.platformArch ?? "<empty>"}).`,
    );
  }

  assertSafePathSegment(version, "appVersion");
  assertSafePathSegment(platformArch, "platformArch");
  assertRemoteCdnBaseVersionMatches(remoteCdnBaseUrls, version);
  const requestedComponentIds = normalizeRequestedComponentIds(options.componentIds);
  const usesContentAddressedArtifactIdentity =
    requestedComponentIds === null ||
    Array.from(requestedComponentIds).some((componentId) =>
      usesRemoteAssetContentAddressedCacheIdentity(componentId),
    );
  const requiredReleasePaths = normalizeRequiredReleasePaths(options.requiredReleasePaths);

  // 之前 cache 目录只按 version 区分，跨平台 remote 会话会互相覆盖资源。
  // 这里改成 version + platformArch 双维隔离，避免 linux/darwin 互串导致部署二进制不匹配。
  const releaseDir = join(remoteCacheDir, "releases", version, platformArch);
  if (
    !options.forceRefresh &&
    !usesContentAddressedArtifactIdentity &&
    (await isReadyReleaseDirForRequestedPaths(releaseDir, platformArch, requiredReleasePaths))
  ) {
    return releaseDir;
  }
  loggers.logWarn(
    `[remote-assets] download required: component=<release> reason=local cache missing or invalid path=${releaseDir}`,
  );

  // 同一个桌面窗口可以并发创建多个 remote session。
  // 若不加进程内锁，会出现多个会话同时下载并解压同一版本资源，最终互相覆盖或留下半成品目录。
  // 之前锁 key 没带 remoteCacheDir，不同缓存目录会误复用同一 Promise。
  // 这会把 A 目录的 release 路径返回给 B 调用方，破坏 cache 隔离语义。
  const requestedComponentLockKey = requestedComponentIds
    ? Array.from(requestedComponentIds).sort().join(",")
    : "<all>";
  const pinnedContentIdentity = usesContentAddressedArtifactIdentity
    ? resolveContentAddressedReleaseSegments(
        options.manifestRef
          ? selectManifestComponents(options.manifestRef.manifest, requestedComponentIds)
          : [],
        requestedComponentIds,
      ).join("/")
    : undefined;
  const lockKey = [
    resolve(releaseDir),
    requestedComponentLockKey,
    options.manifestRef === null ? "<missing-manifest>" : pinnedContentIdentity || "<unpinned>",
    options.forceRefresh ? "force" : "reuse",
    String(options.manifestRequestTimeoutMs ?? "default"),
  ].join("::");
  while (true) {
    const lockedTask = remoteAssetReleaseLocks.get(lockKey);
    if (!lockedTask) {
      break;
    }
    const lockedReleaseDir = await lockedTask;
    const missingPaths = await findMissingLocalRelativePaths(
      lockedReleaseDir,
      requiredReleasePaths,
    );
    if (missingPaths.length === 0) {
      return lockedReleaseDir;
    }
    // 并发 remote session 可能先复用一个“不带 required paths”的 release 下载锁。
    // 等待该锁完成后必须按当前调用方声明的关键路径复检，缺失时继续走后续重下流程。
    loggers.logWarn(
      `[remote-assets] locked release cache still incomplete: missing=${missingPaths.join(",")}; redownloading`,
    );
  }

  const task = ensureRemoteReleaseDirFromCdnInternal(
    {
      remoteCdnBaseUrls,
      remoteCacheDir,
      version,
      platformArch,
      requestedComponentIds,
      requiredReleasePaths,
      manifestRef: options.manifestRef,
      forceRefresh: options.forceRefresh,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
  ).finally(() => {
    remoteAssetReleaseLocks.delete(lockKey);
  });

  remoteAssetReleaseLocks.set(lockKey, task);
  return task;
}
