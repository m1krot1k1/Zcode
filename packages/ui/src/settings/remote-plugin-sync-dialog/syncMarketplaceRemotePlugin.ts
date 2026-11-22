import type { IPluginSyncService } from "@zcode/services";
import {
  awaitRemotePluginSyncStep,
  buildStoppedRemotePluginResult,
  emitRemotePluginSyncProgress,
  isRemotePluginSyncStoppedError,
  throwIfRemotePluginSyncStopped,
} from "@/settings/remote-plugin-sync-dialog/syncSteps.js";
import { syncPortablePluginOptions } from "@/settings/remote-plugin-sync-dialog/syncPortablePluginOptions.js";
import {
  REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
  type RemotePluginSyncAgentService,
  type RemotePluginSyncExecParams,
  type RemotePluginSyncResultItem,
  type RemotePluginSyncRow,
  type RemotePluginSyncWorkspace,
} from "@/settings/remote-plugin-sync-dialog/types.js";

interface RemoteMarketplaceSyncParams extends RemotePluginSyncExecParams {
  localPluginSyncService: IPluginSyncService;
  preparedMarketplaceSources: Set<string>;
  remotePluginSyncService: IPluginSyncService;
  remoteWorkspaceIdentity?: string;
  remoteWorkspacePath: string;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
  selectedMarketplacePluginNames: ReadonlyMap<string, string[]>;
}

export function buildSelectedMarketplacePluginNames(
  rows: readonly RemotePluginSyncRow[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const marketplacePlugin = row.candidate.marketplacePlugin;
    if (row.candidate.kind !== "marketplace" || !marketplacePlugin) {
      continue;
    }
    const names = result.get(row.candidate.marketplace) ?? [];
    names.push(marketplacePlugin.pluginName);
    result.set(row.candidate.marketplace, names);
  }
  return result;
}

export async function syncMarketplaceRemotePlugin(
  params: RemoteMarketplaceSyncParams,
  row: RemotePluginSyncRow,
): Promise<RemotePluginSyncResultItem> {
  const candidate = row.candidate;
  const marketplacePlugin = candidate.marketplacePlugin;
  const directoryName = `${candidate.marketplace}/${candidate.name}`;
  try {
    throwIfRemotePluginSyncStopped(params, row);
    if (!params.remoteZCodeAgentService || !marketplacePlugin) {
      throw new Error("remote plugin install service is not available");
    }
    const remoteZCodeAgentService = params.remoteZCodeAgentService;
    const workspace = {
      workspacePath: params.remoteWorkspacePath,
      ...(params.remoteWorkspaceIdentity
        ? { workspaceIdentity: params.remoteWorkspaceIdentity }
        : {}),
    };
    if (
      !row.remoteMarketplaceExists &&
      !params.preparedMarketplaceSources.has(candidate.marketplace)
    ) {
      await prepareRemoteMarketplaceSource(
        {
          localPluginSyncService: params.localPluginSyncService,
          onItemProgress: params.onItemProgress,
          remotePluginSyncService: params.remotePluginSyncService,
          remoteZCodeAgentService,
          selectedMarketplacePluginNames: params.selectedMarketplacePluginNames,
          signal: params.signal,
          stopControl: params.stopControl,
        },
        row,
        workspace,
      );
      params.preparedMarketplaceSources.add(candidate.marketplace);
    }
    const installResult = await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/install ${candidate.pluginId}`,
      (operationId) =>
        remoteZCodeAgentService.installPlugin({
          ...workspace,
          marketplace: candidate.marketplace,
          operationId,
          pluginName: marketplacePlugin.pluginName,
          scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
        }),
      { cancellableRemoteOperation: true },
    );
    const installError = formatInstallError(installResult, candidate.pluginId);
    if (installError) {
      throw new Error(installError);
    }
    const installedPlugin = installResult.installedPlugins.find(
      (plugin) => plugin.id === candidate.pluginId,
    );
    if (!installedPlugin) {
      throw new Error(`remote install did not return ${candidate.pluginId}`);
    }
    await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/setEnabled enabled=${String(candidate.enabled)} for ${candidate.pluginId}`,
      () =>
        remoteZCodeAgentService.setPluginEnabled({
          ...workspace,
          enabled: candidate.enabled,
          pluginId: candidate.pluginId,
          scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
        }),
    );
    await syncPortablePluginOptions(params, row);
    const result = {
      name: candidate.name,
      pluginId: candidate.pluginId,
      directoryName,
      status: "synced",
      ...(installedPlugin.installPath ? { path: installedPlugin.installPath } : {}),
    } satisfies RemotePluginSyncResultItem;
    emitRemotePluginSyncProgress(params, row, "synced", "marketplace plugin synced", result);
    return result;
  } catch (error) {
    const result = isRemotePluginSyncStoppedError(error)
      ? buildStoppedRemotePluginResult(row)
      : {
          name: candidate.name,
          pluginId: candidate.pluginId,
          directoryName,
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        };
    emitRemotePluginSyncProgress(params, row, result.status, result.error ?? result.status, result);
    return result;
  }
}

