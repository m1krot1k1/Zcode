

import { SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT, SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT, SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL, SessionEventType, traceContextToLogContext } from "../deps.js";
import type { SessionEvent, SessionId, PrismEvidenceReceiptObservedPayload, PrismTaskContract, PrismTaskContractDeclaredPayload, SubagentExecutionTerminalPayload, TraceContext } from "../deps.js";

import type { AgentRuntimeInternal } from "../internal.js";






import {
  isPrismReceiptForCriterion,
  isValidPrismHostEvidenceReceipt,
  isValidPrismTaskContract,
} from "../../runtime-task/registry.js";
import {
  PRISM_PROJECTION_MAX_BYTES,
  PRISM_PROJECTION_MAX_ENTRIES_PER_TYPE,
  PRISM_PROJECTION_MAX_ENTRY_BYTES,
  PRISM_PROJECTION_MAX_EVENTS,
  PrismProjectionEventEnvelope,
  SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT,
  SUMMARY_SESSION_EVENT_TYPES,
  SessionEventAppendAggregate,
  createPrismProjectionEventEnvelope,
  envelopeMatchesEntry,
  getPayloadKind,
  isRecord,
  lineageMatchesContract,
  lineageMatchesReceipt,
  measureJsonBytes,
  parsePrismProjectionEventEnvelope,
  prismAttemptKey,
  prismAttemptKeyFromEvent,
  prismEvidenceReceiptEntryId,
  prismProjectionEventOrder,
  prismTaskContractEntryId,
  prismTaskTerminalEntryId,
  resolveCurrentPrismTaskLineage,
  restorePrismProjectionEvent,
  restorePrismTerminalPayload,
  samePrismProjectionEvent,
  serializePrismFactPersistence,
  sessionEventAppendAggregates,
} from "./events-part1.js";

// Часть 2/3 модуля events: вынесено по лимиту строк.

