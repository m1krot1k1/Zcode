






import { type TurnAttachment } from "@zcode/core";
import { parseRewindTriggeredPayload, RewindScope, RewindStrategy, type MessageWithParts, type MessageId, type SessionEvent, SessionEventType, type SessionId, type TargetCompletionVerificationPayload, type TurnId } from "@zcode/contracts";
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY, zcodeProtocolErrorCodes, zcodeSessionCloseParamsSchema, zcodeSessionMessagesParamsSchema, zcodeSessionReadParamsSchema, elideSessionSnapshotForIndex, type ZCodeSessionCreateParams, type ZCodeDeliveryKind, type ZCodeProtocolTrace, type ZCodeSessionEvent } from "@zcode/shared";
import { buildSessionSnapshot } from "./mapper.js";

import { ProtocolRequestError, parseParams, requireSession, type ZCodeProtocolAgentServerContext, type ZCodeProtocolSessionRecord, type ZCodeProtocolToolInputTransmissionState } from "./server-types.js";















import { abortMcpUiToolCallsForSession, clearMcpUiAppToolsForSession } from "./mcp-ui/index.js";
import {
  ActivatedSessionForResume,
  PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS,
  PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS,
  PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS,
  PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS,
  ProtocolGoalTarget,
  ProtocolStreamingDeltaKind,
  SessionStartupPreferences,
  SessionStartupPreferencesSource,
  asRecord,
  copyBooleanFields,
  copyNumberFields,
  copyObjectKeySummary,
  copyStringFields,
  measureJsonBytes,
  numberValue,
  protocolSourceEventKey,
  shouldCloseSessionForExpectedPersistence,
  stringValue,
  timestampMsForProtocolEvent,
} from "./server-operations-part1.js";
import {
  ActiveConversationRewindPayload,
  ProtocolStreamingDeltaBatch,
  ProtocolStreamingDeltaBatchInfo,
  SnapshotPhaseDurationsMs,
  asGoalCompletionVerification,
  buildProtocolStreamingDeltaBatchKey,
  copyByteLength,
  copyContextUsageBreakdownSummary,
  copySmallObject,
  decodeTextProtocolAttachment,
  emitStateUpdated,
  formatGoalChanged,
  isImportedHistoryMessage,
  isRewindCommandAckMessage,
  isTargetCompletionVerificationStatus,
  isUserVisibleSessionMessage,
  markStreamedToolInputIfPresent,
  protocolEventSequenceKey,
  readActiveSessionMessages,
  readProtocolStreamingParentToolUseId,
  requestSessionRuntimePreferences,
  resolveProtocolBashShellSelection,
  snapshot,
} from "./server-operations-part2.js";

// Часть 3/7 модуля server-operations: вынесено по лимиту строк.

export function parseActiveConversationRewindPayload(
  event: SessionEvent,
): ActiveConversationRewindPayload | null {
  try {
    const payload = parseRewindTriggeredPayload(event.payload);
    if (
      payload.strategy !== RewindStrategy.ActiveChain ||
      (payload.scope !== RewindScope.Conversation && payload.scope !== RewindScope.Both) ||
      !payload.createdMessageId ||
      !payload.targetMessageId
    ) {
      // core 会为不可用的 rewind 记录 unavailable event，但这类事件没有 createdMessageId。
      // 它不是新的 active branch 起点，协议投影不能用它裁剪消息，否则连续编辑会把可见消息投空。
      return null;
    }
    return {
      createdMessageId: payload.createdMessageId,
      targetMessageId: payload.targetMessageId,
    };
  } catch {
    return null;
  }
}

export function filterRewindCommandAckMessages(
  messages: MessageWithParts[],
  activeConversationRewinds: readonly ActiveConversationRewindPayload[],
): MessageWithParts[] {
  if (activeConversationRewinds.length === 0) {
    return messages;
  }
  const targetByNoticeMessageId = new Map<MessageId, MessageId>();
  for (const rewind of activeConversationRewinds) {
    targetByNoticeMessageId.set(rewind.createdMessageId, rewind.targetMessageId);
  }
  return messages.filter((message) => !isRewindCommandAckMessage(message, targetByNoticeMessageId));
}

