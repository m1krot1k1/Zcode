/**
 * task query cache 的公共入口。
 *
 * 实现位于 `store/task-query-cache/`：descriptor 判定、item 合并、等价短路、
 * 各 action 分组与生命周期 facade 分别维护；本文件只保留对外导出的门面。
 */
export { useTaskQueryCacheStore } from "./task-query-cache/store.js";
export type { TaskListMembershipState } from "./task-query-cache/types.js";
export {
  applyTaskQueryCacheMutation,
  invalidateTaskQueryCacheByScopes,
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  removeTaskFromTaskQueryCaches,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
} from "./task-query-cache/facade.js";
