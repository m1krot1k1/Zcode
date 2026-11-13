import type {
  TaskRealtimeEvent,
  TaskRunLeaseTarget,
  TaskStreamMirrorBatchEvent,
  TaskStreamMirrorOp,
  TaskStreamMirrorPublishOp,
} from "@zcode/shared";
import { deliverSnapshotInvalidation } from "./delivery.js";
import { getBatchKey, getLeaseKey } from "./keys.js";
import type { TaskRealtimeBusState } from "./state.js";
import {
  batchToLeaseLike,
  deliverStreamBatch,
  deliverStreamBatchToHost,
  rememberReplayBatch,
} from "./stream-delivery.js";
import type { PendingStreamBatch, RegisteredRealtimeHost } from "./types.js";
import {
  STREAM_MIRROR_FLUSH_INTERVAL_MS,
  STREAM_MIRROR_MAX_BATCH_BYTES,
  STREAM_MIRROR_TEXT_OP_MAX_CHARS,
} from "./types.js";

export function handleStreamOpPublish(
  state: TaskRealtimeBusState,
  origin: RegisteredRealtimeHost,
  target: TaskRunLeaseTarget,
  op: TaskStreamMirrorPublishOp,
): void {
  const lease = state.leases.get(getLeaseKey(target.workspaceKey, target.taskId));
  if (!lease || lease.ownerHostId !== origin.hostId || lease.runId !== target.runId) {
    return;
  }

  const batchKey = getBatchKey(target.workspaceKey, target.taskId, target.runId);
  const batch = getOrCreateBatch(state, batchKey, origin.hostId, target);
  batch.pendingOps.push(op);

  if (isTerminalOrImmediateOp(op)) {
    flushBatch(state, batchKey, true);
    if (op.kind === "stream_event" && isTerminalEventType(op.event.type)) {
      state.leases.delete(getLeaseKey(target.workspaceKey, target.taskId));
    }
    return;
  }

  if (!batch.timer) {
    batch.timer = setTimeout(() => {
      batch.timer = null;
      flushBatch(state, batchKey, false);
    }, STREAM_MIRROR_FLUSH_INTERVAL_MS);
  }
}

function getOrCreateBatch(
  state: TaskRealtimeBusState,
  batchKey: string,
  ownerHostId: string,
  target: TaskRunLeaseTarget,
): PendingStreamBatch {
  let batch = state.streamBatches.get(batchKey);
  if (batch) {
    return batch;
  }
  batch = {
    batchKey,
    workspaceKey: target.workspaceKey,
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    taskId: target.taskId,
    runId: target.runId,
    traceId: target.traceId,
    ownerClientId: target.ownerClientId,
    ownerDeviceLabel: target.ownerDeviceLabel,
    ownerHostId,
    nextBatchSeq: 1,
    nextOpSeq: 1,
    pendingOps: [],
    replay: [],
    replayUnavailable: false,
    timer: null,
    replayInitializedHostIds: new Set<string>(),
  };
  state.streamBatches.set(batchKey, batch);
  return batch;
}

export function flushMatchingStreamBatchBeforeInvalidation(
  state: TaskRealtimeBusState,
  event: TaskRealtimeEvent,
): void {
  if (
    event.type === "task_stream_mirror_batch" ||
    !("taskId" in event) ||
    !event.taskId ||
    (event.reason !== "user_message_saved" &&
      event.reason !== "assistant_message_saved" &&
      event.reason !== "task_status_changed")
  ) {
    return;
  }
  flushBatch(state, getBatchKey(event.workspaceKey, event.taskId, event.traceId), true);
}

