import semver from "semver";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";


import type { PluginManifest } from "@zcode/contracts";



import { isRecord } from "./helpers.js";





import { activateDirectoryAtomically, recoverAtomicTargetSync, type AtomicDirectoryActivation } from "./atomic-directory.js";
import {
  resolveGitHubArchiveSource,
  shouldFallbackGitHubArchiveToGit,
} from "./github-archive-source.js";
import { createArchiveFetchError, createGitUnavailableError, isCommandUnavailableError } from "./source-errors.js";
import {
  DEFAULT_VERSION,
  GIT_CLONE_MAX_ATTEMPTS,
  GIT_CLONE_RETRY_DELAY_MS,
  GIT_COMMAND_TIMEOUT_MS,
  KNOWN_MARKETPLACES_FILE,
  MARKETPLACE_FILE,
  MARKETPLACE_NAME_PATTERN,
  MarketplaceRefreshFailure,
  PLUGIN_ICON_ASSETS_BASE_URL,
  PLUGIN_ICON_SOURCES_FILE,
  PLUGIN_ICON_SOURCES_URL,
  PLUGIN_NAME_PATTERN,
  PluginAppVersionConstraint,
  PluginCompatibilityError,
  PluginIconSourceRecord,
  PluginMarketplaceEntry,
  PluginMarketplaceManifest,
  ResolvedPluginSourceRoot,
  SOURCE_SHA256_PATTERN,
  buildMarketplaceGitEnv,
  createManifestFromMarketplaceEntry,
  delay,
  execFileAsync,
  findPluginManifestPath,
  getMarketplaceManifestPath,
  isRetryableGitCloneError,
  isSafePluginIconPath,
  normalizeDependencyRef,
  parseEntryStoreListing,
  readCompatibilityString,
  readEnginesRange,
  readJsonFileSync,
  requestMarketplaceJson,
  splitGitHubShorthand,
  throwIfPluginOperationAborted,
  writeJsonFile,
} from "./marketplace-types.js";

// Плагин-маркетплейс: primitives. Вынесено из marketplace.ts по лимиту строк.

export function resolvePluginAppVersionConstraints(
  manifest: PluginManifest,
): PluginAppVersionConstraint[] {
  const constraints: PluginAppVersionConstraint[] = [];

  const minAppVersion = readCompatibilityString(manifest.minAppVersion);
  if (minAppVersion) {
    const version = semver.valid(minAppVersion);
    if (!version) {
      throw new PluginCompatibilityError(
        `Plugin manifest has an invalid minAppVersion: ${minAppVersion}`,
      );
    }
    constraints.push({ label: `minAppVersion ${minAppVersion}`, range: `>=${version}` });
  }

  const enginesRange = readEnginesRange(manifest.engines);
  if (enginesRange) {
    if (!semver.validRange(enginesRange)) {
      throw new PluginCompatibilityError(
        `Plugin manifest has an invalid engines.zcode range: ${enginesRange}`,
      );
    }
    constraints.push({ label: `engines.zcode ${enginesRange}`, range: enginesRange });
  }

  return constraints;
}

/**
 * 校验当前内核版本是否满足 manifest 声明；不满足或声明非法时抛
 * {@link PluginCompatibilityError}（diagnostic code: `plugin_incompatible_app_version`）。
 */
export function assertPluginAppVersionCompatible(input: {
  appVersion: string;
  manifest: PluginManifest;
  pluginId: string;
}): void {
  const constraints = resolvePluginAppVersionConstraints(input.manifest);
  if (constraints.length === 0) return;

  const appVersion = semver.valid(input.appVersion);
  if (!appVersion) {
    // 内核版本本身不可解析时不能静默放行，否则声明形同虚设。
    throw new PluginCompatibilityError(
      `Cannot verify plugin ${input.pluginId} compatibility against ZCode version ${input.appVersion}`,
    );
  }

  for (const constraint of constraints) {
    if (!semver.satisfies(appVersion, constraint.range)) {
      throw new PluginCompatibilityError(
        `Plugin ${input.pluginId} requires ZCode ${constraint.range} ` +
          `(declared ${constraint.label}); current ZCode version is ${input.appVersion}`,
      );
    }
  }
}

