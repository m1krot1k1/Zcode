import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";


import type { PluginDiagnostic, PluginManifest } from "@zcode/contracts";

import { ZCODE_OFFLINE_PREVIEW, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";

import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort, directoryExists, fileExists, isRecord, resolveInside } from "./helpers.js";
import { enumeratePluginComponents, type PluginComponentGroup } from "./plugin-components.js";



import {
  isZipPluginUrlSource,
  readZipPluginSourceSha256,
  resolveZipPluginSource,
} from "./zip-source.js";
import { activateDirectoryAtomically, type AtomicDirectoryActivation } from "./atomic-directory.js";
import {
  resolveGitHubArchiveSource,
  shouldFallbackGitHubArchiveToGit,
} from "./github-archive-source.js";
import { createArchiveFetchError } from "./source-errors.js";
import {
  CLAUDE_OFFICIAL_MARKETPLACE,
  CachedMarketplacePluginResult,
  DEFAULT_VERSION,
  INSTALLED_PLUGINS_FILE,
  InstalledPluginRecord,
  InstalledPluginsState,
  PluginManifestDisplayMetadata,
  PluginMarketplaceEntry,
  PluginMarketplaceManifest,
  PluginValidationDiagnostic,
  ResolvedPluginSourceRoot,
  applyClaudePluginIcons,
  assertMarketplaceUrlAvailableInBuild,
  claudeIconMigrationAttempts,
  createManifestFromMarketplaceEntry,
  findPluginManifestPath,
  getMarketplaceManifestPath,
  getPluginCacheDir,
  isGitSshUrl,
  normalizeAuthorValue,
  readOptionalZipPluginSourcePath,
  readOptionalZipPluginSourceStripRoot,
  readPluginSourceHeaders,
  readRequiredPluginSourceString,
  readRequiredZipPluginSourceSha256,
  resolvePathInput,
  splitGitHubShorthand,
  splitRef,
  throwIfPluginOperationAborted,
  tryParseUrl,
  writeJsonFile,
} from "./marketplace-types.js";
import {
  KnownMarketplaceRecord,
  MarketplaceSource,
  assertPluginAppVersionCompatible,
  execGitCloneWithRetry,
  execGitCommand,
  loadClaudePluginIconSources,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  readPluginManifestFromRoot,
} from "./marketplace-primitives.js";
import {
  addMarketplace,
  ensureDefaultPluginMarketplaces,
} from "./marketplace-runtime.js";
import {
  UnsupportedPluginSourceError,
} from "./marketplace-validation.js";

// Плагин-маркетплейс: sources. Вынесено из marketplace.ts по лимиту строк.

export async function parseMarketplaceSourceInput(input: string): Promise<MarketplaceSource> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Marketplace source is empty");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const { url, ref } = splitRef(trimmed);
    if (url.endsWith(".git") || url.includes("/_git/")) {
      return ref ? { source: "git", url, ref } : { source: "git", url };
    }
    const parsed = tryParseUrl(url);
    if (parsed && (parsed.hostname === "github.com" || parsed.hostname === "www.github.com")) {
      const match = parsed.pathname.match(/^\/([^/]+\/[^/]+?)(?:\/|\.git|$)/);
      if (match?.[1]) {
        const gitUrl = url.endsWith(".git") ? url : `${url}.git`;
        return ref ? { source: "git", url: gitUrl, ref } : { source: "git", url: gitUrl };
      }
    }
    return { source: "url", url };
  }

  if (isGitSshUrl(trimmed)) {
    const { url, ref } = splitRef(trimmed);
    return ref ? { source: "git", url, ref } : { source: "git", url };
  }

  const resolved = resolvePathInput(trimmed);
  if (resolved) {
    if (!existsSync(resolved))
      throw new Error(`Marketplace source path does not exist: ${resolved}`);
    if (fileExists(resolved)) {
      if (!resolved.endsWith(".json")) {
        throw new Error(`Marketplace file must be a .json file: ${resolved}`);
      }
      return { source: "file", path: resolved };
    }
    if (directoryExists(resolved)) return { source: "directory", path: resolved };
    throw new Error(`Marketplace source path is not a file or directory: ${resolved}`);
  }

  if (trimmed.includes("/") && !trimmed.includes(":")) {
    const { url: repo, ref } = splitGitHubShorthand(trimmed);
    return ref ? { source: "github", repo, ref } : { source: "github", repo };
  }

  throw new Error(`Unsupported marketplace source: ${input}`);
}