async function prepareRemoteMarketplaceSource(
  params: {
    localPluginSyncService: IPluginSyncService;
    onItemProgress?: RemotePluginSyncExecParams["onItemProgress"];
    remotePluginSyncService: IPluginSyncService;
    remoteZCodeAgentService: RemotePluginSyncAgentService;
    selectedMarketplacePluginNames: ReadonlyMap<string, string[]>;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncExecParams["stopControl"];
  },
  row: RemotePluginSyncRow,
  workspace: RemotePluginSyncWorkspace,
): Promise<void> {
  const candidate = row.candidate;
  const marketplacePlugin = candidate.marketplacePlugin;
  if (!marketplacePlugin) {
    throw new Error("marketplace plugin metadata is not available");
  }
  const marketplaceSourceInput = marketplacePlugin.marketplaceSourceInput;
  if (marketplaceSourceInput) {
    await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/marketplace/add ${candidate.marketplace} from ${marketplaceSourceInput}`,
      (operationId) =>
        params.remoteZCodeAgentService.addPluginMarketplace({
          ...workspace,
          operationId,
          source: marketplaceSourceInput,
        }),
      { cancellableRemoteOperation: true },
    );
    return;
  }
  const marketplaceSourceArchive = marketplacePlugin.marketplaceSourceArchive;
  if (!marketplaceSourceArchive) {
    throw new Error(`marketplace source cannot be synchronized: ${candidate.marketplace}`);
  }
  const exported = await awaitRemotePluginSyncStep(
    params,
    row,
    `export marketplace source ${candidate.marketplace}`,
    () =>
      params.localPluginSyncService.exportMarketplaceSourceArchive({
        marketplaceId: marketplaceSourceArchive.marketplaceId,
        pluginNames: params.selectedMarketplacePluginNames.get(candidate.marketplace) ?? [
          marketplacePlugin.pluginName,
        ],
        source: marketplaceSourceArchive.source,
      }),
  );
  const imported = await awaitRemotePluginSyncStep(
    params,
    row,
    `import marketplace source ${candidate.marketplace} on remote`,
    () =>
      params.remotePluginSyncService.importMarketplaceSourceArchive({
        archive: exported.archive,
        overwrite: false,
      }),
  );
  await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/marketplace/add mirrored ${candidate.marketplace} from ${imported.path}`,
    (operationId) =>
      params.remoteZCodeAgentService.addPluginMarketplace({
        ...workspace,
        operationId,
        source: imported.path,
      }),
    { cancellableRemoteOperation: true },
  );
}

function formatInstallError(
  result: Awaited<ReturnType<RemotePluginSyncAgentService["installPlugin"]>>,
  pluginId: string,
): string | null {
  const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "warning");
  if (diagnostics.length === 0) {
    return null;
  }
  return diagnostics
    .map((diagnostic) => {
      const target = diagnostic.pluginId ?? pluginId;
      return `${target}: ${diagnostic.message}`;
    })
    .join("; ");
}
