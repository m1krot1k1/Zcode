import type { ZCodePermissionRequest } from "@zcode/shared";
import { getTaskUiState, updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import { arePermissionRequestsEquivalent } from "./equality.js";
import type { SetFn } from "./types.js";

export function createTaskPermissionActions(set: SetFn) {
  return {
    setTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodePermissionRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (request === null) {
              if (
                taskUiState.permissionRequest === null &&
                taskUiState.pendingPermissionRequests.length === 0
              ) {
                return current;
              }

              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: null,
                    pendingPermissionRequests: [],
                  },
                },
              };
            }

            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            let nextPermissionRequest = currentPermissionRequest;
            let nextPendingPermissionRequests = pendingPermissionRequests;

            if (currentPermissionRequest?.requestId === request.requestId) {
              if (arePermissionRequestsEquivalent(currentPermissionRequest, request)) {
                return current;
              }
              nextPermissionRequest = request;
            } else if (currentPermissionRequest === null) {
              nextPermissionRequest = request;
              nextPendingPermissionRequests = pendingPermissionRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              const existingPendingIndex = pendingPermissionRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                const existingPendingRequest = pendingPermissionRequests[existingPendingIndex];
                if (!existingPendingRequest) {
                  return current;
                }
                if (arePermissionRequestsEquivalent(existingPendingRequest, request)) {
                  return current;
                }
                nextPendingPermissionRequests = pendingPermissionRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                // 同一 task 里可能连续出现多个权限请求。只有一个 permissionRequest 字段时，
                // 后到的请求会直接覆盖前一个，导致前面的 pending 权限永远没人响应，任务表面上像是“卡住”。
                // 这里把后续请求按 task 入队，保证用户确认当前请求后，下一个还能自动顶上来继续处理。
                nextPendingPermissionRequests = [...pendingPermissionRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  permissionRequest: nextPermissionRequest,
                  pendingPermissionRequests: nextPendingPermissionRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            if (currentPermissionRequest?.requestId === requestId) {
              const [nextPermissionRequest, ...restPendingPermissionRequests] =
                pendingPermissionRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: nextPermissionRequest ?? null,
                    pendingPermissionRequests: restPendingPermissionRequests,
                  },
                },
              };
            }

            const pendingPermissionIndex = pendingPermissionRequests.findIndex(
              (item) => item.requestId === requestId,
            );
            if (pendingPermissionIndex < 0) {
              // 权限响应会走本地乐观清理，也会再收到一次 stream 回放的 permission_response。
              // 第二次清理如果继续重建 taskUiState，会触发 ChatView 和权限预览树无意义重渲染，导致确认后 CPU 飙高。
              return current;
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingPermissionRequests: pendingPermissionRequests.filter(
                    (_item, index) => index !== pendingPermissionIndex,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