export async function restorePrismProjectionEventsFromStore(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  branchGeneration: number,
): Promise<void> {
  const store = this.sessionStore;
  if (!store?.sessionEntries) return;

  const [contractEntries, receiptEntries, terminalEntries] = await Promise.all([
    store.sessionEntries({
      sessionID: this.sessionId,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
      limit: PRISM_PROJECTION_MAX_ENTRIES_PER_TYPE,
      order: "desc",
      maxDataBytes: PRISM_PROJECTION_MAX_ENTRY_BYTES,
    }),
    store.sessionEntries({
      sessionID: this.sessionId,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
      limit: PRISM_PROJECTION_MAX_ENTRIES_PER_TYPE,
      order: "desc",
      maxDataBytes: PRISM_PROJECTION_MAX_ENTRY_BYTES,
    }),
    store.sessionEntries({
      sessionID: this.sessionId,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
      limit: PRISM_PROJECTION_MAX_ENTRIES_PER_TYPE,
      order: "desc",
      maxDataBytes: PRISM_PROJECTION_MAX_ENTRY_BYTES,
    }),
  ]);

  const contractsByAttempt = new Map<string, PrismTaskContract>();
  const terminalsByAttempt = new Set<string>();
  const candidates: Array<{ entryId: string; event: SessionEvent }> = [];

  for (const entry of contractEntries) {
    const data = isRecord(entry.data) ? entry.data : undefined;
    const contract = data?.contract;
    const envelope = parsePrismProjectionEventEnvelope(data?.projectionEvent);
    if (
      !isValidPrismTaskContract(contract) ||
      contract.branchGeneration !== branchGeneration ||
      entry.id !== prismTaskContractEntryId(this.sessionId, contract) ||
      !envelopeMatchesEntry(
        envelope,
        entry,
        this.sessionId,
        SessionEventType.PrismTaskContractDeclared,
      )
    ) {
      continue;
    }
    contractsByAttempt.set(prismAttemptKey(contract), contract);
    candidates.push({
      entryId: entry.id,
      event: restorePrismProjectionEvent(envelope, SessionEventType.PrismTaskContractDeclared, {
        contract,
      }),
    });
  }

  for (const entry of terminalEntries) {
    const data = isRecord(entry.data) ? entry.data : undefined;
    const terminal = restorePrismTerminalPayload(data?.terminal);
    const envelope = parsePrismProjectionEventEnvelope(data?.projectionEvent);
    if (
      !terminal ||
      terminal.branchGeneration !== branchGeneration ||
      terminal.terminalId !==
        `${terminal.rootRunId}/${terminal.taskId}/${terminal.branchGeneration}/${terminal.attemptId}` ||
      entry.id !== prismTaskTerminalEntryId(this.sessionId, terminal) ||
      !envelopeMatchesEntry(
        envelope,
        entry,
        this.sessionId,
        SessionEventType.SubagentExecutionTerminal,
      )
    ) {
      continue;
    }
    const contract = contractsByAttempt.get(prismAttemptKey(terminal));
    if (
      !contract ||
      contract.parentTaskId !== terminal.parentTaskId ||
      terminal.childSessionId.length === 0
    ) {
      continue;
    }
    terminalsByAttempt.add(prismAttemptKey(terminal));
    candidates.push({
      entryId: entry.id,
      event: restorePrismProjectionEvent(envelope, SessionEventType.SubagentExecutionTerminal, {
        ...terminal,
      }),
    });
  }

  for (const entry of receiptEntries) {
    const data = isRecord(entry.data) ? entry.data : undefined;
    const receipt = data?.receipt;
    const envelope = parsePrismProjectionEventEnvelope(data?.projectionEvent);
    if (
      !isValidPrismHostEvidenceReceipt(receipt) ||
      receipt.branchGeneration !== branchGeneration ||
      entry.id !== prismEvidenceReceiptEntryId(this.sessionId, receipt) ||
      !envelopeMatchesEntry(
        envelope,
        entry,
        this.sessionId,
        SessionEventType.PrismEvidenceReceiptObserved,
      )
    ) {
      continue;
    }
    const key = prismAttemptKey(receipt);
    const contract = contractsByAttempt.get(key);
    const terminal = terminalEntries
      .map((candidate) => {
        const candidateData = isRecord(candidate.data) ? candidate.data : undefined;
        return restorePrismTerminalPayload(candidateData?.terminal);
      })
      .find(
        (candidate) =>
          candidate &&
          candidate.branchGeneration === branchGeneration &&
          prismAttemptKey(candidate) === key &&
          candidate.childSessionId === receipt.artifact.evidence.childSessionId,
      );
    const criterion = contract?.criteria.find(
      (candidate) =>
        candidate.id === receipt.criterionId &&
        candidate.evaluatorId === receipt.evaluatorId &&
        candidate.evaluatorVersion === receipt.evaluatorVersion,
    );
    if (
      !contract ||
      !terminal ||
      !terminalsByAttempt.has(key) ||
      contract.contractSha256 !== receipt.contractSha256 ||
      contract.parentTaskId !== receipt.parentTaskId ||
      !criterion ||
      !isPrismReceiptForCriterion(receipt, criterion)
    ) {
      continue;
    }
    candidates.push({
      entryId: entry.id,
      event: restorePrismProjectionEvent(envelope, SessionEventType.PrismEvidenceReceiptObserved, {
        receipt,
      }),
    });
  }

  const groups = new Map<
    string,
    { events: Array<{ entryId: string; event: SessionEvent }>; terminalTimestampMs?: number }
  >();
  for (const candidate of candidates) {
    const attemptKey = prismAttemptKeyFromEvent(candidate.event);
    if (!attemptKey) continue;
    const group = groups.get(attemptKey) ?? { events: [] };
    group.events.push(candidate);
    if (candidate.event.type === SessionEventType.SubagentExecutionTerminal) {
      group.terminalTimestampMs = candidate.event.timestamp.getTime();
    }
    groups.set(attemptKey, group);
  }
  const completeGroups = [...groups.values()]
    .filter(
      (group) =>
        group.terminalTimestampMs !== undefined &&
        group.events.some(({ event }) => event.type === SessionEventType.PrismTaskContractDeclared),
    )
    .sort(
      (left, right) =>
        right.terminalTimestampMs! - left.terminalTimestampMs! ||
        left.events[0]!.entryId.localeCompare(right.events[0]!.entryId),
    );
  const selected: Array<{ entryId: string; event: SessionEvent }> = [];
  let selectedBytes = 0;
  let skippedGroupCount = 0;
  for (const group of completeGroups) {
    const orderedGroupEvents = [...group.events].sort(
      (left, right) =>
        left.event.timestamp.getTime() - right.event.timestamp.getTime() ||
        prismProjectionEventOrder(left.event.type) - prismProjectionEventOrder(right.event.type) ||
        left.entryId.localeCompare(right.entryId),
    );
    const groupBytes = orderedGroupEvents.reduce(
      (total, candidate) => total + Buffer.byteLength(JSON.stringify(candidate.event), "utf8"),
      0,
    );
    if (
      selected.length + orderedGroupEvents.length > PRISM_PROJECTION_MAX_EVENTS ||
      selectedBytes + groupBytes > PRISM_PROJECTION_MAX_BYTES
    ) {
      skippedGroupCount += 1;
      continue;
    }
    selected.push(...orderedGroupEvents);
    selectedBytes += groupBytes;
  }

  // 只保留完整 attempt group；SessionEntry 和历史 acceptance 不受内存 projection 上限影响。
  selected.sort(
    (left, right) =>
      left.event.timestamp.getTime() - right.event.timestamp.getTime() ||
      prismProjectionEventOrder(left.event.type) - prismProjectionEventOrder(right.event.type) ||
      left.entryId.localeCompare(right.entryId),
  );
  let appendFailureCount = 0;
  let firstAppendFailure:
    | { entryId: string; errorName: string; eventId: string; eventType: SessionEvent["type"] }
    | undefined;
  for (const { entryId, event } of selected) {
    try {
      const existing = (await this.eventStore.getEvents(event.sessionId)).find(
        (candidate) => candidate.id === event.id,
      );
      if (existing) {
        if (!samePrismProjectionEvent(existing, event)) {
          this.logger?.warn("Conflicting PRISM event projection was not replaced", {
            ...traceContextToLogContext(traceContext),
            event: "session.event.prism_projection_conflict",
            module: "core.runtime",
            sessionEventType: event.type,
            sessionEventId: event.id,
            sessionEntryId: entryId,
            status: "failed",
          });
        }
        continue;
      }
      await this.eventStore.append(event);
    } catch (error) {
      appendFailureCount += 1;
      firstAppendFailure ??= {
        entryId,
        errorName: error instanceof Error ? error.name : "UnknownError",
        eventId: event.id,
        eventType: event.type,
      };
    }
  }
  if (appendFailureCount > 0) {
    this.logger?.warn("PRISM event projection recovery could not append some events", {
      ...traceContextToLogContext(traceContext),
      ...firstAppendFailure,
      event: "session.event.prism_projection_append_failed",
      module: "core.runtime",
      appendFailureCount,
      selectedEventCount: selected.length,
      status: "failed",
    });
  }
  if (skippedGroupCount > 0) {
    this.logger?.warn("PRISM event projection recovery reached its memory budget", {
      ...traceContextToLogContext(traceContext),
      event: "session.event.prism_projection_budget_reached",
      module: "core.runtime",
      maxEventCount: PRISM_PROJECTION_MAX_EVENTS,
      maxPayloadBytes: PRISM_PROJECTION_MAX_BYTES,
      skippedGroupCount,
      selectedEventCount: selected.length,
      selectedPayloadBytes: selectedBytes,
      status: "completed",
    });
  }
}

