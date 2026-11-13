
import {basename, dirname, isAbsolute, join, resolve, win32} from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createConfig, resolvePath, removeSuppressedBuiltinInFileConfig, type ConfigResult } from "@zcode/adapters/config";
import { addMarketplace, getPluginCompatibilityDiagnosticCode, getPluginSourceDiagnosticCode, loadKnownMarketplacesSync, loadMarketplaceManifestSync, parseEntryStoreListing, type InstalledPluginRecord, type KnownMarketplaceRecord, type MarketplaceSource, type PluginMarketplaceEntry } from "@zcode/adapters/plugins";
import type { PluginLoadOutcome, PluginMetadata, PluginStoreListing } from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, isOfficialMarketplaceId } from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, isZCodeCuaInternalFeatureEnabled } from "@zcode/shared";
import { resolveOfficialPluginRoots } from "./app/bundled-plugins.js";
import { OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME, OFFICIAL_PLUGIN_DEFINITIONS } from "./app/official-plugin-definitions.js";
import { getCliStorageRoot, getPluginStorageRoot } from "./app/paths.js";

import type {
  ResolveZCodePluginsOptions,
  RestoreBuiltinPluginOptions,
  UninstallZCodeMarketplacePluginOptions,
  ZCodeAvailablePluginData,
  ZCodeInstalledPluginData,
  ZCodeMarketplaceSummaryData,
} from "./plugins-types.js";

// Внутренние helpers плагин-фасада (контекст, селекторы, конвертеры, диагностика).
// Вынесены из plugins.ts по лимиту строк.

export function resolvePluginContext(options: ResolveZCodePluginsOptions): {
  configResult: ConfigResult;
  pluginStorageRoot: string;
  workingDirectory: string;
} {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    });
  const storageRoot = resolvePath(configResult.config.storage.dir);
  return {
    configResult,
    pluginStorageRoot:
      options.pluginStorageRoot ?? getPluginStorageRoot(getCliStorageRoot(storageRoot)),
    workingDirectory,
  };
}

export function resolveDeclaredMarketplaceSources(input: {
  configResult: ConfigResult;
}): Map<string, MarketplaceSource> {
  return new Map(
    Object.entries(input.configResult.config.plugins.extraKnownMarketplaces ?? {}).map(
      ([marketplaceId, declaration]) => {
        const baseDirectory = dirname(input.configResult.sources.plugins.paths.user);
        return [marketplaceId, resolveDeclaredMarketplaceSource(declaration.source, baseDirectory)];
      },
    ),
  );
}

export function resolveDeclaredMarketplaceSource(
  source: ConfigResult["config"]["plugins"]["extraKnownMarketplaces"][string]["source"],
  baseDirectory: string,
): MarketplaceSource {
  // User Marketplace 的相对路径按 User config 所在目录解析；配置读取不触碰 source，
  // 只有显式 refresh/install 才会真正读取、复制或联网。
  if (source.source === "file" || source.source === "directory") {
    return {
      ...source,
      path: isAbsolute(source.path) ? resolve(source.path) : resolve(baseDirectory, source.path),
    };
  }
  return source;
}

export function resolveEffectiveMarketplaceRecords(input: {
  configResult: ConfigResult;
  known: KnownMarketplaceRecord[];
  workingDirectory: string;
}): Array<{ record: KnownMarketplaceRecord; useCachedManifest: boolean }> {
  const declared = resolveDeclaredMarketplaceSources(input);
  const knownIds = new Set(input.known.map((record) => record.id));
  const records = input.known.map((record) => {
    const declarationSource = declared.get(record.id);
    if (!declarationSource) return { record, useCachedManifest: true };
    if (isDeepStrictEqual(record.source, declarationSource)) {
      return { record, useCachedManifest: true };
    }
    // 官方 marketplace id 是 Host 保留身份。Workspace 声明同 id 异 source
    // 只能产生诊断，不能把官方缓存投影替换成 pluginCount=0 的空目录。
    if (isOfficialMarketplaceId(record.id)) {
      return { record, useCachedManifest: true };
    }
    return {
      record: createDeclaredMarketplaceRecord(record.id, declarationSource),
      useCachedManifest: false,
    };
  });
  for (const [marketplaceId, source] of declared) {
    if (knownIds.has(marketplaceId)) continue;
    if (isOfficialMarketplaceId(marketplaceId)) continue;
    records.push({
      record: createDeclaredMarketplaceRecord(marketplaceId, source),
      useCachedManifest: false,
    });
  }
  return records;
}

