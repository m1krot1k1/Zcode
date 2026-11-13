import type { ZCodeTaskRuntimeStatus, ZCodeWorkspaceInitStatus } from "@zcode/shared";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { getWorkspaceInitState, updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import type { WorkspaceSliceSet } from "./types.js";

export function createWorkspaceInitActions(set: WorkspaceSliceSet) {
  return {
    setWorkspaceInitState: (
      workspacePath: string,
      status: ZCodeWorkspaceInitStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitAttempts: (
      workspacePath: string,
      attempts: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              attempts,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskState: (
      workspacePath: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            draftRuntime: {
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setDraftError: (
      workspacePath: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // 草稿态首发失败时还没有 taskId，错误如果只留在组件内存里，
            // 切到别的页面再回来就看不到了。单独保存一份 workspace 级 draftError，
            // 保证"未建 task 的错误"也能在当前工作区里继续显示。
            draftError: error,
          }),
          workspaceIdentity,
        ),
      );
    },
  };
}