export function flushSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  aggregateKey: string,
  aggregate: SessionEventAppendAggregate,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  aggregateMap?.delete(aggregateKey);
  // 日志治理原因：model streaming / progress 类事件与 token 流同频，
  // 逐条写默认日志会把 eventStore 索引复制成巨量 daily log；这里保留 seq 范围和 kind 分布用于定位。
  this.logger?.debug("Session event append summary", {
    ...traceContextToLogContext(traceContext),
    event: "event_store.appended.summary",
    eventCount: aggregate.eventCount,
    firstEventId: aggregate.firstEventId,
    firstSessionEventSequenceNumber: aggregate.firstSessionEventSequenceNumber,
    flushReason: reason,
    lastEventId: aggregate.lastEventId,
    lastSessionEventSequenceNumber: aggregate.lastSessionEventSequenceNumber,
    module: "core.runtime",
    payloadBytes: aggregate.payloadBytes,
    payloadKinds: aggregate.payloadKinds,
    sessionEventType: aggregate.eventType,
  });
}

export function getSessionEventAppendAggregateMap(
  runtime: AgentRuntimeInternal,
): Map<string, SessionEventAppendAggregate> {
  let aggregateMap = sessionEventAppendAggregates.get(runtime);
  if (!aggregateMap) {
    aggregateMap = new Map();
    sessionEventAppendAggregates.set(runtime, aggregateMap);
  }
  return aggregateMap;
}

