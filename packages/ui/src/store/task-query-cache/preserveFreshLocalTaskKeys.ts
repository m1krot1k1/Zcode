import type {
  CachedTaskListResult,
  TaskEntityKey,
  TaskListCacheDescriptor,
} from "@/lib/taskQueryCache.js";
import { sortTaskKeysByDescriptor } from "./taskListMatching.js";
import type { CachedTaskListItem } from "./types.js";

export function preserveFreshLocalTaskKeys(params: {
  incomingTaskKeys: TaskEntityKey[];
  previousResult: CachedTaskListResult | undefined;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): { taskKeys: TaskEntityKey[]; preservedCount: number } {
  if (!params.previousResult || params.descriptor.search) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const previousResult = params.previousResult;
  const incomingTaskKeySet = new Set(params.incomingTaskKeys);
  const preservedTaskKeys = previousResult.taskKeys.filter((taskKey) => {
    if (incomingTaskKeySet.has(taskKey)) {
      return false;
    }
    const task = params.taskMetaByEntityKey[taskKey];
    return Boolean(task && task.updatedAt > previousResult.fetchedAt);
  });
  if (preservedTaskKeys.length === 0) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const sortedTaskKeys = sortTaskKeysByDescriptor({
    // sqlite 列表刷新可能晚于首发 optimistic 插入。
    // 只有本地更新时间新于上一轮列表快照的 key 才临时保留，避免旧刷新把新 task 从侧栏抹掉。
    taskKeys: [...params.incomingTaskKeys, ...preservedTaskKeys],
    taskMetaByEntityKey: params.taskMetaByEntityKey,
    descriptor: params.descriptor,
  });
  const visibleTaskKeys =
    params.descriptor.visibleLimit === null
      ? sortedTaskKeys
      : sortedTaskKeys.slice(0, params.descriptor.visibleLimit);
  return {
    taskKeys: visibleTaskKeys,
    preservedCount: preservedTaskKeys.length,
  };
}
