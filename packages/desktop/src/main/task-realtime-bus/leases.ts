import type {
  TaskRunLeaseAcquireRequest,
  TaskRunLeaseResult,
  TaskRunLeaseTarget,
} from "@zcode/shared";
import { getBatchKey, getLeaseKey } from "./keys.js";
import type { TaskRealtimeBusState } from "./state.js";
import { flushBatch } from "./stream-batches.js";
import type { TaskRunLease } from "./types.js";

export function acquireLease(
  state: TaskRealtimeBusState,
  hostId: string,
  request: TaskRunLeaseAcquireRequest,
): TaskRunLeaseResult {
  const key = getLeaseKey(request.workspaceKey, request.taskId);
  const existing = state.leases.get(key);
  if (existing && (existing.ownerHostId !== hostId || existing.runId !== request.runId)) {
    return {
      leaseRequestId: request.leaseRequestId,
      acquired: false,
      ownerHostId: existing.ownerHostId,
      reason: "owned_by_other_host",
    };
  }

  const now = Date.now();
  state.leases.set(key, {
    key,
    workspaceKey: request.workspaceKey,
    workspacePath: request.workspacePath,
    workspaceIdentity: request.workspaceIdentity,
    taskId: request.taskId,
    runId: request.runId,
    traceId: request.traceId,
    ownerClientId: request.ownerClientId,
    ownerDeviceLabel: request.ownerDeviceLabel,
    ownerHostId: hostId,
    acquiredAt: existing?.acquiredAt ?? now,
    updatedAt: now,
  });
  state.logger.info("[task-realtime] task run lease acquired", {
    hostId,
    workspaceKey: request.workspaceKey,
    taskId: request.taskId,
    runId: request.runId,
  });
  return { leaseRequestId: request.leaseRequestId, acquired: true, ownerHostId: hostId };
}

export function releaseLease(
  state: TaskRealtimeBusState,
  hostId: string,
  target: TaskRunLeaseTarget,
): void {
  const key = getLeaseKey(target.workspaceKey, target.taskId);
  const existing = state.leases.get(key);
  if (!existing || existing.ownerHostId !== hostId || existing.runId !== target.runId) {
    return;
  }
  flushBatch(state, getBatchKey(target.workspaceKey, target.taskId, target.runId), true);
  state.leases.delete(key);
  state.logger.info("[task-realtime] task run lease released", {
    hostId,
    workspaceKey: target.workspaceKey,
    taskId: target.taskId,
    runId: target.runId,
  });
}

export function releaseLeasesForHost(state: TaskRealtimeBusState, hostId: string): TaskRunLease[] {
  const released: TaskRunLease[] = [];
  for (const [key, lease] of state.leases) {
    if (lease.ownerHostId !== hostId) {
      continue;
    }
    flushBatch(state, getBatchKey(lease.workspaceKey, lease.taskId, lease.runId), true);
    state.leases.delete(key);
    released.push(lease);
  }
  return released;
}