export function resolveMarketplaceDeclarationDiagnostics(input: {
  configResult: ConfigResult;
  known: KnownMarketplaceRecord[];
  workingDirectory: string;
}): PluginLoadOutcome["diagnostics"] {
  const declared = resolveDeclaredMarketplaceSources(input);
  const knownById = new Map(input.known.map((record) => [record.id, record]));
  return [...declared.entries()].flatMap(([marketplaceId, source]) => {
    if (!isOfficialMarketplaceId(marketplaceId)) return [];
    const known = knownById.get(marketplaceId);
    if (known && isDeepStrictEqual(known.source, source)) return [];
    return [createReservedMarketplaceDeclarationDiagnostic(marketplaceId)];
  });
}

export function createDeclaredMarketplaceRecord(
  marketplaceId: string,
  source: MarketplaceSource,
): KnownMarketplaceRecord {
  return {
    id: marketplaceId,
    source,
    name: marketplaceId,
    addedAt: "",
    pluginCount: 0,
  };
}

export async function materializeDeclaredMarketplaceForExplicitAction(input: {
  abortSignal?: AbortSignal;
  configResult: ConfigResult;
  marketplaceId: string;
  pluginStorageRoot: string;
  workingDirectory: string;
}): Promise<void> {
  const source = resolveDeclaredMarketplaceSources(input).get(input.marketplaceId);
  if (!source) return;
  const known = loadKnownMarketplacesSync(input.pluginStorageRoot).find(
    (record) => record.id === input.marketplaceId,
  );
  if (known && !isDeepStrictEqual(known.source, source)) {
    throw new MarketplaceSourceRepointError(
      createMarketplaceSourceRepointDiagnostic(input.marketplaceId).message,
    );
  }
  if (known && loadMarketplaceManifestSync(input.pluginStorageRoot, input.marketplaceId)) {
    return;
  }
  await addMarketplace({
    expectedId: input.marketplaceId,
    signal: input.abortSignal,
    source,
    storageRoot: input.pluginStorageRoot,
  });
}

export function resolvePluginSelector(selector: string, plugins: PluginMetadata[]): PluginMetadata {
  const normalized = selector.trim();
  const exact = plugins.find((plugin) => plugin.id === normalized);
  if (exact) return exact;

  const nameMatches = plugins.filter((plugin) => plugin.name === normalized);
  if (nameMatches.length === 1 && nameMatches[0]) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new Error(`Plugin name is ambiguous, use full plugin id: ${normalized}`);
  }
  throw new Error(`Plugin not found: ${normalized}`);
}

export function toMarketplaceSummaryData(
  record: KnownMarketplaceRecord,
  featured?: string[],
  pluginCount?: number,
): ZCodeMarketplaceSummaryData {
  return {
    id: record.id,
    name: record.name,
    source: record.source as unknown as Record<string, unknown>,
    ...(record.description ? { description: record.description } : {}),
    ...(record.lastUpdated ? { lastUpdated: record.lastUpdated } : {}),
    pluginCount: pluginCount ?? record.pluginCount,
    isOfficial: isOfficialMarketplaceId(record.id),
    ...(record.lastRefreshFailure
      ? {
          refreshFailure: {
            code: record.lastRefreshFailure.code,
            failedAt: record.lastRefreshFailure.failedAt,
            message: record.lastRefreshFailure.message,
          },
        }
      : {}),
    ...(featured && featured.length > 0 ? { featured } : {}),
  };
}

export function toAvailablePluginData(
  entry: PluginMarketplaceEntry,
  marketplace: string,
  installedIds: ReadonlySet<string>,
): ZCodeAvailablePluginData {
  const id = `${entry.name}@${marketplace}`;
  return {
    id,
    name: entry.name,
    marketplace,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.version ? { version: entry.version } : {}),
    installed: installedIds.has(id),
    componentTypes: inferComponentTypes(entry.raw),
    ...(entry.listing ? { listing: entry.listing } : {}),
  };
}

export function toInstalledPluginData(
  record: InstalledPluginRecord,
  enabled: boolean,
  loaded?: PluginMetadata,
): ZCodeInstalledPluginData {
  return {
    id: record.id,
    name: record.name,
    marketplace: record.marketplace,
    ...((loaded?.description ?? undefined) ? { description: loaded?.description } : {}),
    version: loaded?.version ?? record.version,
    enabled,
    scope: record.scope,
    installPath: record.installPath,
    installedAt: record.installedAt,
    componentTypes: loaded ? inferComponentTypesFromMetadata(loaded) : undefined,
    ...(loaded ? { hookDetails: loaded.hookDetails } : {}),
  };
}

