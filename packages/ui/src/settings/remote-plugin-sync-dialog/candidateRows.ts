import type {
  PluginSyncCandidate,
  PluginSyncRemoteStatus,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginsOverviewResult,
} from "@zcode/shared";
import { isPortablePluginOptionValue } from "@/settings/remote-plugin-sync-dialog/pluginOptions.js";
import type {
  RemotePluginSyncCandidate,
  RemotePluginSyncCandidateStatus,
  RemotePluginSyncDialogStep,
  RemotePluginSyncPluginOptions,
  RemotePluginSyncRow,
} from "@/settings/remote-plugin-sync-dialog/types.js";

export function toInlineRemotePluginSyncCandidate(
  candidate: PluginSyncCandidate,
): RemotePluginSyncCandidate {
  return {
    id: `inline:${candidate.id}`,
    kind: "inline",
    name: candidate.name,
    pluginId: candidate.pluginId,
    marketplace: "inline",
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
    path: candidate.path,
    enabled: candidate.enabled,
    componentTypes: candidate.componentTypes,
    inlineCandidate: candidate,
  };
}

function createInlineStatusKey(pluginId: string, directoryName: string): string {
  return `${pluginId.toLowerCase()}\u0000${directoryName}`;
}

export function buildRemotePluginSyncRows(
  candidates: readonly PluginSyncCandidate[],
  statuses: readonly PluginSyncRemoteStatus[],
): RemotePluginSyncRow[] {
  const statusByKey = new Map(
    statuses.map((status) => [
      createInlineStatusKey(status.pluginId, status.directoryName),
      status,
    ]),
  );
  return buildRemotePluginSyncRowsForCandidates(
    candidates.map(toInlineRemotePluginSyncCandidate),
    candidates.map((candidate) => {
      const status = statusByKey.get(
        createInlineStatusKey(candidate.pluginId, candidate.directoryName),
      );
      return {
        candidateId: `inline:${candidate.id}`,
        exists: status?.exists ?? false,
        ...(status?.path ? { path: status.path } : {}),
        ...(status?.reason ? { reason: status.reason } : {}),
      };
    }),
  );
}

export function buildRemotePluginSyncRowsForCandidates(
  candidates: readonly RemotePluginSyncCandidate[],
  statuses: readonly RemotePluginSyncCandidateStatus[],
): RemotePluginSyncRow[] {
  const statusById = new Map(statuses.map((status) => [status.candidateId, status]));
  return candidates.map((candidate) => {
    const status = statusById.get(candidate.id);
    return {
      candidate,
      exists: status?.exists ?? false,
      ...(status?.path ? { path: status.path } : {}),
      ...(status?.reason ? { reason: status.reason } : {}),
      ...(status?.remoteMarketplaceExists !== undefined
        ? { remoteMarketplaceExists: status.remoteMarketplaceExists }
        : {}),
    };
  });
}

export function resolveDefaultRemotePluginSyncSelection(
  rows: readonly RemotePluginSyncRow[],
): Set<string> {
  return new Set(rows.filter((row) => !row.exists).map((row) => row.candidate.id));
}

export function filterRemotePluginSyncRows(
  rows: readonly RemotePluginSyncRow[],
  showExistingRemotePlugins: boolean,
): RemotePluginSyncRow[] {
  return showExistingRemotePlugins ? [...rows] : rows.filter((row) => !row.exists);
}

export function shouldAllowRemotePluginSyncDialogOpenChange(
  step: RemotePluginSyncDialogStep,
  nextOpen: boolean,
): boolean {
  return nextOpen || (step !== "preflighting" && step !== "syncing");
}

export function buildMarketplaceRemotePluginSyncCandidates(
  overview: ZCodePluginsOverviewResult,
  plugins: readonly ZCodePluginInfo[],
): RemotePluginSyncCandidate[] {
  const pluginInfoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const marketplaceSourceById = new Map(
    overview.marketplaces.map((marketplace) => [
      marketplace.id,
      buildMarketplaceSourceSyncInfo(marketplace),
    ]),
  );
  return overview.installedPlugins.map((plugin) => {
    const info = pluginInfoById.get(plugin.id);
    const componentTypes = plugin.componentTypes ?? componentTypesFromPluginInfo(info);
    const marketplaceSource = marketplaceSourceById.get(plugin.marketplace);
    const pluginOptions = buildRemotePluginSyncPluginOptions(info);
    return {
      id: `marketplace:${plugin.id}`,
      kind: "marketplace",
      name: plugin.name,
      pluginId: plugin.id,
      marketplace: plugin.marketplace,
      ...((plugin.description ?? info?.description)
        ? { description: plugin.description ?? info?.description }
        : {}),
      ...((plugin.version ?? info?.version) ? { version: plugin.version ?? info?.version } : {}),
      ...((plugin.installPath ?? info?.rootPath)
        ? { path: plugin.installPath ?? info?.rootPath }
        : {}),
      enabled: plugin.enabled,
      componentTypes,
      ...(pluginOptions ? { pluginOptions } : {}),
      marketplacePlugin: {
        ...marketplaceSource,
        pluginName: plugin.name,
      },
    };
  });
}

