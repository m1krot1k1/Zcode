import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WindowHostControllerTaskListItem, ZCodeTaskListQuery } from "@zcode/services";
import type {
  SessionSummary,
  WindowHostControllerTaskRow,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  WindowHostControllerSessionOverlay,
  WindowHostControllerSourceScope,
} from "../windowHostControllerProjection.js";

export function sourceKey(scope: WindowHostControllerSourceScope): string {
  return `${scope.kind}\0${scope.kind === "remote" ? (scope.sourceServerId ?? scope.remoteSessionId) : "local"}\0${scope.workspaceIdentity?.trim() || scope.workspacePath}`;
}

export function taskKey(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
) {
  return `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`;
}

export function normalizeTaskMeta(
  meta: ZCodeTaskMeta,
  scope: WindowHostControllerSourceScope,
): ZCodeTaskMeta {
  return {
    ...meta,
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity
      ? { workspaceIdentity: scope.workspaceIdentity }
      : { workspaceIdentity: undefined }),
  };
}

export function compareItems(
  left: WindowHostControllerTaskListItem,
  right: WindowHostControllerTaskListItem,
  sortBy: ZCodeTaskListQuery["sortBy"],
): number {
  const leftAt = sortBy === "created" ? left.createdAt : left.updatedAt;
  const rightAt = sortBy === "created" ? right.createdAt : right.updatedAt;
  return rightAt - leftAt || left.taskId.localeCompare(right.taskId);
}

export function mutationParams(address: WindowHostTaskAddress) {
  return {
    taskId: address.taskId,
    workspacePath: address.workspacePath,
    ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
  };
}

export function sessionOverlay(summary: SessionSummary): WindowHostControllerSessionOverlay {
  const liveStatus: WindowHostControllerSessionOverlay["liveStatus"] =
    summary.pendingInteraction ||
    (summary.pendingInteractionSummary &&
      summary.pendingInteractionSummary.permissionCount +
        summary.pendingInteractionSummary.userInputCount >
        0)
      ? "waiting"
      : summary.phase === "prewarming" || summary.phase === "running"
        ? "running"
        : summary.phase === "error"
          ? "error"
          : summary.phase === "completedSuccess" || summary.phase === "completedInterrupted"
            ? "completed"
            : "idle";
  return {
    taskId: summary.sessionId,
    liveStatus,
    title: summary.title,
    ...(summary.titleSource ? { titleSource: summary.titleSource } : {}),
    updatedAt: summary.lastActivityAt,
    ...(summary.pendingInteraction
      ? {
          pendingInteraction: {
            interactionId: summary.pendingInteraction.interactionId,
            kind: summary.pendingInteraction.kind,
            ...(summary.pendingInteraction.toolName
              ? { toolName: summary.pendingInteraction.toolName }
              : {}),
            ...(summary.pendingInteraction.autoResolution
              ? { autoResolution: summary.pendingInteraction.autoResolution }
              : {}),
          },
        }
      : {}),
    activity: {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
      ...(summary.workflowActivity ? { workflowActivity: summary.workflowActivity } : {}),
    },
  };
}

export function liveStatusFromMeta(meta: ZCodeTaskMeta): WindowHostControllerTaskRow["liveStatus"] {
  if (meta.status === "completed") return "completed";
  if (meta.status === "error") return "error";
  return "idle";
}