export type MarketplaceSource =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string }
  | { hostPattern: string; source: "hostPattern" }
  | { pathPattern: string; source: "pathPattern" }
  | { source: "settings"; marketplace: PluginMarketplaceManifest };

export interface KnownMarketplaceRecord {
  id: string;
  source: MarketplaceSource;
  name: string;
  description?: string;
  addedAt: string;
  lastUpdated?: string;
  lastRefreshFailure?: MarketplaceRefreshFailure;
  pluginCount: number;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface LoadMarketplaceResult {
  cleanup?: () => Promise<void>;
  manifest: PluginMarketplaceManifest;
  sourceRoot?: string;
}

export function loadKnownMarketplacesSync(storageRoot: string): KnownMarketplaceRecord[] {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE));
  if (!isRecord(parsed)) return [];
  const value = parsed.marketplaces;
  if (Array.isArray(value)) return value.filter(isKnownMarketplaceRecord);
  if (isRecord(value)) return Object.values(value).filter(isKnownMarketplaceRecord);
  return [];
}

export function parsePluginIconSources(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const icon = typeof item.icon === "string" ? item.icon.trim() : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
    const sha256 = typeof item.sha256 === "string" ? item.sha256 : undefined;
    if (!PLUGIN_NAME_PATTERN.test(name) || !isSafePluginIconPath(icon)) continue;
    if (mimeType !== undefined && mimeType !== "image/png") continue;
    if (sha256 !== undefined && !SOURCE_SHA256_PATTERN.test(sha256)) continue;
    result.set(name, new URL(icon, PLUGIN_ICON_ASSETS_BASE_URL).href);
  }
  return result;
}

export async function loadClaudePluginIconSources(
  storageRoot: string,
  operationSignal?: AbortSignal,
): Promise<Map<string, string>> {
  const cachePath = join(storageRoot, PLUGIN_ICON_SOURCES_FILE);
  const cached = (): Map<string, string> => parsePluginIconSources(readJsonFileSync(cachePath));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  operationSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await requestMarketplaceJson(
      PLUGIN_ICON_SOURCES_URL,
      undefined,
      controller.signal,
      10_000,
    );
    const value = response;
    const parsed = parsePluginIconSources(value);
    if (parsed.size === 0) return cached();
    // 缓存只保留产品需要的字段，不落盘素材源机器路径等 provenance 信息。
    const sanitized: PluginIconSourceRecord[] = [...parsed.entries()].map(([name, iconUrl]) => ({
      name,
      icon: new URL(iconUrl).pathname.slice(new URL(PLUGIN_ICON_ASSETS_BASE_URL).pathname.length),
      mimeType: "image/png",
    }));
    try {
      await writeJsonFile(cachePath, sanitized);
    } catch {
      // 图标缓存写入失败不影响本次 marketplace 主数据刷新。
    }
    return parsed;
  } catch {
    return cached();
  } finally {
    clearTimeout(timeout);
    operationSignal?.removeEventListener("abort", abort);
  }
}

export function loadMarketplaceManifestSync(
  storageRoot: string,
  marketplace: string,
): PluginMarketplaceManifest | null {
  const manifestPath = getMarketplaceManifestPath(storageRoot, marketplace);
  // 崩溃残留先恢复；若 writer 仍活跃，则在权威 known state 落盘前读 backup，
  // 落盘后读新 target，避免 overview 看见跨代 manifest/summary。
  const readableDirectory = recoverAtomicTargetSync(dirname(manifestPath));
  const parsed = readJsonFileSync(join(readableDirectory, basename(manifestPath)));
  return parseMarketplaceManifest(parsed);
}

