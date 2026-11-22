import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { notifyTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";
import { useTaskQueryCacheStore } from "./store.js";
import type { TaskListMembershipState } from "./types.js";

export function invalidateTaskQueryCacheByScopes(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().invalidateWorkspaceKeys(workspaceKeys);
}

export function markTaskQueryCacheScopesStale(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().markWorkspaceKeysStale(workspaceKeys);
}

export function upsertTaskQueryCacheTaskMeta(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().upsertTaskMeta(task);
}

export function updateTaskQueryCacheTaskMetaPreservingMembership(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().updateTaskMetaPreservingMembership(task);
}

export function applyTaskQueryCacheMutation(params: {
  previousTask: ZCodeTaskMeta;
  nextTask: ZCodeTaskMeta;
  previousState: TaskListMembershipState;
  nextState: TaskListMembershipState;
}): void {
  useTaskQueryCacheStore.getState().applyTaskMutation(params);
  if (!params.previousState.archived && params.nextState.archived) {
    notifyTaskLifecycle({
      type: "archived",
      taskId: params.nextTask.taskId,
      workspaceKey: buildTaskWorkspaceKey(
        params.nextTask.workspacePath,
        params.nextTask.workspaceIdentity,
      ),
    });
  }
}

export function setTaskQueryCacheUnreadOverlay(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().setTaskUnreadOverlay(task, unreadAt);
}

export function reconcileTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().reconcileTaskUnread(task, unreadAt);
}

export function rollbackTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().rollbackTaskUnread(task, unreadAt);
}

export function removeTaskFromTaskQueryCaches(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): boolean {
  const removed = useTaskQueryCacheStore.getState().removeTask(task);
  notifyTaskLifecycle({
    type: "deleted",
    taskId: task.taskId,
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  });
  return removed;
}

// 内存诊断计数器：版本化 queryKey 只增不删，先落日志。
uiMemoryDiagnosticsRegistry.register("taskQueryCache", () => {
  const state = useTaskQueryCacheStore.getState();
  return {
    queryKeys: Object.keys(state.resultsByQueryKey).length,
    taskMetas: Object.keys(state.taskMetaByEntityKey).length,
  };
});
