import { pushNavEntry } from "@/lib/taskNavigationHistory.js";
import { notifyTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import type { ComposerInitialConfig } from "@/store/zcodeSessionStoreTypes.js";
import { resolveActiveTaskConfigOptionsOnSwitch } from "./active-task-config.js";
import type { WorkspaceSliceSet } from "./types.js";

export function createTaskNavigationActions(set: WorkspaceSliceSet) {
  return {
    setActiveTaskId: (
      workspacePath: string,
      id: string | null,
      workspaceIdentity?: string,
      composerConfig?: ComposerInitialConfig,
    ) => {
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [id ?? ""]: _ignoredUnreadTask, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const optimisticTask = id ? current.optimisticTaskListByTaskId[id] : undefined;
            const nextOptimisticTaskListByTaskId =
              id && typeof optimisticTask?.unreadAt === "number"
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [id]: {
                      ...optimisticTask,
                      // 右键标记未读会把 unreadAt 同时写进 optimistic task；
                      // 之前重复打开当前 task 只清旧 unread map，列表合并又从 optimistic task
                      // 把蓝点写回来。打开 task 时必须在同一个 workspace 事务里清掉这份投影。
                      unreadAt: undefined,
                    },
                  }
                : current.optimisticTaskListByTaskId;
            const activeTaskId = id;
            const activeTaskConfig = activeTaskId
              ? resolveActiveTaskConfigOptionsOnSwitch(current, activeTaskId)
              : null;
            const nextState = {
              ...current,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              activeTaskId: id,
              composerInitialization:
                id && composerConfig
                  ? { taskId: id, config: composerConfig }
                  : current.activeTaskId === id
                    ? current.composerInitialization
                    : undefined,
            };
            return activeTaskId && activeTaskConfig
              ? {
                  ...nextState,
                  taskConfigOptionsByTaskId: {
                    ...current.taskConfigOptionsByTaskId,
                    [activeTaskId]: activeTaskConfig.configOptions,
                  },
                  taskConfigOptionsStatusByTaskId: {
                    ...current.taskConfigOptionsStatusByTaskId,
                    [activeTaskId]: activeTaskConfig.status,
                  },
                }
              : nextState;
          },
          workspaceIdentity,
        );

        const navUpdate = id
          ? {
              taskNavHistory: pushNavEntry(
                state.taskNavHistory,
                workspacePath,
                id,
                workspaceIdentity,
              ),
            }
          : {};

        return { ...workspaceUpdate, ...navUpdate };
      });
      if (id) notifyTaskNavigationCommitted({ workspacePath, workspaceIdentity, taskId: id });
    },
  };
}