export async function resolveRepositoryMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<ResolvedPluginSourceRoot> {
  // sparsePaths 是既有 MarketplaceSource 契约。Archive 需要先下载整仓，
  // 会让原本能 sparse clone 的大仓库因下载上限失败；在 Archive 尚未实现等价投影前，
  // 显式保留系统 Git 的 sparse checkout 路由。
  if (!sparsePaths?.length) {
    try {
      return await resolveGitHubArchiveSource({ pin: ref, signal, url });
    } catch (error) {
      if (!shouldFallbackGitHubArchiveToGit(error)) {
        throw createArchiveFetchError(url, error);
      }
    }
  }
  const dir = await cloneMarketplaceSource(url, ref, sparsePaths, signal);
  return {
    cleanup: async () => {
      await rm(dir, { force: true, recursive: true });
    },
    path: dir,
  };
}

export async function cloneMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-marketplace-src-"));
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  if (sparsePaths?.length) args.push("--filter=blob:none", "--sparse");
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sparsePaths?.length) {
      await execGitCommand(["-C", dir, "sparse-checkout", "set", ...sparsePaths], signal);
    }
    return dir;
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
}

export async function execGitCloneWithRetry(
  args: string[],
  targetDir: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GIT_CLONE_MAX_ATTEMPTS; attempt += 1) {
    try {
      throwIfPluginOperationAborted(signal);
      if (attempt > 1) {
        await rm(targetDir, { force: true, recursive: true });
        await mkdir(targetDir, { recursive: true });
      }
      await execGitCommand(args, signal);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= GIT_CLONE_MAX_ATTEMPTS || !isRetryableGitCloneError(error)) {
        throw error;
      }
      // GitHub 偶发 RPC/recv timeout 会让官方 marketplace add 失败。
      // 仅对明确的网络型 clone 错误做短重试，避免掩盖权限、路径或仓库不存在等确定性错误。
      await delay(GIT_CLONE_RETRY_DELAY_MS * attempt, signal);
    }
  }
  throw lastError;
}

export async function execGitCommand(args: string[], signal?: AbortSignal): Promise<void> {
  throwIfPluginOperationAborted(signal);
  try {
    // 显式二进制覆盖既支持非标准 Git 安装位置，也让跨进程 E2E 能把 Git 指向不存在的
    // 绝对路径，真实证明 Archive 主链路不依赖开发机上偶然存在的 Git。
    const gitBinary = process.env.ZCODE_GIT_BINARY?.trim() || "git";
    await execFileAsync(gitBinary, args, {
      env: buildMarketplaceGitEnv(),
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 10,
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (isCommandUnavailableError(error)) {
      const source = args.find(
        (arg) => arg.includes("://") || arg.startsWith("git@") || arg.startsWith("git+"),
      );
      throw createGitUnavailableError(source ?? args.at(-1) ?? "Git operation");
    }
    throw error;
  }
  throwIfPluginOperationAborted(signal);
}

export async function stageMarketplaceDirectoryPlugins(
  sourceDir: string,
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  throwIfPluginOperationAborted(signal);
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    sourcePath: sourceDir,
    targetPath: targetDir,
  });
}

export async function stageMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  // URL/settings source 没有 sourceRoot；直接覆盖 manifest 时若写入期间
  // deadline 到达或 known state 落盘失败就无法回滚。prepare-only activation 让 manifest
  // 与 known_marketplaces.json 使用同一个 transactionId 提交，失败时继续读取上一代快照。
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    targetPath: targetDir,
  });
}

export async function writeKnownMarketplaces(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[],
): Promise<void> {
  await writeJsonFile(join(storageRoot, KNOWN_MARKETPLACES_FILE), {
    version: 1,
    marketplaces,
  });
}

