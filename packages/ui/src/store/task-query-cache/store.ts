import { create } from "zustand";
import { createCacheMaintenanceActions } from "./cacheMaintenanceActions.js";
import { createQueryResultActions } from "./queryResultActions.js";
import { createTaskMetaActions } from "./taskMetaActions.js";
import type { TaskQueryCacheState } from "./types.js";
import { createUnreadOverlayActions } from "./unreadOverlayActions.js";

/**
 * task query cache store。
 *
 * action 按原文件的键顺序合并：查询结果 → task meta → unread overlay → 缓存清理，
 * 保证 Zustand 状态键顺序和写入语义不变。
 */
export const useTaskQueryCacheStore = create<TaskQueryCacheState>()((set) => ({
  resultsByQueryKey: {},
  taskMetaByEntityKey: {},
  taskUnreadOverlayByEntityKey: {},
  ...createQueryResultActions(set),
  ...createTaskMetaActions(set),
  ...createUnreadOverlayActions(set),
  ...createCacheMaintenanceActions(set),
}));
