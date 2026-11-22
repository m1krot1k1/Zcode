import { existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";

import { basename, join, resolve } from "node:path";




import { ZCODE_OFFLINE_PREVIEW, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, ZCODE_VERSION } from "@zcode/shared";

import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort, directoryExists, isRecord, sanitizePluginId } from "./helpers.js";





import { recoverAtomicTargetSync, type AtomicDirectoryActivation } from "./atomic-directory.js";


import {
  DEFAULT_VERSION,
  DescribeMarketplacePluginResult,
  INSTALLED_PLUGINS_FILE,
  InstalledPluginRecord,
  InstalledPluginsState,
  MarketplaceInstallResult,
  MarketplaceRefreshFailure,
  PluginMarketplaceManifest,
  PluginValidationDiagnostic,
  ResolvedPluginSourceRoot,
  findMarketplaceManifestPath,
  findPluginManifestPath,
  getMarketplaceManifestPath,
  getPluginCacheDir,
  parsePluginId,
  readJsonFileSync,
  throwIfPluginOperationAborted,
  writeJsonFile,
} from "./marketplace-types.js";
import {
  KnownMarketplaceRecord,
  LoadMarketplaceResult,
  MarketplaceSource,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  writeKnownMarketplaces,
} from "./marketplace-primitives.js";
import {
  addMarketplace,
  ensureDefaultPluginMarketplaces,
  loadMarketplaceFromSource,
  resolveDependencyClosure,
} from "./marketplace-runtime.js";
import {
  getMarketplaceSourceValidationDeferral,
  pushDependencyDiagnostics,
  pushDependencyDiagnosticsFromManifest,
  pushEntryCompatibilityDiagnostics,
  toValidationDiagnostic,
  validateMarketplaceEntryShape,
  validatePluginRoot,
} from "./marketplace-validation.js";
import {
  cacheMarketplacePlugin,
  ensureMarketplaceManifestAvailable,
  readComponentsAtRoot,
  resolveManifestRootFromFile,
  resolvePluginSourceRoot,
} from "./marketplace-sources.js";

// Плагин-маркетплейс: store. Вынесено из marketplace.ts по лимиту строк.

