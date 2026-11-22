import { collectTelemetryRendererContext } from "@zcode/shared";
import {
  awaitRemotePluginSyncStep,
  buildStoppedRemotePluginResult,
  emitRemotePluginSyncProgress,
  isRemotePluginSyncStoppedError,
  throwIfRemotePluginSyncStopped,
} from "@/settings/remote-plugin-sync-dialog/syncSteps.js";
import {
  buildSelectedMarketplacePluginNames,
  syncMarketplaceRemotePlugin,
} from "@/settings/remote-plugin-sync-dialog/syncMarketplaceRemotePlugin.js";
import { syncPortablePluginOptions } from "@/settings/remote-plugin-sync-dialog/syncPortablePluginOptions.js";
import type {
  RemotePluginSyncResultItem,
  RemotePluginSyncRow,
  RemotePluginSyncRunParams,
  RemotePluginSyncRunResult,
} from "@/settings/remote-plugin-sync-dialog/types.js";

export async function syncSelectedRemotePlugins(
  params: RemotePluginSyncRunParams,
): Promise<RemotePluginSyncRunResult> {
  const results: RemotePluginSyncRunResult["results"] = [];
  // 每项从实际执行起计时；只记录目标端最终结果，不上传归档、配置或路径。
  const reportResult = (
    row: RemotePluginSyncRow,
    item: RemotePluginSyncResultItem,
    startedAt: number,
  ) => {
    if (!params.reportTelemetryEvent) return;
    try {
      void Promise.resolve(
        params.reportTelemetryEvent({
          elementName: "plugin_lifecycle",
          eventRegion: "app",
          eventType: "result",
          context: collectTelemetryRendererContext(),
          eventExtraDetail: {
            schema_version: "1",
            action: "sync",
            trigger: "sync",
            scope: "user",
            plugin_id: row.candidate.pluginId,
            marketplace: row.candidate.marketplace,
            workspace_kind: "remote",
            result:
              item.status === "synced"
                ? "success"
                : item.status === "skipped"
                  ? "noop"
                  : item.status === "stopped"
                    ? "cancelled"
                    : "failure",
            duration_ms: String(Math.max(0, Date.now() - startedAt)),
          },
        }),
      ).catch(() => {});
    } catch {
      /* 观测失败不影响远端同步结果。 */
    }
  };
  for (const row of params.rows) {
    emitRemotePluginSyncProgress(params, row, "queued", "Queued plugin sync");
  }

  for (const row of params.rows) {
    if (row.candidate.kind !== "inline") {
      continue;
    }
    const startedAt = Date.now();
    try {
      throwIfRemotePluginSyncStopped(params, row);
      const inlineCandidate = row.candidate.inlineCandidate;
      if (!inlineCandidate) {
        throw new Error("inline plugin metadata is not available");
      }
      const exported = await awaitRemotePluginSyncStep(
        params,
        row,
        `export inline plugin ${row.candidate.pluginId}`,
        () =>
          params.localPluginSyncService.exportPluginsArchive({
            pluginIds: [inlineCandidate.id],
          }),
      );
      const result = await awaitRemotePluginSyncStep(
        params,
        row,
        `import inline plugin ${row.candidate.pluginId} on remote`,
        () =>
          params.remotePluginSyncService.importPluginsArchive({
            archive: exported.archive,
            overwrite: false,
          }),
      );
      const item = result.results[0];
      if (!item) {
        throw new Error(`remote import did not return ${row.candidate.pluginId}`);
      }
      if (item.status === "synced") {
        await syncPortablePluginOptions(params, row);
      }
      results.push(item);
      reportResult(row, item, startedAt);
      emitRemotePluginSyncProgress(params, row, item.status, `inline plugin ${item.status}`, item);
    } catch (error) {
      const item = isRemotePluginSyncStoppedError(error)
        ? buildStoppedRemotePluginResult(row)
        : {
            name: row.candidate.name,
            pluginId: row.candidate.pluginId,
            directoryName: row.candidate.inlineCandidate?.directoryName ?? row.candidate.name,
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          };
      results.push(item);
      reportResult(row, item, startedAt);
      emitRemotePluginSyncProgress(params, row, item.status, item.error ?? item.status, item);
    }
  }

  const selectedMarketplacePluginNames = buildSelectedMarketplacePluginNames(params.rows);
  const preparedMarketplaceSources = new Set<string>();
  for (const row of params.rows) {
    if (row.candidate.kind !== "marketplace") {
      continue;
    }
    const startedAt = Date.now();
    const item = await syncMarketplaceRemotePlugin(
      {
        ...params,
        preparedMarketplaceSources,
        selectedMarketplacePluginNames,
      },
      row,
    );
    results.push(item);
    reportResult(row, item, startedAt);
  }
  return { results };
}
