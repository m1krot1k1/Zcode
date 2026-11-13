import { readFileSync } from "node:fs";


import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginDiagnostic,
  PluginDiagnosticCode,
  PluginManifest,
  PluginStoreListing,
} from "@zcode/contracts";

import { isZCodeOfficialPluginCdnUrl, sanitizeZCodeRuntimeEnv, ZCODE_OFFLINE_PREVIEW } from "@zcode/shared";

import { fileExists, isRecord, resolveInside, sanitizePluginId } from "./helpers.js";
import { type PluginComponentGroup } from "./plugin-components.js";
import { applyNetworkEgressEnv } from "../network/subprocess-env.js";
import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";


import { recoverAtomicTargetSync, writeFileAtomically, type AtomicDirectoryActivation } from "./atomic-directory.js";



// Плагин-маркетплейс: типы, константы и низкоуровневые утилиты.
// Вынесено из marketplace.ts по лимиту строк.

// ============================================================
// 插件 manifest 的宿主版本兼容门禁
//
// 背景：`plugin.json` 之前没有任何内核版本声明，旧插件可以在不兼容的新内核上安装成功，
// 直到 runtime 发现组件/协议异常才失败。这里在安装与校验阶段 fail-closed：
// 声明了 `minAppVersion` 或 `engines.zcode` 但当前内核不满足时直接拒绝，而不是装完再降级。
//
// 语义：
// - `minAppVersion` 是纯 semver 版本，表示最低可运行内核版本（等价于 `>=x`）。
// - `engines.zcode` / 字符串简写 `engines` 是 semver range（`>=0.17.0`、`^0.17.0` 等）。
// - 两个字段同时出现时都要满足；字段缺省表示不限制，保持旧目录完全兼容。
// - 声明本身非法（非 semver / 不通用的 range）同样 fail-closed：无法证明兼容就不安装。
// ============================================================

export class PluginCompatibilityError extends Error {
  readonly diagnosticCode: PluginDiagnosticCode = "plugin_incompatible_app_version";

  constructor(message: string) {
    super(message);
    this.name = "PluginCompatibilityError";
  }
}

export function getPluginCompatibilityDiagnosticCode(
  error: unknown,
): PluginDiagnosticCode | undefined {
  return error instanceof PluginCompatibilityError ? error.diagnosticCode : undefined;
}

export interface PluginAppVersionConstraint {
  /** 用于错误信息的原始声明，例如 `minAppVersion 9.0.0`。 */
  label: string;
  range: string;
}

export function readCompatibilityString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readEnginesRange(engines: PluginManifest["engines"]): string | undefined {
  if (engines === undefined) return undefined;
  if (typeof engines === "string") {
    const trimmed = readCompatibilityString(engines);
    if (!trimmed) {
      throw new PluginCompatibilityError("Plugin manifest has an empty engines declaration");
    }
    return trimmed;
  }
  if (typeof engines !== "object" || engines === null || Array.isArray(engines)) {
    throw new PluginCompatibilityError("Plugin manifest engines must be a string or object");
  }
  const zcode = (engines as { zcode?: unknown }).zcode;
  if (zcode === undefined) return undefined;
  const trimmed = readCompatibilityString(zcode);
  if (!trimmed) {
    throw new PluginCompatibilityError("Plugin manifest has an empty engines.zcode declaration");
  }
  return trimmed;
}

export const execFileAsync = promisify(execFile);

export const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";

export const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

export const MARKETPLACE_FILE = "marketplace.json";

export const CLAUDE_OFFICIAL_MARKETPLACE = "claude-plugins-official";

export const PLUGIN_ICON_SOURCES_FILE = "icon-sources.json";

export const PLUGIN_ICON_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets/";

export const PLUGIN_ICON_SOURCES_URL = `${PLUGIN_ICON_ASSETS_BASE_URL}${PLUGIN_ICON_SOURCES_FILE}`;

export const MARKETPLACE_JSON_MAX_BYTES = 10 * 1024 * 1024;

export const MARKETPLACE_JSON_MAX_REDIRECTS = 5;

export const MARKETPLACE_JSON_TIMEOUT_MS = 180_000;

export const claudeIconMigrationAttempts = new Set<string>();