export async function updateMarketplace(input: {
  marketplace?: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord[]> {
  ensureDefaultPluginMarketplaces(input.storageRoot);
  const known = loadKnownMarketplacesSync(input.storageRoot);
  const selected = input.marketplace
    ? known.filter((record) => record.id === input.marketplace)
    : known;
  if (input.marketplace && selected.length === 0) {
    throw new Error(`Marketplace not found: ${input.marketplace}`);
  }
  const updated: KnownMarketplaceRecord[] = [];
  for (const record of selected) {
    throwIfPluginOperationAborted(input.signal);
    // 更新全部目录时跳过官方生产 CDN；用户手动刷新单一官方目录时给出明确原因。
    if (ZCODE_OFFLINE_PREVIEW && record.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID) {
      if (input.marketplace) {
        throw new Error("Official ZCode plugin updates are unavailable in the offline Preview build.");
      }
      updated.push(record);
      continue;
    }

    // 受信任的刷新会重新拉取已知 marketplace 自带的 source；record.id 作为 trustedId，
    // 使官方 id 只能由原本就是该 id 的记录刷新得到。
    try {
      updated.push(
        await addMarketplace({
          signal: input.signal,
          source: record.source,
          storageRoot: input.storageRoot,
          trustedId: record.id,
        }),
      );
    } catch (error) {
      // 取消是当前 operation 的控制流，不是 Marketplace 健康状态；不得把 AbortError
      // 持久化成 refresh failure，避免后续普通商店页面误报官方源故障。
      if (input.signal?.aborted) throw error;
      const diagnostic = toValidationDiagnostic(error, record.id);
      await persistMarketplaceRefreshFailure(input.storageRoot, record.id, {
        code: diagnostic.code,
        failedAt: new Date().toISOString(),
        message: diagnostic.message,
      });
    }
  }
  return updated;
}

export async function removeMarketplace(input: {
  marketplace: string;
  storageRoot: string;
}): Promise<void> {
  const known = loadKnownMarketplacesSync(input.storageRoot).filter(
    (record) => record.id !== input.marketplace,
  );
  await writeKnownMarketplaces(input.storageRoot, known);
}

export function loadInstalledPluginsSync(storageRoot: string): InstalledPluginsState {
  const parsed = readJsonFileSync(join(storageRoot, INSTALLED_PLUGINS_FILE));
  return normalizeInstalledPluginsState(parsed);
}

export async function saveInstalledPlugins(
  storageRoot: string,
  state: InstalledPluginsState,
): Promise<void> {
  await writeJsonFile(join(storageRoot, INSTALLED_PLUGINS_FILE), state);
}

export function listInstalledPluginRecords(storageRoot: string): InstalledPluginRecord[] {
  return loadInstalledPluginsSync(storageRoot).plugins;
}

export function resolveInstalledPluginRoot(
  storageRoot: string,
  record: InstalledPluginRecord,
): string {
  const root =
    record.installPath ||
    getPluginCacheDir(storageRoot, record.marketplace, record.name, record.version);
  return recoverAtomicTargetSync(root);
}

export async function installMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  signal?: AbortSignal;
  storageRoot: string;
  scope?: "user" | "workspace";
  allowCrossMarketplaces?: ReadonlySet<string>;
  /** 当前 ZCode 内核版本；缺省使用构建注入的 `ZCODE_VERSION`。测试/宿主可显式传入。 */
  appVersion?: string;
}): Promise<MarketplaceInstallResult> {
  await ensureMarketplaceManifestAvailable({
    marketplace: input.marketplace,
    signal: input.signal,
    storageRoot: input.storageRoot,
  });
  throwIfPluginOperationAborted(input.signal);
  const rootManifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  const closure = resolveDependencyClosure({
    allowCrossMarketplaces:
      input.allowCrossMarketplaces ??
      new Set(rootManifest?.allowCrossMarketplaceDependenciesOn ?? []),
    marketplace: input.marketplace,
    name: input.name,
    storageRoot: input.storageRoot,
  });
  const state = loadInstalledPluginsSync(input.storageRoot);
  const installed: InstalledPluginRecord[] = [];
  const activations: AtomicDirectoryActivation[] = [];
  try {
    for (const pluginId of closure) {
      const { marketplace, name } = parsePluginId(pluginId);
      const manifest = loadMarketplaceManifestSync(input.storageRoot, marketplace);
      if (!manifest) throw new Error(`Marketplace not found: ${marketplace}`);
      const entry = manifest.plugins.find((plugin) => plugin.name === name);
      if (!entry) throw new Error(`Plugin not found: ${pluginId}`);
      const cached = await cacheMarketplacePlugin({
        appVersion: input.appVersion ?? ZCODE_VERSION,
        entry,
        marketplace,
        signal: input.signal,
        scope: input.scope ?? "user",
        state,
        storageRoot: input.storageRoot,
      });
      installed.push(cached.record);
      if (cached.activation) activations.push(cached.activation);
    }
    throwIfPluginOperationAborted(input.signal);
    await saveInstalledPlugins(input.storageRoot, state);
  } catch (error) {
    let rollbackError: unknown;
    for (const activation of activations.reverse()) {
      try {
        await activation.rollback();
      } catch (currentRollbackError) {
        rollbackError ??= currentRollbackError;
      }
    }
    throw appendPluginSourceCleanupError(error, rollbackError);
  }
  for (const activation of activations) await activation.finalize();
  return { closure, installed };
}

export async function uninstallMarketplacePlugin(input: {
  pluginId: string;
  storageRoot: string;
  removeCache?: boolean;
  /** `zcode plugins uninstall --keep-data`：删安装缓存但保留 data/<plugin-id> 用户数据目录。 */
  keepData?: boolean;
}): Promise<InstalledPluginRecord | null> {
  const state = loadInstalledPluginsSync(input.storageRoot);
  const index = state.plugins.findIndex((record) => record.id === input.pluginId);
  if (index < 0) return null;
  const [removed] = state.plugins.splice(index, 1);
  await saveInstalledPlugins(input.storageRoot, state);
  if (removed && input.removeCache === true) {
    await rm(removed.installPath, { force: true, recursive: true });
    // 彻底卸载：data/<plugin-id> 是持久化的 per-plugin 目录（含 materialize 的 generated-commands）。
    // 按「卸载最后一份安装时一并删除」语义，保证重装是干净的。

    if (input.keepData !== true) {
      await rm(getPluginDataDir(input.storageRoot, removed.id), { force: true, recursive: true });
    }
  }
  return removed ?? null;
}

