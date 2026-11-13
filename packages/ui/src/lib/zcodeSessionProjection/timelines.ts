import {
  type ZCodeStreamEvent,
  type InputId,
  type TraceId,
  type ZCodeMessagePart,
  type ZCodeContextCompactionTimelineMeta,
  type ZCodeGoalVerification,
  type ZCodeGoalVerificationTimelineMeta,
  type ZCodeTimelineMeta,
} from "@zcode/shared";
import {
  asRecord,
  booleanValue,
  compactionPhaseValue,
  goalVerificationTimelineStatusValue,
  numberValue,
  positiveIntegerValue,
  stringValue,
  timelineStatusValue,
  timelineTriggerValue,
} from "./primitives.js";

export function goalVerificationTimelineIdentityKey(
  item: Extract<
    ZCodeGoalVerificationTimelineMeta,
    { type: "goal_verification" }
  >,
): string {
  if (typeof item.goalIteration === "number") {
    return `${item.targetId}:${item.goalIteration}`;
  }
  return `verification:${item.verificationId}`;
}

export function goalVerificationTimelineMessageId(
  item: Extract<
    ZCodeGoalVerificationTimelineMeta,
    { type: "goal_verification" }
  >,
): string {
  if (typeof item.goalIteration === "number") {
    return `zcode-goal-verification-${item.targetId}-${item.goalIteration}`;
  }
  return `zcode-goal-verification-${item.verificationId}`;
}

export function extractSyntheticTimelineFromTextPart(
  part: Extract<ZCodeMessagePart, { type: "text" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = part.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const forkContext = (metadata as Record<string, unknown>)["forkContext"];
  if (!forkContext || typeof forkContext !== "object") return undefined;
  const ctx = forkContext as Record<string, unknown>;
  if (ctx["kind"] !== "session_fork") return undefined;
  const parentSessionId =
    typeof ctx["parentSessionId"] === "string" ? ctx["parentSessionId"] : "";
  const targetMessageId =
    typeof ctx["targetMessageId"] === "string" ? ctx["targetMessageId"] : "";
  const targetCheckpointId =
    typeof ctx["targetCheckpointId"] === "string"
      ? ctx["targetCheckpointId"]
      : undefined;
  if (!parentSessionId || !targetMessageId) return undefined;
  return {
    version: 1,
    kind: "synthetic",
    type: "session_fork",
    display: "separator",
    parentSessionId,
    targetMessageId,
    ...(targetCheckpointId ? { targetCheckpointId } : {}),
    ...(typeof ctx["restoredFileCount"] === "number"
      ? { restoredFileCount: ctx["restoredFileCount"] }
      : {}),
  };
}

export function synthesizeTimelineFromTimelinePart(
  part: Extract<ZCodeMessagePart, { type: "timeline" }>,
): ZCodeTimelineMeta | undefined {
  if (part.timelineType !== "session_fork") {
    return undefined;
  }
  const parentSessionId = part.parentSessionId;
  const targetMessageId = part.targetMessageId;
  if (!parentSessionId || !targetMessageId) {
    return undefined;
  }
  return {
    version: 1,
    kind: "synthetic",
    type: "session_fork",
    display: "separator",
    parentSessionId,
    targetMessageId,
    ...(part.targetCheckpointId
      ? { targetCheckpointId: part.targetCheckpointId }
      : {}),
    ...(typeof part.restoredFileCount === "number"
      ? { restoredFileCount: part.restoredFileCount }
      : {}),
  };
}

export function synthesizeCompactionTimeline(
  part: Extract<ZCodeMessagePart, { type: "compaction" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = asRecord(part.metadata);
  const operationId = stringValue(metadata.operationId) ?? part.partId;
  const status = timelineStatusValue(metadata.timelineStatus);
  if (!status && !part.summaryMessageId) {
    // 修复原因：compact 成功后 summary user message 也会携带 compaction 元数据，
    // 但它只是模型上下文边界，不是 UI timeline。只有 lifecycle part 才渲染横线。
    return undefined;
  }
  const trigger =
    timelineTriggerValue(metadata.trigger) ?? (part.auto ? "auto" : "manual");
  const replace = booleanValue(metadata.replace);
  const reason = part.reason ?? stringValue(metadata.reason);
  const boundaryId = stringValue(metadata.boundaryId) ?? part.summaryMessageId;
  const summaryMessageId =
    part.summaryMessageId ?? stringValue(metadata.summaryMessageId);
  const preCompactTokenCount = numberValue(metadata.preCompactTokenCount);
  const postCompactTokenCount = numberValue(metadata.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(
    metadata.truePostCompactTokenCount,
  );
  const attempt = numberValue(metadata.attempt);
  const maxAttempts = numberValue(metadata.maxAttempts);
  const phase = compactionPhaseValue(metadata.phase);
  const startedAt = numberValue(metadata.startedAt);
  const endedAt = numberValue(metadata.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status: status ?? "completed",
    trigger,
    display: "separator",
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined
      ? { truePostCompactTokenCount }
      : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(phase ? { phase } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

export function mapCompactTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const timeline = compactTimelineMetaFromPayload(payload, inputId);
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    // Bugfix: compact lifecycle 是结构化状态事件，不是 assistant 正文。
    // 即使上游误带 text，也不能把内部 summary/prompt 投影到聊天区。
    content: "",
    zcodeTimeline: timeline,
  };
}

export function mapSyntheticTimelinePartPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const part = asRecord(payload.part);
  if (part.type !== "text") {
    return null;
  }
  const timeline = extractSyntheticTimelineFromTextPart(
    part as Extract<ZCodeMessagePart, { type: "text" }>,
  );
  if (!timeline) {
    return null;
  }
  const messageId =
    stringValue(part.messageId) ?? stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    content: "",
    // Bugfix: fork notice 是 part.upserted 里的结构化 synthetic text，不是模型正文 delta。
    // 这里提前投成 timeline divider，避免 UI 按普通消息渲染后丢掉横线。
    zcodeTimeline: timeline,
  };
}

export function mapGoalVerificationTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  timestamp: number,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const targetId = stringValue(payload.targetId);
  const verificationId = stringValue(payload.verificationId);
  const status = goalVerificationTimelineStatusValue(payload.status);
  if (!targetId || !verificationId || !status) {
    return null;
  }
  const verification = goalVerificationFromRecord(
    asRecord(payload.verification),
  );
  const goalIteration = positiveIntegerValue(payload.goalIteration);
  const anchorAssistantMessageId = stringValue(
    payload.anchorAssistantMessageId,
  );
  const anchorTurnId = stringValue(payload.anchorTurnId);
  const startedAt =
    numberValue(payload.startedAt) ??
    (status === "started" ? timestamp : undefined);
  const timeline: ZCodeGoalVerificationTimelineMeta = {
    version: 1,
    kind: "synthetic",
    type: "goal_verification",
    display: "separator",
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    updatedAt: timestamp,
  };
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    messageId: goalVerificationTimelineMessageId(timeline),
    content: "",
    zcodeTimeline: timeline,
  };
}