export function afterPromptAccepted(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  record.stateRevision++;
  record.updatedAt = Date.now();
  emitStateUpdated(context, record, reason, { status: "running" });
  return {
    accepted: true as const,
    sessionId: record.app.sessionId,
    stateRevision: record.stateRevision,
  };
}

export interface LiveProtocolStreamingDeltaBatch {
  batch?: ProtocolStreamingDeltaBatch;
  flushedFirstDeltaBatchKeys: Set<string>;
  lastFlushAtByBatchKey: Map<string, number>;
}

export function getProtocolEventSequenceState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
) {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolEventSequences.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    lastSeq: 0,
    seqBySourceEventKey: new Map<string, number>(),
  };
  record.protocolEventSequences.set(key, created);
  return created;
}

export function getProtocolToolInputTransmissionState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeProtocolToolInputTransmissionState {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolToolInputTransmissions.get(key);
  if (existing) {
    return existing;
  }
  const created: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  record.protocolToolInputTransmissions.set(key, created);
  return created;
}

export function readStreamingDeltaBatchableEvent(
  event: SessionEvent,
): ProtocolStreamingDeltaBatchInfo | null {
  if (event.type !== SessionEventType.ModelStreaming) {
    return null;
  }
  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind) as ProtocolStreamingDeltaKind | undefined;
  if (kind !== "tool_input_delta" && kind !== "text_delta" && kind !== "reasoning_delta") {
    return null;
  }
  const delta = stringValue(payload.delta);
  if (!delta) {
    return null;
  }
  const assistantMessageId = stringValue(payload.assistantMessageId);
  const inputId = stringValue(payload.inputId);
  const partId = stringValue(payload.partId);
  const parentToolUseId = readProtocolStreamingParentToolUseId(payload);
  const toolCallId = stringValue(payload.toolCallId);
  if (kind === "tool_input_delta" && !toolCallId) {
    return null;
  }
  return {
    batchKey: buildProtocolStreamingDeltaBatchKey({
      assistantMessageId,
      inputId,
      kind,
      partId,
      parentToolUseId,
      toolCallId,
    }),
    delta,
    kind,
    maxChars:
      kind === "tool_input_delta"
        ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS
        : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS,
    shouldFlushFirstDelta:
      kind === "text_delta" || kind === "reasoning_delta" || kind === "tool_input_delta",
    timestampMs: timestampMsForProtocolEvent(event),
  };
}

export function mergeProtocolStreamingDeltaBatch(
  batch: ProtocolStreamingDeltaBatch | undefined,
  event: SessionEvent,
  deltaInfo: ProtocolStreamingDeltaBatchInfo,
): ProtocolStreamingDeltaBatch {
  if (!batch || batch.batchKey !== deltaInfo.batchKey) {
    return {
      batchKey: deltaInfo.batchKey,
      delta: deltaInfo.delta,
      event,
      kind: deltaInfo.kind,
      maxChars: deltaInfo.maxChars,
      startedAtMs: deltaInfo.timestampMs,
      updatedAtMs: deltaInfo.timestampMs,
    };
  }
  return {
    batchKey: deltaInfo.batchKey,
    delta: `${batch.delta}${deltaInfo.delta}`,
    event,
    kind: deltaInfo.kind,
    maxChars: deltaInfo.maxChars,
    startedAtMs: batch.startedAtMs,
    updatedAtMs: deltaInfo.timestampMs,
  };
}

export function materializeProtocolStreamingDeltaBatch(batch: ProtocolStreamingDeltaBatch): SessionEvent {
  const payload = asRecord(batch.event.payload);
  return {
    ...batch.event,
    payload: {
      ...payload,
      delta: batch.delta,
    },
  };
}

