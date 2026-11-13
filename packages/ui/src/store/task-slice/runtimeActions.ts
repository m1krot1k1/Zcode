import {
  type ZCodeApiRetryStatus,
  type ZCodeConfigOption,
  type ZCodeProvider,
  type ZCodeTaskRuntimeStatus,
} from "@zcode/shared";
import type { ConfigOptionsStatus, TaskUsageState } from "@/store/zcodeSessionStoreTypes.js";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import {
  getTaskRuntimeState,
  getWorkspaceState,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";
import { areTaskUsageStatesEqual } from "./equality.js";
import type { SetFn } from "./types.js";
import {
  normalizeTaskContextWindow,
  updateWorkspaceStateForIdentityScopedTaskState,
} from "./workspaceUpdates.js";

export function createTaskRuntimeActions(set: SetFn) {
  return {
    setTaskRuntimeState: (
      workspacePath: string,
      taskId: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
      provider?: ZCodeProvider,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const currentTaskRuntime = getTaskRuntimeState(current, taskId);
            const isRunningStatus =
              status === "creating" || status === "restoring" || status === "streaming";
            const nextTaskRuntime = {
              ...currentTaskRuntime,
              status,
              error: error ?? null,
              provider: provider ?? currentTaskRuntime.provider,
              // activeInputId 是当前生成轮次的命令路由标识。
              // 终态/非运行态如果继续保留旧 inputId，移动端只靠快照补齐时会把已结束任务误判成仍在 loading。
              // activeTurnKind 同样是 session 运行态；compact 完成后必须清掉，
              // 否则 app 层会继续把同一 task 的发送误判为“压缩中”并吞掉。
              activeTurnKind: isRunningStatus ? currentTaskRuntime.activeTurnKind : undefined,
              activeInputId: isRunningStatus ? currentTaskRuntime.activeInputId : undefined,
              activeInputOwnerClientId: isRunningStatus
                ? currentTaskRuntime.activeInputOwnerClientId
                : undefined,
            };
            return {
              ...current,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [taskId]: nextTaskRuntime,
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskUsage: (
      workspacePath: string,
      taskId: string,
      usage: TaskUsageState | null,
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        if (areTaskUsageStatesEqual(currentRuntime.usage, usage)) {
          // usage_update 在流式期间可能以相同数值重复到达。
          // 如果继续创建新的 workspace/taskRuntime 对象，React 会被无意义唤醒并造成掉帧。
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                usage,
              },
            },
          }),
        );
      });
    },

    setTaskContextWindow: (
      workspacePath: string,
      taskId: string,
      contextWindow: number | null,
      workspaceIdentity?: string,
    ) => {
      const normalizedContextWindow = normalizeTaskContextWindow(contextWindow);
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        if (currentRuntime.contextWindow === normalizedContextWindow) {
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                // contextWindow 来自模型状态，usage.used 来自运行时 token 统计。
                // 两者流式到达顺序不同，窗口刷新不能重建 usage 对象，否则会把正数 used 覆盖成 0。
                contextWindow: normalizedContextWindow,
              },
            },
          }),
        );
      });
    },

    setTaskApiRetryStatus: (
      workspacePath: string,
      taskId: string,
      apiRetry: ZCodeApiRetryStatus | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                apiRetry,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskConfigOptions: (
      workspacePath: string,
      taskId: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
      status: ConfigOptionsStatus = "ready",
    ) => {
      const normalizedOptions = [...options];
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentOptions = current.taskConfigOptionsByTaskId[taskId] ?? [];
        const currentStatus = current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready";
        if (
          currentStatus === status &&
          areConfigOptionsEquivalent(currentOptions, normalizedOptions)
        ) {
          // 历史 task 恢复旧模型或无 API key 自动清空模型时，多个恢复路径可能反复提交
          // 内容相同但引用不同的 configOptions。这里直接跳过等价写入，避免 Zustand 通知触发 React effect 循环。
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            return {
              ...current,
              taskConfigOptionsByTaskId: {
                ...current.taskConfigOptionsByTaskId,
                [taskId]: normalizedOptions,
              },
              taskConfigOptionsStatusByTaskId: {
                ...current.taskConfigOptionsStatusByTaskId,
                [taskId]: status,
              },
            };
          },
          workspaceIdentity,
        );
      });
    },
  };
}
