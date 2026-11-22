import type {
  WindowHostControllerTaskListItem,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import type { WindowHostControllerSourceScope } from "../windowHostControllerProjection.js";
import { compareItems, liveStatusFromMeta, normalizeTaskMeta, sourceKey } from "./helpers.js";
import type {
  ResolvedWindowHostControllerSource,
  WindowHostControllerListTaskList,
  WindowHostControllerRuntimeContext,
} from "./types.js";

/**
 * 列表查询只消费 Host 内存中的投影与 source 注册表；刷新失败按 source 隔离，
 * 不因一个 remote 瞬时错误清空其它 source 的可信行。
 */
export function createWindowHostControllerTaskList(
  context: WindowHostControllerRuntimeContext,
): WindowHostControllerListTaskList {
  const { options, projection, refreshSource, state } = context;
  const { pendingReplacementByNextSourceKey } = state;

  function resolveQuerySources(
    scopes: ZCodeTaskListWorkspaceScope[],
  ): ResolvedWindowHostControllerSource[] {
    const resolved = new Map<string, ResolvedWindowHostControllerSource>();
    for (const scope of scopes) {
      const source = options.resolveSource(scope);
      if (!source) {
        continue;
      }
      resolved.set(sourceKey(source.scope), source);
    }
    return Array.from(resolved.values());
  }

  return async function listTaskList(query) {
    const resolvedSources = resolveQuerySources(query.workspaceScopes);
    await Promise.all(
      resolvedSources.map(async (source) => {
        try {
          await refreshSource(source);
        } catch (error) {
          // 一个 remote source 的瞬时读取失败不能清空 local 或其他 remote 的可信投影。
          options.onSourceError?.(source.scope, "refresh", error);
        }
      }),
    );

    const search = query.search?.trim();
    let items: WindowHostControllerTaskListItem[];
    if (search) {
      const results = await Promise.all(
        resolvedSources
          .filter((source) => source.sourceAvailability === "online" && source.taskService != null)
          .map(async (source) => {
            try {
              const result = await source.taskService!.listTaskList({
                ...query,
                workspaceScopes: [
                  {
                    workspacePath: source.scope.workspacePath,
                    ...(source.scope.workspaceIdentity
                      ? { workspaceIdentity: source.scope.workspaceIdentity }
                      : {}),
                  },
                ],
                limit: undefined,
              });
              return result.items.map((item) => {
                const normalized = normalizeTaskMeta(item, source.scope);
                const projected = projection
                  .getTasks()
                  .find(
                    (row) =>
                      row.address.taskId === normalized.taskId &&
                      row.address.workspacePath === normalized.workspacePath &&
                      row.address.workspaceIdentity === normalized.workspaceIdentity &&
                      row.address.remoteSessionId ===
                        (source.scope.kind === "remote" ? source.scope.remoteSessionId : undefined),
                  );
                return {
                  ...(projected?.meta ?? normalized),
                  ...(source.scope.kind === "remote"
                    ? {
                        ...(source.scope.sourceServerId
                          ? { sourceServerId: source.scope.sourceServerId }
                          : {}),
                        ...(source.scope.serverDisplayName
                          ? { serverDisplayName: source.scope.serverDisplayName }
                          : {}),
                        remoteSessionId: source.scope.remoteSessionId,
                      }
                    : {}),
                  sourceAvailability: "online" as const,
                  liveStatus: projected?.liveStatus ?? liveStatusFromMeta(normalized),
                  ...(projected?.activity ? { activity: projected.activity } : {}),
                  ...(item.searchSnippets ? { searchSnippets: item.searchSnippets } : {}),
                };
              });
            } catch (error) {
              options.onSourceError?.(source.scope, "search", error);
              return [];
            }
          }),
      );
      items = results.flat();
    } else {
      const selectedSources = new Set<string>();
      for (const source of resolvedSources) {
        const key = sourceKey(source.scope);
        selectedSources.add(key);
        const pendingPreviousScope = pendingReplacementByNextSourceKey.get(key);
        if (pendingPreviousScope) {
          // 新 source 的首个 snapshot 失败时继续展示上一代离线可信投影；只有成功的
          // replaceSourceSnapshot 才会在一个 delta frame 中移除旧 rows 并加入新 rows。
          selectedSources.add(sourceKey(pendingPreviousScope));
        }
      }
      items = projection
        .getTasks()
        .filter((row) => {
          const scope: WindowHostControllerSourceScope =
            row.address.sourceServerId || row.address.remoteSessionId
              ? {
                  kind: "remote",
                  ...(row.address.sourceServerId
                    ? { sourceServerId: row.address.sourceServerId }
                    : {}),
                  remoteSessionId: row.address.remoteSessionId,
                  workspacePath: row.address.workspacePath,
                  workspaceIdentity: row.address.workspaceIdentity!,
                }
              : {
                  kind: "local",
                  workspacePath: row.address.workspacePath,
                  ...(row.address.workspaceIdentity
                    ? { workspaceIdentity: row.address.workspaceIdentity }
                    : {}),
                };
          return (
            selectedSources.has(sourceKey(scope)) &&
            matchesTaskListMembershipKind(row.membership, query.kind)
          );
        })
        .map((row) => {
          const resolvedSource = resolvedSources.find((source) => {
            const addressKey = row.address.workspaceIdentity?.trim() || row.address.workspacePath;
            const scopeKeyValue =
              source.scope.workspaceIdentity?.trim() || source.scope.workspacePath;
            return (
              addressKey === scopeKeyValue &&
              (source.scope.kind !== "remote" ||
                (row.address.sourceServerId
                  ? source.scope.sourceServerId === row.address.sourceServerId
                  : source.scope.remoteSessionId === row.address.remoteSessionId))
            );
          });
          return {
            ...row.meta,
            ...(row.address.sourceServerId ? { sourceServerId: row.address.sourceServerId } : {}),
            ...(resolvedSource?.scope.kind === "remote" && resolvedSource.scope.serverDisplayName
              ? { serverDisplayName: resolvedSource.scope.serverDisplayName }
              : {}),
            ...(row.address.remoteSessionId
              ? { remoteSessionId: row.address.remoteSessionId }
              : {}),
            sourceAvailability: row.sourceAvailability,
            liveStatus: row.liveStatus,
            ...(row.activity ? { activity: row.activity } : {}),
            ...(row.searchSnippets ? { searchSnippets: row.searchSnippets } : {}),
          };
        });
    }
    items.sort((left, right) => compareItems(left, right, query.sortBy));
    const total = items.length;
    const visible = query.limit == null ? items : items.slice(0, query.limit);
    return { items: visible, total, hasMore: total > visible.length };
  };
}
