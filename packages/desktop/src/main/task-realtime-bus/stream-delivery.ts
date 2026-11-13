import { HostMessageTypes } from "@zcode/shared";
import type {
  TaskRealtimeDeliveredEvent,
  TaskStreamMirrorBatchEvent,
  TaskStreamWatermark,
} from "@zcode/shared";
import { deliverSnapshotInvalidation } from "./delivery.js";
import { getLeaseKey } from "./keys.js";
import type { TaskRealtimeBusState } from "./state.js";
import type { PendingStreamBatch, TaskRunLease } from "./types.js";
import { STREAM_MIRROR_MAX_REPLAY_BATCHES, STREAM_MIRROR_MAX_REPLAY_BYTES } from "./types.js";

export function deliverStreamBatch(
  state: TaskRealtimeBusState,
  batch: PendingStreamBatch,
  event: TaskStreamMirrorBatchEvent,
): void {
  for (const target of state.hosts.values()) {
    if (!target.workspaceKeys.has(batch.workspaceKey)) {
      continue;
    }
    target.child.postMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        ...event,
        originHostId: batch.ownerHostId,
        // owner 和 observer 以前消费两条不同事件源：owner 走不可重放 direct event，
        // observer 走 mirror batch。切换 task 或跨端 relay 时两边会因为事件丢失/乱序产生分叉。
        // 这里统一把 mirror batch 回投给 owner，让所有 renderer 都按同一条 seq 流更新 task store。
        deliveryPurpose: target.hostId === batch.ownerHostId ? "relay_owner" : "observer",
      } satisfies TaskRealtimeDeliveredEvent,
    });
  }
}

export function deliverStreamBatchToHost(
  state: TaskRealtimeBusState,
  hostId: string,
  batch: PendingStreamBatch,
  event: TaskStreamMirrorBatchEvent,
  deliveryPurpose: "relay_owner" | "observer",
): void {
  const target = state.hosts.get(hostId);
  if (!target?.workspaceKeys.has(batch.workspaceKey)) {
    return;
  }
  target.child.postMessage({
    type: HostMessageTypes.TaskRealtimeDeliver,
    event: {
      ...event,
      originHostId: batch.ownerHostId,
      deliveryPurpose,
    } satisfies TaskRealtimeDeliveredEvent,
  });
}

export function rememberReplayBatch(
  batch: PendingStreamBatch,
  event: TaskStreamMirrorBatchEvent,
): void {
  // 无上限 replay 在长任务中会线性占用主进程内存。
  // 这里恢复批次数+字节数双阈值，超限后由 replayVisibleRunsToHost 触发 stream_mirror_gap 并走快照补齐。
  batch.replay.push(event);
  while (batch.replay.length > STREAM_MIRROR_MAX_REPLAY_BATCHES) {
    batch.replay.shift();
  }
  while (replayBytes(batch.replay) > STREAM_MIRROR_MAX_REPLAY_BYTES) {
    batch.replay.shift();
  }
}

function replayBytes(replay: TaskStreamMirrorBatchEvent[]): number {
  return replay.reduce((total, replayEvent) => total + JSON.stringify(replayEvent).length, 0);
}

export function replayVisibleRunsToHost(
  state: TaskRealtimeBusState,
  hostId: string,
  workspaceKeys: Iterable<string>,
): void {
  const host = state.hosts.get(hostId);
  if (!host) {
    return;
  }
  const visible = new Set(workspaceKeys);
  for (const batch of state.streamBatches.values()) {
    if (!visible.has(batch.workspaceKey)) {
      continue;
    }
    const replayKey = `${hostId}\u0000${batch.workspaceKey}\u0000${batch.taskId}\u0000${batch.runId}`;
    if (batch.replayInitializedHostIds.has(replayKey)) {
      continue;
    }
    batch.replayInitializedHostIds.add(replayKey);
    if (batch.replayUnavailable || batch.replay.length === 0 || batch.replay[0]?.fromSeq !== 1) {
      deliverSnapshotInvalidation(
        state,
        batchToLeaseLike(batch),
        batch.ownerHostId,
        "stream_mirror_gap",
        hostId,
        getReplaySnapshotWatermark(batch),
      );
      continue;
    }
    for (const event of batch.replay) {
      host.child.postMessage({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: { ...event, originHostId: batch.ownerHostId, deliveryPurpose: "observer" },
      });
    }
  }
}

export function batchToLeaseLike(batch: PendingStreamBatch): TaskRunLease {
  return {
    key: getLeaseKey(batch.workspaceKey, batch.taskId),
    workspaceKey: batch.workspaceKey,
    workspacePath: batch.workspacePath,
    workspaceIdentity: batch.workspaceIdentity,
    taskId: batch.taskId,
    runId: batch.runId,
    traceId: batch.traceId,
    ownerClientId: batch.ownerClientId,
    ownerDeviceLabel: batch.ownerDeviceLabel,
    ownerHostId: batch.ownerHostId,
    acquiredAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function getReplaySnapshotWatermark(batch: PendingStreamBatch): TaskStreamWatermark {
  return {
    runId: batch.runId,
    opSeq: batch.replay.at(-1)?.toSeq ?? Math.max(batch.nextOpSeq - 1, 0),
  };
}
