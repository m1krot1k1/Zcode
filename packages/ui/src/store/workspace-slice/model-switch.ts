import { updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import type { ModelSwitchStage } from "@/store/zcodeSessionStoreTypes.js";
import type { WorkspaceSliceSet } from "./types.js";

export function createModelSwitchActions(set: WorkspaceSliceSet) {
  return {
    startModelSwitch: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage = "settingModel",
      workspaceIdentity?: string,
      options?: { pending?: boolean },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            modelSwitchRequestId: requestId,
            // 普通 session/setModel 已经先乐观更新 UI，只需要 requestId 防止旧回包覆盖新选择。
            // 只有 custom provider、runtime restart 等重路径才需要把 toolbar 置为 loading。
            modelSwitchPending: options?.pending ?? true,
            modelSwitchStage: stage,
          }),
          workspaceIdentity,
        ),
      );
    },

    updateModelSwitchStage: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchStage: stage,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