export function rememberProtocolStreamingDeltaBatchFlush(
  lastFlushAtByBatchKey: Map<string, number>,
  batch: ProtocolStreamingDeltaBatch,
): void {
  lastFlushAtByBatchKey.set(batch.batchKey, batch.updatedAtMs);
}

export function shouldFlushProtocolStreamingDeltaBatchForInterval(
  batch: ProtocolStreamingDeltaBatch,
  lastFlushAtByBatchKey: Map<string, number>,
): boolean {
  const lastFlushAt = lastFlushAtByBatchKey.get(batch.batchKey);
  if (lastFlushAt === undefined) {
    return false;
  }
  // active 任务的流式 function call 不能只按 4KB 字节预算出包。
  // 单行 JSON 参数会在 protocol 边界长时间滞留，表现为工具卡参数不再流式更新。
  const maxIntervalMs =
    batch.kind === "tool_input_delta"
      ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS
      : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS;
  return batch.updatedAtMs - lastFlushAt >= maxIntervalMs;
}

export function omitDuplicateScheduledToolInput(
  event: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): ZCodeSessionEvent {
  markStreamedToolInputIfPresent(mappedEvent, toolInputTransmissions);
  if (event.type !== SessionEventType.ToolCallScheduled || mappedEvent.type !== "tool.updated") {
    return mappedEvent;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "scheduled" || !("input" in payload)) {
    return mappedEvent;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId || !toolInputTransmissions.streamedToolCallIdsWithInput.has(toolCallId)) {
    return mappedEvent;
  }

  const nextPayload: Record<string, unknown> = { ...payload };
  const input = nextPayload.input;
  delete nextPayload.input;
  nextPayload.inputByteLength = measureJsonBytes(input);
  nextPayload.inputOmitted = true;
  nextPayload.inputRef = "model_stream";
  // 性能修复：AI SDK 的 tool_call 已经在 model.streaming 里交付完整 input；
  // scheduled 只是生命周期边界，重复携带 Write/Edit 大参数会让 stdio 和 renderer 双重放大。
  return {
    ...mappedEvent,
    payload: nextPayload,
  };
}