export function flushBatch(state: TaskRealtimeBusState, batchKey: string, force: boolean): void {
  const batch = state.streamBatches.get(batchKey);
  if (!batch || batch.pendingOps.length === 0) {
    return;
  }
  if (!force && batch.pendingOps.length === 0) {
    return;
  }
  if (batch.timer) {
    clearTimeout(batch.timer);
    batch.timer = null;
  }

  const coalesced = splitLargeTextOps(coalesceOps(batch.pendingOps));
  batch.pendingOps = [];
  const ops: TaskStreamMirrorOp[] = coalesced.map((op) => ({
    ...op,
    seq: batch.nextOpSeq++,
  }));
  const event: TaskStreamMirrorBatchEvent = {
    type: "task_stream_mirror_batch",
    eventId: `stream-${batch.workspaceKey}-${batch.taskId}-${batch.runId}-${batch.nextBatchSeq}`,
    workspacePath: batch.workspacePath,
    workspaceIdentity: batch.workspaceIdentity,
    workspaceKey: batch.workspaceKey,
    traceId: batch.traceId,
    createdAt: Date.now(),
    taskId: batch.taskId,
    runId: batch.runId,
    ownerClientId: batch.ownerClientId,
    ownerDeviceLabel: batch.ownerDeviceLabel,
    batchSeq: batch.nextBatchSeq++,
    fromSeq: ops[0]?.seq ?? batch.nextOpSeq,
    toSeq: ops[ops.length - 1]?.seq ?? batch.nextOpSeq - 1,
    ops,
    terminal: ops.some((op) => op.kind === "stream_event" && isTerminalEventType(op.event.type)),
  };
  if (JSON.stringify(event).length > STREAM_MIRROR_MAX_BATCH_BYTES) {
    // 单次 mirror batch 过大时，RPC/base64/JSON 会在链路上多次复制，导致 host 堆内存打满。
    // owner 仍依赖 mirror seq 流渲染主动发送端，所以这里对 owner 做小批次分片；observer
    // 不消费正文流，只收到 snapshot invalidation/remoteGenerating 状态。
    deliverOversizedStreamBatchFallback(state, batch, event);
    return;
  }
  rememberReplayBatch(batch, event);
  deliverStreamBatch(state, batch, event);

  if (event.terminal) {
    state.streamBatches.delete(batchKey);
  }
}

function deliverOversizedStreamBatchFallback(
  state: TaskRealtimeBusState,
  batch: PendingStreamBatch,
  event: TaskStreamMirrorBatchEvent,
): void {
  // 不能丢弃 owner 的 mirror seq。ZCode Agent 有 realtime port 时 owner direct stream 会被关闭，
  // 如果 oversized batch 只发 gap，service 会因为后续 seq 缺口禁用 mirror，桌面端就停到终态快照。
  // 这里只给 owner 发送连续小批次；observer 和 late subscriber 统一走快照补齐，避免大 payload 扩散。
  batch.replayUnavailable = true;
  batch.replay = [];
  for (const chunk of splitOversizedBatchForOwner(batch, event)) {
    deliverStreamBatchToHost(state, batch.ownerHostId, batch, chunk, "relay_owner");
  }
  deliverSnapshotInvalidation(
    state,
    batchToLeaseLike(batch),
    batch.ownerHostId,
    "stream_mirror_gap",
    undefined,
    { runId: event.runId, opSeq: event.toSeq },
  );
  if (event.terminal) {
    state.streamBatches.delete(batch.batchKey);
  }
}

function splitOversizedBatchForOwner(
  batch: PendingStreamBatch,
  event: TaskStreamMirrorBatchEvent,
): TaskStreamMirrorBatchEvent[] {
  const chunks: TaskStreamMirrorBatchEvent[] = [];
  let pendingOps: TaskStreamMirrorOp[] = [];

  const createChunk = (
    ops: TaskStreamMirrorOp[],
    batchSeq: number,
  ): TaskStreamMirrorBatchEvent => ({
    ...event,
    eventId: `stream-${batch.workspaceKey}-${batch.taskId}-${batch.runId}-${batchSeq}`,
    batchSeq,
    fromSeq: ops[0]?.seq ?? event.fromSeq,
    toSeq: ops[ops.length - 1]?.seq ?? event.toSeq,
    ops,
    terminal: ops.some((op) => op.kind === "stream_event" && isTerminalEventType(op.event.type)),
  });

  const flushPending = () => {
    if (pendingOps.length === 0) {
      return;
    }
    chunks.push(createChunk(pendingOps, batch.nextBatchSeq++));
    pendingOps = [];
  };

  for (const op of event.ops) {
    const candidate = [...pendingOps, op];
    const candidateChunk = createChunk(candidate, batch.nextBatchSeq);
    if (
      pendingOps.length > 0 &&
      JSON.stringify(candidateChunk).length > STREAM_MIRROR_MAX_BATCH_BYTES
    ) {
      flushPending();
    }
    pendingOps.push(op);
  }
  flushPending();
  return chunks;
}

