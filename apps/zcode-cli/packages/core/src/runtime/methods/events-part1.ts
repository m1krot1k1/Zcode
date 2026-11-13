

import { SessionEventType, createMessageId, createPartId, createSessionEvent, traceContextToLogContext } from "../deps.js";
import type { MessageId, PartId, SessionEvent, SessionId, TargetCompletionVerificationPayload, PrismHostEvidenceReceipt, PrismTaskAcceptanceLineage, PrismTaskContract, SubagentExecutionTerminalPayload, TraceContext } from "../deps.js";

import type { AgentRuntimeInternal } from "../internal.js";








// Часть 1/3 модуля events: вынесено по лимиту строк.

export const SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT = 100;

export const PRISM_PROJECTION_MAX_EVENTS = 512;

export const PRISM_PROJECTION_MAX_BYTES = 8 * 1024 * 1024;

export const PRISM_PROJECTION_MAX_ENTRIES_PER_TYPE = 512;

export const PRISM_PROJECTION_MAX_ENTRY_BYTES = 16 * 1024;

export const SUMMARY_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.ModelStreaming,
  SessionEventType.ModelNetworkStatus,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ToolCallProgress,
]);

// 生产环境只记录会改变 Turn/Session 生命周期的低频事件；stream/progress 仍由
// 现有 debug 聚合日志覆盖，避免诊断日志和消息流同频刷盘。
export const LIFECYCLE_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.SessionTitleUpdated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelRequest,
  SessionEventType.ModelComplete,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.PrismTaskContractDeclared,
  SessionEventType.PrismEvidenceReceiptObserved,
  SessionEventType.SubagentExecutionTerminal,
]);

export const PERSIST_BEFORE_EVENT_STORE_TYPES = new Set<SessionEventType>([
  SessionEventType.PrismTaskContractDeclared,
  SessionEventType.PrismEvidenceReceiptObserved,
  SessionEventType.SubagentExecutionTerminal,
]);

export interface PrismProjectionEventEnvelope {
  schema: "zcode.prism.event-projection.v1";
  eventId: string;
  eventSessionId: string;
  eventType: string;
  timestampMs: number;
  turnId?: string;
  traceId: string;
}

export interface SessionEventAppendAggregate {
  eventCount: number;
  eventType: SessionEventType;
  firstEventId: string;
  firstSessionEventSequenceNumber: number;
  lastEventId: string;
  lastSessionEventSequenceNumber: number;
  payloadBytes: number;
  payloadKinds: Record<string, number>;
}

export const prismFactPersistenceLocks = new WeakMap<
  AgentRuntimeInternal,
  Map<string, Promise<void>>
>();

export function createEvent(
  this: AgentRuntimeInternal,
  type: SessionEventType,
  payload: unknown,
  traceContext: TraceContext,
): SessionEvent {
  return createSessionEvent(type, this.sessionId, payload, {
    turnId: traceContext.turnId,
    traceId: traceContext.traceId,
  });
}

export function getPayloadKind(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const kind = (payload as Record<string, unknown>).kind;
    if (typeof kind === "string" && kind.length > 0) {
      return kind;
    }
  }
  return "<missing>";
}

export function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

export function resolveCurrentPrismTaskLineage(
  this: AgentRuntimeInternal,
  eventSessionId: SessionId,
  taskId: string,
): PrismTaskAcceptanceLineage & { childSessionId: SessionId; rootSessionId: SessionId } {
  const task = this.runtimeTaskRegistry.get(taskId);
  if (
    this.sessionId !== eventSessionId ||
    !task ||
    task.type !== "local_agent" ||
    !task.childSessionId ||
    task.parentSessionId !== eventSessionId ||
    !task.rootRunId ||
    !task.rootSessionId ||
    !task.attemptId ||
    task.branchGeneration === undefined ||
    this.runtimeTaskRegistry.getBranchGenerationForSession(eventSessionId) !== task.branchGeneration
  ) {
    // 原因：只有直接 owner runtime 能发布子任务的证据，worker 不能把事件伪装到父会话。
    throw new Error("PRISM task is not registered in the current branch");
  }
  const parent = this.runtimeTaskRegistry.getSubagentTaskByChildSession(task.parentSessionId);
  if (parent && parent.rootRunId !== task.rootRunId) {
    throw new Error("PRISM task parent belongs to a different root run");
  }
  return {
    rootRunId: task.rootRunId,
    rootSessionId: task.rootSessionId,
    taskId: task.taskId,
    parentTaskId: parent?.taskId,
    attemptId: task.attemptId,
    branchGeneration: task.branchGeneration,
    childSessionId: task.childSessionId,
  };
}

export function lineageMatchesContract(
  lineage: PrismTaskAcceptanceLineage,
  contract: PrismTaskContract,
): boolean {
  return (
    lineage.rootRunId === contract.rootRunId &&
    lineage.taskId === contract.taskId &&
    lineage.parentTaskId === contract.parentTaskId &&
    lineage.attemptId === contract.attemptId &&
    lineage.branchGeneration === contract.branchGeneration
  );
}

