import { isActiveProfile } from "./identity.js";
import { resolveSilentTarget } from "./targets.js";
import type {
  SourceServerDirectoryContext,
  SourceServerDirectorySnapshot,
  SourceServerReconnectCandidate,
} from "./types.js";

export async function readSnapshot(
  context: SourceServerDirectoryContext,
): Promise<SourceServerDirectorySnapshot> {
  await context.initialize();
  const settings = await context.options.settingService.get();
  return {
    profiles: [...(settings.connectionProfiles ?? [])],
    servers: [...(settings.sourceServers ?? [])],
    workspaceHistory: [...(settings.sourceServerWorkspaceHistory ?? [])],
  };
}

export async function resolveLegacyWorkspaceIdentity(
  context: SourceServerDirectoryContext,
  input: {
    profileId: string;
    workspacePath: string;
    fallback: string;
  },
): Promise<string> {
  await context.initialize();
  const settings = await context.options.settingService.get();
  const historical = (settings.sourceServerWorkspaceHistory ?? []).find(
    (entry) => entry.profileId === input.profileId && entry.workspacePath === input.workspacePath,
  )?.legacyWorkspaceIdentity;
  // Bug 原因：Renderer stable identity 曾覆盖当前 route hint，导致旧 alias 行丢失时无法命中
  // 更精确的历史 key。legacy hint 的优先级属于 Host Directory 权威，不允许 UI 决定。
  return historical?.trim() || input.fallback;
}

export async function listStartupReconnectCandidates(
  context: SourceServerDirectoryContext,
): Promise<SourceServerReconnectCandidate[]> {
  const snapshot = await readSnapshot(context);
  const candidates: SourceServerReconnectCandidate[] = [];
  // Bug 原因：Directory 数组按 Source 首次发现顺序持久化。冷启动 worker 有并发上限时，
  // 旧 Source 会先占满槽位，最近活动 workspace 的 Source 反而可能排到后面并超时。
  // 候选队列以最近在线事实排序；单个 Source 内仍由 preferred Profile 决定连接路由。
  // 保存的连接不因七天未使用失去启动重连资格；凭据和全局关闭开关继续由原入口守卫。
  const serversByRecentActivity = [...snapshot.servers].sort(
    (left, right) => (right.lastOnlineAt ?? 0) - (left.lastOnlineAt ?? 0),
  );
  for (const server of serversByRecentActivity) {
    const profiles = snapshot.profiles
      .filter(
        (profile) => isActiveProfile(profile) && profile.sourceServerId === server.sourceServerId,
      )
      .sort((left, right) => {
        if (left.profileId === server.preferredProfileId) return -1;
        if (right.profileId === server.preferredProfileId) return 1;
        return (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0);
      });
    for (const profile of profiles) {
      const target = await resolveSilentTarget(context, profile);
      if (!target) continue;
      candidates.push({ profile, target });
      break;
    }
  }
  // 首次握手失败的已保存 Profile 仍是有效连接；是否保留由 Host 的 SQLite 成员表筛选。
  for (const profile of snapshot.profiles) {
    if (!isActiveProfile(profile) || profile.sourceServerId) continue;
    const target = await resolveSilentTarget(context, profile);
    if (target) candidates.push({ profile, target });
  }
  return candidates;
}
