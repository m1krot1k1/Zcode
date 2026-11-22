import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildTaskEntityKey,
  type CachedTaskListResult,
  type TaskListCacheKey,
} from "@/lib/taskQueryCache.js";
import type { SetFn } from "./types.js";

type TaskIdentity = Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">;

/** 删除单条 task、按 workspace 标脏/失效以及整表清理。 */
export function createCacheMaintenanceActions(set: SetFn) {
  return {
    removeTask: (task: TaskIdentity) => {
      let removedFromVisibleCache = false;
      set((state) => {
        const entityKey = buildTaskEntityKey(task);
        if (!state.taskMetaByEntityKey[entityKey]) {
          const hasCachedResult = Object.values(state.resultsByQueryKey).some((result) =>
            result.taskKeys.includes(entityKey),
          );
          if (!hasCachedResult) {
            return state;
          }
        }

        const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
        delete nextTaskMetaByEntityKey[entityKey];
        const nextTaskUnreadOverlayByEntityKey = {
          ...state.taskUnreadOverlayByEntityKey,
        };
        delete nextTaskUnreadOverlayByEntityKey[entityKey];

        const nextResultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult> = {};
        for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
          if (!result.taskKeys.includes(entityKey)) {
            nextResultsByQueryKey[queryKey] = result;
            continue;
          }

          const taskKeys = result.taskKeys.filter((taskKey) => taskKey !== entityKey);
          removedFromVisibleCache = true;
          // 删除 task 以前只能整表刷新；这里只对实际可见缓存命中的列表扣减 total。
          // 对未出现在折叠可见区的隐藏项不猜 membership，避免误扣其它列表计数。
          const total = Math.max(0, result.total - 1);
          nextResultsByQueryKey[queryKey] = {
            ...result,
            taskKeys,
            total,
            hasMore: total > taskKeys.length,
          };
        }

        return {
          resultsByQueryKey: nextResultsByQueryKey,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          taskUnreadOverlayByEntityKey: nextTaskUnreadOverlayByEntityKey,
        };
      });
      return removedFromVisibleCache;
    },
    markWorkspaceKeysStale: (workspaceKeys: string[]) =>
      set((state) => {
        if (workspaceKeys.length === 0) {
          return state;
        }

        const staleWorkspaceKeySet = new Set(workspaceKeys);
        const nextResultsByQueryKey = { ...state.resultsByQueryKey };
        let changed = false;

        for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
          if (
            !result.descriptor.workspaceKeys.some((workspaceKey) =>
              staleWorkspaceKeySet.has(workspaceKey),
            )
          ) {
            continue;
          }

          // 删除折叠/分页隐藏 task 时无法只靠 taskId 安全扣 total。
          // 这里保留当前可见列表，只标脏匹配 workspace，让 hook 的下一轮 effect 真正回源刷新计数。
          nextResultsByQueryKey[queryKey] = {
            ...result,
            invalidationVersion: result.invalidationVersion + 1,
            stale: true,
          };
          changed = true;
        }

        if (!changed) {
          return state;
        }

        return {
          resultsByQueryKey: nextResultsByQueryKey,
        };
      }),
    invalidateWorkspaceKeys: (workspaceKeys: string[]) =>
      set((state) => {
        if (workspaceKeys.length === 0) {
          return state;
        }

        const invalidatedWorkspaceKeySet = new Set(workspaceKeys);
        const nextResultsByQueryKey = Object.fromEntries(
          Object.entries(state.resultsByQueryKey).filter(([queryKey]) => {
            return ![...invalidatedWorkspaceKeySet].some(
              (workspaceKey) =>
                queryKey.includes(`workspaces=${workspaceKey}`) ||
                queryKey.includes(`|${workspaceKey}`),
            );
          }),
        );
        const nextTaskMetaByEntityKey = Object.fromEntries(
          Object.entries(state.taskMetaByEntityKey).filter(([entityKey]) => {
            const workspaceKey = entityKey.split("::")[0] ?? "";
            return !invalidatedWorkspaceKeySet.has(workspaceKey);
          }),
        );

        return {
          resultsByQueryKey: nextResultsByQueryKey,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
        };
      }),
    clearAll: () =>
      set(() => ({
        // clearAll 是 Zustand action，必须通过 set 写回 store。
        // 之前只返回对象，测试和开发态清理 query cache 时旧 task meta 会继续残留。
        resultsByQueryKey: {},
        taskMetaByEntityKey: {},
        taskUnreadOverlayByEntityKey: {},
      })),
  };
}