export function lineageMatchesReceipt(
  lineage: PrismTaskAcceptanceLineage,
  receipt: PrismHostEvidenceReceipt,
): boolean {
  return (
    lineage.rootRunId === receipt.rootRunId &&
    lineage.taskId === receipt.taskId &&
    lineage.parentTaskId === receipt.parentTaskId &&
    lineage.attemptId === receipt.attemptId &&
    lineage.branchGeneration === receipt.branchGeneration
  );
}

export function prismTaskContractEntryId(
  rootSessionId: SessionId,
  contract: Pick<PrismTaskContract, "rootRunId" | "taskId" | "attemptId">,
): string {
  return `prism-task-contract:${rootSessionId}:${contract.rootRunId}:${contract.taskId}:${contract.attemptId}`;
}

export function prismEvidenceReceiptEntryId(
  rootSessionId: SessionId,
  receipt: Pick<PrismHostEvidenceReceipt, "receiptId">,
): string {
  return `prism-evidence-receipt:${rootSessionId}:${receipt.receiptId}`;
}

export function prismTaskTerminalEntryId(
  rootSessionId: SessionId,
  terminal: Pick<SubagentExecutionTerminalPayload, "terminalId">,
): string {
  return `prism-task-terminal:${rootSessionId}:${terminal.terminalId}`;
}

export function prismAttemptKey(value: { rootRunId: string; taskId: string; attemptId: string }): string {
  return JSON.stringify([value.rootRunId, value.taskId, value.attemptId]);
}

export function prismProjectionEventOrder(type: SessionEvent["type"]): number {
  switch (type) {
    case SessionEventType.PrismTaskContractDeclared:
      return 0;
    case SessionEventType.PrismEvidenceReceiptObserved:
      return 1;
    case SessionEventType.SubagentExecutionTerminal:
      return 2;
    default:
      return 3;
  }
}

export function samePrismProjectionEvent(left: SessionEvent, right: SessionEvent): boolean {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.type === right.type &&
    left.timestamp.getTime() === right.timestamp.getTime() &&
    left.turnId === right.turnId &&
    left.traceId === right.traceId &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function targetCompletionVerificationTimelineKey(
  payload: TargetCompletionVerificationPayload,
): string {
  return payload.goalIteration !== undefined
    ? `${payload.targetId}_${payload.goalIteration}`
    : payload.verificationId;
}

export async function readExistingTimelineTiming(
  this: AgentRuntimeInternal,
  input: { partID: PartId; sessionID: SessionId },
): Promise<{ messageCreated?: number; partStarted?: number } | undefined> {
  const messages = await this.sessionStore?.messages({ sessionID: input.sessionID });
  if (!messages) return undefined;
  for (const message of messages) {
    const part = message.parts.find((candidate) => candidate.id === input.partID);
    if (part?.type !== "timeline") continue;
    return {
      messageCreated: message.info.time.created,
      partStarted: part.time?.start,
    };
  }
  return undefined;
}

export async function notifyEventSinks(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  for (const sink of this.eventSinks) {
    try {
      await sink.onSessionEvent(event);
    } catch (error) {
      this.logger?.warn("Session event sink failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_event_sink.failed",
        module: "core.runtime",
        sessionEventType: event.type,
        status: "failed",
      });
    }
  }
}

/**
 * 会话是否已进入持久化 store（首条输入 / 外部活动 / 直接启动的启动轮 / 冷恢复任一路径落过行）。
 * 协议层的 session record 以它为 draft 判定的事实源（bootstrap `onSessionEvent` 每条事件对齐一次），
 * 不再靠各命令 handler 各自翻 `record.persistence`。
 */
export function isSessionPersisted(this: AgentRuntimeInternal): boolean {
  return this.sessionPersisted;
}

export const pendingSessionPersistence = new WeakMap<AgentRuntimeInternal, Promise<void>>();

export const sessionEventAppendAggregates = new WeakMap<
  AgentRuntimeInternal,
  Map<string, SessionEventAppendAggregate>
>();