function compactTimelineMetaFromPayload(
  payload: Record<string, unknown>,
  inputId: InputId | undefined,
): ZCodeContextCompactionTimelineMeta | null {
  const operationId = stringValue(payload.operationId);
  const status = timelineStatusValue(payload.status ?? payload.timelineStatus);
  if (!operationId || !status) {
    return null;
  }
  const trigger = timelineTriggerValue(payload.trigger) ?? "manual";
  const replace = booleanValue(payload.replace);
  const reason = stringValue(payload.reason);
  const boundaryId = stringValue(payload.boundaryId);
  const summaryMessageId = stringValue(payload.summaryMessageId);
  const preCompactTokenCount = numberValue(payload.preCompactTokenCount);
  const postCompactTokenCount = numberValue(payload.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(
    payload.truePostCompactTokenCount,
  );
  const attempt = numberValue(payload.attempt);
  const maxAttempts = numberValue(payload.maxAttempts);
  const phase = compactionPhaseValue(payload.phase);
  const startedAt = numberValue(payload.startedAt);
  const endedAt = numberValue(payload.endedAt);
  const timeline: ZCodeContextCompactionTimelineMeta = {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status,
    trigger,
    display: "separator",
    ...(inputId ? { inputId } : {}),
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined
      ? { truePostCompactTokenCount }
      : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(phase ? { phase } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
  return timeline;
}

export function compactFailureToTimelineEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  reason: string,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> {
  const operationId = `compact-failed-${inputId ?? traceId}`;
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    content: "",
    zcodeTimeline: {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId,
      status: /abort|cancel|interrupt|stop/i.test(reason)
        ? "interrupted"
        : "failed",
      trigger: "manual",
      display: "separator",
      ...(inputId ? { inputId } : {}),
      reason,
      endedAt: Date.now(),
    },
  };
}

function goalVerificationFromRecord(
  record: Record<string, unknown>,
): ZCodeGoalVerification | null {
  const reason = stringValue(record.reason)?.trim();
  if (!reason) {
    return null;
  }
  const nextAction = stringValue(record.nextAction)?.trim();
  return {
    ...(nextAction ? { nextAction } : {}),
    passed: record.passed === true,
    reason,
  };
}
