import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { addSuppressedBuiltinInFileConfig, createConfig, enablePluginsByDefaultInFileConfig, removePluginEnabledFromFileConfig, removePluginFromFileConfig, removeSuppressedBuiltinInFileConfig, updatePluginEnabledInFileConfig, updatePluginOptionsInFileConfig } from "@zcode/adapters/config";
import { addMarketplace, comparePluginUpdate, describeMarketplacePlugin, enrichCachedClaudeMarketplaceIcons, ensureDefaultPluginMarketplaces, discoverNodePluginsSync, ensureMarketplaceManifestAvailable, getPluginDataDir, installMarketplacePlugin, listInstalledPluginRecords, loadKnownMarketplacesSync, loadMarketplaceManifestSync, parseMarketplaceSourceInput, parseEntryStoreListing, readPluginSourceIdentityPin, removeMarketplace, uninstallMarketplacePlugin, updateMarketplace, validateLocalPluginPath, validateMarketplacePlugin, validateMarketplaceSource, type DescribeMarketplacePluginResult, type KnownMarketplaceRecord, type PluginMarketplaceEntry } from "@zcode/adapters/plugins";
import type { PluginLoadOutcome, PluginStoreListing } from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { isZCodeCuaInternalFeatureEnabled } from "@zcode/shared";
import { resolveOfficialPluginRoots } from "./app/bundled-plugins.js";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS, OFFICIAL_PLUGIN_DEFINITIONS } from "./app/official-plugin-definitions.js";

import { withPluginStorageLock } from "./lib/plugin-storage-lock.js";

export type {
  ResolveZCodePluginsOptions,
  ListZCodePluginsOptions,
  SetZCodePluginEnabledOptions,
  SetZCodePluginEnabledResult,
  ZCodeMarketplaceSummaryData,
  ZCodeAvailablePluginData,
  ZCodeInstalledPluginData,
  ZCodePluginsOverviewData,
  ZCodeMarketplaceUpdateData,
  AddZCodeMarketplaceOptions,
  RemoveZCodeMarketplaceOptions,
  UpdateZCodeMarketplaceOptions,
  InstallZCodeMarketplacePluginOptions,
  UninstallZCodeMarketplacePluginOptions,
  UpdateZCodeMarketplacePluginOptions,
  ValidateZCodePluginPathOptions,
  ZCodePluginUpdateData,
  ZCodePluginInstallData,
} from "./plugins-types.js";

import { createMarketplaceSourceRepointDiagnostic, materializeDeclaredMarketplaceForExplicitAction, normalizePluginOptionKeys, normalizePluginOptions, resolveDeclaredMarketplaceSources, resolveEffectiveMarketplaceRecords, resolveMarketplaceDeclarationDiagnostics, resolveMarketplaceRefreshTargetIds, resolvePluginConfigPath, resolvePluginContext, resolvePluginIdForMutation, resolvePluginSelector, toAvailablePluginData, toInstalledPluginData, toMarketplaceInstallDiagnostic, toMarketplaceRefreshDiagnostic, toMarketplaceSummaryData, toPluginDiagnostic, countVisibleMarketplacePlugins, loadPluginListingsById, applySparsePaths, restoreBuiltinPluginCore } from "./plugins-helpers.js";

export { isWorkspacePluginConfigPath, resolveMarketplaceRefreshTargetIds } from "./plugins-helpers.js";
import type {
  AddZCodeMarketplaceOptions,
  ConfigureZCodePluginOptions,
  DescribeZCodePluginOptions,
  InstallZCodeMarketplacePluginOptions,
  ListZCodePluginsOptions,
  RemoveZCodeMarketplaceOptions,
  ResetZCodePluginConfigOptions,
  ResolveZCodePluginsOptions,
  RestoreBuiltinPluginOptions,
  SetZCodePluginEnabledOptions,
  SetZCodePluginEnabledResult,
  UninstallZCodeMarketplacePluginOptions,
  UpdateZCodeMarketplaceOptions,
  UpdateZCodeMarketplacePluginOptions,
  ValidateZCodePluginOptions,
  ValidateZCodePluginPathOptions,
  ZCodeAvailablePluginData,
  ZCodeInstalledPluginData,
  ZCodeMarketplaceSummaryData,
  ZCodeMarketplaceUpdateData,
  ZCodePluginInstallData,
  ZCodePluginUpdateData,
  ZCodePluginsOverviewData,
} from "./plugins-types.js";


