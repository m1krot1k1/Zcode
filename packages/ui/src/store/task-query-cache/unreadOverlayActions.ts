import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import type { SetFn } from "./types.js";

type TaskIdentity = Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">;

/** unread overlay 的乐观写入、服务端确认与回滚。 */
export function createUnreadOverlayActions(set: SetFn) {
  return {
    setTaskUnreadOverlay: (task: TaskIdentity, unreadAt: number | undefined) =>
      set((state) => {
        const entityKey = buildTaskEntityKey(task);
        const existingTask = state.taskMetaByEntityKey[entityKey];
        return {
          taskUnreadOverlayByEntityKey: {
            ...state.taskUnreadOverlayByEntityKey,
            [entityKey]: unreadAt ?? null,
          },
          taskMetaByEntityKey: existingTask
            ? {
                ...state.taskMetaByEntityKey,
                [entityKey]: {
                  ...existingTask,
                  unreadAt,
                },
              }
            : state.taskMetaByEntityKey,
        };
      }),
    reconcileTaskUnread: (task: TaskIdentity, unreadAt: number | undefined) =>
      set((state) => {
        const entityKey = buildTaskEntityKey(task);
        const existingTask = state.taskMetaByEntityKey[entityKey];
        // 服务端回包只确认 mutation 已持久化；旧 membership 请求仍可能稍后返回。
        // 把 overlay 更新成服务端值，直到 setQueryResult 观察到同值后再自动释放。
        return {
          taskUnreadOverlayByEntityKey: {
            ...state.taskUnreadOverlayByEntityKey,
            [entityKey]: unreadAt ?? null,
          },
          taskMetaByEntityKey: existingTask
            ? {
                ...state.taskMetaByEntityKey,
                [entityKey]: {
                  ...existingTask,
                  unreadAt,
                },
              }
            : state.taskMetaByEntityKey,
        };
      }),
    rollbackTaskUnread: (task: TaskIdentity, unreadAt: number | undefined) =>
      set((state) => {
        const entityKey = buildTaskEntityKey(task);
        const existingTask = state.taskMetaByEntityKey[entityKey];
        const nextOverlays = { ...state.taskUnreadOverlayByEntityKey };
        delete nextOverlays[entityKey];
        return {
          taskUnreadOverlayByEntityKey: nextOverlays,
          taskMetaByEntityKey: existingTask
            ? {
                ...state.taskMetaByEntityKey,
                [entityKey]: {
                  ...existingTask,
                  unreadAt,
                },
              }
            : state.taskMetaByEntityKey,
        };
      }),
  };
}
