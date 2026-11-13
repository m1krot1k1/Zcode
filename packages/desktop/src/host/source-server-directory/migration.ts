import type {
  AppSettings,
  ConnectionProfile,
  SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import { migrateProfileTarget, restoreCredentials } from "./credentials.js";
import { routeKey } from "./identity.js";
import { profileTargetFromRemote } from "./targets.js";
import type { LegacySourceWorkspaceEntry, SourceServerDirectoryContext } from "./types.js";

export async function migrateLegacyRemoteEntries(
  context: SourceServerDirectoryContext,
  settings: AppSettings,
): Promise<void> {
  const previousCredentials = new Map<string, string | null>();
  try {
    await persistLegacyRemoteEntries(context, settings, previousCredentials);
  } catch (error) {
    // Bug 原因：legacy 迁移先落新 Profile 凭据、最后提交 Directory settings；settings
    // 写入失败后重试会生成新 profileId，旧 key 因无人引用而永久残留。迁移失败必须在
    // 返回前恢复本轮所有凭据写入，保留 legacy key 供下一次初始化重新迁移。
    await restoreCredentials(context, previousCredentials);
    throw error;
  }
}

async function persistLegacyRemoteEntries(
  context: SourceServerDirectoryContext,
  settings: AppSettings,
  previousCredentials: Map<string, string | null>,
): Promise<void> {
  const remoteEntries = (settings.lastWorkspaceSession ?? [])
    .filter((entry) => entry.kind === "remote" && entry.target.kind !== "server")
    .map((entry) => entry as LegacySourceWorkspaceEntry);
  const groups = new Map<string, typeof remoteEntries>();
  for (const entry of remoteEntries) {
    const key = routeKey(entry);
    if (!key) continue;
    const values = groups.get(key) ?? [];
    values.push(entry);
    groups.set(key, values);
  }

  const profiles: ConnectionProfile[] = [];
  const workspaceHistory: SourceServerWorkspaceHistoryEntry[] = [];
  const shouldMigrateProfiles = !settings.connectionProfiles?.length;
  for (const entries of groups.values()) {
    const ordered = [...entries].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
    const latest = ordered[0]!;
    const profileId = context.createProfileId();
    // 既有 Profile 会作为本次 settings patch 的权威值保留；为随后被丢弃的临时 Profile
    // 复制凭据会在成功迁移时也制造 orphan key，因此只有真正进入提交集的 Profile 才落 secret。
    const target = shouldMigrateProfiles
      ? await migrateProfileTarget(
          context,
          profileId,
          latest.target,
          previousCredentials,
          ordered.map((entry) => entry.target),
        )
      : profileTargetFromRemote(latest.target);
    const transport = target.kind;
    profiles.push({
      profileId,
      transport,
      target,
      displayName:
        target.kind === "ssh"
          ? (target.sshConfigAlias ?? target.host)
          : target.kind === "wsl"
            ? (target.distro ?? "WSL")
            : target.container,
      createdAt: Math.min(...entries.map((entry) => entry.lastOpenedAt)),
      lastConnectedAt:
        latest.lastConnectionStatus === "connected" ? latest.lastOpenedAt : undefined,
      lastConnectError: latest.lastConnectionError,
    } as ConnectionProfile);
    for (const entry of entries) {
      workspaceHistory.push({
        workspacePath: entry.workspacePath,
        ...(entry.workspaceIdentity ? { legacyWorkspaceIdentity: entry.workspaceIdentity } : {}),
        profileId,
        lastOpenedAt: entry.lastOpenedAt,
      });
    }
  }

  await context.persistSettings({
    sourceServers: settings.sourceServers ?? [],
    connectionProfiles: settings.connectionProfiles?.length
      ? settings.connectionProfiles
      : profiles,
    sourceServerWorkspaceHistory: settings.sourceServerWorkspaceHistory?.length
      ? settings.sourceServerWorkspaceHistory
      : workspaceHistory.sort((left, right) => left.lastOpenedAt - right.lastOpenedAt),
    sourceServerDirectoryMigrationVersion: 1,
  });
}