export function mapProtocolPromptAttachment(attachment: unknown): TurnAttachment | undefined {
  const record = asRecord(attachment);
  const kind = stringValue(record.kind);
  const filename = stringValue(record.filename) ?? "attachment";
  const localPath = stringValue(record.localPath);
  const mimeType = stringValue(record.mimeType);
  const isPdf =
    kind === "pdf" || mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  // GUI 协议附件使用 kind/localPath/dataBase64，而 core runtime 只认 type/path/content。
  // 这里在协议边界完成语义转换，避免把 renderer 的传输格式泄漏到 agent 内部。
  // 展示元信息（filename/mimeType/sizeBytes）在协议边界保真透传，
  // TurnStarted 事件与 v4 userInput row 的附件展示不再依赖 basename/扩展名推断。
  const displayMeta = {
    filename,
    ...(mimeType ? { mimeType } : {}),
    ...(typeof record.sizeBytes === "number" ? { sizeBytes: record.sizeBytes } : {}),
  };
  if (isPdf) {
    if (localPath) {
      return { path: localPath, type: "pdf", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    return dataBase64
      ? {
          content: `data:application/pdf;base64,${dataBase64}`,
          path: filename,
          type: "pdf",
          ...displayMeta,
        }
      : undefined;
  }
  if (kind === "image") {
    if (localPath) {
      return { path: localPath, type: "image", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "image/*";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "image",
          ...displayMeta,
        }
      : undefined;
  }

  // video：localPath 零拷贝（agent 侧读文件做大小校验）；Web 端 dataBase64 组 data URL inline。
  if (kind === "video") {
    if (localPath) {
      return { path: localPath, type: "video", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "video/mp4";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "video",
          ...displayMeta,
        }
      : undefined;
  }

  if (kind === "file" || kind === "audio") {
    if (localPath) {
      return {
        path: localPath,
        ...(kind === "file" &&
        (stringValue(record.sourceKind) === "clipboard-text" ||
          stringValue(record.sourceKind) === "topic-history")
          ? { sourceKind: stringValue(record.sourceKind) as "clipboard-text" | "topic-history" }
          : {}),
        type: "file",
        ...displayMeta,
      };
    }
    const textContent = stringValue(record.textContent);
    if (textContent !== undefined) {
      return {
        content: textContent,
        path: filename,
        type: "file",
        ...displayMeta,
      };
    }
    const decoded = decodeTextProtocolAttachment(record);
    return decoded !== undefined
      ? { content: decoded, path: filename, type: "file", ...displayMeta }
      : undefined;
  }

  return undefined;
}

export function summarizeProtocolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  copyStringFields(summary, payload, [
    "action",
    "anchorId",
    "assistantMessageId",
    "inputId",
    "kind",
    "queryId",
    "reason",
    "requestId",
    "resultPartId",
    "source",
    "status",
    "taskId",
    "terminalId",
    "toolCallId",
    "toolName",
  ]);
  copyBooleanFields(summary, payload, ["concurrentSafe", "destructive", "done", "readOnly"]);
  copyNumberFields(summary, payload, [
    "durationMs",
    "elapsedMs",
    "outputBytes",
    "stderrBytes",
    "stdoutBytes",
    "tokenCount",
    "toolCallCount",
  ]);
  copyByteLength(summary, payload, "content", "contentBytes");
  copyByteLength(summary, payload, "delta", "deltaBytes");
  copyByteLength(summary, payload, "input", "inputBytes");
  copyByteLength(summary, payload, "outputTail", "outputTailBytes");
  copyByteLength(summary, payload, "previousTarget", "previousTargetBytes");
  copyByteLength(summary, payload, "response", "responseBytes");
  copyByteLength(summary, payload, "result", "resultBytes");
  copyByteLength(summary, payload, "stderrTail", "stderrTailBytes");
  copyByteLength(summary, payload, "stdoutTail", "stdoutTailBytes");
  copyByteLength(summary, payload, "target", "targetBytes");
  copyObjectKeySummary(summary, payload, "input", "input");
  copyObjectKeySummary(summary, payload, "requestHeaders", "requestHeader");
  copyObjectKeySummary(summary, payload, "responseHeaders", "responseHeader");
  copyObjectKeySummary(summary, payload, "result", "result");
  copySmallObject(summary, payload, "usage");
  copyContextUsageBreakdownSummary(summary, payload);
  return summary;
}

export async function removePreviousImportedSessionHistory(params: {
  sessionStore: NonNullable<ZCodeProtocolAgentServerContext["deps"]["sessionStore"]>;
  sessionId: SessionId;
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"];
}): Promise<number> {
  const existingMessages = await params.sessionStore.messages({
    sessionID: params.sessionId,
  });
  let removedCount = 0;
  for (const message of existingMessages) {
    if (!isImportedHistoryMessage(message, params.source)) {
      continue;
    }
    // 旧导入版本复用了 msg_import_0/msg_import_1 这类全局固定 ID。
    // 第二个导入 session 会通过 saveMessage 的 upsert 把前一个 session 的消息改绑过来，
    // 并保留旧 time_created，最终导致会话串消息、顺序反转或恢复为空。重导入前只清理
    // 当前 session 的迁移消息，保留用户后续在导入会话里继续聊出的真实消息。
    await params.sessionStore.removeMessage({
      sessionID: params.sessionId,
      messageID: message.info.id,
    });
    removedCount += 1;
  }
  return removedCount;
}

/**
 * 只恢复 session runtime 生命周期，不物化任何协议表示。
 *
 * V4 冷订阅过去复用 resumeSession，虽然返回值会被直接丢弃，仍会为大历史
 * 构建一份完整 legacy snapshot。runtime 激活和 legacy 表示是两个职责；这里保留
 * snapshot 之前的原有顺序与副作用，让 V4 随后用自己的 durable projection 水合。
 */
export type ResumeActivation = ActivatedSessionForResume;

export async function readSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionReadParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    deliveryKind: params.deliveryKind,
    operation: "session_read",
  });
  record.deliveryKind = params.deliveryKind ?? record.deliveryKind;
  const result = await snapshot(context, record, undefined, {
    messageLimit: params.messageLimit,
    modelAvailability: "current",
  });
  // task index resync 只需标题/搜索文本/可见性/状态，完整历史单行可达 ~15MB 会打满 host stdio；
  // 先按 full 构建再裁剪大载荷，保证 index 派生字段与 full 同源一致。
  return params.contentProfile === "index" ? elideSessionSnapshotForIndex(result) : result;
}