export function writeKnownMarketplacesSync(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[],
): void {
  const path = join(storageRoot, KNOWN_MARKETPLACES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        marketplaces,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function defaultMarketplaceSourceFromString(source: string): MarketplaceSource {
  const trimmed = source.trim();
  if (/^[^/]+\/[^/]+(?:[#@].+)?$/u.test(trimmed) && !trimmed.includes(":")) {
    const { ref, url } = splitGitHubShorthand(trimmed);
    return ref ? { source: "github", repo: url, ref } : { source: "github", repo: url };
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { source: "url", url: trimmed };
  }
  return { source: "url", url: trimmed };
}

export function parseRequiredMarketplaceManifest(value: unknown): PluginMarketplaceManifest {
  const parsed = parseMarketplaceManifest(value);
  if (!parsed) throw new Error("Marketplace manifest is invalid");
  return parsed;
}

export function parseMarketplaceManifest(value: unknown): PluginMarketplaceManifest | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!MARKETPLACE_NAME_PATTERN.test(name)) return null;
  const rawPlugins = value.plugins;
  const pluginEntries = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) =>
          isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName },
        )
      : [];
  return normalizeMarketplaceManifest({
    ...value,
    name,
    plugins: pluginEntries,
  });
}

export function normalizeMarketplaceManifest(
  value: PluginMarketplaceManifest | Record<string, unknown>,
): PluginMarketplaceManifest {
  if (isPluginMarketplaceManifest(value)) return value;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const plugins = Array.isArray(value.plugins)
    ? value.plugins
        .filter(isRecord)
        .map((entry): PluginMarketplaceEntry | null => {
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          if (name.length === 0) return null;
          const dependencies = Array.isArray(entry.dependencies)
            ? entry.dependencies
                .map(normalizeDependencyRef)
                .filter((item): item is string => item !== null)
            : undefined;
          const tags = Array.isArray(entry.tags)
            ? entry.tags.filter((item): item is string => typeof item === "string")
            : undefined;
          const listing = parseEntryStoreListing(entry);
          return {
            name,
            ...(typeof entry.category === "string" ? { category: entry.category } : {}),
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            ...(typeof entry.version === "string" ? { version: entry.version } : {}),
            ...(entry.source !== undefined ? { source: entry.source } : {}),
            ...(typeof entry.cachePath === "string" ? { cachePath: entry.cachePath } : {}),
            ...(dependencies ? { dependencies } : {}),
            ...(typeof entry.strict === "boolean" ? { strict: entry.strict } : {}),
            ...(tags ? { tags } : {}),
            ...(listing ? { listing } : {}),
            raw: entry,
          };
        })
        .filter((entry): entry is PluginMarketplaceEntry => entry !== null)
    : [];
  const allowCrossMarketplaceDependenciesOn = Array.isArray(
    value.allowCrossMarketplaceDependenciesOn,
  )
    ? value.allowCrossMarketplaceDependenciesOn.filter(
        (item): item is string => typeof item === "string",
      )
    : undefined;
  // 目录顶层的 Featured 策展名单：仅接受非空字符串数组，去掉空白项。
  const featured = Array.isArray(value.featured)
    ? value.featured.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  return {
    name: String(value.name),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : typeof metadata.description === "string"
        ? { description: metadata.description }
        : {}),
    plugins,
    ...(allowCrossMarketplaceDependenciesOn ? { allowCrossMarketplaceDependenciesOn } : {}),
    ...(typeof metadata.pluginRoot === "string" ? { pluginRoot: metadata.pluginRoot } : {}),
    ...(featured && featured.length > 0 ? { featured } : {}),
    raw: value,
  };
}

export function readPluginManifestFromRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
): { manifest: PluginManifest; manifestPath?: string } | null {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Plugin manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      manifest: {
        ...parsed,
        name,
        version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
      } as PluginManifest,
      manifestPath,
    };
  }
  if (entry.strict === false) {
    const rawManifest = createManifestFromMarketplaceEntry(entry);
    return {
      manifest: rawManifest as unknown as PluginManifest,
    };
  }
  return null;
}

export function isPluginMarketplaceManifest(value: unknown): value is PluginMarketplaceManifest {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.plugins) &&
    isRecord(value.raw)
  );
}

export function isKnownMarketplaceRecord(value: unknown): value is KnownMarketplaceRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.pluginCount === "number" &&
    isRecord(value.source)
  );
}
