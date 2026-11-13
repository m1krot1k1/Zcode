import { updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import type {
  ComposerInitialization,
  ComposerMentionPrefill,
} from "@/store/zcodeSessionStoreTypes.js";
import type { WorkspaceSliceSet } from "./types.js";

export function createComposerActions(set: WorkspaceSliceSet) {
  return {
    invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // 预热会话只存在于 V4 pane 内；递增版本让 owner 回收并重建能力快照。
            draftRuntimeInvalidationVersion: current.draftRuntimeInvalidationVersion + 1,
          }),
          workspaceIdentity,
        ),
      );
    },

    requestComposerTextInsert: (
      workspacePath: string,
      text: string,
      workspaceIdentity?: string,
      mention?: ComposerMentionPrefill,
      mode?: "replace" | "prepend-if-missing",
    ) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.composerTextInsertVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              composerTextInsertVersion: requestId,
              composerTextInsertRequest: {
                requestId,
                text,
                ...(mention ? { mention } : {}),
                ...(mode ? { mode } : {}),
              },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearComposerTextInsertRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.composerTextInsertRequest?.requestId === requestId
              ? { ...current, composerTextInsertRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    requestTimelineBottom: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.timelineBottomRequestVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              timelineBottomRequestVersion: requestId,
              timelineBottomRequest: { requestId, taskId },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearTimelineBottomRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.timelineBottomRequest?.requestId === requestId
              ? { ...current, timelineBottomRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    consumeComposerInitialization: (
      workspacePath: string,
      initialization: ComposerInitialization,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.composerInitialization === initialization
              ? { ...current, composerInitialization: undefined }
              : current,
          workspaceIdentity,
        ),
      );
    },

    clearDraftTaskGroup: (workspacePath: string, workspaceIdentity?: string) => {
      // 关闭分组行只撤销组织意图；调用 startDraft 会重置预热、配置和焦点。
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.draftTaskGroupId === undefined
              ? current
              : { ...current, draftTaskGroupId: undefined },
          workspaceIdentity,
        ),
      );
    },
  };
}
