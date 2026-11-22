import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { getTaskUiState, updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import type { SetFn } from "./types.js";

export function createTaskErrorActions(set: SetFn) {
  return {
    setTaskError: (
      workspacePath: string,
      taskId: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskUiByTaskId: {
              ...current.taskUiByTaskId,
              [taskId]: {
                ...getTaskUiState(current, taskId),
                // 完整错误对象之前只放在 ChatView/useZCodeChat 的本地 state。
                // 一旦切换页面或任务，组件卸载后 traceId/code 就会一起丢失，只剩 taskRuntime.error 的纯文本。
                // 这里改成按 task 写进 store，让错误提示能跟 plan/permission 一样跨页面恢复。
                error,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },
  };
}