export async function readMessages(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionMessagesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const allMessages = await readActiveSessionMessages(context, record);
  const afterMessageIndex = params.afterMessageId
    ? allMessages.findIndex((message) => String(message.info.id) === params.afterMessageId)
    : -1;
  const messages = afterMessageIndex >= 0 ? allMessages.slice(afterMessageIndex + 1) : allMessages;
  return {
    messages: params.limit ? messages.slice(-params.limit) : messages,
  };
}

export async function closeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCloseParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  if (!shouldCloseSessionForExpectedPersistence(record.persistence, params.expectedPersistence)) {
    // 连接切换与跨端首发可能并发。session/send 会先把 deferred 提升为
    // immediate；条件关闭必须在 Agent record 上原子判断，不能依赖 renderer 的旧快照。
    return { closed: false };
  }
  record.unsubscribe?.();
  // 会话关闭时 abort 仍在进行的插件 UI 工具调用，登记表不留孤儿。
  abortMcpUiToolCallsForSession(params.sessionId);
  // App-Provided Tools：结束本会话全部待执行的页面调用并丢弃登记。
  clearMcpUiAppToolsForSession(context, params.sessionId);
  // 清掉本会话全部资源订阅（refcount 归零的 uri 才真正向 server 退订）。
  await record.app.unsubscribeMcpResourcesForUi?.(`${params.sessionId}|`).catch(() => 0);
  await record.app.close?.();
  // v4 通道（M3）：会话关闭同时清 publisher / 订阅调度；重开会话走 snapshot 冷启动。
  // 关闭运行实例不删除持久化事实，因此必须保留 sessions-index 中的行。
  context.v4Gateway?.disposeSession(params.sessionId);
  context.sessions.delete(params.sessionId);
  // 内存 event store 随 record 释放。
  await record.eventStore.deleteSession(params.sessionId as SessionId);
  return { closed: true };
}

export function formatGoalSummary(target: ProtocolGoalTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatGoalChanged(`Goal ${target.status}`, target);
}

export async function resolveTurnMessageId(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  turnIndex: number,
  role: "assistant" | "user",
): Promise<MessageId> {
  const messages = (await readActiveSessionMessages(context, record)).filter(
    isUserVisibleSessionMessage,
  );
  let currentTurn = -1;
  let lastAssistantForTargetTurn: MessageId | undefined;
  for (const message of messages) {
    if (message.info.role === "user") {
      if (role === "assistant" && currentTurn === turnIndex && lastAssistantForTargetTurn) {
        // fork/rewind 的 legacy turn target 是“目标轮次的 assistant”，
        // 不是“扫描到历史末尾时仍然处于目标轮次”。遇到下一条 user 就清空已找到的
        // assistant，导致只有最后一轮能 fork；compact summary 和 fork notice 这类 synthetic
        // user 又会把最后一轮变成非最后一轮。离开目标轮次前直接返回稳定目标。
        return lastAssistantForTargetTurn;
      }
      currentTurn += 1;
      if (role === "user" && currentTurn === turnIndex) {
        return message.info.id as MessageId;
      }
      continue;
    }
    if (message.info.role === "assistant" && currentTurn === turnIndex) {
      lastAssistantForTargetTurn = message.info.id as MessageId;
    }
  }
  if (role === "assistant" && lastAssistantForTargetTurn) {
    return lastAssistantForTargetTurn;
  }
  throw new ProtocolRequestError(
    zcodeProtocolErrorCodes.sessionUnavailable,
    `Cannot resolve ${role} message for turnIndex=${turnIndex}`,
  );
}