export const CLAUDE_MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

export const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");

export const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");

export const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");

export const DEFAULT_VERSION = "0.0.0";

export const GIT_CLONE_MAX_ATTEMPTS = 3;

export const GIT_COMMAND_TIMEOUT_MS = 90_000;

export const GIT_CLONE_RETRY_DELAY_MS = 1_000;

export const CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS = 30_000;

export const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const SOURCE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const UNSUPPORTED_MANIFEST_FIELDS = [
  "channels",
  "lspServers",
  "outputStyles",
  "settings",
] as const;

export interface PluginMarketplaceEntry {
  name: string;
  category?: string;
  description?: string;
  version?: string;
  source?: unknown;
  // 内置 official 插件 seed 时写入的缓存目录绝对路径（source 为 "filesystem"/"sea"）。
  // describe/解析时据此直接定位已落盘的插件根目录，无需把 source 当路径解析。
  cachePath?: string;
  dependencies?: string[];
  strict?: boolean;
  tags?: string[];
  // 商店信息（displayName/icon/hero/示例提示词/链接等展示元数据），从条目 raw 解析；
  // 全部可选，见 contracts PluginStoreListing。
  listing?: PluginStoreListing;
  raw: Record<string, unknown>;
}

export interface PluginMarketplaceManifest {
  name: string;
  description?: string;
  plugins: PluginMarketplaceEntry[];
  allowCrossMarketplaceDependenciesOn?: string[];
  pluginRoot?: string;
  // 商店「公开」分段 Featured 区的策展名单（插件 name，按序）；由目录 JSON 顶层 featured 字段远程控制。
  featured?: string[];
  raw: Record<string, unknown>;
}

export interface MarketplaceRefreshFailure {
  code: PluginDiagnostic["code"];
  failedAt: string;
  message: string;
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  installPath: string;
  installedAt: string;
  updatedAt?: string;
  scope: "user" | "workspace";
  dependencies?: string[];
  source?: unknown;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface PluginIconSourceRecord {
  name: string;
  icon: string;
  mimeType?: string;
  sha256?: string;
}

export interface InstalledPluginsState {
  version: 1;
  plugins: InstalledPluginRecord[];
}

export interface MarketplaceInstallResult {
  closure: string[];
  installed: InstalledPluginRecord[];
}

export interface PluginValidationDiagnostic {
  code: PluginDiagnostic["code"];
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnostic["severity"];
}

// 组件枚举的类型定义在 plugin-components.ts；这里再导出，保持 adapter barrel 的对外契约稳定。
export type {
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
} from "./plugin-components.js";

export interface DescribeMarketplacePluginResult {
  components: PluginComponentGroup[];
  diagnostics: PluginValidationDiagnostic[];
  // 插件包内 plugin.json 的展示性回退字段（作者/主页/版本）；商店信息缺失时详情页信息区用它兜底。
  metadata?: PluginManifestDisplayMetadata;
}

export interface PluginManifestDisplayMetadata {
  author?: string;
  authorUrl?: string;
  homepage?: string;
  version?: string;
}

export function buildMarketplaceGitEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = sanitizeZCodeRuntimeEnv(sourceEnv);
  // marketplace 安装会启动 Git 子进程，不能只依赖父进程继承的 shell 代理。
  // 这里统一从 ZCode 显式网络环境恢复 HTTP(S)/NO_PROXY/CA，避免安装按钮卡到协议超时。
  return applyNetworkEgressEnv(env, { sourceEnv });
}

export function throwIfPluginOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createPluginOperationCancelledError();
  }
}

export function createPluginOperationCancelledError(): Error {
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  return error;
}

export interface MarketplaceOperationSignalScope {
  cleanup: () => void;
  signal?: AbortSignal;
  timedOut: boolean;
  timeoutError: Error;
}

export interface KnownMarketplaceActivation {
  finalize: () => void;
  rollback: () => Promise<void>;
}