export async function ensureMarketplaceManifestAvailable(input: {
  marketplace: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord | null> {
  throwIfPluginOperationAborted(input.signal);
  ensureDefaultPluginMarketplaces(input.storageRoot);
  if (loadMarketplaceManifestSync(input.storageRoot, input.marketplace)) {
    return (
      loadKnownMarketplacesSync(input.storageRoot).find(
        (record) => record.id === input.marketplace,
      ) ?? null
    );
  }
  const record = loadKnownMarketplacesSync(input.storageRoot).find(
    (item) => item.id === input.marketplace,
  );
  if (!record) return null;
  // Offline Preview 保留已有官方目录快照；没有缓存时不自动连接 ZCode 生产 CDN。
  if (ZCODE_OFFLINE_PREVIEW && record.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID) {
    throw new Error("The official ZCode plugin catalog is not cached in this offline Preview build.");
  }
  // 受信任的内部懒加载：用 known record 的规范 source 拉取，并以 record.id 作为 trustedId，
  // 使官方 id 只能由本来就是该官方 id 的记录刷新得到。
  return await addMarketplace({
    signal: input.signal,
    source: record.source,
    storageRoot: input.storageRoot,
    trustedId: record.id,
  });
}

export async function enrichCachedClaudeMarketplaceIcons(
  storageRoot: string,
  withWriteLock: (write: () => Promise<void>) => Promise<void> = (write) => write(),
): Promise<void> {
  const attemptKey = resolve(storageRoot);
  if (claudeIconMigrationAttempts.has(attemptKey)) return;
  claudeIconMigrationAttempts.add(attemptKey);

  const manifest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
  if (!manifest) return;
  try {
    const iconSources = await loadClaudePluginIconSources(storageRoot);
    await withWriteLock(async () => {
      // 网络请求期间不持 plugin storage 锁；获得锁后必须重读，避免覆盖并发 marketplace 更新。
      const latest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
      if (!latest) return;
      const enriched = applyClaudePluginIcons(latest.raw, iconSources);
      if (enriched === latest.raw) return;
      // Bugfix：升级前已有 lastUpdated 的 catalog 不会触发 UI 自动刷新，导致新图标功能永远不可见。
      // 这里只回写展示增强字段，不重拉 marketplace，也不改变更新检测时间。
      await writeMarketplaceManifest(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE, enriched);
    });
  } catch {
    // 存量图标迁移是 best-effort；失败不能让 plugins/overview 不可用，下次 Agent 启动可重试。
  }
}

/** 读插件根目录的 manifest（失败按 null 降级），再交给纯枚举器列出组件名称+描述。 */
export function readComponentsAtRoot(input: {
  diagnostics: PluginValidationDiagnostic[];
  entry?: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
}): { components: PluginComponentGroup[]; metadata?: PluginManifestDisplayMetadata } {
  let loadedManifest: { manifest: PluginManifest; manifestPath?: string } | null = null;
  try {
    loadedManifest = readPluginManifestFromRoot(
      input.rootPath,
      input.entry ?? { name: "__describe__", raw: {} },
    );
  } catch {
    // manifest 解析失败不致命：仍可按默认目录约定扫描组件。
    loadedManifest = null;
  }
  const loaded = loadedManifest
    ? {
        id: `${loadedManifest.manifest.name}@${input.marketplace}`,
        manifest: loadedManifest.manifest,
        manifestPath: loadedManifest.manifestPath ?? input.rootPath,
        marketplace: input.marketplace,
        rootPath: input.rootPath,
        source: "cache" as const,
      }
    : undefined;
  const components = enumeratePluginComponents(input.rootPath, loadedManifest?.manifest ?? null, {
    diagnostics: input.diagnostics as PluginDiagnostic[],
    ...(loaded ? { loaded } : {}),
  });
  const metadata = loadedManifest ? toManifestDisplayMetadata(loadedManifest.manifest) : undefined;
  return { components, ...(metadata ? { metadata } : {}) };
}

/** 抽取 plugin.json 里可展示的回退字段；一个都没有时返回 undefined。 */
export function toManifestDisplayMetadata(
  manifest: PluginManifest,
): PluginManifestDisplayMetadata | undefined {
  const author = normalizeAuthorValue(manifest.author);
  const homepage =
    typeof manifest.homepage === "string" && manifest.homepage.trim().length > 0
      ? manifest.homepage
      : undefined;
  const metadata: PluginManifestDisplayMetadata = {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    ...(manifest.version ? { version: manifest.version } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** 用户传入 manifest 文件时，回推对应的插件根目录。 */
export function resolveManifestRootFromFile(filePath: string): string {
  const dir = dirname(filePath);
  const dirName = basename(dir);
  return dirName.startsWith(".") && dirName.endsWith("-plugin") ? dirname(dir) : dir;
}

export async function cacheMarketplacePlugin(input: {
  appVersion: string;
  entry: PluginMarketplaceEntry;
  marketplace: string;
  signal?: AbortSignal;
  scope: "user" | "workspace";
  state: InstalledPluginsState;
  storageRoot: string;
}): Promise<CachedMarketplacePluginResult> {
  throwIfPluginOperationAborted(input.signal);
  const sourceRoot = await resolvePluginSourceRoot({
    entry: input.entry,
    marketplace: input.marketplace,
    signal: input.signal,
    storageRoot: input.storageRoot,
  });
  let version: string;
  let target: string;
  let activation: AtomicDirectoryActivation | undefined;
  try {
    // 多顶层 ZIP 未显式 path 时 resolver 会回退到 extract root，
    // 原安装流程未在删除旧 cache 前校验 manifest，仍会写 installed record 并默认启用，最终 runtime
    // 无法 discover。ZIP 源必须先确认根目录可形成合法插件；strict:false 继续复用 synthetic manifest。
    if (isZipPluginUrlSource(input.entry.source)) {
      assertZipPluginInstallRoot(sourceRoot.path, input.entry, input.marketplace);
    }
    // 兼容门禁必须在复制缓存/写 installed record 之前执行：声明了不兼容内核版本的插件
    // 不能先装进 inventory 再靠 runtime 报错，否则用户看到的是「安装成功但不可用」。
    assertPluginInstallCompatibility({
      appVersion: input.appVersion,
      entry: input.entry,
      marketplace: input.marketplace,
      rootPath: sourceRoot.path,
    });
    // 缓存目录的版本段与安装记录的 version 不能取自 marketplace 条目的
    // version 字段：git/url 源插件的条目通常不带 version，取了也只会兜底成
    // "0.0.0"，导致 Root path 落到 .../<name>/0.0.0；而 UI 展示读的是插件自带 plugin.json 里的
    // 真实版本，两者割裂。因此在 clone/拷贝后的源根目录上按加载器同样的规则解析真实
    // 版本（详见 resolveInstalledPluginVersion），让缓存路径段与安装记录、UI 展示版本一致。
    version = resolveInstalledPluginVersion(sourceRoot.path, input.entry);
    target = getPluginCacheDir(input.storageRoot, input.marketplace, input.entry.name, version);
    // 内置 filesystem/sea 插件的 cachePath 即缓存目录本身，源根目录可能与 target 相同；
    // 此时无需（也不能）先 rm 再自我拷贝，否则会把源删掉。
    if (resolve(sourceRoot.path) !== resolve(target)) {
      throwIfPluginOperationAborted(input.signal);
      activation = await activateDirectoryAtomically({
        authorityPath: join(input.storageRoot, INSTALLED_PLUGINS_FILE),
        prepare: async (stagedPath) => {
          await ensureMarketplaceEntryManifest({ entry: input.entry, target: stagedPath });
        },
        signal: input.signal,
        sourcePath: sourceRoot.path,
        targetPath: target,
      });
    }
    if (resolve(sourceRoot.path) === resolve(target)) {
      await ensureMarketplaceEntryManifest({ entry: input.entry, target });
    }
  } finally {
    // cache 已复制成功后，临时目录 cleanup 失败不能阻断 installed record 落盘。
    await cleanupPluginSourceBestEffort(sourceRoot.cleanup);
  }

  const now = new Date().toISOString();
  const record: InstalledPluginRecord = {
    id: `${input.entry.name}@${input.marketplace}`,
    name: input.entry.name,
    marketplace: input.marketplace,
    version,
    installPath: target,
    installedAt: now,
    updatedAt: now,
    scope: input.scope,
    ...(input.entry.dependencies ? { dependencies: input.entry.dependencies } : {}),
    ...(input.entry.source !== undefined ? { source: input.entry.source } : {}),
    ...(activation ? { cacheTransactionId: activation.transactionId } : {}),
  };
  const existingIndex = input.state.plugins.findIndex((plugin) => plugin.id === record.id);
  if (existingIndex >= 0) {
    const { cacheTransactionId: _previousCacheTransactionId, ...previousRecord } =
      input.state.plugins[existingIndex] ?? record;
    input.state.plugins[existingIndex] = {
      ...previousRecord,
      ...record,
      installedAt: previousRecord.installedAt ?? record.installedAt,
    };
  } else {
    input.state.plugins.push(record);
  }
  return { ...(activation ? { activation } : {}), record };
}

export async function resolvePluginSourceRoot(input: {
  entry: PluginMarketplaceEntry;
  manifest?: PluginMarketplaceManifest;
  marketplace: string;
  signal?: AbortSignal;
  sourceRoot?: string;
  storageRoot: string;
}): Promise<ResolvedPluginSourceRoot> {
  throwIfPluginOperationAborted(input.signal);
  const source = input.entry.source;
  const marketplaceDir =
    input.sourceRoot ?? dirname(getMarketplaceManifestPath(input.storageRoot, input.marketplace));
  const manifest =
    input.manifest ?? loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  const pluginBaseDir = resolveMarketplacePluginBaseDir(marketplaceDir, manifest);
  // 内置 official 插件 seed 到 marketplace.json 时 source 写的是裸 kind 字符串
  // "filesystem"/"sea"（见 bootstrap/app/bundled-plugins.ts writeOfficialMarketplace），
  // 原逻辑落到下面的 `typeof source === "string"` 分支，把 "filesystem" 当相对路径解析后抛
  // "Unsupported or missing plugin source: filesystem"，导致市场详情页对内置插件枚举不出组件。
  // 这类插件已落盘在 cachePath（缺失时按 cache/<marketplace>/<name>/<version> 兜底），直接定位即可。
  if (source === "filesystem" || source === "sea") {
    const cachePath = input.entry.cachePath;
    if (cachePath && directoryExists(cachePath)) return { path: cachePath };
    const computed = getPluginCacheDir(
      input.storageRoot,
      input.marketplace,
      input.entry.name,
      input.entry.version ?? DEFAULT_VERSION,
    );
    if (directoryExists(computed)) return { path: computed };
    throw new Error(
      `Bundled plugin cache directory missing: ${input.entry.name}@${input.marketplace}`,
    );
  }
  if (typeof source === "string") {
    const local = resolveInside(pluginBaseDir, source.replace(/^\.\//, ""));
    if (local && directoryExists(local)) return { path: local };
    const fallback = resolve(source);
    if (directoryExists(fallback)) return { path: fallback };
    throw new Error(`Unsupported or missing plugin source: ${source}`);
  }
  if (isRecord(source)) {
    const sourceKind = typeof source.source === "string" ? source.source : "";
    if (sourceKind === "directory") {
      const path = resolve(readRequiredPluginSourceString(source, "path", "directory path"));
      if (directoryExists(path)) return { path };
      throw new Error(`Plugin source directory does not exist: ${path}`);
    }
    if (sourceKind === "github") {
      const repo = readRequiredPluginSourceString(source, "repo", "GitHub repo");
      const url = `https://github.com/${repo}.git`;
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url,
      });
    }
    if (sourceKind === "git") {
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: readRequiredPluginSourceString(source, "url", "Git URL"),
      });
    }
    if (sourceKind === "url") {
      const url = readRequiredPluginSourceString(source, "url", "URL");
      assertMarketplaceUrlAvailableInBuild(url);
      const sourceType = typeof source.type === "string" ? source.type : "";
      if (sourceType === "zip") {
        return resolveZipPluginSource({
          headers: readPluginSourceHeaders(source),
          path: readOptionalZipPluginSourcePath(source),
          sha256: readRequiredZipPluginSourceSha256(source),
          signal: input.signal,
          stripRoot: readOptionalZipPluginSourceStripRoot(source),
          url,
        });
      }
      if (sourceType && sourceType !== "git") {
        throw new UnsupportedPluginSourceError(`url:${sourceType}`);
      }
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url,
      });
    }
    if (sourceKind === "git-subdir") {
      return resolveRepositoryPluginSource({
        path: readRequiredPluginSourceString(source, "path", "git-subdir path"),
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: normalizeGitUrl(readRequiredPluginSourceString(source, "url", "git-subdir URL")),
      });
    }
    if (sourceKind === "npm" || sourceKind === "pip") {
      throw new UnsupportedPluginSourceError(sourceKind);
    }
    // 显式 object source 配置错误时不能降级到 marketplace 内同名目录，否则会安装错误来源。
    throw new Error(
      `Plugin source is invalid or unsupported for ${input.entry.name}@${input.marketplace}: ${sourceKind || "missing kind"}`,
    );
  }
  const localByName = join(pluginBaseDir, input.entry.name);
  if (directoryExists(localByName)) return { path: localByName };
  throw new Error(`Plugin source is not supported for ${input.entry.name}@${input.marketplace}`);
}

export function readPluginSourceSha(source: unknown): string | undefined {
  return readPluginSourceIdentityPin(source);
}

export function readPluginSourceIdentityPin(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  const zipSha256 = readZipPluginSourceSha256(source);
  if (zipSha256) return zipSha256;
  if (typeof source.sha === "string") return source.sha;

  // 兼容旧版及第三方 marketplace 的 source identity 写法。
  if (typeof source.commit === "string") return source.commit;
  return undefined;
}

export async function resolveGitPluginSource(input: {
  path?: string;
  ref?: string;
  signal?: AbortSignal;
  sha?: string;
  url: string;
}): Promise<ResolvedPluginSourceRoot> {
  const dir = await clonePluginSource(input.url, input.ref, input.sha, input.signal);
  const cleanup = async (): Promise<void> => {
    await rm(dir, { force: true, recursive: true });
  };
  if (!input.path) return { cleanup, path: dir };
  throwIfPluginOperationAborted(input.signal);
  const subdir = resolveInside(dir, input.path);
  if (!subdir || !directoryExists(subdir)) {
    const primaryError = new Error(`Plugin source subdirectory does not exist: ${input.path}`);
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
    throw appendPluginSourceCleanupError(primaryError, cleanupError);
  }
  return { cleanup, path: subdir };
}

export async function resolveRepositoryPluginSource(input: {
  path?: string;
  ref?: string;
  signal?: AbortSignal;
  sha?: string;
  url: string;
}): Promise<ResolvedPluginSourceRoot> {
  try {
    return await resolveGitHubArchiveSource({
      path: input.path,
      pin: input.sha ?? input.ref,
      signal: input.signal,
      url: input.url,
    });
  } catch (error) {
    if (!shouldFallbackGitHubArchiveToGit(error)) {
      throw createArchiveFetchError(input.url, error);
    }
  }
  return resolveGitPluginSource(input);
}

export async function clonePluginSource(
  url: string,
  ref: string | undefined,
  sha?: string,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-src-"));
  const args = ["clone"];
  if (!sha) args.push("--depth", "1");
  if (ref) args.push("--branch", ref);
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sha) await execGitCommand(["-C", dir, "checkout", sha], signal);
    return dir;
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

export function normalizeGitUrl(value: string): string {
  if (/^[^/]+\/[^/]+$/u.test(value) && !value.includes(":")) {
    return `https://github.com/${value}.git`;
  }
  return value;
}

export function resolveMarketplacePluginBaseDir(
  marketplaceDir: string,
  manifest: PluginMarketplaceManifest | null,
): string {
  const pluginRoot = manifest?.pluginRoot;
  if (!pluginRoot) return marketplaceDir;
  const resolved = resolveInside(marketplaceDir, pluginRoot);
  return resolved && directoryExists(resolved) ? resolved : marketplaceDir;
}

export async function ensureMarketplaceEntryManifest(input: {
  entry: PluginMarketplaceEntry;
  target: string;
}): Promise<void> {
  if (findPluginManifestPath(input.target)) return;
  if (input.entry.strict !== false) return;
  const manifestDir = join(input.target, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  await writeJsonFile(
    join(manifestDir, "plugin.json"),
    createManifestFromMarketplaceEntry(input.entry),
  );
}

export function assertZipPluginInstallRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
  marketplace: string,
): void {
  const loaded = readPluginManifestFromRoot(rootPath, entry);
  const pluginId = `${entry.name}@${marketplace}`;
  if (!loaded) {
    throw new Error(`Plugin manifest not found: ${pluginId}`);
  }
  if (loaded.manifest.name !== entry.name) {
    throw new Error(
      `Plugin manifest name '${loaded.manifest.name}' does not match marketplace entry '${entry.name}'`,
    );
  }
}

/**
 * 安装期的宿主版本门禁。manifest 不可读时交给既有 validate/runtime 路径处理，
 * 这里只负责「能读到声明就必须证明兼容」，避免把兼容性判断降级成静默放行。
 */
export function assertPluginInstallCompatibility(input: {
  appVersion: string;
  entry: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
}): void {
  let manifest: PluginManifest | null = null;
  try {
    manifest = readPluginManifestFromRoot(input.rootPath, input.entry)?.manifest ?? null;
  } catch {
    return;
  }
  if (!manifest) return;
  assertPluginAppVersionCompatible({
    appVersion: input.appVersion,
    manifest,
    pluginId: `${input.entry.name}@${input.marketplace}`,
  });
}

export async function writeMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await writeJsonFile(getMarketplaceManifestPath(storageRoot, marketplace), raw);
}

// 缓存路径段与安装记录的版本来源。优先取插件落盘 plugin.json 里的真实
// version（与加载器 readPluginManifestFromRoot/index.ts 展示版本同源），缺失时才回退到 marketplace
// 条目的 version，最后兜底 DEFAULT_VERSION。读取失败保持宽松回退，校验交给 validateMarketplacePlugin。
export function resolveInstalledPluginVersion(rootPath: string, entry: PluginMarketplaceEntry): string {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.version === "string" &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version;
      }
    } catch {
      // 落到下方回退：manifest 不可读/非法时不应中断安装，版本以条目或默认值兜底。
    }
  }
  return entry.version ?? DEFAULT_VERSION;
}