export async function resolveSessionStartupPreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<SessionStartupPreferences> {
  if (source.kind === "inherit") {
    const inheritedShellSelection = source.parent.app.runtime.getSessionShellSelection();
    return {
      memoryEnabled: source.parent.memoryEnabled,
      subagentRuntimeConfigEnabled: source.parent.subagentRuntimeConfigEnabled,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      nativeSearchEnhancementsEnabled: source.parent.nativeSearchEnhancementsEnabled,
      toolSearchMode: source.parent.toolSearchMode,
      workspaceBoundary: source.parent.workspaceBoundary ?? "allow",
      ...(source.parent.sandboxMode ? { sandboxMode: source.parent.sandboxMode } : {}),
      ...(source.parent.sandboxAllowNetwork !== undefined
        ? { sandboxAllowNetwork: source.parent.sandboxAllowNetwork }
        : {}),
      resolveInitialBashShellSelection: async () => inheritedShellSelection,
    };
  }

  const runtimePreferences = await requestSessionRuntimePreferences(
    context,
    sessionId,
    "runtime-materialization",
    trace,
  );
  // 必须在 session runtime 可发出第一次提问前应用；关闭路径会等待已有 snooze 持久化完成。
  await context.v4Interactions.initializeAskUserQuestionAutoResolutionEnabled(
    runtimePreferences.askUserQuestionAutoResolutionEnabled,
  );
  return {
    additionalDirectories: runtimePreferences.additionalDirectories,
    subagentRuntimeConfigEnabled: runtimePreferences.subagentRuntimeConfigEnabled,
    memoryEnabled: runtimePreferences.memoryEnabled,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    nativeSearchEnhancementsEnabled: runtimePreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: runtimePreferences.toolSearchMode,
    workspaceBoundary: runtimePreferences.workspaceBoundary,
    // Этап 4.6: пробрасываем ровно то, что Host прислал; отсутствие поля — дефолт рантайма.
    ...(runtimePreferences.promptDepth ? { promptDepth: runtimePreferences.promptDepth } : {}),
    ...(runtimePreferences.autoRepairLoopEnabled !== undefined
      ? { autoRepairLoopEnabled: runtimePreferences.autoRepairLoopEnabled }
      : {}),
    ...(runtimePreferences.autoRepairLoopLimits
      ? { autoRepairLoopLimits: runtimePreferences.autoRepairLoopLimits }
      : {}),
    ...(runtimePreferences.sandboxMode ? { sandboxMode: runtimePreferences.sandboxMode } : {}),
    ...(runtimePreferences.sandboxAllowNetwork !== undefined
      ? { sandboxAllowNetwork: runtimePreferences.sandboxAllowNetwork }
      : {}),
    ...(runtimePreferences.sandboxCommandTimeoutMs
      ? { sandboxCommandTimeoutMs: runtimePreferences.sandboxCommandTimeoutMs }
      : {}),
    ...(runtimePreferences.subagentMaxParallel !== undefined
      ? { subagentMaxParallel: runtimePreferences.subagentMaxParallel }
      : {}),
    ...(runtimePreferences.codeIndexAutoStart !== undefined
      ? { codeIndexAutoStart: runtimePreferences.codeIndexAutoStart }
      : {}),
    ...(runtimePreferences.codeIndexVectorChannel !== undefined
      ? { codeIndexVectorChannel: runtimePreferences.codeIndexVectorChannel }
      : {}),
    ...(runtimePreferences.codeIndexTokenBudget
      ? { codeIndexTokenBudget: runtimePreferences.codeIndexTokenBudget }
      : {}),
    ...(runtimePreferences.backgroundFileTasks !== undefined
      ? { backgroundFileTasks: runtimePreferences.backgroundFileTasks }
      : {}),
    ...(runtimePreferences.chatAutocompleteEnabled !== undefined
      ? { chatAutocompleteEnabled: runtimePreferences.chatAutocompleteEnabled }
      : {}),
    ...(runtimePreferences.promptEnhancerEnabled !== undefined
      ? { promptEnhancerEnabled: runtimePreferences.promptEnhancerEnabled }
      : {}),
    resolveInitialBashShellSelection: async () => {
      const executionPreferences = await requestSessionRuntimePreferences(
        context,
        sessionId,
        "user-execution",
        trace,
      );
      return resolveProtocolBashShellSelection(
        context,
        executionPreferences.integratedTerminalShell,
      );
    },
  };
}