// Claude 官方市场只提供可选目录，外部网络不可达时必须中止底层请求，不能拖住其他插件市场。
export function createMarketplaceOperationSignalScope(
  trustedId: string | undefined,
  externalSignal?: AbortSignal,
): MarketplaceOperationSignalScope {
  if (trustedId !== CLAUDE_OFFICIAL_MARKETPLACE) {
    return {
      cleanup: () => {},
      signal: externalSignal,
      timedOut: false,
      timeoutError: new Error("Marketplace operation timed out"),
    };
  }

  const controller = new AbortController();
  const timeoutError = new Error(
    `Claude marketplace refresh timed out after ${CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS / 1000} seconds`,
  );
  timeoutError.name = "TimeoutError";
  const scope: MarketplaceOperationSignalScope = {
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortExternal);
    },
    signal: controller.signal,
    timedOut: false,
    timeoutError,
  };
  const abortExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };
  const timeout = setTimeout(() => {
    scope.timedOut = true;
    controller.abort(timeoutError);
  }, CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS);

  if (externalSignal?.aborted) {
    abortExternal();
  } else {
    externalSignal?.addEventListener("abort", abortExternal, { once: true });
  }
  return scope;
}

export interface ResolvedPluginSourceRoot {
  cleanup?: () => Promise<void>;
  path: string;
}

export interface CachedMarketplacePluginResult {
  activation?: AtomicDirectoryActivation;
  record: InstalledPluginRecord;
}

export function applyClaudePluginIcons(
  manifest: Record<string, unknown>,
  iconByPluginName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!Array.isArray(manifest.plugins) || iconByPluginName.size === 0) return manifest;
  let changed = false;
  const plugins = manifest.plugins.map((plugin) => {
    if (!isRecord(plugin) || typeof plugin.name !== "string") return plugin;
    if (typeof plugin.icon === "string" && plugin.icon.trim().length > 0) return plugin;
    const icon = iconByPluginName.get(plugin.name);
    if (!icon) return plugin;
    changed = true;
    return { ...plugin, icon };
  });
  return changed ? { ...manifest, plugins } : manifest;
}

export function isSafePluginIconPath(icon: string): boolean {
  if (!icon.endsWith(".png") || icon.startsWith("/") || icon.includes("\\")) return false;
  const segments = icon.split("/");
  return segments.length >= 2 && segments.every((segment) => PLUGIN_NAME_PATTERN.test(segment));
}

