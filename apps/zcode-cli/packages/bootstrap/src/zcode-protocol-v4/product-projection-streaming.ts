// ProductProjection 域模块：onModelStreaming, openTextRow, closeTextRow, openReasoningRow 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import type {
  AssistantFeedbackUpdatedPayload,
  HighspeedMetricsUpdatedPayload,
  ModelNetworkStatusPayload,
  TurnExecutionModelFallbackPayload,
  SessionEvent,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
} from "@zcode/contracts";
import { isHighspeedProviderId } from "@zcode/shared";
import type {
  ApiRetryState,
  AssistantTextRow,
  ConversationDelta,
  ReasoningRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  type CanonicalAssistantSegmentFact,
  type CanonicalOpenSegmentIdentity,
} from "./event-normalizer.js";
import {
  positiveInteger,
  nonNegativeInteger,
  modelRetryReasonCode,
  readProviderFallback,
  streamRecoveryReasonCode,
} from "./product-projection-types.js";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function onModelStreaming(
  self: ProductProjectionContext,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const event = fact.event;
  // 迟到终态不复活：非运行期到达的流式事件一律拒收。
  // assistant 守恒：正文类拒收不是无害丢弃——投影建立晚于
  // TurnStarted（订阅中途建 publisher）时，整段回复会静默消失直到刷新
  // （「回复整段消失」的 live 向量）。计数暴露给 gateway：置 stale 标记，
  // 下次订阅强制重新 hydration 从持久事实补齐。
  if (!self.isRunning()) {
    const dropped = fact.stream;
    if (
      dropped.kind === "text_start" ||
      dropped.kind === "text_delta" ||
      dropped.kind === "reasoning_start" ||
      dropped.kind === "reasoning_delta"
    ) {
      self.droppedContentStreamEventCount += 1;
    }
    return [];
  }
  const payload = fact.stream;
  switch (payload.kind) {
    case "text_start":
      return self.openTextRow(event, fact);
    case "text_delta": {
      const open = self.streamingTextRowId === null ? self.openTextRow(event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: self.streamingTextRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "text_end":
      return self.closeTextRow("complete");
    case "reasoning_start":
      return self.openReasoningRow(event, fact);
    case "reasoning_delta": {
      const open = self.streamingReasoningRowId === null ? self.openReasoningRow(event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: self.streamingReasoningRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "reasoning_end":
      return self.closeReasoningRow();
    case "tool_input_start":
      return self.openToolRow(event, payload, fact.entityId);
    case "tool_input_delta": {
      return self.appendStreamingToolInput(event, payload);
    }
    case "tool_input_end":
      return self.flushStreamingToolInput(String(payload.toolCallId ?? ""));
    case "tool_call":
      return self.finalizeStreamingToolInput(event, payload);
    default:
      return [];
  }
}

export function openTextRow(
  self: ProductProjectionContext,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = self.closeTextRow("complete");
  const continuationRowId = self.outputContinuationTextRowId;
  self.outputContinuationTextRowId = null;
  const continuationRow = continuationRowId === null ? undefined : self.findRow(continuationRowId);
  const currentTurnId = self.turnIdOf(event);
  const lastVisibleRow = self.snapshot.rows.window.at(-1);
  if (
    continuationRow?.kind === "assistantText" &&
    continuationRow.turnId === currentTurnId &&
    lastVisibleRow?.rowId === continuationRow.rowId
  ) {
    // runtime 的 output-token Continue 会为每次 provider 请求创建新的
    // assistantMessageId；旧投影因此把一句话拆成 history partial + 轮尾正文。length
    // 已经在 ModelComplete 上提供精确资格，这里只重新打开紧邻的同 turn text row，
    // 让外部 continuous/replayable 客户端都只观察到一条持续增长的 assistant。
    const {
      actions: _actions,
      assistantResponseId: _assistantResponseId,
      feedback: _feedback,
      ...continuedBase
    } = continuationRow;
    const row: AssistantTextRow = {
      ...continuedBase,
      entityId: fact.entityId,
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      state: "streaming",
    };
    self.streamingTextRowId = row.rowId;
    self.entityIdByRowId.set(row.rowId, fact.entityId);
    const previousMessageId = self.messageIdByRowId.get(row.rowId);
    if (previousMessageId) {
      self.outputContinuationRowIdByMessageId.set(previousMessageId, row.rowId);
    }
    if (fact.transcriptMessageId) {
      self.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.upserted", row }];
  }

  // 不变量：非 output-token Continue 的新段必然新 rowId；已有 streaming 行先收口。
  const row: AssistantTextRow = {
    ...self.rowBase(event, self.turnIdOf(event), fact.entityId),
    kind: "assistantText",
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  self.streamingTextRowId = row.rowId;
  self.entityIdByRowId.set(row.rowId, fact.entityId);
  // forkAssistant 锚点：assistant 行 → 权威 messageId（provider 流首帧即带）。
  if (fact.transcriptMessageId) {
    self.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
  }
  return [...close, { op: "row.appended", row }];
}

export function closeTextRow(
  self: ProductProjectionContext,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  if (self.streamingTextRowId === null) return [];
  const row = self.findRow(self.streamingTextRowId);
  self.streamingTextRowId = null;
  if (row?.kind !== "assistantText") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function openReasoningRow(
  self: ProductProjectionContext,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = self.closeReasoningRow();
  const row: ReasoningRow = {
    ...self.rowBase(event, self.turnIdOf(event), fact.entityId),
    kind: "reasoning",
    // Bug 原因：canonical stream 已携带 assistant response 身份，但旧投影只在正文与工具行
    // 保存它，UI 因而无法把同 response 的 reasoning 确定性归入 CUA Group。
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  self.streamingReasoningRowId = row.rowId;
  self.entityIdByRowId.set(row.rowId, fact.entityId);
  return [...close, { op: "row.appended", row }];
}

export function closeReasoningRow(
  self: ProductProjectionContext,
  state: "complete" | "interrupted" = "complete",
): ConversationDelta[] {
  if (self.streamingReasoningRowId === null) return [];
  const row = self.findRow(self.streamingReasoningRowId);
  self.streamingReasoningRowId = null;
  if (row?.kind !== "reasoning") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function closeStreamingRows(
  self: ProductProjectionContext,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  return [...self.closeTextRow(state), ...self.closeReasoningRow(state)];
}

export function onAssistantFeedbackUpdated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as AssistantFeedbackUpdatedPayload;
  const row = self.snapshot.rows.window.find(
    (candidate): candidate is AssistantTextRow =>
      candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  if (payload.feedback === null) {
    if (row.feedback === undefined) return [];
    const { feedback: _removedFeedback, ...withoutFeedback } = row;
    return [{ op: "row.upserted", row: withoutFeedback }];
  }
  if (row.feedback === payload.feedback) return [];
  return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
}

export function onHighspeedMetricsUpdated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as HighspeedMetricsUpdatedPayload;
  const row = self.snapshot.rows.window.find(
    (candidate): candidate is UserInputRow =>
      candidate.kind === "userInput" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  // Bug 根因：终态指标更新曾整体替换 row.highspeed。payload 来自 transcript 原始 metadata + 耗时字段，
  // 不含 live 投影刚由 TurnExecutionModelFallback 写入的 fallbackAt；降级 Toast 依赖的字段被清空，
  // live 与 cold/replay 的结果也不一致。指标更新是增量补充：字段级合并、只增不删（spec §5）。
  return [
    {
      op: "row.upserted",
      row: { ...row, highspeed: { ...row.highspeed, ...payload.highspeed } },
    },
  ];
}

export function onTurnExecutionModelFallback(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnExecutionModelFallbackPayload;
  // Bug 根因：fallback 会作废当前 assistant attempt，但旧投影只更新输入行元数据，仍把旧模型的
  // text/reasoning row 留在 streaming；原模型续流时这些内容会被误标 complete，缺少 text_start 时
  // 甚至直接拼到同一行。未定稿的 tool input 同样不会收到 tool_call，必须随废弃 attempt 一起收口。
  // 已提交执行的工具不在这里处理，它们由 core 的 tool_abandoned 事件收口。
  const discardedStreamDeltas = self.acceptsActiveModelEvent(event)
    ? [
        ...self.closeStreamingRows("interrupted"),
        ...self.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
      ]
    : [];
  // 卡过期与其他加速请求失败都投影到同一张加速输入行：fallbackAt 触发一次性提示，
  // fallbackReason 让 Renderer 区分“卡已到期”与“加速服务不可用”两种文案。
  const turnId = self.turnIdOf(event);
  const row = self.snapshot.rows.window.find(
    (candidate): candidate is UserInputRow =>
      candidate.kind === "userInput" &&
      // Bug 根因：cold hydration 会重建 product turnId，不能再拿 runtime turnId
      // 关联已持久化的输入；inputId/sourceCommandId 才是跨恢复稳定身份。
      (candidate.turnId === turnId ||
        (payload.inputId !== undefined && candidate.sourceCommandId === payload.inputId)) &&
      candidate.highspeed !== undefined,
  );
  if (!row?.highspeed) return discardedStreamDeltas;
  return [
    ...discardedStreamDeltas,
    {
      op: "row.upserted",
      row: {
        ...row,
        highspeed: {
          ...row.highspeed,
          fallbackAt: event.timestamp.getTime(),
          fallbackReason: payload.reason,
        },
      },
    },
  ];
}

export function onModelNetworkStatus(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!self.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as ModelNetworkStatusPayload;
  if (
    (payload.querySource === undefined || payload.querySource === "main_turn") &&
    (payload.type === "model_request_completed" || payload.type === "model_request_failed") &&
    // 加速卡按 family 拆成了多个隐藏 Provider（zai/bigmodel），不能再和单个常量比较，
    // 否则 BigModel 账号的加速轮会被判成普通轮、节省时间恒为 0。
    isHighspeedProviderId(payload.providerId) &&
    payload.durationMs !== undefined
  ) {
    // Bug 根因：混合 Turn 卡过期后会切到普通 provider，旧逻辑把普通模型的重试/超时
    // 也累计进 Highspeed modelDurationMs，导致节省时间按高速倍率放大数小时。
    const turnId = self.turnIdOf(event);
    self.highspeedModelDurationByTurnId.set(
      turnId,
      (self.highspeedModelDurationByTurnId.get(turnId) ?? 0) + Math.max(0, payload.durationMs),
    );
  }
  switch (payload.type) {
    case "model_retry_scheduled": {
      const attempt = positiveInteger(payload.attempt, 1);
      const maxAttempts = Math.max(positiveInteger(payload.maxAttempts, attempt + 1), attempt + 1);
      return self.setApiRetry({
        attempt,
        maxAttempts,
        nextRetryAt: self.ms(event) + nonNegativeInteger(payload.delayMs, 0),
        reasonCode: modelRetryReasonCode(payload.reason),
      });
    }
    case "model_request_started":
      if (payload.streamRecovery) {
        return self.setApiRetry(
          self.streamRecoveryApiRetry(
            payload.streamRecovery.retryNumber,
            payload.streamRecovery.maxRetries,
            self.ms(event),
            self.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
          ),
        );
      }
      // 配额耗尽切换 Provider：适配器在新 Provider 的首个请求上带 providerFallback，
      // 用它作为一条轻量提示，而不是错误横幅。
      const fallback = readProviderFallback(payload.providerFallback);
      if (fallback) {
        return self.setApiRetry({
          attempt: positiveInteger(payload.attempt, 1),
          maxAttempts: positiveInteger(payload.attempt, 1),
          nextRetryAt: self.ms(event),
          reasonCode: "provider_fallback",
          providerFallback: fallback,
        });
      }
      // adapter attempt=2+ 只说明重试请求已发出，不代表连接恢复；
      // 保持当前状态，等首个有效 text/reasoning/tool 进展再清理，避免标签闪退。
      return positiveInteger(payload.attempt, 1) <= 1 ? self.setApiRetry(null) : [];
    case "model_request_completed":
      return self.setApiRetry(null);
    case "model_request_failed":
      return payload.retryable ? [] : self.setApiRetry(null);
    case "model_stream_stalled":
    case "model_first_provider_event":
    case "model_first_content":
    case "model_first_text":
    // 准入等待的两端是 runtime 观测，不是 UI 状态：
    // 不映射成重试/等待标签。
    case "model_request_queued":
    case "model_request_admitted":
    case "model_request_observation":
      return [];
  }
}

export function onStreamRecoveryStarted(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!self.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as StreamRecoveryStartedPayload;
  return self.setApiRetry(
    self.streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      self.ms(event),
      streamRecoveryReasonCode(payload.failureKind),
    ),
  );
}

export function onStreamRecoveryTailDiscarded(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!self.acceptsActiveModelEvent(event)) return [];
  // Bug 原因：Core 已用 tail_discarded 切断失败 assistant attempt，但旧 V4 投影忽略该事件，
  // 下一次 reasoning/text 到达时会把旧行误收口为 complete。这里必须先标 interrupted，
  // 让恢复流用新 assistant identity 打开新行，避免 UI 看起来像一次连续完整输出。
  // Bug 原因：断流时已由 tool_input_start 打开、但还没等到 tool_call 定稿的工具行也属于
  // 被作废的 tail——core 只为已提交的工具合成终态，这些行没人收口；恢复请求会用新的
  // toolCallId 再开一行，UI 于是并排出现两张「正在编写工作流」。已提交（running /
  // pendingApproval）的行不在此列，它们的终态由 executor 自己发布。
  return [
    ...self.closeStreamingRows("interrupted"),
    ...self.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
  ];
}

export function onStreamRecoveryRetryStarted(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  if (!self.acceptsActiveModelEvent(event)) return [];
  const payload = event.payload as StreamRecoveryRetryStartedPayload;
  return self.setApiRetry(
    self.streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      self.ms(event),
      self.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
    ),
  );
}

export function streamRecoveryApiRetry(
  self: ProductProjectionContext,
  retryNumber: number,
  maxRetriesValue: number,
  nextRetryAt: number,
  reasonCode: string,
): ApiRetryState {
  const attempt = positiveInteger(retryNumber, 1);
  const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
  return {
    attempt,
    maxAttempts: maxRetries + 1,
    nextRetryAt,
    reasonCode,
  };
}

export function setApiRetry(
  self: ProductProjectionContext,
  apiRetry: ApiRetryState | null,
): ConversationDelta[] {
  const current = self.snapshot.control.apiRetry;
  if (
    current === apiRetry ||
    (current !== null &&
      apiRetry !== null &&
      current.attempt === apiRetry.attempt &&
      current.maxAttempts === apiRetry.maxAttempts &&
      current.nextRetryAt === apiRetry.nextRetryAt &&
      current.reasonCode === apiRetry.reasonCode &&
      current.providerFallback?.from === apiRetry.providerFallback?.from &&
      current.providerFallback?.to === apiRetry.providerFallback?.to)
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: self.controlPatch({ apiRetry }),
    },
  ];
}

export function acceptsActiveModelEvent(
  self: ProductProjectionContext,
  event: SessionEvent,
): boolean {
  if (!self.isRunning()) return false;
  // stop/新一轮后旧请求可能迟到；仅凭 session 级状态会让旧 turn 的
  // retry/progress 覆盖当前输入栏。当前 runtime turn 已知时必须按 turnId 隔离。
  return (
    self.currentTurnId === null ||
    event.turnId === undefined ||
    String(event.turnId) === self.currentTurnId
  );
}

export function recordHighspeedToolStarted(
  self: ProductProjectionContext,
  turnId: string,
  toolCallId: string,
  startedAt: number,
): void {
  const intervals = self.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
  intervals.set(toolCallId, { startedAt });
  self.highspeedToolIntervalsByTurnId.set(turnId, intervals);
}

export function recordHighspeedToolEnded(
  self: ProductProjectionContext,
  turnId: string,
  toolCallId: string,
  endedAt: number,
  durationMs?: number,
): void {
  const intervals = self.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
  const existing = intervals.get(toolCallId);
  const startedAt = existing?.startedAt ?? Math.max(0, endedAt - Math.max(0, durationMs ?? 0));
  intervals.set(toolCallId, {
    startedAt,
    endedAt: Math.max(
      startedAt,
      existing && durationMs !== undefined ? startedAt + durationMs : endedAt,
    ),
  });
  self.highspeedToolIntervalsByTurnId.set(turnId, intervals);
}

export function highspeedTimingForTurn(
  self: ProductProjectionContext,
  turnId: string,
  activeMs?: number,
): { modelDurationMs: number; toolDurationMs: number; otherDurationMs: number } | undefined {
  const modelDurationMs = self.highspeedModelDurationByTurnId.get(turnId);
  const intervals = self.highspeedToolIntervalsByTurnId.get(turnId);
  if (modelDurationMs === undefined && intervals === undefined) return undefined;
  const sorted = [...(intervals?.values() ?? [])]
    .filter((interval) => interval.endedAt !== undefined)
    .sort((left, right) => left.startedAt - right.startedAt);
  let toolDurationMs = 0;
  let unionEnd = -1;
  for (const interval of sorted) {
    const start = Math.max(0, interval.startedAt);
    const end = Math.max(start, interval.endedAt ?? start);
    if (start > unionEnd) toolDurationMs += end - start;
    else if (end > unionEnd) toolDurationMs += end - unionEnd;
    unionEnd = Math.max(unionEnd, end);
  }
  const model = Math.max(0, modelDurationMs ?? 0);
  const otherDurationMs = Math.max(
    0,
    (activeMs ?? model + toolDurationMs) - model - toolDurationMs,
  );
  self.highspeedModelDurationByTurnId.delete(turnId);
  self.highspeedToolIntervalsByTurnId.delete(turnId);
  return { modelDurationMs: model, toolDurationMs, otherDurationMs };
}

export function openAssistantSegments(
  self: ProductProjectionContext,
): Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> {
  const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
  const text = self.openSegmentIdentity(self.streamingTextRowId);
  const reasoning = self.openSegmentIdentity(self.streamingReasoningRowId);
  if (text) segments.text = text;
  if (reasoning) segments.reasoning = reasoning;
  return segments;
}

export function openSegmentIdentity(
  self: ProductProjectionContext,
  rowId: number | null,
): CanonicalOpenSegmentIdentity | null {
  if (rowId === null) return null;
  const entityId = self.entityIdByRowId.get(rowId);
  if (!entityId) return null;
  return {
    entityId,
    transcriptMessageId: self.messageIdByRowId.get(rowId) ?? null,
  };
}

export function isMirroredSubagentToolEvent(
  self: ProductProjectionContext,
  event: SessionEvent,
): boolean {
  const payload = event.payload as unknown as Record<string, unknown>;
  // Bug 原因：child tool lifecycle 会镜像到父 runtime，但它不是父 session 的工具事实。
  // V4 过去把 mirror 当普通 ToolCallRow，导致 main timeline 展示 child 的 Read/Bash，
  // 并让 replayable snapshot 同样带上脏 row。完整工具历史只应由 child topic 物化。
  return payload.source === "subagent";
}
