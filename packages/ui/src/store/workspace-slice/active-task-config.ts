import type { ZCodeConfigOption } from "@zcode/shared";
import { resolveTaskRestorePreloadConfigOptions } from "@/lib/taskModelRecovery.js";
import { getTaskMeta } from "@/store/zcodeSessionStoreSelectors.js";
import type { ConfigOptionsStatus, WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";
import { normalizeConfigOptions } from "./config-options.js";

export function updateActiveTaskConfigOptions(
  current: WorkspaceZCodeUIState,
  updater: (options: ZCodeConfigOption[] | null) => ZCodeConfigOption[] | null,
): Pick<WorkspaceZCodeUIState, "taskConfigOptionsByTaskId"> | null {
  const activeTaskId = current.activeTaskId;
  if (!activeTaskId) {
    return null;
  }

  const currentTaskOptions = current.taskConfigOptionsByTaskId[activeTaskId];
  if (!currentTaskOptions) {
    return null;
  }

  const nextTaskOptions = updater(currentTaskOptions);
  if (nextTaskOptions === currentTaskOptions || !nextTaskOptions) {
    return null;
  }

  return {
    taskConfigOptionsByTaskId: {
      ...current.taskConfigOptionsByTaskId,
      [activeTaskId]: nextTaskOptions,
    },
  };
}

export function resolveActiveTaskConfigOptionsOnSwitch(
  current: WorkspaceZCodeUIState,
  taskId: string,
): { configOptions: ZCodeConfigOption[]; status: ConfigOptionsStatus } | null {
  const cachedTaskConfigOptions = current.taskConfigOptionsByTaskId[taskId];
  if (cachedTaskConfigOptions) {
    return {
      configOptions: cachedTaskConfigOptions,
      status: current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready",
    };
  }

  const taskMeta = getTaskMeta(current, taskId);
  // 切到历史 task 时，工具栏模型和 context 用量来自不同状态桶。
  // 没有 task 级 settings 缓存时先用 task meta 预热模型，并进入 loading 等待运行态 settings 回填，
  // 避免继续展示上一条任务的模型（例如 glm-0531[1m]）配上当前任务的 contextWindow。
  const preloadedOptions = normalizeConfigOptions(
    resolveTaskRestorePreloadConfigOptions({
      taskMeta: {
        provider: taskMeta?.provider ?? current.selectedProvider,
        model: taskMeta?.model,
        mode: taskMeta?.mode,
        thoughtLevel: taskMeta?.thoughtLevel,
      },
    }),
  );
  if (preloadedOptions.length === 0) {
    return null;
  }

  return {
    configOptions: preloadedOptions,
    status: "loading",
  };
}
