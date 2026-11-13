import { HostMessageTypes } from "@zcode/shared";
import type { TaskRealtimeDeliveredEvent, TaskStreamWatermark } from "@zcode/shared";
import type { TaskRealtimeBusState } from "./state.js";
import type { RegisteredRealtimeHost, TaskRunLease } from "./types.js";

export function deliverRealtimeEvent(
  state: TaskRealtimeBusState,
  delivered: TaskRealtimeDeliveredEvent,
  shouldDeliver: (target: RegisteredRealtimeHost) => boolean,
): void {
  for (const target of state.hosts.values()) {
    if (!shouldDeliver(target) || !target.workspaceKeys.has(delivered.workspaceKey)) {
      continue;
    }
    target.child.postMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: delivered,
    });
  }
}

export function deliverSnapshotInvalidation(
  state: TaskRealtimeBusState,
  lease: TaskRunLease,
  originHostId: string,
  reason: "stream_mirror_owner_lost" | "stream_mirror_gap",
  onlyHostId?: string,
  streamWatermark?: TaskStreamWatermark,
): void {
  deliverRealtimeEvent(
    state,
    {
      type: "task_snapshot_invalidated",
      eventId: `${reason}-${lease.workspaceKey}-${lease.taskId}-${lease.runId}-${Date.now()}`,
      workspacePath: lease.workspacePath,
      workspaceIdentity: lease.workspaceIdentity,
      workspaceKey: lease.workspaceKey,
      reason,
      traceId: lease.traceId,
      createdAt: Date.now(),
      taskId: lease.taskId,
      ...(streamWatermark ? { streamWatermark } : {}),
      originHostId,
    },
    (target) => (onlyHostId ? target.hostId === onlyHostId : target.hostId !== originHostId),
  );
}
