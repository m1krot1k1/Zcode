import type {
  CachedTaskListResult,
  TaskEntityKey,
  TaskListCacheDescriptor,
} from "@/lib/taskQueryCache.js";

export function buildCachedTaskListResult(params: {
  descriptor: TaskListCacheDescriptor;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial?: boolean;
  loadingShardKeys?: string[];
  failedShardKeys?: string[];
  invalidationVersion?: number;
}): CachedTaskListResult {
  return {
    taskKeys: params.taskKeys,
    unreadTaskKeys: params.unreadTaskKeys,
    searchSnippetsByTaskKey: params.searchSnippetsByTaskKey,
    searchSnippetListsByTaskKey: params.searchSnippetListsByTaskKey,
    total: params.total,
    hasMore: params.hasMore,
    fetchedAt: Date.now(),
    invalidationVersion: params.invalidationVersion ?? 0,
    stale: false,
    partial: params.partial ?? false,
    loadingShardKeys: params.loadingShardKeys ?? [],
    failedShardKeys: params.failedShardKeys ?? [],
    descriptor: params.descriptor,
  };
}

// republish 内容与现缓存完全等价时，直接跳过整个 setState，
// 避免 resultsByQueryKey/taskMetaByEntityKey 换新引用引发全列表无效重渲染。
// fetchedAt/stale 不参与比较（保留旧值不影响正确性，preserve 窗口只会更保守）。
export function isQueryResultEquivalent(params: {
  previousResult: CachedTaskListResult | undefined;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
}): boolean {
  const previous = params.previousResult;
  if (!previous || previous.stale) {
    return false;
  }
  if (
    previous.total !== params.total ||
    previous.hasMore !== params.hasMore ||
    previous.partial !== params.partial
  ) {
    return false;
  }
  if (
    previous.taskKeys.length !== params.taskKeys.length ||
    previous.taskKeys.some((taskKey, index) => taskKey !== params.taskKeys[index])
  ) {
    return false;
  }
  const sameStringArray = (left: string[], right: string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  if (
    !sameStringArray(previous.unreadTaskKeys ?? [], params.unreadTaskKeys ?? []) ||
    !sameStringArray(previous.loadingShardKeys, params.loadingShardKeys) ||
    !sameStringArray(previous.failedShardKeys, params.failedShardKeys)
  ) {
    return false;
  }
  return (
    JSON.stringify(previous.searchSnippetsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetsByTaskKey ?? null) &&
    JSON.stringify(previous.searchSnippetListsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetListsByTaskKey ?? null)
  );
}
