import type { IPluginSyncService } from "@zcode/services";
import {
  buildMarketplaceRemotePluginStatuses,
  buildMarketplaceRemotePluginSyncCandidates,
  buildRemotePluginSyncRows,
  enrichRemotePluginSyncCandidatesWithPluginInfo,
  toInlineRemotePluginSyncCandidate,
} from "@/settings/remote-plugin-sync-dialog/candidateRows.js";
import type {
  RemotePluginSyncAgentService,
  RemotePluginSyncCandidate,
  RemotePluginSyncCandidateStatus,
} from "@/settings/remote-plugin-sync-dialog/types.js";

export async function loadRemotePluginSyncCandidates(params: {
  localPluginSyncService: IPluginSyncService;
  localWorkspacePath: string;
  localZCodeAgentService?: RemotePluginSyncAgentService | null;
  remotePluginSyncService: IPluginSyncService;
  remoteWorkspaceIdentity?: string;
  remoteWorkspacePath: string;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
}): Promise<{
  candidates: RemotePluginSyncCandidate[];
  statuses: RemotePluginSyncCandidateStatus[];
}> {
  const localInlineResult = await params.localPluginSyncService.listLocalUserPluginCandidates();
  const inlineCandidates = localInlineResult.candidates.map(toInlineRemotePluginSyncCandidate);
  const remoteInlineResult = await params.remotePluginSyncService.listRemoteUserPluginStatuses({
    plugins: localInlineResult.candidates.map((candidate) => ({
      pluginId: candidate.pluginId,
      directoryName: candidate.directoryName,
    })),
  });
  const inlineStatuses = buildRemotePluginSyncRows(
    localInlineResult.candidates,
    remoteInlineResult.statuses,
  ).map(
    (row): RemotePluginSyncCandidateStatus => ({
      candidateId: row.candidate.id,
      exists: row.exists,
      ...(row.path ? { path: row.path } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    }),
  );

  if (!params.localZCodeAgentService || !params.remoteZCodeAgentService) {
    return { candidates: inlineCandidates, statuses: inlineStatuses };
  }

  const [localOverview, localPluginsResult, remoteOverview] = await Promise.all([
    params.localZCodeAgentService.getPluginsOverview({
      workspacePath: params.localWorkspacePath,
    }),
    params.localZCodeAgentService.listPlugins({
      workspacePath: params.localWorkspacePath,
    }),
    params.remoteZCodeAgentService.getPluginsOverview({
      workspacePath: params.remoteWorkspacePath,
      ...(params.remoteWorkspaceIdentity
        ? { workspaceIdentity: params.remoteWorkspaceIdentity }
        : {}),
    }),
  ]);
  const marketplaceCandidates = buildMarketplaceRemotePluginSyncCandidates(
    localOverview,
    localPluginsResult.plugins,
  );
  return {
    candidates: [
      ...enrichRemotePluginSyncCandidatesWithPluginInfo(
        inlineCandidates,
        localPluginsResult.plugins,
      ),
      ...marketplaceCandidates,
    ],
    statuses: [
      ...inlineStatuses,
      ...buildMarketplaceRemotePluginStatuses(marketplaceCandidates, remoteOverview),
    ],
  };
}
