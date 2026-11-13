import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  AppSettings,
  ConnectionProfile,
  SourceServerManagementSnapshot,
} from "@zcode/shared";

export function formatTimestamp(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatRelativeTimestamp(
  timestamp: number,
  locale: string,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return formatMessage({ id: "common.justNow" });
  if (elapsed < 60 * 60_000) {
    return formatMessage({ id: "common.minutesAgo" }, { count: Math.floor(elapsed / 60_000) });
  }
  if (elapsed < 24 * 60 * 60_000) {
    return formatMessage({ id: "common.hoursAgo" }, { count: Math.floor(elapsed / (60 * 60_000)) });
  }
  if (elapsed < 48 * 60 * 60_000) return formatMessage({ id: "common.yesterday" });
  return new Date(timestamp).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

export function getProjectCount(
  snapshot: SourceServerManagementSnapshot,
  sourceServerId: string,
  remoteConversationWorkspaceBySourceServerId?: AppSettings["remoteConversationWorkspaceBySourceServerId"],
): number {
  return new Set(
    snapshot.workspaceHistory
      .filter(
        (entry) =>
          entry.sourceServerId === sourceServerId &&
          remoteConversationWorkspaceBySourceServerId?.[sourceServerId]?.workspacePath !==
            entry.workspacePath,
      )
      .map((entry) => resolveWorkspaceKey(entry)),
  ).size;
}

export const COLLAPSED_PROJECT_COUNT = 3;

export function toggleSetItem(current: Set<string>, item: string): Set<string> {
  const next = new Set(current);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

export function profileOperationScope(profile: ConnectionProfile): string {
  return profile.sourceServerId
    ? `source:${profile.sourceServerId}`
    : `profile:${profile.profileId}`;
}