export async function ensurePrismProjectionEnvelope(
  this: AgentRuntimeInternal,
  entry: {
    id: string;
    sessionID: SessionId;
    type: string;
    touchSession?: boolean;
    time: { created: number; updated: number };
    data: unknown;
  },
  event: SessionEvent,
): Promise<PrismProjectionEventEnvelope> {
  const store = this.sessionStore;
  if (!store?.saveSessionEntry) {
    throw new Error("PRISM projection envelope storage is unavailable");
  }
  const data = isRecord(entry.data) ? entry.data : undefined;
  if (!data) throw new Error("Malformed PRISM durable entry data");
  const existingEnvelope = parsePrismProjectionEventEnvelope(data.projectionEvent);
  if (existingEnvelope) {
    if (!envelopeMatchesEntry(existingEnvelope, entry, entry.sessionID, event.type)) {
      throw new Error("Conflicting PRISM projection event envelope");
    }
    return existingEnvelope;
  }
  if (data.projectionEvent !== undefined) {
    throw new Error("Malformed PRISM projection event envelope");
  }

  // 原因：旧版事实的创建时间是唯一可证明的持久顺序；新 envelope 采用它，确保 cold-resume 校验一致。
  if (!Number.isFinite(entry.time.created)) {
    throw new Error("Malformed PRISM durable entry timestamp");
  }
  const envelope = {
    ...createPrismProjectionEventEnvelope(event),
    timestampMs: entry.time.created,
  };
  await store.saveSessionEntry({
    ...entry,
    data: { ...data, projectionEvent: envelope },
    time: { ...entry.time, updated: Date.now() },
  });
  return envelope;
}

