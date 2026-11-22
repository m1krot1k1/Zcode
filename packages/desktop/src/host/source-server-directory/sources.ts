import { restoreCredentials, sshCredentialKeys } from "./credentials.js";
import { isActiveProfile } from "./identity.js";
import type { SourceServerDirectoryContext } from "./types.js";

export async function renameSource(
  context: SourceServerDirectoryContext,
  sourceServerId: string,
  displayName: string,
): Promise<void> {
  await context.initialize();
  const normalized = displayName.trim();
  if (!normalized) throw new Error("Source Server display name is required");
  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const servers = [...(settings.sourceServers ?? [])];
    const index = servers.findIndex((server) => server.sourceServerId === sourceServerId);
    if (index < 0) throw new Error(`Unknown Source Server: ${sourceServerId}`);
    servers[index] = { ...servers[index]!, displayName: normalized };
    await context.persistSettings({ sourceServers: servers });
  });
}

export async function removeSourceServer(
  context: SourceServerDirectoryContext,
  sourceServerId: string,
): Promise<void> {
  await context.initialize();
  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const profiles = [...(settings.connectionProfiles ?? [])];
    const removedProfiles = profiles.filter((profile) => profile.sourceServerId === sourceServerId);
    // 幂等空操作：设备无任何本地记录时直接成功返回，不产生写入也不发布变更事件。
    const hasAnyRecord =
      removedProfiles.length > 0 ||
      (settings.sourceServers ?? []).some((server) => server.sourceServerId === sourceServerId) ||
      (settings.sourceServerWorkspaceHistory ?? []).some(
        (entry) => entry.sourceServerId === sourceServerId,
      ) ||
      Boolean(settings.remoteConversationWorkspaceBySourceServerId?.[sourceServerId]);
    if (!hasAnyRecord) return;
    // Bug 原因：识别前写入的 workspace history 尚未回填 sourceServerId，只按设备 id 过滤
    // 会留下指向已删 Profile 的孤儿条目；删除面必须同时覆盖被删设备全部 Profile 的条目。
    const removedProfileIds = new Set(removedProfiles.map((profile) => profile.profileId));
    const credentialKeys = removedProfiles.flatMap((profile) =>
      profile.target.kind === "ssh" ? sshCredentialKeys(profile.target) : [],
    );
    const previousCredentials = new Map<string, string | null>();
    try {
      for (const key of credentialKeys) {
        previousCredentials.set(key, await context.options.credentialService.load(key));
        await context.options.credentialService.delete(key);
      }
      await context.persistSettings({
        connectionProfiles: profiles.filter((profile) => profile.sourceServerId !== sourceServerId),
        sourceServers: (settings.sourceServers ?? []).filter(
          (server) => server.sourceServerId !== sourceServerId,
        ),
        sourceServerWorkspaceHistory: (settings.sourceServerWorkspaceHistory ?? []).filter(
          (entry) =>
            entry.sourceServerId !== sourceServerId && !removedProfileIds.has(entry.profileId),
        ),
        remoteConversationWorkspaceBySourceServerId: Object.fromEntries(
          Object.entries(settings.remoteConversationWorkspaceBySourceServerId ?? {}).filter(
            ([key]) => key !== sourceServerId,
          ),
        ),
      });
    } catch (error) {
      await restoreCredentials(context, previousCredentials);
      throw error;
    }
  });
}

export async function markSourceUninstalled(
  context: SourceServerDirectoryContext,
  profileId: string,
): Promise<void> {
  await context.initialize();
  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const profile = (settings.connectionProfiles ?? []).find(
      (candidate) => candidate.profileId === profileId && isActiveProfile(candidate),
    );
    if (!profile?.sourceServerId) return;
    await context.persistSettings({
      sourceServers: (settings.sourceServers ?? []).map((server) =>
        server.sourceServerId === profile.sourceServerId
          ? { ...server, installState: "uninstalled" as const }
          : server,
      ),
    });
  });
}