export function resolveZCodePlugins(options: ResolveZCodePluginsOptions = {}): PluginLoadOutcome {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);

  return discoverNodePluginsSync({
    config: configResult.config.plugins,
    env: options.env ?? process.env,
    officialPluginRoots: resolveOfficialPluginRoots({
      extraRoots: options.officialPluginRoots,
      // cache 锁冲突已从 fatal 改为 degraded，普通插件入口也必须保留诊断日志。
      logger: options.logger,
      storageRoot: pluginStorageRoot,
      suppressedBuiltins: new Set(configResult.config.plugins.suppressedBuiltins),
    }),
    officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
    storageRoot: pluginStorageRoot,
    workingDirectory,
  });
}

export function getZCodePluginsOverview(
  options: ResolveZCodePluginsOptions = {},
): ZCodePluginsOverviewData {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const effectiveMarketplaces = resolveEffectiveMarketplaceRecords({
    configResult,
    known,
    workingDirectory,
  });
  const marketplaceDeclarationDiagnostics = resolveMarketplaceDeclarationDiagnostics({
    configResult,
    known,
    workingDirectory,
  });
  const installed = listInstalledPluginRecords(pluginStorageRoot);
  const installedIds = new Set(installed.map((record) => record.id));

  // 每个市场的 manifest 只读一次：同时取 entries（目录条目）与 featured（策展名单）。
  // zcode-plugins-official 的内置与 CDN 分片已在 adapter 层合并为唯一 canonical manifest。
  const catalogs: Array<{
    summary: ZCodeMarketplaceSummaryData;
    entries: PluginMarketplaceEntry[];
  }> = [];
  for (const { record, useCachedManifest } of effectiveMarketplaces) {
    // Marketplace source 只来自 User/Host 配置。只有目标 Host 已经通过显式 refresh/install
    // 物化了同一 source 时，才读取 Host cache；同 id 不同 source 必须 fail closed，避免
    // 不同 Host 或旧配置误用错误的全局 marketplace 快照。
    const manifest = useCachedManifest
      ? loadMarketplaceManifestSync(pluginStorageRoot, record.id)
      : null;
    catalogs.push({
      summary: toMarketplaceSummaryData(
        record,
        manifest?.featured,
        countVisibleMarketplacePlugins(record.id, manifest?.plugins),
      ),
      entries: manifest?.plugins ?? [],
    });
  }

  // 边遍历 marketplace catalog 边记录每个插件 id 的最新「版本 pin」用于更新检测。

  // 条目可能只有 version、只有 sha 或两者兼有，因此同时收集 version 与 sha
  // 两个轴，由 comparePluginUpdate 决定用哪条轴比对 installed 记录。
  const latestPinByPluginId = new Map<string, { version?: string; sha?: string }>();
  // 同时按 id 收集目录条目的商店信息，供已安装插件 join（详情/图标条/管理视图共用）。
  const listingByPluginId = new Map<string, PluginStoreListing>();
  const availablePlugins = catalogs.flatMap((catalog) =>
    catalog.entries.map((entry) => {
      const data = toAvailablePluginData(entry, catalog.summary.id, installedIds);
      latestPinByPluginId.set(data.id, {
        ...(entry.version ? { version: entry.version } : {}),
        ...(readPluginSourceIdentityPin(entry.source)
          ? { sha: readPluginSourceIdentityPin(entry.source) }
          : {}),
      });
      if (entry.listing) listingByPluginId.set(data.id, entry.listing);
      return data;
    }),
  );
  const loadedById = new Map(outcome.plugins.map((plugin) => [plugin.id, plugin]));

  // 被抑制（uninstall）的内置（官方）插件可一键恢复：从 OFFICIAL_PLUGIN_DEFINITIONS
  // 里挑出 id 落在 suppressedBuiltins 集合内的，映射成 available 形态供 UI 的「恢复」入口使用。
  // 完整 Catalog/cache 仍然保留，restorable 只是 Runtime 抑制态的投影，商店信息直接取定义里的 listing seed。
  const suppressed = new Set(configResult.config.plugins.suppressedBuiltins);
  const restorableBuiltins: ZCodeAvailablePluginData[] = OFFICIAL_PLUGIN_DEFINITIONS.filter(
    (def) =>
      suppressed.has(`${def.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`) &&
      // computer-use 的恢复入口需要 internal 特性开启（与 restoreBuiltinPluginCore 同口径）。
      (def.name !== "computer-use" || isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)),
  ).map((def) => {
    const listing = def.listing
      ? parseEntryStoreListing({ name: def.name, ...def.listing })
      : undefined;
    return {
      id: `${def.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
      name: def.name,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      version: def.version,
      installed: false,
      // Bugfix：可恢复条目只带 listing 时丢了 "ui"，卸载后的文档插件从「UI 插件」掉进分类分组。
      ...(def.componentTypes ? { componentTypes: [...def.componentTypes] } : {}),
      ...(listing ? { listing } : {}),
    };
  });

  return {
    marketplaces: catalogs.map((catalog) => catalog.summary),
    availablePlugins,
    installedPlugins: installed.map((record) => {
      const enabled = configResult.config.plugins.enabledPlugins[record.id] ?? false;
      const data = toInstalledPluginData(record, enabled, loadedById.get(record.id));
      const pin = latestPinByPluginId.get(record.id);
      const installedSha = readPluginSourceIdentityPin(record.source);
      const updateStatus = comparePluginUpdate({
        installedVersion: data.version,
        installedSha,
        latestVersion: pin?.version,
        latestSha: pin?.sha,
      });
      // latestVersion 展示：优先用 manifest 的 version；否则用最新 sha（短 7 位）让 UI 有可读提示。
      const latestLabel = pin?.version ?? (pin?.sha ? pin.sha.slice(0, 7) : undefined);
      const listing = listingByPluginId.get(record.id);
      return {
        ...data,
        updateStatus,
        ...(latestLabel ? { latestVersion: latestLabel } : {}),
        ...(listing ? { listing } : {}),
      };
    }),
    restorableBuiltins,
    diagnostics: [
      ...outcome.diagnostics,
      ...marketplaceDeclarationDiagnostics,
      ...known.flatMap((record): PluginLoadOutcome["diagnostics"] =>
        record.lastRefreshFailure
          ? [
              {
                code: record.lastRefreshFailure.code,
                message: record.lastRefreshFailure.message,
                pluginId: record.id,
                severity: "error",
              },
            ]
          : [],
      ),
    ],
  };
}

export function enrichCachedClaudeMarketplaceIconsForOverview(
  options: ResolveZCodePluginsOptions = {},
): void {
  const { pluginStorageRoot } = resolvePluginContext(options);
  // 图标是可选展示增强：overview 不等待网络；仅写回阶段进入 storage lock。
  void enrichCachedClaudeMarketplaceIcons(pluginStorageRoot, (write) =>
    withPluginStorageLock(pluginStorageRoot, write),
  );
}

export function listZCodePlugins(options: ListZCodePluginsOptions = {}): PluginLoadOutcome {
  const outcome = resolveZCodePlugins(options);
  const { pluginStorageRoot } = resolvePluginContext(options);
  return {
    ...outcome,
    // 用户可见名称必须从 marketplace listing 解析；这里按完整 id 传递给 CLI，
    // 不把展示元数据混入 adapter 的运行时 PluginMetadata，也不按裸 name 猜测。
    pluginListingsById: loadPluginListingsById(pluginStorageRoot),
  };
}


export async function setZCodePluginEnabled(
  options: SetZCodePluginEnabledOptions,
): Promise<SetZCodePluginEnabledResult> {
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
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.plugin, outcome.plugins);
  const patch = await updatePluginEnabledInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    options.enabled,
  );

  return {
    enabled: patch.enabled,
    path: patch.path,
    plugin: {
      ...plugin,
      enabled: patch.enabled,
    },
  };
}

export async function addZCodePluginMarketplace(
  options: AddZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceSummaryData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const source = applySparsePaths(
    await parseMarketplaceSourceInput(options.source),
    options.sparsePaths,
  );
  if (options.dryRun === true) {
    return {
      id: "dry-run",
      name: "dry-run",
      source: source as unknown as Record<string, unknown>,
      pluginCount: 0,
      isOfficial: false,
    };
  }
  const record = await addMarketplace({
    signal: options.abortSignal,
    source,
    storageRoot: pluginStorageRoot,
  });
  return toMarketplaceSummaryData(record);
}

export async function removeZCodePluginMarketplace(
  options: RemoveZCodeMarketplaceOptions,
): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await removeMarketplace({
    marketplace: options.marketplace,
    storageRoot: pluginStorageRoot,
  });
}

export async function updateZCodePluginMarketplace(
  options: UpdateZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceUpdateData> {
  const { configResult, pluginStorageRoot, workingDirectory: _workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const declared = resolveDeclaredMarketplaceSources({
    configResult,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const knownById = new Map(known.map((record) => [record.id, record]));
  const targetIds = resolveMarketplaceRefreshTargetIds({
    declaredIds: declared.keys(),
    knownIds: knownById.keys(),
    marketplace: options.marketplace,
  });
  if (
    options.marketplace &&
    !knownById.has(options.marketplace) &&
    !declared.has(options.marketplace)
  ) {
    throw new Error(`Marketplace not found: ${options.marketplace}`);
  }

  const updated: KnownMarketplaceRecord[] = [];
  const declarationDiagnostics: PluginLoadOutcome["diagnostics"] = [];
  for (const marketplaceId of targetIds) {
    const declarationSource = declared.get(marketplaceId);
    const knownRecord = knownById.get(marketplaceId);
    if (
      options.marketplace &&
      declarationSource &&
      knownRecord &&
      !isDeepStrictEqual(knownRecord.source, declarationSource)
    ) {
      declarationDiagnostics.push(createMarketplaceSourceRepointDiagnostic(marketplaceId));
      continue;
    }
    if (declarationSource && !knownRecord) {
      try {
        updated.push(
          await addMarketplace({
            expectedId: marketplaceId,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          }),
        );
      } catch (error) {
        declarationDiagnostics.push(toMarketplaceRefreshDiagnostic(error, marketplaceId));
      }
      continue;
    }
    updated.push(
      ...(await updateMarketplace({
        marketplace: marketplaceId,
        signal: options.abortSignal,
        storageRoot: pluginStorageRoot,
      })),
    );
  }

  // map 回调只吃第一个参数：toMarketplaceSummaryData 的第二参是 featured，不能接 map 的 index。
  const records = loadKnownMarketplacesSync(pluginStorageRoot);
  const selectedFailures = records.flatMap((record): PluginLoadOutcome["diagnostics"] => {
    if (options.marketplace && record.id !== options.marketplace) return [];
    if (!record.lastRefreshFailure) return [];
    return [
      {
        code: record.lastRefreshFailure.code,
        message: record.lastRefreshFailure.message,
        pluginId: record.id,
        severity: "error",
      },
    ];
  });
  return {
    marketplaces: updated.map((record) => toMarketplaceSummaryData(record)),
    diagnostics: [...declarationDiagnostics, ...selectedFailures],
  };
}

export async function installZCodeMarketplacePlugin(
  options: InstallZCodeMarketplacePluginOptions,
): Promise<ZCodePluginInstallData> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.dryRun === true) {
    const declarationSource = resolveDeclaredMarketplaceSources({
      configResult,
    }).get(options.marketplace);
    const known = loadKnownMarketplacesSync(pluginStorageRoot).find(
      (record) => record.id === options.marketplace,
    );
    if (declarationSource && known && !isDeepStrictEqual(known.source, declarationSource)) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [createMarketplaceSourceRepointDiagnostic(options.marketplace)],
      };
    }
    if (
      declarationSource &&
      (!known || !loadMarketplaceManifestSync(pluginStorageRoot, options.marketplace))
    ) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: (
          await validateMarketplaceSource({
            expectedId: options.marketplace,
            pluginName: options.pluginName,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          })
        ).map(toPluginDiagnostic),
      };
    }
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: (
        await validateMarketplacePlugin({
          marketplace: options.marketplace,
          name: options.pluginName,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic),
    };
  }
  const pluginId = `${options.pluginName}@${options.marketplace}`;
  const bundledEntry = loadMarketplaceManifestSync(
    pluginStorageRoot,
    options.marketplace,
  )?.plugins.find((entry) => entry.name === options.pluginName);
  const isSuppressedBundledOfficial =
    options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
    configResult.config.plugins.suppressedBuiltins.includes(pluginId) &&
    (bundledEntry?.source === "filesystem" || bundledEntry?.source === "sea");
  if (isSuppressedBundledOfficial) {
    // 内置插件的 filesystem/SEA entry 只是 Catalog 指针，不是普通 Marketplace source。
    // 直接安装必须复用 restore，避免把同一份官方 cache 写进 installed_plugins.json，
    // 否则卸载/更新会把内置资产误判成用户安装并破坏恢复语义。
    // 当前调用由协议层的 storage lock 保护；这里必须调用不再加锁的核心，
    // 否则同一 storageRoot 的 promise-chain lock 会等待自身而永久阻塞。
    await restoreBuiltinPluginCore({ ...options, configResult, pluginId });
    const fresh = resolvePluginContext({ ...options, configResult: undefined });
    const outcome = resolveZCodePlugins({
      ...options,
      configResult: fresh.configResult,
      pluginStorageRoot: fresh.pluginStorageRoot,
    });
    const restored = outcome.plugins.find((plugin) => plugin.id === pluginId);
    if (!restored) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [
          toPluginDiagnostic({
            code: "plugin_not_found",
            message: `Bundled plugin could not be restored: ${pluginId}`,
            pluginId,
            severity: "error",
          }),
        ],
      };
    }
    const now = new Date().toISOString();
    return {
      dependencyClosure: [pluginId],
      installedPlugins: [
        toInstalledPluginData(
          {
            id: restored.id,
            name: restored.name,
            marketplace: restored.marketplace,
            version: restored.version ?? "",
            installPath: restored.rootPath,
            installedAt: now,
            updatedAt: now,
            scope: "user",
          },
          restored.enabled,
          restored,
        ),
      ],
      diagnostics: [],
    };
  }
  let installed: Awaited<ReturnType<typeof installMarketplacePlugin>>;
  try {
    await materializeDeclaredMarketplaceForExplicitAction({
      configResult,
      marketplaceId: options.marketplace,
      pluginStorageRoot,
      abortSignal: options.abortSignal,
      workingDirectory,
    });
    installed = await installMarketplacePlugin({
      signal: options.abortSignal,
      marketplace: options.marketplace,
      name: options.pluginName,
      // package/cache/installed record 是目标 Host 的 User inventory；
      // 旧协议的 Workspace scope 仅为兼容保留，不能改变 Marketplace 默认启用写入 User config
      // 的语义。installed record 没有 workspace identity，不能让它参与 Workspace 配置归属。
      scope: "user",
      storageRoot: pluginStorageRoot,
    });
  } catch (error) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: [
        toMarketplaceInstallDiagnostic(error, `${options.pluginName}@${options.marketplace}`),
      ],
    };
  }
  if (options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    // 官方 marketplace 复用内置插件的 id 空间。若同名 CDN 插件重新安装，
    // 清掉历史内置 suppression，否则 Runtime 仍会把已拥有的安装误判为 suppressed。
    for (const record of installed.installed) {
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, record.id);
    }
  }
  // Marketplace 只管理 Host User inventory；即使旧协议调用方传入 workspace scope，
  // 安装即默认启用也必须写入 User config，不能把 Marketplace 动作变成 Workspace override。
  // 仅作用于用户配置里尚未显式声明的 id（停用后重装等显式选择不被覆盖）。
  const { enabledIds } = await enablePluginsByDefaultInFileConfig(
    configResult.sources.user.path,
    installed.installed.map((record) => record.id),
  );
  const enabledIdSet = new Set(enabledIds);
  // 已有显式配置的，沿用其当前启用态；本次新置默认启用的标记为 true。
  const enabledById = (id: string): boolean =>
    enabledIdSet.has(id) || (configResult.config.plugins.enabledPlugins[id] ?? false);
  return {
    dependencyClosure: installed.closure,
    installedPlugins: installed.installed.map((record) =>
      toInstalledPluginData(record, enabledById(record.id)),
    ),
    diagnostics: [],
  };
}

export async function uninstallZCodeMarketplacePlugin(
  options: UninstallZCodeMarketplacePluginOptions,
): Promise<ZCodeInstalledPluginData | null> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  return withPluginStorageLock(pluginStorageRoot, async () => {
    const pluginId = resolvePluginIdForMutation(options);

    // 官方 CDN marketplace 与内置插件共享 zcode-plugins-official id 空间，且其缓存
    // 也位于 official cache 下。若先看 runtime source="official"，会把已有
    // installed_plugins.json 记录的 CDN 插件误判成内置插件，只写 suppression 却不删安装记录，
    // 导致 UI 永远保持 installed、无法重装。持久化安装记录是 marketplace 所有权的权威证据，
    // 必须优先于运行时来源分类；同时清掉可能遗留的错误 suppression，让状态自愈。
    const installedRecord = listInstalledPluginRecords(pluginStorageRoot).find(
      (record) => record.id === pluginId,
    );
    if (installedRecord) {
      const removed = await uninstallMarketplacePlugin({
        pluginId,
        // 卸载语义即彻底清除：除非调用方显式传 removeCache=false，否则连缓存与 data 目录一起删。
        removeCache: options.removeCache ?? true,
        keepData: options.keepData,
        storageRoot: pluginStorageRoot,
      });
      if (!removed) return null;
      await removePluginFromFileConfig(configResult.sources.user.path, removed.id);
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, removed.id);
      return toInstalledPluginData(removed, false);
    }

    // 内置（官方）插件不在 installed_plugins.json 里，无法走 marketplace 卸载路径。
    // 卸载只改变 Runtime 抑制态并清理用户数据/config；Catalog 与不可变 cache 必须保留，
    // 这样详情页仍能离线读取组件，且恢复动作不依赖重新下载或重新构造目录。
    const outcome = resolveZCodePlugins({
      ...options,
      configResult,
      pluginStorageRoot,
      workingDirectory,
    });
    const builtin = outcome.plugins.find(
      (plugin) => plugin.id === pluginId && plugin.source === "official",
    );
    if (builtin) {
      await addSuppressedBuiltinInFileConfig(configResult.sources.user.path, pluginId);
      // 先清掉 user config 里的 enabledPlugins[id] 与 options[id]，再删目录：抑制标记已是
      // 唯一真相源（写入用原子 temp+rename），即使后续删除抛错，下次 resolve 也会跳过并补删
      // 缓存；把 config 清理放在删除之前可保证「恢复时从干净状态开始」即便删除中途失败。
      await removePluginFromFileConfig(configResult.sources.user.path, pluginId);
      // 不删除官方 cache：它与 Marketplace Catalog 同属详情/恢复所需的只读资产。
      if (options.keepData !== true) {
        await rm(getPluginDataDir(pluginStorageRoot, pluginId), { force: true, recursive: true });
      }
      const now = new Date().toISOString();
      return toInstalledPluginData(
        {
          id: builtin.id,
          name: builtin.name,
          marketplace: builtin.marketplace,
          version: builtin.version ?? "",
          installPath: builtin.rootPath,
          installedAt: now,
          updatedAt: now,
          scope: "user",
        },
        false,
      );
    }

    return null;
  });
}

/**
 * `zcode plugins update <plugin>`：先刷新所属 marketplace 目录，再按同一条目重装。
 * cacheMarketplacePlugin 对已存在的安装记录做原地覆盖并保留 installedAt；启用态只会给
 * 用户配置里尚未显式声明的 id 补默认值，因此更新不会改变用户已经做过的开关选择。
 */
export async function updateZCodeMarketplacePlugin(
  options: UpdateZCodeMarketplacePluginOptions,
): Promise<ZCodePluginUpdateData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const record = listInstalledPluginRecords(pluginStorageRoot).find(
    (installed) => installed.id === options.pluginId,
  );
  if (!record) throw new Error(`Plugin not installed: ${options.pluginId}`);
  const refreshed = await updateZCodePluginMarketplace({
    ...options,
    marketplace: record.marketplace,
  });
  const refreshErrors = refreshed.diagnostics.filter((item) => item.severity === "error");
  if (refreshErrors.length > 0) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: refreshErrors,
      previousVersion: record.version,
    };
  }
  const installed = await installZCodeMarketplacePlugin({
    ...options,
    marketplace: record.marketplace,
    pluginName: record.name,
    scope: record.scope,
  });
  return { ...installed, previousVersion: record.version };
}

/** `zcode plugins validate <path>`：只读校验本地插件目录或 marketplace 目录。 */
export async function validateZCodePluginPath(
  options: ValidateZCodePluginPathOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  return (
    await validateLocalPluginPath({
      path: options.path,
      signal: options.abortSignal,
      storageRoot: pluginStorageRoot,
    })
  ).map(toPluginDiagnostic);
}


/**
 * 恢复一个被抑制（uninstall）的内置（官方）插件的无锁核心。
 *
 * 调用方可能已经持有同一 storageRoot 的 storage lock（例如协议 install handler），
 * 因此核心不能再次获取 promise-chain lock；公开入口再负责提供锁保护。
 */

export async function restoreBuiltinPlugin(options: RestoreBuiltinPluginOptions): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await withPluginStorageLock(pluginStorageRoot, () => restoreBuiltinPluginCore(options));
}

export async function configureZCodePlugin(options: ConfigureZCodePluginOptions): Promise<void> {
  const normalizedOptions = normalizePluginOptions(options.options);
  const clearOptionKeys = normalizePluginOptionKeys(options.clearOptionKeys);
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.pluginId, outcome.plugins);
  if (options.dryRun === true) return;
  await updatePluginOptionsInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    normalizedOptions,
    clearOptionKeys,
  );
}

/** 删除指定 scope 的 Plugin 配置键，使 Workspace scope 回退到 User。 */
export async function resetZCodePluginConfig(
  options: ResetZCodePluginConfigOptions,
): Promise<{ path: string; pluginId: string }> {
  const { configResult, workingDirectory } = resolvePluginContext(options);
  const path = resolvePluginConfigPath(options, configResult, workingDirectory);
  if (options.scope === "workspace") {
    // “恢复继承”只删除 Workspace 的 enable override。options 是独立配置维度，
    // 不能因为用户恢复开关继承而把 Workspace options/secret 一并抹掉。
    await removePluginEnabledFromFileConfig(path, options.pluginId);
  } else {
    await removePluginFromFileConfig(path, options.pluginId);
  }
  return { path, pluginId: options.pluginId };
}

export async function validateZCodePlugin(
  options: ValidateZCodePluginOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.source) {
    try {
      const source = await parseMarketplaceSourceInput(options.source);
      return (
        await validateMarketplaceSource({
          source,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic);
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ];
    }
  }
  if (options.marketplace && options.pluginName) {
    try {
      await ensureMarketplaceManifestAvailable({
        marketplace: options.marketplace,
        storageRoot: pluginStorageRoot,
      });
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId: `${options.pluginName}@${options.marketplace}`,
          severity: "error",
        },
      ];
    }
    return (
      await validateMarketplacePlugin({
        marketplace: options.marketplace,
        name: options.pluginName,
        storageRoot: pluginStorageRoot,
      })
    ).map(toPluginDiagnostic);
  }
  return [];
}

export async function describeZCodePlugin(
  options: DescribeZCodePluginOptions,
): Promise<DescribeMarketplacePluginResult> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  // 默认市场登记由 ensureMarketplaceManifestAvailable 在写锁内完成；这里不再无锁写 known 列表。
  return describeMarketplacePlugin({
    marketplace: options.marketplace,
    name: options.pluginName,
    storageRoot: pluginStorageRoot,
    ...(options.withWriteLock ? { withWriteLock: options.withWriteLock } : {}),
  });
}
