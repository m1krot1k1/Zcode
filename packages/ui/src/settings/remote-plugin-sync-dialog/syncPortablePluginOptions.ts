import {
  arePluginOptionsEqual,
  buildPortablePluginOptionsSyncPlan,
} from "@/settings/remote-plugin-sync-dialog/pluginOptions.js";
import {
  awaitRemotePluginSyncStep,
  emitRemotePluginSyncProgress,
} from "@/settings/remote-plugin-sync-dialog/syncSteps.js";
import {
  REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
  type RemotePluginSyncRemoteParams,
  type RemotePluginSyncRow,
} from "@/settings/remote-plugin-sync-dialog/types.js";

export async function syncPortablePluginOptions(
  params: RemotePluginSyncRemoteParams,
  row: RemotePluginSyncRow,
): Promise<void> {
  const localOptions = row.candidate.pluginOptions;
  if (!localOptions || Object.keys(localOptions.configuredOptions).length === 0) {
    return;
  }
  const remoteZCodeAgentService = params.remoteZCodeAgentService;
  if (!remoteZCodeAgentService) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      "skip plugin options: remote plugin service is not available",
    );
    return;
  }
  const workspace = {
    workspacePath: params.remoteWorkspacePath,
    ...(params.remoteWorkspaceIdentity
      ? { workspaceIdentity: params.remoteWorkspaceIdentity }
      : {}),
  };
  const remotePlugins = await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/list for options ${row.candidate.pluginId}`,
    () => remoteZCodeAgentService.listPlugins(workspace),
  );
  const remotePlugin = remotePlugins.plugins.find((plugin) => plugin.id === row.candidate.pluginId);
  if (!remotePlugin) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `skip plugin options: remote plugin schema not found for ${row.candidate.pluginId}`,
    );
    return;
  }
  const plan = buildPortablePluginOptionsSyncPlan(localOptions, remotePlugin);
  if (plan.skippedCount > 0) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `skipped ${plan.skippedCount} non-portable plugin option(s)`,
    );
  }
  const portableCount = Object.keys(plan.options).length;
  if (portableCount === 0) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      "skip plugin options: no portable configured option values",
    );
    return;
  }
  const mergedOptions = {
    ...remotePlugin.configuredOptions,
    ...plan.options,
  };
  if (arePluginOptionsEqual(remotePlugin.configuredOptions ?? {}, mergedOptions)) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `plugin options already synced (${portableCount} portable option(s))`,
    );
    return;
  }
  await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/configure ${portableCount} portable option(s) for ${row.candidate.pluginId}`,
    () =>
      remoteZCodeAgentService.configurePlugin({
        ...workspace,
        options: mergedOptions,
        pluginId: row.candidate.pluginId,
        scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
      }),
  );
}