export async function validateMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  try {
    await ensureMarketplaceManifestAvailable({
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
    return diagnostics;
  }
  const manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  if (!manifest) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Marketplace not found: ${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return diagnostics;
  }
  const plugin = manifest.plugins.find((entry) => entry.name === input.name);
  if (!plugin) {
    diagnostics.push({
      code: "plugin_not_found",
      message: `Plugin not found: ${input.name}@${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return diagnostics;
  }

  pushDependencyDiagnostics({
    diagnostics,
    marketplace: input.marketplace,
    name: input.name,
    storageRoot: input.storageRoot,
  });

  let resolved: ResolvedPluginSourceRoot | null = null;
  try {
    resolved = await resolvePluginSourceRoot({
      entry: plugin,
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
    diagnostics.push(
      ...validatePluginRoot({
        entry: plugin,
        marketplace: input.marketplace,
        rootPath: resolved.path,
        storageRoot: input.storageRoot,
      }),
    );
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  } finally {
    await cleanupPluginSourceBestEffort(resolved?.cleanup);
  }
  return diagnostics;
}

/**
 * 按需枚举单个插件的组件「名称 + 描述」，供 marketplace 详情 UI 使用。
 * - 已安装插件：直接读本地缓存/安装目录，无需联网。
 * - 未安装候选：解析并按需临时 clone 插件源（finally 清理临时目录），参照 validateMarketplacePlugin。
 * 组件名称与描述来自组件目录的 frontmatter（command/agent 的 .md、skill 的 SKILL.md）、
 * 以及 manifest（hooks 事件名、mcpServers 名称、object 形式声明的 commands/agents）。
 * 任何一类组件读取失败都降级为「能拿到多少返回多少」+ 诊断，不抛断整个详情。
 */
export async function describeMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  storageRoot: string;
  /** 只包住会写 known/manifest 的懒加载分支；其余只读路径不进锁。 */
  withWriteLock?: <T>(write: () => Promise<T>) => Promise<T>;
}): Promise<DescribeMarketplacePluginResult> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${input.name}@${input.marketplace}`;

  // 已安装优先：本地目录无需 clone，速度快且离线可用。
  const installedRecord = loadInstalledPluginsSync(input.storageRoot).plugins.find(
    (record) => record.marketplace === input.marketplace && record.name === input.name,
  );
  if (installedRecord) {
    const rootPath = resolveInstalledPluginRoot(input.storageRoot, installedRecord);
    if (directoryExists(rootPath)) {
      const read = readComponentsAtRoot({
        diagnostics,
        marketplace: input.marketplace,
        rootPath,
      });
      return {
        components: read.components,
        diagnostics,
        ...(read.metadata ? { metadata: read.metadata } : {}),
      };
    }
    // 安装记录存在但缓存缺失（被清理）——继续走源解析兜底，而不是直接报错。
  }

  let manifest: PluginMarketplaceManifest | null = null;
  try {
    manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    if (!manifest) {
      // Bugfix：describe 曾整体持 storage lock，安装下载期间所有详情都排在锁后。
      // 只有 manifest 缺失时才写 known/manifest，此时必须与安装、市场刷新串行。
      const withWriteLock = input.withWriteLock ?? ((write) => write());
      await withWriteLock(() =>
        ensureMarketplaceManifestAvailable({
          marketplace: input.marketplace,
          storageRoot: input.storageRoot,
        }),
      );
      manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    }
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, pluginId));
    return { components: [], diagnostics };
  }
  if (!manifest) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Marketplace not found: ${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return { components: [], diagnostics };
  }
  const entry = manifest.plugins.find((candidate) => candidate.name === input.name);
  if (!entry) {
    diagnostics.push({
      code: "plugin_not_found",
      message: `Plugin not found: ${pluginId}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return { components: [], diagnostics };
  }

  let resolved: ResolvedPluginSourceRoot | null = null;
  try {
    resolved = await resolvePluginSourceRoot({
      entry,
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
    const read = readComponentsAtRoot({
      diagnostics,
      entry,
      marketplace: input.marketplace,
      rootPath: resolved.path,
    });
    return {
      components: read.components,
      diagnostics,
      ...(read.metadata ? { metadata: read.metadata } : {}),
    };
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, pluginId));
    return { components: [], diagnostics };
  } finally {
    await cleanupPluginSourceBestEffort(resolved?.cleanup);
  }
}

export async function validateMarketplaceSource(input: {
  expectedId?: string;
  pluginName?: string;
  signal?: AbortSignal;
  source: MarketplaceSource;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  let loaded: LoadMarketplaceResult | null = null;
  try {
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: input.signal,
    });
    if (input.expectedId && loaded.manifest.name !== input.expectedId) {
      diagnostics.push({
        code: "plugin_marketplace_invalid",
        message:
          `Marketplace declaration id mismatch: expected ${input.expectedId}, ` +
          `received ${loaded.manifest.name}`,
        pluginId: input.expectedId,
        severity: "error",
      });
      return diagnostics;
    }
    if (loaded.manifest.plugins.length === 0) {
      diagnostics.push({
        code: "plugin_marketplace_invalid",
        message: `Marketplace has no plugins: ${loaded.manifest.name}`,
        severity: "warning",
      });
    }
    const entries = input.pluginName
      ? loaded.manifest.plugins.filter((entry) => entry.name === input.pluginName)
      : loaded.manifest.plugins;
    if (input.pluginName && entries.length === 0) {
      diagnostics.push({
        code: "plugin_not_found",
        message: `Plugin not found: ${input.pluginName}@${loaded.manifest.name}`,
        pluginId: `${input.pluginName}@${loaded.manifest.name}`,
        severity: "error",
      });
      return diagnostics;
    }
    for (const entry of entries) {
      diagnostics.push(
        ...validateMarketplaceEntryShape(entry, loaded.manifest.name, {
          includeEntryCompatibility: false,
        }),
      );
      pushDependencyDiagnosticsFromManifest({
        diagnostics,
        manifest: loaded.manifest,
        marketplace: loaded.manifest.name,
        name: entry.name,
        storageRoot: input.storageRoot,
      });
      const deferred = getMarketplaceSourceValidationDeferral(entry, loaded.manifest.name);
      if (deferred) {
        diagnostics.push(deferred);
        pushEntryCompatibilityDiagnostics({
          diagnostics,
          entry,
          marketplace: loaded.manifest.name,
        });
        continue;
      }
      let resolved: ResolvedPluginSourceRoot | null = null;
      try {
        resolved = await resolvePluginSourceRoot({
          entry,
          marketplace: loaded.manifest.name,
          manifest: loaded.manifest,
          signal: input.signal,
          sourceRoot: loaded.sourceRoot,
          storageRoot: input.storageRoot,
        });
        diagnostics.push(
          ...validatePluginRoot({
            entry,
            marketplace: loaded.manifest.name,
            rootPath: resolved.path,
            storageRoot: input.storageRoot,
          }),
        );
      } catch (error) {
        diagnostics.push(toValidationDiagnostic(error, `${entry.name}@${loaded.manifest.name}`));
        // validate source 是 dry-run, 但也必须给 UI 展示 marketplace 条目里声明的能力风险。
        // 当远端/相对 plugin source 暂时不可解析时, 仍基于 entry 原文输出 diagnostic-only 能力诊断。
        pushEntryCompatibilityDiagnostics({
          diagnostics,
          entry,
          marketplace: loaded.manifest.name,
        });
      } finally {
        await cleanupPluginSourceBestEffort(resolved?.cleanup);
      }
    }
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error));
  } finally {
    await cleanupPluginSourceBestEffort(loaded?.cleanup);
  }
  return diagnostics;
}

/**
 * 校验本地插件或 marketplace 路径，只读解析 manifest 并返回结构化诊断，不写入 storage。
 * 输入可以是目录或 manifest 文件；目录按 marketplace 优先、插件根目录其次的顺序识别。
 */
export async function validateLocalPluginPath(input: {
  path: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const resolved = resolve(input.path);
  if (!existsSync(resolved)) {
    return [
      {
        code: "plugin_manifest_not_found",
        message: `Path does not exist: ${resolved}`,
        path: resolved,
        severity: "error",
      },
    ];
  }
  const rootPath = statSync(resolved).isDirectory() ? resolved : resolveManifestRootFromFile(resolved);
  if (findMarketplaceManifestPath(rootPath)) {
    return validateMarketplaceSource({
      signal: input.signal,
      source: { source: "directory", path: rootPath },
      storageRoot: input.storageRoot,
    });
  }
  const manifestPath = findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return [
      {
        code: "plugin_manifest_not_found",
        message: `Plugin manifest not found: ${rootPath}`,
        path: rootPath,
        severity: "error",
      },
    ];
  }
  let name = "";
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.name === "string") name = parsed.name.trim();
  } catch (error) {
    return [
      {
        code: "plugin_manifest_invalid",
        message: error instanceof Error ? error.message : String(error),
        path: manifestPath,
        severity: "error",
      },
    ];
  }
  // 本地目录没有 marketplace 条目：用 manifest 自己的 name 合成一个 strict 条目，
  // 让 validatePluginRoot 走与已安装插件完全相同的 manifest/MCP 校验。
  return validatePluginRoot({
    entry: { name: name || basename(rootPath), raw: {} },
    marketplace: "inline",
    rootPath,
    storageRoot: input.storageRoot,
  });
}

export async function persistMarketplaceRefreshFailure(
  storageRoot: string,
  marketplace: string,
  failure: MarketplaceRefreshFailure,
): Promise<void> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((record) => record.id === marketplace);
  if (index < 0 || !known[index]) return;
  known[index] = { ...known[index], lastRefreshFailure: failure };
  await writeKnownMarketplaces(storageRoot, known);
}

export function normalizeInstalledPluginsState(value: unknown): InstalledPluginsState {
  if (!isRecord(value)) return { version: 1, plugins: [] };
  const rawPlugins = value.plugins;
  if (isRecord(rawPlugins)) {
    return {
      version: 1,
      plugins: Object.entries(rawPlugins).flatMap(([pluginId, entry]) =>
        normalizeInstalledPluginRecordFromMap(pluginId, entry),
      ),
    };
  }
  const plugins = Array.isArray(rawPlugins) ? rawPlugins : [];
  return {
    version: 1,
    plugins: plugins.filter(isInstalledPluginRecord),
  };
}

export function normalizeInstalledPluginRecordFromMap(
  pluginId: string,
  entry: unknown,
): InstalledPluginRecord[] {
  const entries = Array.isArray(entry) ? entry : [entry];
  return entries.flatMap((item): InstalledPluginRecord[] => {
    if (!isRecord(item)) return [];
    const installPath = typeof item.installPath === "string" ? item.installPath : "";
    if (!installPath) return [];
    let parsed: { marketplace: string; name: string };
    try {
      parsed = parsePluginId(pluginId);
    } catch {
      return [];
    }
    const scope = item.scope === "project" || item.scope === "local" ? "workspace" : "user";
    return [
      {
        id: pluginId,
        name: parsed.name,
        marketplace: parsed.marketplace,
        version: typeof item.version === "string" ? item.version : DEFAULT_VERSION,
        installPath,
        installedAt:
          typeof item.installedAt === "string" ? item.installedAt : new Date(0).toISOString(),
        ...(typeof item.lastUpdated === "string" ? { updatedAt: item.lastUpdated } : {}),
        scope,
      },
    ];
  });
}

export function getPluginDataDir(storageRoot: string, pluginId: string): string {
  // 与 NodePluginAdapter.discoverPluginsSync 的 dataPath 解析保持一致：<storageRoot>/data/<sanitized-id>。
  return join(storageRoot, "data", sanitizePluginId(pluginId));
}

export function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.marketplace === "string" &&
    typeof value.version === "string" &&
    typeof value.installPath === "string" &&
    typeof value.installedAt === "string" &&
    (value.scope === "user" || value.scope === "workspace")
  );
}