export function inferComponentTypes(raw: Record<string, unknown>): string[] {
  const types: string[] = [];
  if ("agents" in raw) types.push("agent");
  if ("commands" in raw) types.push("command");
  if ("skills" in raw) types.push("skill");
  if ("hooks" in raw) types.push("hook");
  if ("mcpServers" in raw) types.push("mcp");
  if ("lspServers" in raw) types.push("lsp");
  if (Array.isArray(raw.componentTypes) && raw.componentTypes.includes("ui")) types.push("ui");
  return types;
}

export function inferComponentTypesFromMetadata(plugin: PluginMetadata): string[] {
  const types: string[] = [];
  // agent 由约定目录枚举，不一定出现在 manifest；只看 manifest 会让已安装列表漏报子代理能力。
  if (plugin.components.some((group) => group.kind === "agent" && group.items.length > 0)) {
    types.push("agent");
  }
  if (plugin.commandRootCount > 0) types.push("command");
  if (plugin.skillRootCount > 0 || plugin.skillCount > 0) types.push("skill");
  if (plugin.declaredMcpServerNames.length > 0 || plugin.mcpServerNames.length > 0) {
    types.push("mcp");
  }
  if (plugin.hookDetails.length > 0) types.push("hook");
  if (plugin.uiSurfaces?.length) types.push("ui");
  return types;
}

export function resolvePluginIdForMutation(options: UninstallZCodeMarketplacePluginOptions): string {
  if (options.pluginId) return options.pluginId;
  if (options.pluginName && options.marketplace) {
    return `${options.pluginName}@${options.marketplace}`;
  }
  throw new Error("pluginId or pluginName + marketplace is required");
}

export function normalizePluginOptions(
  options: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

export function normalizePluginOptionKeys(keys: string[] | undefined): string[] {
  return [...new Set((keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0))];
}

export function resolvePluginConfigPath(
  options: ResolveZCodePluginsOptions & { scope?: "user" | "workspace" },
  configResult: ConfigResult,
  workingDirectory: string,
): string {
  if (options.scope !== "workspace") {
    return configResult.sources.user.path;
  }

  // Workspace Plugin 配置固定落在当前 `<workspace>/.zcode/config.json`。嵌套 workspace
  // 可能同时发现仓库根与自身的配置，读取端 innermost 优先；写入端也必须锁定当前
  // workspace，不能用 project discovery 的第一个 outermost 文件。
  const workspaceConfigPath = join(workingDirectory, ".zcode", "config.json");
  const projectConfigPaths = [
    ...(options.projectConfigPath ? [options.projectConfigPath] : []),
    ...configResult.sources.project.paths,
  ];
  const existingWorkspaceConfig = projectConfigPaths.find(
    (path) =>
      normalizePluginConfigPathForComparison(path) ===
      normalizePluginConfigPathForComparison(workspaceConfigPath),
  );
  if (existingWorkspaceConfig) return existingWorkspaceConfig;
  return workspaceConfigPath;
}

export function normalizePluginConfigPathForComparison(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolvedPath = platform === "win32" ? win32.resolve(path) : resolve(path);
  return platform === "win32" ? resolvedPath.replaceAll("\\", "/").toLowerCase() : resolvedPath;
}

export function isWorkspacePluginConfigPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return (
      win32.basename(path).toLowerCase() === "config.json" &&
      win32.basename(win32.dirname(path)).toLowerCase() === ".zcode"
    );
  }
  return basename(path) === "config.json" && basename(dirname(path)) === ".zcode";
}

export function resolveMarketplaceRefreshTargetIds(input: {
  declaredIds: Iterable<string>;
  knownIds: Iterable<string>;
  marketplace?: string;
}): string[] {
  if (input.marketplace) return [input.marketplace];
  // refresh-all 只刷新已经物化的 Host known records；项目声明必须逐个显式物化，
  // 避免一次全量刷新把任意 Workspace 声明写进全局 marketplace 状态。
  return [...new Set(input.knownIds)];
}

export function createMarketplaceSourceRepointDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_invalid",
    message:
      `Workspace marketplace declaration "${marketplaceId}" conflicts with an existing Host source. ` +
      "Remove the existing marketplace or use a different marketplace id before materializing it.",
    pluginId: marketplaceId,
    severity: "error",
  };
}

export function createReservedMarketplaceDeclarationDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_declaration_reserved",
    message:
      `Workspace marketplace declaration "${marketplaceId}" uses a reserved official id and was ignored. ` +
      "Use a different marketplace id for project declarations.",
    pluginId: marketplaceId,
    severity: "warning",
  };
}

