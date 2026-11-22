import {
  buildTaskEntityKey,
  type TaskEntityKey,
  type TaskListCacheDescriptor,
  type TaskListCacheKey,
} from "@/lib/taskQueryCache.js";
import { mergeIncomingTaskListItem } from "./mergeTaskListItem.js";
import { preserveFreshLocalTaskKeys } from "./preserveFreshLocalTaskKeys.js";
import { buildCachedTaskListResult, isQueryResultEquivalent } from "./queryResultBuilder.js";
import type { CachedTaskListItem, SetFn } from "./types.js";

/**
 * 查询结果写入 action。单条与批量写入必须保持同一合并顺序：
 * entity 合并 → overlay 释放判定 → fresh-local 保留 → 等价短路 → 提交。
 */
export function createQueryResultActions(set: SetFn) {
  return {
    setQueryResult: ({
      queryKey,
      descriptor,
      items,
      total,
      hasMore,
      unreadTaskKeys,
      partial,
      loadingShardKeys,
      failedShardKeys,
    }: {
      queryKey: TaskListCacheKey;
      descriptor: TaskListCacheDescriptor;
      items: CachedTaskListItem[];
      total: number;
      hasMore: boolean;
      unreadTaskKeys?: TaskEntityKey[];
      partial?: boolean;
      loadingShardKeys?: string[];
      failedShardKeys?: string[];
    }) =>
      set((state) => {
        const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
        let taskMetaChanged = false;
        let taskUnreadOverlayChanged = false;
        const nextTaskUnreadOverlayByEntityKey = {
          ...state.taskUnreadOverlayByEntityKey,
        };
        const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
        const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
        const incomingTaskKeys = items.map((item) => {
          const entityKey = buildTaskEntityKey(item);
          if (item.searchSnippet) {
            searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
          }
          if (item.searchSnippets?.length) {
            searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
          }
          const existingItem = nextTaskMetaByEntityKey[entityKey];
          const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
            state.taskUnreadOverlayByEntityKey,
            entityKey,
          );
          const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
          const mergedItem = mergeIncomingTaskListItem({
            item,
            existingItem,
            descriptor,
            hasUnreadOverlay,
            unreadAtOverlay,
          });
          if (
            hasUnreadOverlay &&
            (unreadAtOverlay === null
              ? typeof item.unreadAt !== "number"
              : item.unreadAt === unreadAtOverlay)
          ) {
            // RPC 成功不等于所有在途 membership 查询都已更新。
            // overlay 只有在 query 真正发布出同一字段值后才可释放，旧回包前后都不能覆盖新状态。
            delete nextTaskUnreadOverlayByEntityKey[entityKey];
            taskUnreadOverlayChanged = true;
          }
          if (mergedItem !== existingItem) {
            taskMetaChanged = true;
            nextTaskMetaByEntityKey[entityKey] = mergedItem;
          }
          return entityKey;
        });
        const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
          incomingTaskKeys,
          previousResult: state.resultsByQueryKey[queryKey],
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor,
        });

        const resultParams = {
          descriptor,
          taskKeys,
          unreadTaskKeys,
          searchSnippetsByTaskKey:
            Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
          searchSnippetListsByTaskKey:
            Object.keys(searchSnippetListsByTaskKey).length > 0
              ? searchSnippetListsByTaskKey
              : undefined,
          total:
            preservedCount > 0
              ? Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length)
              : total,
          hasMore:
            hasMore ||
            (preservedCount > 0 &&
              Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length) >
                taskKeys.length),
          partial,
          loadingShardKeys,
          failedShardKeys,
          invalidationVersion: state.resultsByQueryKey[queryKey]?.invalidationVersion ?? 0,
        };
        // 内容与现缓存完全等价时跳过 setState，republish 不再引发全列表无效重渲染。
        if (
          !taskMetaChanged &&
          !taskUnreadOverlayChanged &&
          isQueryResultEquivalent({
            previousResult: state.resultsByQueryKey[queryKey],
            taskKeys,
            unreadTaskKeys: resultParams.unreadTaskKeys,
            searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
            searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
            total: resultParams.total,
            hasMore: resultParams.hasMore,
            partial: partial ?? false,
            loadingShardKeys: loadingShardKeys ?? [],
            failedShardKeys: failedShardKeys ?? [],
          })
        ) {
          return state;
        }

        return {
          resultsByQueryKey: {
            ...state.resultsByQueryKey,
            [queryKey]: buildCachedTaskListResult(resultParams),
          },
          taskMetaByEntityKey: taskMetaChanged
            ? nextTaskMetaByEntityKey
            : state.taskMetaByEntityKey,
          taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
            ? nextTaskUnreadOverlayByEntityKey
            : state.taskUnreadOverlayByEntityKey,
        };
      }),
    setQueryResults: (
      entries: Array<{
        queryKey: TaskListCacheKey;
        descriptor: TaskListCacheDescriptor;
        items: CachedTaskListItem[];
        total: number;
        hasMore: boolean;
        unreadTaskKeys?: TaskEntityKey[];
        partial?: boolean;
        loadingShardKeys?: string[];
        failedShardKeys?: string[];
        expectedInvalidationVersion?: number;
      }>,
    ) =>
      set((state) => {
        if (entries.length === 0) {
          return state;
        }

        const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
        let taskMetaChanged = false;
        let taskUnreadOverlayChanged = false;
        const nextTaskUnreadOverlayByEntityKey = {
          ...state.taskUnreadOverlayByEntityKey,
        };
        const nextResultsByQueryKey = { ...state.resultsByQueryKey };
        let resultsChanged = false;

        for (const entry of entries) {
          const previousResult = state.resultsByQueryKey[entry.queryKey];
          const currentInvalidationVersion = previousResult?.invalidationVersion ?? 0;
          if (
            entry.expectedInvalidationVersion !== undefined &&
            entry.expectedInvalidationVersion !== currentInvalidationVersion
          ) {
            // sessions-index activity 与 tasks-index membership 是异步 join。
            // 在途期间再次失效时，旧结果不能写 entity、释放 unread overlay 或把 query 标 fresh；
            // hook 会按最新 activity/membership revision 自动重算。
            continue;
          }
          const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
          const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
          const incomingTaskKeys = entry.items.map((item) => {
            const entityKey = buildTaskEntityKey(item);
            if (item.searchSnippet) {
              searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
            }
            if (item.searchSnippets?.length) {
              searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
            }
            const existingItem = nextTaskMetaByEntityKey[entityKey];
            const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
              state.taskUnreadOverlayByEntityKey,
              entityKey,
            );
            const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
            const mergedItem = mergeIncomingTaskListItem({
              item,
              existingItem,
              descriptor: entry.descriptor,
              hasUnreadOverlay,
              unreadAtOverlay,
            });
            if (
              hasUnreadOverlay &&
              (unreadAtOverlay === null
                ? typeof item.unreadAt !== "number"
                : item.unreadAt === unreadAtOverlay)
            ) {
              delete nextTaskUnreadOverlayByEntityKey[entityKey];
              taskUnreadOverlayChanged = true;
            }
            if (mergedItem !== existingItem) {
              taskMetaChanged = true;
              nextTaskMetaByEntityKey[entityKey] = mergedItem;
            }
            return entityKey;
          });
          const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
            incomingTaskKeys,
            previousResult,
            taskMetaByEntityKey: nextTaskMetaByEntityKey,
            descriptor: entry.descriptor,
          });

          const resultParams = {
            descriptor: entry.descriptor,
            taskKeys,
            unreadTaskKeys: entry.unreadTaskKeys,
            searchSnippetsByTaskKey:
              Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
            searchSnippetListsByTaskKey:
              Object.keys(searchSnippetListsByTaskKey).length > 0
                ? searchSnippetListsByTaskKey
                : undefined,
            total:
              preservedCount > 0
                ? Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length)
                : entry.total,
            hasMore:
              entry.hasMore ||
              (preservedCount > 0 &&
                Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length) >
                  taskKeys.length),
            partial: entry.partial,
            loadingShardKeys: entry.loadingShardKeys,
            failedShardKeys: entry.failedShardKeys,
            invalidationVersion: currentInvalidationVersion,
          };
          // 与单条 setQueryResult 同一等价短路——内容没变的条目保留旧结果引用。
          if (
            isQueryResultEquivalent({
              previousResult,
              taskKeys,
              unreadTaskKeys: resultParams.unreadTaskKeys,
              searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
              searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
              total: resultParams.total,
              hasMore: resultParams.hasMore,
              partial: entry.partial ?? false,
              loadingShardKeys: entry.loadingShardKeys ?? [],
              failedShardKeys: entry.failedShardKeys ?? [],
            })
          ) {
            continue;
          }
          resultsChanged = true;
          nextResultsByQueryKey[entry.queryKey] = buildCachedTaskListResult(resultParams);
        }

        if (!taskMetaChanged && !resultsChanged && !taskUnreadOverlayChanged) {
          return state;
        }

        return {
          resultsByQueryKey: resultsChanged ? nextResultsByQueryKey : state.resultsByQueryKey,
          taskMetaByEntityKey: taskMetaChanged
            ? nextTaskMetaByEntityKey
            : state.taskMetaByEntityKey,
          taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
            ? nextTaskUnreadOverlayByEntityKey
            : state.taskUnreadOverlayByEntityKey,
        };
      }),
  };
}
