import type { ZCodeTaskMeta } from "@zcode/shared";
import { updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import type { WorkspaceSliceSet } from "./types.js";

export function createTaskListActions(set: WorkspaceSliceSet) {
  return {
    bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListVersion: current.taskListVersion + 1,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskListCache: (
      workspacePath: string,
      tasks: ZCodeTaskMeta[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListCache: tasks,
            // unread 的真实来源已经统一收敛到 task meta.unreadAt。
            // 这里不再把列表缓存重建成另一份“未读真相源”，避免 cache 刷新和局部 optimistic 更新互相打架。
            taskUnreadByTaskId: current.taskUnreadByTaskId,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskUnreadIndicator: (
      workspacePath: string,
      taskId: string,
      hasUnread: boolean,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTaskMeta = current.optimisticTaskListByTaskId[taskId];
            const cachedTaskMeta = current.taskListCache?.find((task) => task.taskId === taskId);
            const baseTaskMeta = optimisticTaskMeta ?? cachedTaskMeta;
            const currentHasUnread = current.taskUnreadByTaskId[taskId] === true;
            const currentUnreadAt = optimisticTaskMeta?.unreadAt ?? cachedTaskMeta?.unreadAt;

            if (hasUnread) {
              const nextUnreadAt = baseTaskMeta?.unreadAt ?? Date.now();
              if (currentHasUnread && currentUnreadAt === nextUnreadAt) {
                return current;
              }

              const nextOptimisticTaskListByTaskId = baseTaskMeta
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [taskId]: {
                      ...baseTaskMeta,
                      unreadAt: nextUnreadAt,
                    },
                  }
                : current.optimisticTaskListByTaskId;

              return {
                ...current,
                optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
                taskUnreadByTaskId: {
                  ...current.taskUnreadByTaskId,
                  [taskId]: true,
                },
              };
            }

            if (!currentHasUnread && currentUnreadAt === undefined) {
              // 权限确认后本地响应和 stream 响应都会清一次未读。
              // 已经是已读时直接复用 workspace state，避免任务列表和 ChatView 被无意义刷新。
              return current;
            }

            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const nextOptimisticTaskListByTaskId = baseTaskMeta
              ? {
                  ...current.optimisticTaskListByTaskId,
                  [taskId]: {
                    ...baseTaskMeta,
                    unreadAt: undefined,
                  },
                }
              : current.optimisticTaskListByTaskId;

            return {
              ...current,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
