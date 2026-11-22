import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildTaskEntityKey,
  type CachedTaskListResult,
  type TaskListCacheKey,
} from "@/lib/taskQueryCache.js";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { getTaskListRowActivity, mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import { matchesTaskDescriptor, sortTaskKeysByDescriptor } from "./taskListMatching.js";
import type { SetFn, TaskListMembershipState } from "./types.js";

/** task meta 的写入、成员关系保留与 pinned/archived mutation。 */
export function createTaskMetaActions(set: SetFn) {
  return {
    upsertTaskMeta: (task: ZCodeTaskMeta) =>
      set((state) => {
        const entityKey = buildTaskEntityKey(task);
        const existingTask = state.taskMetaByEntityKey[entityKey];
        // 重启恢复时 raw session snapshot 可能先于列表刷新写入 query cache。
        // 这里必须和已有 indexed meta 合并，避免缺少 titleOverridden 的 snapshot 把用户手动标题覆盖掉。
        const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
        const nextTask = getTaskListRowActivity(task)
          ? mergeTaskListMembershipFields(task, mergedTask)
          : existingTask
            ? mergeTaskListMembershipFields(existingTask, mergedTask)
            : mergedTask;
        return {
          ...state,
          taskMetaByEntityKey: {
            ...state.taskMetaByEntityKey,
            [entityKey]: nextTask,
          },
        };
      }),
    updateTaskMetaPreservingMembership: (task: ZCodeTaskMeta) =>
      set((state) => {
        const entityKey = buildTaskEntityKey(task);
        const existingTask = state.taskMetaByEntityKey[entityKey];
        // workspace_task_list_changed 可能携带 runtime snapshot 投影标题。
        // 保留 query cache 里已存在的手动重命名事实源，只用新 meta 补 status/updatedAt 等运行态字段。
        const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
        // workspace_task_list_changed 带来的 tasks-index updatedAt
        // 只是 metadata 更新，不是用户真实会话活动。已有 sessions-index sidecar 时
        // 只合并 membership/meta 字段，否则 rename/unread 会让任务错误跳到顶部。
        const nextTask = existingTask
          ? mergeTaskListMembershipFields(existingTask, mergedTask)
          : mergedTask;
        const nextTaskMetaByEntityKey = {
          ...state.taskMetaByEntityKey,
          [entityKey]: nextTask,
        };
        const nextResultsByQueryKey = { ...state.resultsByQueryKey };

        for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
          if (!result.taskKeys.includes(entityKey)) {
            continue;
          }

          // workspace_task_list_changed 的 meta 增量只说明任务内容/状态变化，
          // 不代表 pinned/archived 成员关系变化；因此只重排已经包含该任务的列表，不能把它从 pinned 区移走。
          nextResultsByQueryKey[queryKey] = {
            ...result,
            taskKeys: sortTaskKeysByDescriptor({
              taskKeys: result.taskKeys,
              taskMetaByEntityKey: nextTaskMetaByEntityKey,
              descriptor: result.descriptor,
            }),
          };
        }

        return {
          resultsByQueryKey: nextResultsByQueryKey,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
        };
      }),
    applyTaskMutation: ({
      previousTask,
      nextTask,
      previousState,
      nextState,
    }: {
      previousTask: ZCodeTaskMeta;
      nextTask: ZCodeTaskMeta;
      previousState: TaskListMembershipState;
      nextState: TaskListMembershipState;
    }) =>
      set((state) => {
        const previousEntityKey = buildTaskEntityKey(previousTask);
        const nextEntityKey = buildTaskEntityKey(nextTask);
        const existingTask =
          state.taskMetaByEntityKey[nextEntityKey] ?? state.taskMetaByEntityKey[previousEntityKey];
        const mergedNextTask = existingTask
          ? mergeTaskListMembershipFields(existingTask, nextTask)
          : nextTask;
        const nextTaskMetaByEntityKey = {
          ...state.taskMetaByEntityKey,
          [nextEntityKey]: mergedNextTask,
        };
        if (previousEntityKey !== nextEntityKey) {
          delete nextTaskMetaByEntityKey[previousEntityKey];
        }

        const nextResultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult> = {
          ...state.resultsByQueryKey,
        };
        for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
          if (result.descriptor.search) {
            // 正文搜索结果由服务端 sqlite searchable_text 决定，前端缓存只有 task meta/title，
            // 不能用 title-only 规则判断增量列表成员资格；否则正文命中的会话会被本地缓存误判为不匹配。
            nextResultsByQueryKey[queryKey] = {
              ...result,
              invalidationVersion: result.invalidationVersion + 1,
              stale: true,
            };
            continue;
          }

          const previousIncluded = matchesTaskDescriptor(
            result.descriptor,
            previousTask,
            previousState,
          );
          const nextIncluded = matchesTaskDescriptor(result.descriptor, nextTask, nextState);
          const wasVisible =
            result.taskKeys.includes(previousEntityKey) || result.taskKeys.includes(nextEntityKey);

          if (!previousIncluded && !nextIncluded && !wasVisible) {
            continue;
          }

          const taskKeysWithoutTarget = result.taskKeys.filter(
            (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
          );
          const unreadTaskKeysWithoutTarget = (result.unreadTaskKeys ?? []).filter(
            (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
          );
          const visibleCandidateKeys = nextIncluded
            ? [...taskKeysWithoutTarget, nextEntityKey]
            : taskKeysWithoutTarget;
          const nextUnreadTaskKeys =
            nextIncluded && typeof mergedNextTask.unreadAt === "number"
              ? [...unreadTaskKeysWithoutTarget, nextEntityKey]
              : unreadTaskKeysWithoutTarget;
          const sortedTaskKeys = sortTaskKeysByDescriptor({
            taskKeys: visibleCandidateKeys,
            taskMetaByEntityKey: nextTaskMetaByEntityKey,
            descriptor: result.descriptor,
          });
          const visibleTaskKeys =
            result.descriptor.visibleLimit === null
              ? sortedTaskKeys
              : sortedTaskKeys.slice(0, result.descriptor.visibleLimit);
          const nextTotal = Math.max(
            0,
            result.total + Number(nextIncluded) - Number(previousIncluded),
          );
          const shouldBackgroundRefresh =
            result.descriptor.visibleLimit !== null &&
            previousIncluded !== nextIncluded &&
            nextTotal > visibleTaskKeys.length;

          nextResultsByQueryKey[queryKey] = {
            ...result,
            taskKeys: visibleTaskKeys,
            ...(result.unreadTaskKeys ? { unreadTaskKeys: nextUnreadTaskKeys } : {}),
            total: nextTotal,
            hasMore: nextTotal > visibleTaskKeys.length,
            stale: result.stale || shouldBackgroundRefresh,
          };
        }

        return {
          resultsByQueryKey: nextResultsByQueryKey,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
        };
      }),
  };
}
