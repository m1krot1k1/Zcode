import {
  normalizeAgentProviderToZCodeAgent,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { removeTaskFromHistory } from "@/lib/taskNavigationHistory.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import { clearPersistedComposerDraft } from "@/lib/chatComposerDraftStorage.js";
import { getTaskRuntimeState, updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import type { SetFn } from "./types.js";
import { sortTasksByUpdatedAt } from "./workspaceUpdates.js";

export function createTaskListActions(set: SetFn) {
  return {
    initializeBackgroundTaskRuntime: (
      workspacePath: string,
      params: {
        task: ZCodeTaskMeta;
        provider: ZCodeProvider;
        activeInputId: string;
        workspaceIdentity?: string;
      },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[params.task.taskId];
            const nextTask = existingTask
              ? mergeTaskWithOptimisticMeta(params.task, existingTask)
              : params.task;
            const currentTaskRuntime = getTaskRuntimeState(current, params.task.taskId);
            const cachedTasks = current.taskListCache ?? [];
            const nextTaskListCache =
              current.taskListCache === null
                ? current.taskListCache
                : sortTasksByUpdatedAt([
                    nextTask,
                    ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== params.task.taskId),
                  ]);

            return {
              ...current,
              selectedProvider: normalizeAgentProviderToZCodeAgent(params.provider),
              // 性能优化：后台首发不需要先经历 optimistic -> cache -> runtime 多轮 set。
              // 合到一次写入可以削掉并发压测创建任务时的 renderer 订阅风暴。
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                [params.task.taskId]: nextTask,
              },
              taskListCache: nextTaskListCache,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [params.task.taskId]: {
                  ...currentTaskRuntime,
                  status: "streaming",
                  error: null,
                  provider: params.provider,
                  activeInputId: params.activeInputId,
                },
              },
            };
          },
          params.workspaceIdentity ?? params.task.workspaceIdentity,
        ),
      );
    },

    upsertOptimisticTaskListItem: (
      workspacePath: string,
      task: ZCodeTaskMeta,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[task.taskId];
            const nextTask = existingTask ? mergeTaskWithOptimisticMeta(task, existingTask) : task;

            return {
              ...current,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // desktop-continuous 的 readSession 快照可能旧于首发 optimistic Date.now()。
                // 这里按 updatedAt 单调合并，避免旧快照把新 task 压回列表下面。
                [task.taskId]: nextTask,
              },
            };
          },
          workspaceIdentity ?? task.workspaceIdentity,
        ),
      );
    },

    removeOptimisticTaskListItem: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;
            return {
              ...current,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      // task 删除会清内存 task state，但 composer 草稿还有桌面端 localStorage 桶。
      // 如果不在统一删除 action 里同步清理，重启后已删除 task 的草稿会继续残留。
      clearPersistedComposerDraft(workspacePath, taskId, workspaceIdentity);
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskRuntime, ...restTaskRuntimeByTaskId } =
              current.taskRuntimeByTaskId;
            const { [taskId]: _removedTaskUi, ...restTaskUiByTaskId } = current.taskUiByTaskId;
            const { [taskId]: _removedTaskConfigOptions, ...restTaskConfigOptionsByTaskId } =
              current.taskConfigOptionsByTaskId;
            const {
              [taskId]: _removedTaskConfigOptionsStatus,
              ...restTaskConfigOptionsStatusByTaskId
            } = current.taskConfigOptionsStatusByTaskId;
            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;

            const shouldCloseDeletedTask = current.activeTaskId === taskId;

            // 删除左侧当前正在查看的任务时，之前只更新了任务列表数据，
            // workspace 里的 activeTaskId 仍指向已删除 task，右侧主区就会继续按旧 taskId 渲染详情。
            // 这里在删除成功后统一回收选中态和运行态，让主区域立即退出这条已删除任务。
            return {
              ...current,
              activeTaskId: shouldCloseDeletedTask ? null : current.activeTaskId,
              draftRuntime: shouldCloseDeletedTask
                ? { status: "idle", error: null }
                : current.draftRuntime,
              taskRuntimeByTaskId: restTaskRuntimeByTaskId,
              taskUiByTaskId: restTaskUiByTaskId,
              taskConfigOptionsByTaskId: restTaskConfigOptionsByTaskId,
              taskConfigOptionsStatusByTaskId: restTaskConfigOptionsStatusByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        );

        return {
          ...workspaceUpdate,
          taskNavHistory: removeTaskFromHistory(state.taskNavHistory, taskId),
        };
      });
    },
  };
}