export async function restorePrismProjectionEvents(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  branchGeneration: number,
): Promise<void> {
  try {
    await restorePrismProjectionEventsFromStore.call(this, traceContext, branchGeneration);
  } catch (error) {
    this.logger?.warn("PRISM event projection recovery could not read durable entries", {
      ...traceContextToLogContext(traceContext),
      errorName: error instanceof Error ? error.name : "UnknownError",
      event: "session.event.prism_projection_read_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export function recordSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): boolean {
  if (!SUMMARY_SESSION_EVENT_TYPES.has(event.type)) {
    return false;
  }

  const aggregateKey = `${traceContext.turnId ?? "session"}:${event.type}`;
  const aggregateMap = getSessionEventAppendAggregateMap(this);
  const payloadKind = getPayloadKind(event.payload);
  const existing = aggregateMap.get(aggregateKey);
  if (existing) {
    existing.eventCount += 1;
    existing.lastEventId = String(event.id);
    existing.lastSessionEventSequenceNumber = event.sequenceNumber;
    existing.payloadBytes += measureJsonBytes(event.payload);
    existing.payloadKinds[payloadKind] = (existing.payloadKinds[payloadKind] ?? 0) + 1;
    if (existing.eventCount >= SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT) {
      flushSessionEventAppendAggregate.call(
        this,
        aggregateKey,
        existing,
        traceContext,
        "count_threshold",
      );
    }
    return true;
  }

  aggregateMap.set(aggregateKey, {
    eventCount: 1,
    eventType: event.type,
    firstEventId: String(event.id),
    firstSessionEventSequenceNumber: event.sequenceNumber,
    lastEventId: String(event.id),
    lastSessionEventSequenceNumber: event.sequenceNumber,
    payloadBytes: measureJsonBytes(event.payload),
    payloadKinds: { [payloadKind]: 1 },
  });
  return true;
}

export function flushSessionEventAppendAggregates(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  if (!aggregateMap || aggregateMap.size === 0) {
    return;
  }
  for (const [aggregateKey, aggregate] of aggregateMap) {
    flushSessionEventAppendAggregate.call(this, aggregateKey, aggregate, traceContext, reason);
  }
}

export async function persistPrismTaskContract(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<SessionEvent> {
  const store = this.sessionStore;
  if (!store?.saveSessionEntry || !store.sessionEntries) {
    throw new Error("PRISM task contract persistence is unavailable");
  }
  const readSessionEntries = store.sessionEntries.bind(store);
  const saveSessionEntry = store.saveSessionEntry.bind(store);
  const contract = (event.payload as PrismTaskContractDeclaredPayload | undefined)?.contract;
  if (!isValidPrismTaskContract(contract)) {
    throw new Error("Invalid PRISM task contract");
  }
  const lineage = resolveCurrentPrismTaskLineage.call(this, event.sessionId, contract.taskId);
  if (!lineageMatchesContract(lineage, contract)) {
    // 原因：迟到的旧 attempt/branch 事件不能覆盖当前任务的证据来源。
    throw new Error("PRISM task contract lineage is stale");
  }

  const entryId = prismTaskContractEntryId(lineage.rootSessionId, contract);
  return serializePrismFactPersistence.call(this, entryId, async () => {
    const entries = await readSessionEntries({
      sessionID: lineage.rootSessionId,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
    });
    const existing = entries.find((entry) => entry.id === entryId);
    if (existing) {
      const existingContract = isRecord(existing.data) ? existing.data.contract : undefined;
      if (
        isValidPrismTaskContract(existingContract) &&
        existingContract.contractSha256 === contract.contractSha256
      ) {
        const envelope = await ensurePrismProjectionEnvelope.call(this, existing, event);
        return restorePrismProjectionEvent(envelope, event.type, { contract: existingContract });
      }
      // 原因：SessionEntry upsert 会静默覆盖同一个 id；冲突时必须 fail-closed 才能保持 append-only。
      throw new Error("Conflicting PRISM task contract receipt");
    }

    const timestamp = event.timestamp.getTime();
    try {
      await saveSessionEntry({
        id: entryId,
        sessionID: lineage.rootSessionId,
        type: SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
        touchSession: false,
        time: { created: timestamp, updated: timestamp },
        data: { contract, projectionEvent: createPrismProjectionEventEnvelope(event) },
      });
    } catch (error) {
      this.logger?.warn("Failed to persist PRISM task contract", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_entry.prism_task_contract.persist_failed",
        module: "core.runtime",
        taskId: contract.taskId,
        status: "failed",
      });
      throw error;
    }
    return event;
  });
}

export async function persistPrismEvidenceReceipt(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<SessionEvent> {
  const store = this.sessionStore;
  if (!store?.saveSessionEntry || !store.sessionEntries) {
    throw new Error("PRISM evidence persistence is unavailable");
  }
  const readSessionEntries = store.sessionEntries.bind(store);
  const saveSessionEntry = store.saveSessionEntry.bind(store);
  const receipt = (event.payload as PrismEvidenceReceiptObservedPayload | undefined)?.receipt;
  if (!isValidPrismHostEvidenceReceipt(receipt)) {
    throw new Error("Invalid PRISM Host evidence receipt");
  }
  const lineage = resolveCurrentPrismTaskLineage.call(this, event.sessionId, receipt.taskId);
  if (!lineageMatchesReceipt(lineage, receipt)) {
    // 原因：旧 branch generation 或旧 attempt 的结果在 rewind/resume 后不得成为当前证据。
    throw new Error("PRISM evidence receipt lineage is stale");
  }
  if (receipt.artifact.evidence.childSessionId !== lineage.childSessionId) {
    // 原因：receipt 的 lineage 还不足以证明 artifact 来自该任务的实际子会话。
    throw new Error("PRISM evidence receipt child session does not match the registered task");
  }

  const contractEntries = await readSessionEntries({
    sessionID: lineage.rootSessionId,
    type: SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
  });
  const contractEntryId = prismTaskContractEntryId(lineage.rootSessionId, {
    rootRunId: receipt.rootRunId,
    taskId: receipt.taskId,
    attemptId: receipt.attemptId,
  });
  const contractData = contractEntries.find((entry) => entry.id === contractEntryId)?.data;
  const contract = isRecord(contractData) ? contractData.contract : undefined;
  const criterion = isValidPrismTaskContract(contract)
    ? contract.criteria.find(
        (candidate) =>
          candidate.id === receipt.criterionId &&
          candidate.evaluatorId === receipt.evaluatorId &&
          candidate.evaluatorVersion === receipt.evaluatorVersion,
      )
    : undefined;
  if (
    !isValidPrismTaskContract(contract) ||
    contract.contractSha256 !== receipt.contractSha256 ||
    !criterion ||
    !isPrismReceiptForCriterion(receipt, criterion)
  ) {
    throw new Error("PRISM evidence receipt does not match the persisted task contract");
  }

  const entryId = prismEvidenceReceiptEntryId(lineage.rootSessionId, receipt);
  return serializePrismFactPersistence.call(this, entryId, async () => {
    const entries = await readSessionEntries({
      sessionID: lineage.rootSessionId,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
    });
    const existing = entries.find((entry) => entry.id === entryId);
    if (existing) {
      const existingReceipt = isRecord(existing.data) ? existing.data.receipt : undefined;
      if (
        isValidPrismHostEvidenceReceipt(existingReceipt) &&
        JSON.stringify(existingReceipt) === JSON.stringify(receipt)
      ) {
        const envelope = await ensurePrismProjectionEnvelope.call(this, existing, event);
        return restorePrismProjectionEvent(envelope, event.type, { receipt: existingReceipt });
      }
      // 原因：同一个 verifier invocation 的结果不可被后续 upsert 改写。
      throw new Error("Conflicting PRISM evidence receipt");
    }

    const timestamp = event.timestamp.getTime();
    try {
      await saveSessionEntry({
        id: entryId,
        sessionID: lineage.rootSessionId,
        type: SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
        touchSession: false,
        time: { created: timestamp, updated: timestamp },
        data: { receipt, projectionEvent: createPrismProjectionEventEnvelope(event) },
      });
    } catch (error) {
      this.logger?.warn("Failed to persist PRISM evidence receipt", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_entry.prism_evidence_receipt.persist_failed",
        module: "core.runtime",
        receiptId: receipt.receiptId,
        status: "failed",
        taskId: receipt.taskId,
      });
      throw error;
    }
    return event;
  });
}

export async function persistSubagentExecutionTerminal(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<SessionEvent> {
  const store = this.sessionStore;
  if (!store?.saveSessionEntry || !store.sessionEntries) {
    throw new Error("PRISM terminal lifecycle persistence is unavailable");
  }
  const saveSessionEntry = store.saveSessionEntry.bind(store);
  const readSessionEntries = store.sessionEntries.bind(store);
  const candidate = event.payload;
  if (
    !isRecord(candidate) ||
    candidate.schema !== "zcode.prism.subagent-terminal.v3" ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.attemptId !== "string"
  ) {
    throw new Error("Invalid PRISM terminal lifecycle event");
  }
  const payload = candidate as unknown as SubagentExecutionTerminalPayload;
  const lineage = resolveCurrentPrismTaskLineage.call(this, event.sessionId, payload.taskId);
  const task = this.runtimeTaskRegistry.get(payload.taskId);
  const expectedTerminalStatus =
    payload.childStarted === false && task?.status === "killed" ? "cancelled" : task?.status;
  const expectedAcceptanceStatus =
    task?.status === "completed" && task.output?.status === "completed"
      ? (task.output.acceptance?.status ?? "unknown")
      : "unknown";
  const expectedTerminalId = task
    ? `${task.rootRunId}/${task.taskId}/${task.branchGeneration ?? 0}/${task.attemptId}`
    : undefined;
  if (
    !task ||
    task.status === "running" ||
    typeof payload.terminalId !== "string" ||
    payload.terminalId !== expectedTerminalId ||
    payload.rootRunId !== lineage.rootRunId ||
    payload.parentTaskId !== lineage.parentTaskId ||
    payload.attemptId !== lineage.attemptId ||
    payload.branchGeneration !== lineage.branchGeneration ||
    payload.childSessionId !== lineage.childSessionId ||
    typeof payload.childStarted !== "boolean" ||
    payload.terminalStatus !== expectedTerminalStatus ||
    payload.provenance !== "runtime_lifecycle" ||
    payload.acceptanceStatus !== expectedAcceptanceStatus ||
    !(payload.observedAt instanceof Date) ||
    !Number.isFinite(payload.observedAt.getTime())
  ) {
    // 原因：不能将旧 attempt、伪造状态或其他 child 的 terminal 投影写入 root session。
    throw new Error("PRISM terminal lifecycle does not match the registered task");
  }

  const entryId = prismTaskTerminalEntryId(lineage.rootSessionId, payload);
  return serializePrismFactPersistence.call(this, entryId, async () => {
    const entries = await readSessionEntries({
      sessionID: lineage.rootSessionId,
      type: SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
    });
    const existing = entries.find((entry) => entry.id === entryId);
    if (existing) {
      const existingPayload = isRecord(existing.data) ? existing.data.terminal : undefined;
      if (JSON.stringify(existingPayload) === JSON.stringify(payload)) {
        const canonicalPayload = restorePrismTerminalPayload(existingPayload);
        if (!canonicalPayload) throw new Error("Malformed PRISM terminal lifecycle projection");
        const envelope = await ensurePrismProjectionEnvelope.call(this, existing, event);
        return restorePrismProjectionEvent(envelope, event.type, canonicalPayload);
      }
      // 原因：同一稳定 terminal id 只允许重复写入同一个终态快照。
      throw new Error("Conflicting PRISM terminal lifecycle projection");
    }

    const timestamp = event.timestamp.getTime();
    try {
      await saveSessionEntry({
        id: entryId,
        sessionID: lineage.rootSessionId,
        type: SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
        touchSession: false,
        time: { created: timestamp, updated: timestamp },
        data: { terminal: payload, projectionEvent: createPrismProjectionEventEnvelope(event) },
      });
    } catch (error) {
      this.logger?.warn("Failed to persist PRISM terminal lifecycle", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_entry.prism_task_terminal.persist_failed",
        module: "core.runtime",
        status: "failed",
        taskId: payload.taskId,
        terminalId: payload.terminalId,
      });
      throw error;
    }
    return event;
  });
}