export async function requestMarketplaceJson(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = MARKETPLACE_JSON_TIMEOUT_MS,
): Promise<unknown> {
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: MARKETPLACE_JSON_MAX_BYTES,
    timeoutMs,
  });
  let currentHeaders = headers;
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MARKETPLACE_JSON_MAX_REDIRECTS; redirectCount += 1) {
    assertMarketplaceUrlAvailableInBuild(currentUrl);
    const response = await client.request(
      {
        ...(currentHeaders ? { headers: currentHeaders } : {}),
        method: "GET",
        redirect: "manual",
        url: currentUrl,
      },
      { signal },
    );
    if (isMarketplaceJsonRedirectStatus(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Marketplace redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 代理/自定义 CA 分支的 http.request 不会执行 redirect:follow；
      // 这里统一有界跟随，并在跨 origin 时清理市场自定义 header，避免凭据泄露给 CDN。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch marketplace: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  }
  throw new Error(`Marketplace fetch exceeded redirect limit: ${url}`);
}

export function assertMarketplaceUrlAvailableInBuild(url: string): void {
  if (ZCODE_OFFLINE_PREVIEW && isZCodeOfficialPluginCdnUrl(url)) {
    throw new Error("Official ZCode plugin downloads are unavailable in the offline Preview build.");
  }
}

export function isMarketplaceJsonRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function getMarketplaceManifestPath(storageRoot: string, marketplace: string): string {
  return join(storageRoot, "marketplaces", sanitizePluginId(marketplace), MARKETPLACE_FILE);
}

export function readRequiredZipPluginSourceSha256(source: Record<string, unknown>): string {
  if (typeof source.sha256 === "string") return source.sha256;
  throw new Error("Plugin zip source sha256 is required");
}

export function readRequiredPluginSourceString(
  source: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Plugin ${label} source requires a non-empty ${field}`);
  }
  return value;
}

export function readOptionalZipPluginSourcePath(source: Record<string, unknown>): string | undefined {
  if (source.path === undefined) return undefined;
  if (typeof source.path === "string") return source.path;
  throw new Error("Plugin zip source path must be a string");
}

export function readOptionalZipPluginSourceStripRoot(
  source: Record<string, unknown>,
): boolean | undefined {
  if (source.stripRoot === undefined) return undefined;
  if (typeof source.stripRoot === "boolean") return source.stripRoot;
  throw new Error("Plugin zip source stripRoot must be a boolean");
}

export function readPluginSourceHeaders(
  source: Record<string, unknown>,
): Record<string, string> | undefined {
  if (source.headers === undefined) return undefined;
  if (!isRecord(source.headers)) {
    throw new Error("Plugin zip source headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source.headers)) {
    if (typeof value !== "string") {
      throw new Error(`Plugin zip source header must be a string: ${key}`);
    }
    headers[key] = value;
  }
  return headers;
}

export function createManifestFromMarketplaceEntry(
  entry: PluginMarketplaceEntry,
): Record<string, unknown> {
  const raw = { ...entry.raw };
  delete raw.source;
  delete raw.category;
  delete raw.tags;
  delete raw.strict;
  // 商店信息（Store Listing）是目录层展示元数据，不属于插件 manifest；
  // 合成 manifest 时剔除，避免污染 plugin.json 语义（author/homepage 是合法 manifest 字段，保留）。
  delete raw.displayName;
  delete raw.displayName_i18n;
  delete raw.description_i18n;
  delete raw.icon;
  delete raw.privacyPolicy;
  delete raw.termsOfService;
  delete raw.heroImage;
  delete raw.examplePrompts;
  delete raw.examplePrompts_i18n;
  delete raw.requiresPaidPlan;
  return {
    ...raw,
    name: entry.name,
    version: entry.version ?? DEFAULT_VERSION,
  };
}

export function isRetryableGitCloneError(error: unknown): boolean {
  const output = getErrorOutput(error);
  return /RPC failed|Operation timed out|Recv failure|expected flush|early EOF|remote end hung up|HTTP\/2 stream|Connection reset|ETIMEDOUT|ECONNRESET|network timeout/iu.test(
    output,
  );
}

export function getErrorOutput(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const chunks = [
    error instanceof Error ? error.message : "",
    typeof error.stdout === "string" ? error.stdout : "",
    typeof error.stderr === "string" ? error.stderr : "",
  ];
  return chunks.filter(Boolean).join("\n");
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(createPluginOperationCancelledError());
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = (): void => {
      cleanup();
      rejectDelay(createPluginOperationCancelledError());
    };
    timeout = setTimeout(() => {
      cleanup();
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

/**
 * 从目录条目解析可选的商店展示信息。兼容字符串或对象形式的 author、i18n map 和多值字段；
 * 解析不到有效内容时返回 undefined，避免给每个条目挂空对象。
 */
export function parseEntryStoreListing(
  entry: Record<string, unknown>,
): PluginStoreListing | undefined {
  const readString = (key: string): string | undefined => {
    const value = entry[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };
  const readStringMap = (key: string): Record<string, string> | undefined => {
    const value = entry[key];
    if (!isRecord(value)) return undefined;
    const map: Record<string, string> = {};
    for (const [locale, text] of Object.entries(value)) {
      if (typeof text === "string") map[locale] = text;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };
  const readStringListMap = (key: string): Record<string, string[]> | undefined => {
    const value = entry[key];
    if (!isRecord(value)) return undefined;
    const map: Record<string, string[]> = {};
    for (const [locale, list] of Object.entries(value)) {
      if (!Array.isArray(list)) continue;
      const items = list.filter((item): item is string => typeof item === "string");
      if (items.length > 0) map[locale] = items;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };

  const listing: PluginStoreListing = {};
  if (entry.publisherType === "official" || entry.publisherType === "community") {
    listing.publisherType = entry.publisherType;
  }
  const displayName = readString("displayName");
  if (displayName) listing.displayName = displayName;
  const displayNameI18n = readStringMap("displayName_i18n");
  if (displayNameI18n) listing.displayNameI18n = displayNameI18n;
  const descriptionI18n = readStringMap("description_i18n");
  if (descriptionI18n) listing.descriptionI18n = descriptionI18n;
  for (const key of [
    "icon",
    "category",
    "homepage",
    "privacyPolicy",
    "termsOfService",
    "heroImage",
  ] as const) {
    const value = readString(key);
    if (value) listing[key] = value;
  }
  const author = normalizeAuthorValue(entry.author);
  if (author?.name) listing.author = author.name;
  if (author?.url) listing.authorUrl = author.url;
  const examplePrompts = Array.isArray(entry.examplePrompts)
    ? entry.examplePrompts.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  if (examplePrompts && examplePrompts.length > 0) listing.examplePrompts = examplePrompts;
  const examplePromptsI18n = readStringListMap("examplePrompts_i18n");
  if (examplePromptsI18n) listing.examplePromptsI18n = examplePromptsI18n;
  // 付费套餐提示只认显式布尔 true；字符串 "true"、1 等歧义写法一律按无需套餐处理，
  // 避免目录写错就给免费插件挂上付费提示。
  if (entry.requiresPaidPlan === true) listing.requiresPaidPlan = true;
  return Object.keys(listing).length > 0 ? listing : undefined;
}

/** author 字段兼容 string 与 {name,url}（plugin.json 与目录条目共用此规则）。 */
export function normalizeAuthorValue(value: unknown): { name?: string; url?: string } | undefined {
  if (typeof value === "string") {
    const name = value.trim();
    return name.length > 0 ? { name } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!name && !url) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
  };
}

export function normalizeDependencyRef(value: unknown): string | null {
  if (typeof value === "string") return value.replace(/@\^[^@]*$/u, "");
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  const marketplace = typeof value.marketplace === "string" ? value.marketplace.trim() : "";
  return marketplace ? `${name}@${marketplace}` : name;
}

export function findMarketplaceManifestPath(rootPath: string, explicitPath?: string): string | null {
  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    CLAUDE_MARKETPLACE_FILE,
    MARKETPLACE_FILE,
  ];
  for (const candidate of candidates) {
    const path = resolveInside(rootPath, candidate);
    if (path && fileExists(path)) return path;
  }
  return null;
}

export function findPluginManifestPath(rootPath: string): string | null {
  for (const candidate of [ZCODE_MANIFEST_PATH, CLAUDE_MANIFEST_PATH, CODEX_MANIFEST_PATH]) {
    const path = join(rootPath, candidate);
    if (fileExists(path)) return path;
  }
  return null;
}

export class UnsupportedMarketplaceSourceError extends Error {
  constructor(source: string) {
    super(`Marketplace source is recognized but not supported in this runtime: ${source}`);
  }
}

export function readJsonFileSync(path: string): unknown {
  const readablePath = recoverAtomicTargetSync(path);
  try {
    return JSON.parse(readFileSync(readablePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function getPluginCacheDir(
  storageRoot: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  return join(
    storageRoot,
    "cache",
    sanitizePluginId(marketplace),
    sanitizePluginId(name),
    sanitizePluginId(version),
  );
}

export function parsePluginId(pluginId: string): { marketplace: string; name: string } {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) {
    throw new Error(`Plugin id must use <name>@<marketplace>: ${pluginId}`);
  }
  return {
    name: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1),
  };
}

export function qualifyDependency(dependency: string, marketplace: string): string {
  return dependency.includes("@") ? dependency : `${dependency}@${marketplace}`;
}

export function resolvePathInput(input: string): string | null {
  if (
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("/") ||
    input.startsWith("~") ||
    /^[a-zA-Z]:[/\\]/.test(input)
  ) {
    return input.startsWith("~") ? join(process.env.HOME ?? "", input.slice(1)) : resolve(input);
  }
  return null;
}

export function splitRef(input: string): { ref?: string; url: string } {
  const index = input.lastIndexOf("#");
  if (index < 0) return { url: input };
  return { url: input.slice(0, index), ref: input.slice(index + 1) };
}

export function splitGitHubShorthand(input: string): { ref?: string; url: string } {
  const hash = input.lastIndexOf("#");
  const at = input.lastIndexOf("@");
  const index = Math.max(hash, at);
  if (index <= 0) return { url: input };
  return { url: input.slice(0, index), ref: input.slice(index + 1) };
}

export function isGitSshUrl(input: string): boolean {
  return /^[a-zA-Z0-9._-]+@[^:]+:.+/.test(input);
}

export function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}