export function buildMarketplaceRemotePluginStatuses(
  candidates: readonly RemotePluginSyncCandidate[],
  remoteOverview: ZCodePluginsOverviewResult,
): RemotePluginSyncCandidateStatus[] {
  const installedById = new Map(
    remoteOverview.installedPlugins.map((plugin) => [plugin.id, plugin]),
  );
  const remoteMarketplaceIds = new Set(
    remoteOverview.marketplaces.map((marketplace) => marketplace.id),
  );
  return candidates.map((candidate) => {
    const installed = installedById.get(candidate.pluginId);
    return {
      candidateId: candidate.id,
      exists: Boolean(installed),
      ...(installed?.installPath ? { path: installed.installPath } : {}),
      ...(installed ? { reason: "samePluginId" as const } : {}),
      remoteMarketplaceExists: remoteMarketplaceIds.has(candidate.marketplace),
    };
  });
}

function componentTypesFromPluginInfo(plugin: ZCodePluginInfo | undefined): string[] {
  return plugin?.components?.map((component) => component.kind) ?? [];
}

function buildRemotePluginSyncPluginOptions(
  plugin: ZCodePluginInfo | undefined,
): RemotePluginSyncPluginOptions | undefined {
  const configuredOptions = plugin?.configuredOptions ?? {};
  if (Object.keys(configuredOptions).length === 0) {
    return undefined;
  }
  return {
    configuredOptions: { ...configuredOptions },
    userConfig: { ...plugin?.userConfig },
  };
}

function applyPluginInfoToRemoteSyncCandidate(
  candidate: RemotePluginSyncCandidate,
  plugin: ZCodePluginInfo | undefined,
): RemotePluginSyncCandidate {
  const pluginOptions = buildRemotePluginSyncPluginOptions(plugin);
  return pluginOptions ? { ...candidate, pluginOptions } : candidate;
}

export function enrichRemotePluginSyncCandidatesWithPluginInfo(
  candidates: readonly RemotePluginSyncCandidate[],
  plugins: readonly ZCodePluginInfo[],
): RemotePluginSyncCandidate[] {
  const pluginInfoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return candidates.map((candidate) =>
    applyPluginInfoToRemoteSyncCandidate(candidate, pluginInfoById.get(candidate.pluginId)),
  );
}

export function summarizeLocalPluginOptionsForDisplay(
  pluginOptions: RemotePluginSyncPluginOptions | undefined,
): { manualCount: number; syncableCount: number } | null {
  if (!pluginOptions || Object.keys(pluginOptions.configuredOptions).length === 0) {
    return null;
  }
  let syncableCount = 0;
  let manualCount = 0;
  for (const [key, value] of Object.entries(pluginOptions.configuredOptions)) {
    const option = pluginOptions.userConfig[key];
    if (isPortablePluginOptionValue(value, option, option)) {
      syncableCount += 1;
    } else {
      manualCount += 1;
    }
  }
  return { manualCount, syncableCount };
}

function serializeMarketplaceSourceInput(
  marketplace: ZCodePluginMarketplaceSummary,
): string | undefined {
  const source = marketplace.source;
  const sourceKind = typeof source.source === "string" ? source.source : "";
  const refSuffix =
    typeof source.ref === "string" && source.ref.trim() ? `#${source.ref.trim()}` : "";
  if (sourceKind === "github" && typeof source.repo === "string" && source.repo.trim()) {
    return `${source.repo.trim()}${refSuffix}`;
  }
  if (sourceKind === "git" && typeof source.url === "string" && source.url.trim()) {
    return `${source.url.trim()}${refSuffix}`;
  }
  if (sourceKind === "url" && typeof source.url === "string" && source.url.trim()) {
    return source.url.trim();
  }
  return undefined;
}

function buildMarketplaceSourceSyncInfo(
  marketplace: ZCodePluginMarketplaceSummary,
): Pick<
  NonNullable<RemotePluginSyncCandidate["marketplacePlugin"]>,
  "marketplaceSourceArchive" | "marketplaceSourceInput"
> {
  const sourceInput = serializeMarketplaceSourceInput(marketplace);
  if (sourceInput) {
    return { marketplaceSourceInput: sourceInput };
  }
  const sourceKind = typeof marketplace.source.source === "string" ? marketplace.source.source : "";
  if (["file", "directory", "settings"].includes(sourceKind)) {
    return {
      marketplaceSourceArchive: {
        marketplaceId: marketplace.id,
        source: marketplace.source,
      },
    };
  }
  return {};
}