class MarketplaceSourceRepointError extends Error {}

export function toPluginDiagnostic(diagnostic: {
  code: string;
  message: string;
  pluginId?: string;
  severity: "warning" | "error";
}): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: diagnostic.code as PluginLoadOutcome["diagnostics"][number]["code"],
    message: diagnostic.message,
    ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
    severity: diagnostic.severity,
  };
}

export function toMarketplaceInstallDiagnostic(
  error: unknown,
  pluginId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof MarketplaceSourceRepointError) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_invalid",
      message,
      pluginId,
      severity: "error",
    });
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return toPluginDiagnostic({
      code: sourceCode,
      message,
      pluginId,
      severity: "error",
    });
  }
  const compatibilityCode = getPluginCompatibilityDiagnosticCode(error);
  if (compatibilityCode) {
    return toPluginDiagnostic({
      code: compatibilityCode,
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.startsWith("Plugin not found:")) {
    return toPluginDiagnostic({
      code: "plugin_not_found",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("Cross-marketplace dependency")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cross_marketplace",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("dependency cycle")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cycle",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return toPluginDiagnostic({
      code: "plugin_dependency_missing",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("source is recognized but not supported")) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_source_unsupported",
      message,
      pluginId,
      severity: "error",
    });
  }
  return toPluginDiagnostic({
    code: "plugin_marketplace_invalid",
    message,
    pluginId,
    severity: "error",
  });
}

export function toMarketplaceRefreshDiagnostic(
  error: unknown,
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  return toPluginDiagnostic({
    code: getPluginSourceDiagnosticCode(error) ?? "plugin_marketplace_invalid",
    message,
    pluginId: marketplaceId,
    severity: "error",
  });
}

export async function restoreBuiltinPluginCore(options: RestoreBuiltinPluginOptions): Promise<void> {
  const zcodeCuaPluginId = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
  if (
    options.pluginId === zcodeCuaPluginId &&
    !isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)
  ) {
    // overview 虽然隐藏了恢复入口，但协议调用仍可绕过 UI 写用户配置。
    // 功能开关关闭时在写盘前失败，确保用户配置与插件缓存都保持零痕迹。
    throw new Error("computer-use built-in plugin requires ZCODE_CUA_PRODUCT_HELPER to be enabled");
  }
  const { configResult } = resolvePluginContext(options);
  await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, options.pluginId);
  // 重读磁盘上的最新 config（patch 后），确保抑制集合不再包含刚恢复的 id；
  // 不能复用 patch 前可能被传入的 configResult。
  const fresh = resolvePluginContext({ ...options, configResult: undefined });
  // 立即重新 seed，让插件即刻可用，无需等待下一次 resolve。
  resolveOfficialPluginRoots({
    storageRoot: fresh.pluginStorageRoot,
    suppressedBuiltins: new Set(fresh.configResult.config.plugins.suppressedBuiltins),
  });
}

export function applySparsePaths(
  source: MarketplaceSource,
  sparsePaths: string[] | undefined,
): MarketplaceSource {
  const paths = (sparsePaths ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (paths.length === 0) return source;
  if (source.source !== "git" && source.source !== "github") {
    throw new Error("--sparse only applies to git or GitHub marketplace sources");
  }
  return { ...source, sparsePaths: paths };
}

export function loadPluginListingsById(storageRoot: string): Record<string, PluginStoreListing> {
  const listings = new Map<string, PluginStoreListing>();

  // 没有 marketplace 快照时，bundled official definition 仍是内置插件 listing 的安全回退。
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (!definition.listing) continue;
    const listing = parseEntryStoreListing({ name: definition.name, ...definition.listing });
    if (listing) {
      listings.set(`${definition.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`, listing);
    }
  }

  // 目录条目按完整 `${name}@${marketplace}` 关联；同名插件不会互相覆盖。
  for (const marketplace of loadKnownMarketplacesSync(storageRoot)) {
    const manifest = loadMarketplaceManifestSync(storageRoot, marketplace.id);
    for (const entry of manifest?.plugins ?? []) {
      if (entry.listing) listings.set(`${entry.name}@${marketplace.id}`, entry.listing);
    }
  }

  return Object.fromEntries(listings);
}

export function countVisibleMarketplacePlugins(
  marketplaceId: string,
  plugins: readonly { name: string }[] | undefined,
): number | undefined {
  if (!plugins) return undefined;
  if (marketplaceId !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return plugins.length;
  return plugins.filter((entry) => entry.name !== OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME).length;
}