function coalesceOps(ops: TaskStreamMirrorPublishOp[]): TaskStreamMirrorPublishOp[] {
  const coalesced: TaskStreamMirrorPublishOp[] = [];
  for (const op of ops) {
    const previous = coalesced[coalesced.length - 1];
    if (canMergeTextChunk(previous, op)) {
      const current = op as Extract<TaskStreamMirrorPublishOp, { kind: "stream_event" }> & {
        event: { content: string };
      };
      coalesced[coalesced.length - 1] = {
        kind: "stream_event",
        event: {
          ...previous.event,
          content: previous.event.content + current.event.content,
        },
      };
      continue;
    }
    if (
      previous?.kind === "stream_event" &&
      op.kind === "stream_event" &&
      isRedundantStateEvent(op.event.type) &&
      previous.event.type === op.event.type &&
      previous.event.taskId === op.event.taskId
    ) {
      coalesced[coalesced.length - 1] = op;
      continue;
    }
    coalesced.push(op);
  }
  return coalesced;
}

function splitLargeTextOps(ops: TaskStreamMirrorPublishOp[]): TaskStreamMirrorPublishOp[] {
  const splitOps: TaskStreamMirrorPublishOp[] = [];
  for (const op of ops) {
    if (
      op.kind !== "stream_event" ||
      (op.event.type !== "agent_message_chunk" && op.event.type !== "agent_thought_chunk") ||
      op.event.content.length <= STREAM_MIRROR_TEXT_OP_MAX_CHARS
    ) {
      splitOps.push(op);
      continue;
    }

    // 文本 chunk 可能被 coalesce 合成超大单 op；后续即使按 op 分 batch，
    // 单个 op 仍会超过 RPC 安全预算。这里先把文本切成连续小 op，再统一分配 seq。
    for (
      let offset = 0;
      offset < op.event.content.length;
      offset += STREAM_MIRROR_TEXT_OP_MAX_CHARS
    ) {
      splitOps.push({
        kind: "stream_event",
        event: {
          ...op.event,
          content: op.event.content.slice(offset, offset + STREAM_MIRROR_TEXT_OP_MAX_CHARS),
        },
      });
    }
  }
  return splitOps;
}

function canMergeTextChunk(
  previous: TaskStreamMirrorPublishOp | undefined,
  op: TaskStreamMirrorPublishOp,
): previous is Extract<TaskStreamMirrorPublishOp, { kind: "stream_event" }> & {
  event: {
    type: "agent_message_chunk" | "agent_thought_chunk";
    taskId: string;
    traceId: string;
    content: string;
  };
} {
  return (
    previous?.kind === "stream_event" &&
    op.kind === "stream_event" &&
    (op.event.type === "agent_message_chunk" || op.event.type === "agent_thought_chunk") &&
    previous.event.type === op.event.type &&
    previous.event.taskId === op.event.taskId &&
    previous.event.traceId === op.event.traceId &&
    "content" in previous.event &&
    "content" in op.event &&
    typeof previous.event.content === "string" &&
    typeof op.event.content === "string"
  );
}

function isRedundantStateEvent(type: string): boolean {
  return type === "usage_update" || type === "session_info_update" || type === "plan";
}

function isTerminalEventType(type: string): boolean {
  return type === "task_complete" || type === "task_error";
}

function isTerminalOrImmediateOp(op: TaskStreamMirrorPublishOp): boolean {
  return (
    op.kind === "stream_event" &&
    (op.event.type === "permission_request" || isTerminalEventType(op.event.type))
  );
}