export interface SnapshotWithDiagnostics {
  snapshot: Awaited<ReturnType<typeof buildSessionSnapshot>>;
  phaseDurationsMs: SnapshotPhaseDurationsMs;
}

export async function readSnapshotTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTarget();
  } catch (error) {
    // goal 是 session_target 的持久业务状态；snapshot 恢复失败时不能静默吞掉，
    // 否则 UI 会误以为历史 session 没有目标。这里保留运行期 projection 并记录协议层日志。
    context.logger?.warn("Failed to read persisted session goal for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.target_read_failed",
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
}

export async function readSnapshotTodos(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTodos();
  } catch (error) {
    // todo 是 DB 中的权威短期计划；如果恢复读取失败，UI 需要看到明确日志，
    // 但协议 snapshot 仍可用消息历史继续恢复首屏。
    context.logger?.warn("Failed to read persisted session todos for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.todos_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

export function readTargetCompletionVerificationPayload(
  value: unknown,
): TargetCompletionVerificationPayload | null {
  const record = asRecord(value);
  const targetId = stringValue(record.targetId);
  const verificationId = stringValue(record.verificationId);
  const status = stringValue(record.status);
  if (!targetId || !verificationId || !isTargetCompletionVerificationStatus(status)) {
    return null;
  }
  const verification = asGoalCompletionVerification(record.verification);
  const goalIteration = numberValue(record.goalIteration);
  const anchorAssistantMessageId = stringValue(record.anchorAssistantMessageId);
  const anchorTurnId = stringValue(record.anchorTurnId);
  return {
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId
      ? { anchorAssistantMessageId: anchorAssistantMessageId as MessageId }
      : {}),
    ...(anchorTurnId ? { anchorTurnId: anchorTurnId as TurnId } : {}),
  };
}

/**
 * 纯配置类 mutation reason：只改会话选型，不算用户活动。
 * 与 isConfigOnlySessionEvent 同一裁决——record.updatedAt 是 sessions-index
 * lastActivityAt / snapshot.session.updatedAt（task index 排序时间）的事实源，
 * 切模型/切思考深度/切模式不能把任务顶到列表最前。
 */
export const CONFIG_ONLY_MUTATION_REASONS = new Set([
  "model_changed",
  "thought_level_changed",
  "mode_changed",
]);

export const liveProtocolStreamingDeltaBatches = new WeakMap<
  ZCodeProtocolSessionRecord,
  Map<string, LiveProtocolStreamingDeltaBatch>
>();

export function assignProtocolEventSeq(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): number {
  const state = getProtocolEventSequenceState(record, deliveryKind);
  const sourceEventKey = protocolSourceEventKey(event);
  const existing = state.seqBySourceEventKey.get(sourceEventKey);
  if (existing !== undefined) {
    return existing;
  }
  const nextSeq = state.lastSeq + 1;
  state.lastSeq = nextSeq;
  state.seqBySourceEventKey.set(sourceEventKey, nextSeq);
  return nextSeq;
}

export function mapProtocolPromptAttachments(
  attachments: unknown[] | undefined,
): TurnAttachment[] | undefined {
  const mapped = (attachments ?? [])
    .map(mapProtocolPromptAttachment)
    .filter((attachment): attachment is TurnAttachment => attachment !== undefined);
  return mapped.length > 0 ? mapped : undefined;
}
