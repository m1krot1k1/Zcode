import type { ZCodeTaskListItem } from "./contract.ts";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import {
  buildTaskWorkspaceKey,
  type TaskEntityKey,
  type TaskListCacheDescriptor,
} from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import type { TaskListMembershipState } from "./types.js";

function matchesTaskMembership(
  descriptor: TaskListCacheDescriptor,
  membership: TaskListMembershipState,
): boolean {
  const kind = descriptor.kind === "workspace" ? "timeline" : descriptor.kind;
  return matchesTaskListMembershipKind(membership, kind);
}

function matchesTaskSearch(descriptor: TaskListCacheDescriptor, task: ZCodeTaskMeta): boolean {
  if (!descriptor.search) {
    return true;
  }

  return task.title.toLocaleLowerCase().includes(descriptor.search);
}

export function matchesTaskDescriptor(
  descriptor: TaskListCacheDescriptor,
  task: ZCodeTaskMeta,
  membership: TaskListMembershipState,
): boolean {
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  if (!descriptor.workspaceKeys.includes(workspaceKey)) {
    return false;
  }

  return matchesTaskMembership(descriptor, membership) && matchesTaskSearch(descriptor, task);
}

export function sortTaskKeysByDescriptor(params: {
  taskKeys: TaskEntityKey[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): TaskEntityKey[] {
  const uniqueTaskKeys = [...new Set(params.taskKeys)];
  return uniqueTaskKeys.sort((leftKey, rightKey) => {
    const leftTask = params.taskMetaByEntityKey[leftKey];
    const rightTask = params.taskMetaByEntityKey[rightKey];
    if (!leftTask && !rightTask) {
      return leftKey.localeCompare(rightKey);
    }
    if (!leftTask) {
      return 1;
    }
    if (!rightTask) {
      return -1;
    }
    return compareZCodeTaskListItems(leftTask, rightTask, params.descriptor.sortBy);
  });
}
