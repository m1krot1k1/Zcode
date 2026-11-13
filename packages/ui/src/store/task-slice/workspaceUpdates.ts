import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ZCodeSessionStoreState } from "@/store/zcodeSessionStoreTypes.js";
import { getDefaultWorkspaceState } from "@/store/zcodeSessionStoreTypes.js";
import {
  resolveWorkspaceStateKey,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

export function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

export function normalizeTaskContextWindow(contextWindow: number | null): number | null {
  if (contextWindow === null) {
    return null;
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.floor(contextWindow);
}

export function updateWorkspaceStateForIdentityScopedTaskState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  updater: (
    current: ReturnType<typeof getDefaultWorkspaceState>,
  ) => ReturnType<typeof getDefaultWorkspaceState>,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return updateWorkspaceState(state, workspacePath, updater);
  }
  const current = state.workspaces[workspaceKey] ?? getDefaultWorkspaceState();
  return {
    workspaces: {
      ...state.workspaces,
      [workspaceKey]: updater(current),
    },
  };
}