export async function serializePrismFactPersistence(
  this: AgentRuntimeInternal,
  key: string,
  operation: () => Promise<SessionEvent>,
): Promise<SessionEvent> {
  let locks = prismFactPersistenceLocks.get(this);
  if (!locks) {
    locks = new Map();
    prismFactPersistenceLocks.set(this, locks);
  }
  const previous = locks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export function createPrismProjectionEventEnvelope(
  event: SessionEvent,
): PrismProjectionEventEnvelope {
  return {
    schema: "zcode.prism.event-projection.v1",
    eventId: event.id,
    eventSessionId: event.sessionId,
    eventType: event.type,
    timestampMs: event.timestamp.getTime(),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    // SessionEvent 契约要求 traceId；投影 envelope 同样必须保留它供冷启动校验。
    traceId: event.traceId,
  };
}

export function parsePrismProjectionEventEnvelope(
  value: unknown,
): PrismProjectionEventEnvelope | undefined {
  if (!isRecord(value) || value.schema !== "zcode.prism.event-projection.v1") return undefined;
  if (
    typeof value.eventId !== "string" ||
    value.eventId.length === 0 ||
    typeof value.eventSessionId !== "string" ||
    value.eventSessionId.length === 0 ||
    typeof value.eventType !== "string" ||
    !Number.isSafeInteger(value.timestampMs) ||
    typeof value.timestampMs !== "number" ||
    typeof value.traceId !== "string" ||
    value.traceId.length === 0 ||
    (value.turnId !== undefined && typeof value.turnId !== "string")
  ) {
    return undefined;
  }
  return value as unknown as PrismProjectionEventEnvelope;
}

export function envelopeMatchesEntry(
  envelope: PrismProjectionEventEnvelope | undefined,
  entry: { time: { created: number }; sessionID: SessionId },
  expectedSessionId: SessionId,
  expectedType: SessionEvent["type"],
): envelope is PrismProjectionEventEnvelope {
  return Boolean(
    envelope &&
    entry.sessionID === expectedSessionId &&
    envelope.eventId.length <= 256 &&
    envelope.eventSessionId.length <= 256 &&
    envelope.eventSessionId === expectedSessionId &&
    envelope.eventType === expectedType &&
    envelope.traceId.length <= 256 &&
    (envelope.turnId === undefined ||
      (envelope.turnId.length > 0 && envelope.turnId.length <= 256)) &&
    envelope.timestampMs === entry.time.created &&
    Number.isFinite(new Date(envelope.timestampMs).getTime()),
  );
}

export function restorePrismProjectionEvent(
  envelope: PrismProjectionEventEnvelope,
  type: SessionEvent["type"],
  payload: unknown,
): SessionEvent {
  return {
    id: envelope.eventId as SessionEvent["id"],
    sessionId: envelope.eventSessionId as SessionId,
    turnId: envelope.turnId as SessionEvent["turnId"],
    type,
    timestamp: new Date(envelope.timestampMs),
    traceId: envelope.traceId as SessionEvent["traceId"],
    sequenceNumber: 0,
    payload,
  };
}

export function restorePrismTerminalPayload(value: unknown): SubagentExecutionTerminalPayload | undefined {
  if (!isRecord(value)) return undefined;
  const observedAt =
    value.observedAt instanceof Date
      ? value.observedAt
      : typeof value.observedAt === "string"
        ? new Date(value.observedAt)
        : undefined;
  if (
    value.schema !== "zcode.prism.subagent-terminal.v3" ||
    typeof value.terminalId !== "string" ||
    typeof value.rootRunId !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.attemptId !== "string" ||
    typeof value.branchGeneration !== "number" ||
    !Number.isSafeInteger(value.branchGeneration) ||
    typeof value.childSessionId !== "string" ||
    typeof value.childStarted !== "boolean" ||
    !["completed", "failed", "cancelled", "killed", "timed_out"].includes(
      String(value.terminalStatus),
    ) ||
    value.provenance !== "runtime_lifecycle" ||
    !["unknown", "verified", "rejected"].includes(String(value.acceptanceStatus)) ||
    !observedAt ||
    !Number.isFinite(observedAt.getTime())
  ) {
    return undefined;
  }
  return { ...value, observedAt } as unknown as SubagentExecutionTerminalPayload;
}

export function prismAttemptKeyFromEvent(event: SessionEvent): string | undefined {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  if (event.type === SessionEventType.PrismTaskContractDeclared) {
    const contract = isRecord(payload?.contract) ? payload.contract : undefined;
    return typeof contract?.rootRunId === "string" &&
      typeof contract.taskId === "string" &&
      typeof contract.attemptId === "string"
      ? prismAttemptKey({
          rootRunId: contract.rootRunId,
          taskId: contract.taskId,
          attemptId: contract.attemptId,
        })
      : undefined;
  }
  if (event.type === SessionEventType.PrismEvidenceReceiptObserved) {
    const receipt = isRecord(payload?.receipt) ? payload.receipt : undefined;
    return typeof receipt?.rootRunId === "string" &&
      typeof receipt.taskId === "string" &&
      typeof receipt.attemptId === "string"
      ? prismAttemptKey({
          rootRunId: receipt.rootRunId,
          taskId: receipt.taskId,
          attemptId: receipt.attemptId,
        })
      : undefined;
  }
  if (event.type === SessionEventType.SubagentExecutionTerminal) {
    const terminal = payload;
    return typeof terminal?.rootRunId === "string" &&
      typeof terminal.taskId === "string" &&
      typeof terminal.attemptId === "string"
      ? prismAttemptKey({
          rootRunId: terminal.rootRunId,
          taskId: terminal.taskId,
          attemptId: terminal.attemptId,
        })
      : undefined;
  }
  return undefined;
}

export function targetCompletionVerificationTimelineMessageId(
  payload: TargetCompletionVerificationPayload,
): MessageId {
  return createMessageId(`goal_verify_${targetCompletionVerificationTimelineKey(payload)}`);
}

export function targetCompletionVerificationTimelinePartId(
  payload: TargetCompletionVerificationPayload,
): PartId {
  return createPartId(`goal_verify_${targetCompletionVerificationTimelineKey(payload)}_timeline`);
}
