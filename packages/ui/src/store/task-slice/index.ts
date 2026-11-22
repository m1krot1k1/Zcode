import { createTaskElicitationActions } from "./elicitationActions.js";
import { createTaskErrorActions } from "./errorActions.js";
import { createTaskPermissionActions } from "./permissionActions.js";
import { createTaskRuntimeActions } from "./runtimeActions.js";
import { createTaskListActions } from "./taskListActions.js";
import type { SetFn } from "./types.js";

/**
 * task 级状态切片：运行态、usage/configOptions、权限/问答请求、错误与任务列表乐观态。
 *
 * 拆分到 `task-slice/` 下按职责分文件后，这里只负责保持原有 action 顺序与合并结果，
 * 避免 Zustand store 的键顺序和写入语义发生变化。
 */
export function createTaskSlice(set: SetFn) {
  return {
    ...createTaskRuntimeActions(set),
    ...createTaskPermissionActions(set),
    ...createTaskElicitationActions(set),
    ...createTaskErrorActions(set),
    ...createTaskListActions(set),
  };
}
