// Transcript → SessionEvent 合成（「reduce(transcript) ≡ reduce(events)」）。
//
// 动机：v4 投影是事件溯源，但部分历史突变（纯对话 fork 复制 message 不复制 event、
// rewind 截断只动 message 库）会让 session 的事件日志无法覆盖可见 transcript。冷订阅
// hydration 从事件日志重建拿不到这些历史（「fork-child 历史」）。
//
// 本模块把 message 库的 transcript 反向合成为 reducer 能消费的 SessionEvent 序列——
// 从而复用整套 ProductProjection 归约逻辑，不必再写一份 message→row 的平行归约器。
// 合成事件是「视图重建」用途：只需产出与真实事件流「归约等价」的最小序列。
// v4 冷恢复只能重放 ProductProjection 认识的事件；如果 transcript 里的
// tool/reasoning/subagent/compact part 不反向合成，重启后历史可见运行态会从快照里消失。
import type { MessagePart, MessageWithParts, ModelSelection } from "@zcode/contracts";
import { isHighspeedProviderId } from "@zcode/shared";

import { createSessionId, parseCompletedToolPartMetadata, SessionEventType } from "@zcode/contracts";
import { getConversationModelOnlyTurnTriggerSource, getConversationMessageProjectionPolicy } from "@zcode/shared";

import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";



import {
  AssistantSynthesisState,
  ParsedSubagentOutput,
  PushEvent,
  SUBAGENT_TOOL_NAMES,
  TurnResultForHydration,
  compactEventType,
  compactPayloadFromLegacyCompactionPart,
  compactPayloadFromTimelinePart,
  isPersistedAssistantCancellation,
  isPersistedStreamRecoveryDiscard,
  isRealUserTurnStarter,
  messageCreatedAtMs,
  normalizeTurnResult,
  parseJsonObject,
  persistedTurnResultMarkerOf,
  stableToolSchedule,
  stringField,
  workflowLaunchOfMessage,
  HydratedGoalVerificationEntry,
} from "./transcript-hydration-primitives.js";

/**
 * Синтез событий из частей сообщений (tool/reasoning/subagent/compact/turn-модель).
 * Вынесено из transcript-hydration.ts; зависит только от примитивов.
 */

export function executionKindOfMessage(message: MessageWithParts): "agent" | "controlOnly" | undefined {
  const value = message.info.metadata?.executionKind;
  return value === "agent" || value === "controlOnly" ? value : undefined;
}

/**
 * 引擎附加文本的起点：热路径它在 TurnStarted 上，
 * 冷路径从用户消息 metadata 读回同一个字段。只认非负整数——别的形状按缺席处理（宁可多显示）。
 */
export function epilogueStartOfMessage(message: MessageWithParts): number | undefined {
  const value = message.info.metadata?.epilogueStart;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks = value
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0);
  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

export function subagentInfoFromToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
): ParsedSubagentOutput | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const input =
    part.state.input && typeof part.state.input === "object"
      ? (part.state.input as Record<string, unknown>)
      : {};
  const output = part.state.status === "completed" ? parseJsonObject(part.state.output) : null;
  const metadata = part.metadata && typeof part.metadata === "object" ? part.metadata : {};
  const explicitAgentId =
    stringField(output, "agentId") ??
    stringField(metadata, "agentId") ??
    agentIdFromToolOutput(part.state.status === "completed" ? part.state.output : undefined);
  const agentId = explicitAgentId ?? part.callID;
  return {
    agentId,
    agentType:
      stringField(output, "agentType") ??
      stringField(metadata, "agentType") ??
      stringField(input, "agent") ??
      stringField(input, "agentType") ??
      "subagent",
    childSessionId:
      stringField(output, "childSessionId") ??
      stringField(metadata, "childSessionId") ??
      // 后台 Agent 的持久化 tool output 是人类可读文本而非 JSON；cold merge
      // 会抑制重复 durable spawned，若不从稳定 agentId 行恢复 child session，侧栏入口会丢失。
      (explicitAgentId ? createSessionId(`subagent_${agentId}`) : undefined),
    description:
      stringField(output, "description") ??
      stringField(input, "description") ??
      stringField(metadata, "description"),
    parentToolCallId: part.callID,
    prompt: stringField(output, "prompt") ?? stringField(input, "prompt"),
    summaryText:
      contentBlocksToText(output?.content) ??
      stringField(output, "result") ??
      stringField(output, "summary") ??
      stringField(input, "description") ??
      stringField(input, "prompt"),
  };
}

export function agentIdFromToolOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /(?:^|\r?\n)agentId:\s*([^\s(]+)/u.exec(value)?.[1];
}

export function subagentStatusFromToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
): "completed" | "failed" | "cancelled" {
  switch (part.state.status) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      return "cancelled";
  }
}

/**
 * 附件渲染：FilePart → TurnStarted 附件展示元信息（TurnAttachmentMeta）。
 * 冷订阅/fork-child 的历史附件由 transcript 反向合成——与 live 事件同一投影入口
 * （buildUserInputRow），保证冷/热路径行内容一致。
 */
export function attachmentMetasOfMessage(
  parts: readonly MessagePart[],
): Array<{ fileName: string; mime: string; bytes: number; ref?: string }> {
  const fileParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "file" }> => part.type === "file",
  );
  return fileParts.map((part, index) => {
    const urlIsStableRef = part.url.length > 0 && !part.url.startsWith("data:");
    const basenameFromUrl = urlIsStableRef ? (part.url.split(/[\\/]/).pop() ?? "") : "";
    return {
      fileName: part.filename ?? (basenameFromUrl || `attachment-${index + 1}`),
      mime: part.mime,
      bytes: part.metadata?.sizeBytes ?? 0,
      ...(urlIsStableRef ? { ref: part.url } : {}),
    };
  });
}

export function forkContextOfMessage(message: MessageWithParts):
  | {
      parentSessionId: string;
      restoredFileCount?: number;
      targetCheckpointId?: string;
      targetMessageId?: string;
    }
  | undefined {
  for (const part of message.parts) {
    if (part.type === "timeline" && part.timelineType === "session_fork") {
      return {
        parentSessionId: String(part.parentSessionId),
        ...(typeof part.restoredFileCount === "number"
          ? { restoredFileCount: part.restoredFileCount }
          : {}),
        ...(part.targetCheckpointId ? { targetCheckpointId: part.targetCheckpointId } : {}),
        ...(part.targetMessageId ? { targetMessageId: String(part.targetMessageId) } : {}),
      };
    }
    const metadata = part.type === "text" ? part.metadata : undefined;
    const context = forkContextFromMetadata(metadata);
    if (context) return context;
  }
  return message.info.role === "user" ? forkContextFromMetadata(message.info.metadata) : undefined;
}

export function forkContextFromMetadata(metadata: Record<string, unknown> | undefined):
  | {
      parentSessionId: string;
      restoredFileCount?: number;
      targetCheckpointId?: string;
      targetMessageId?: string;
    }
  | undefined {
  const forkContext = metadata?.forkContext;
  if (typeof forkContext !== "object" || forkContext === null || Array.isArray(forkContext)) {
    return undefined;
  }
  const context = forkContext as Record<string, unknown>;
  if (context.kind !== "session_fork" || typeof context.parentSessionId !== "string") {
    return undefined;
  }
  return {
    parentSessionId: context.parentSessionId,
    ...(typeof context.restoredFileCount === "number"
      ? { restoredFileCount: context.restoredFileCount }
      : {}),
    ...(typeof context.targetCheckpointId === "string"
      ? { targetCheckpointId: context.targetCheckpointId }
      : {}),
    ...(typeof context.targetMessageId === "string"
      ? { targetMessageId: context.targetMessageId }
      : {}),
  };
}

export function isForkTimelineMessage(message: MessageWithParts): boolean {
  return (
    getConversationMessageProjectionPolicy(message) === "timelineOnly" &&
    forkContextOfMessage(message) !== undefined
  );
}

export function synthesizeTextPart(
  part: Extract<MessagePart, { type: "text" }>,
  assistantMessageId: string,
  assistantMessageCreatedAtMs: number | undefined,
  push: PushEvent,
  turnId: string,
): void {
  if (part.ignored === true || part.text.length === 0) return;
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
    // cold 合成事件不能统一用“首条消息时间 + seq”：刷新后
    // assistant 动作栏会把不同历史回复显示成接近同一时间。text row 创建时必须
    // 保留所属 transcript assistant message 的真实创建时间；事件顺序仍由 seq 裁决。
    assistantMessageCreatedAtMs,
  );
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_delta",
      delta: part.text,
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    { kind: "text_end", delta: "", done: false, partId: part.id },
    turnId,
  );
}

export function synthesizeReasoningPart(
  part: Extract<MessagePart, { type: "reasoning" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): void {
  if (part.text.length === 0) return;
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_delta",
      delta: part.text,
      done: false,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    { kind: "reasoning_end", delta: "", done: false, partId: part.id },
    turnId,
  );
}

export function synthesizeSubagentLifecycle(
  info: ParsedSubagentOutput,
  status: "completed" | "failed" | "cancelled",
  push: PushEvent,
  turnId: string,
): void {
  const agentId = info.agentId ?? `subagent-${turnId}`;
  push(
    SessionEventType.SubagentSpawned,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description ?? info.summaryText ?? info.prompt ?? agentId,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      status: "running",
    },
    turnId,
  );
  push(
    SessionEventType.SubagentStopped,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      summaryText: info.summaryText,
      status,
    },
    turnId,
  );
}

export function synthesizeToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) {
    // footprint 过滤只决定是否需要补事件，不能阻止实际合成；这里必须在事件源头
    // 跳过带原始空名 metadata 的恢复 part，避免 cold hydration 重新物化工具行。
    return { resultType: "success", toolCallCount: 0 };
  }
  const toolCallId = part.callID;
  const persistedMetadata = parseCompletedToolPartMetadata(
    "metadata" in part.state ? part.state.metadata : part.metadata,
  );
  push(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId,
      assistantMessageId,
      toolName: part.tool,
      input: part.state.input,
      ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
      schedule: stableToolSchedule(toolCallId),
    },
    turnId,
  );

  const started =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error";
  if (started) {
    push(
      SessionEventType.ToolCallStarted,
      {
        toolCallId,
        toolName: part.tool,
        ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        startedAt: new Date(
          "time" in part.state && typeof part.state.time.start === "number"
            ? part.state.time.start
            : 0,
        ),
      },
      turnId,
    );
  }

  // （2026-09-12）：历史 transcript 里残留的 metadata.widgetState 不再合成事件，
  // 冷恢复直接忽略（widgetState 只留 renderer 内存）。

  const subagentInfo = subagentInfoFromToolPart(part);
  if (subagentInfo && started) {
    synthesizeSubagentLifecycle(subagentInfo, subagentStatusFromToolPart(part), push, turnId);
  }

  if (part.state.status === "completed") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: true,
          content: part.state.output,
          ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  if (part.state.status === "error") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: false,
          content: part.state.error,
          error: {
            type: "fault.runtime.toolFailed",
            message: part.state.error,
          },
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  // CLI 重启后无法证明历史 pending/running 工具仍在运行，不能把
  // active work / stop 按钮复活；让 TurnComplete(cancelled) 统一收口成只读历史。
  return { resultType: "cancelled", toolCallCount: 1 };
}

export function synthesizeCompactPart(
  part: MessagePart,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  push: PushEvent,
  turnId: string,
): boolean {
  let compact =
    part.type === "timeline"
      ? compactPayloadFromTimelinePart(part)
      : part.type === "compaction"
        ? compactPayloadFromLegacyCompactionPart(part)
        : null;
  if (!compact) return false;
  const operationId = String(compact.payload.operationId);
  const durablePart = durableCompactPartsByOperation.get(operationId);
  if (durablePart) {
    // 同 operation 的 timeline part 通常排在 durable compaction part 前面。
    // 旧“先到先得”会丢 tail_start_id；优先采用带 coverage boundary 的 durable payload。
    const durablePayload = compactPayloadFromLegacyCompactionPart(durablePart);
    compact = durablePayload ?? {
      ...compact,
      payload: {
        ...compact.payload,
        ...(durablePart.tail_start_id ? { tailStartMessageId: durablePart.tail_start_id } : {}),
        ...(durablePart.boundaryId ? { boundaryId: durablePart.boundaryId } : {}),
        ...(durablePart.summaryMessageId ? { summaryMessageId: durablePart.summaryMessageId } : {}),
      },
    };
  }
  if (emittedCompactOperations.has(operationId)) return true;
  emittedCompactOperations.add(operationId);
  push(compactEventType(compact.status), compact.payload, turnId);
  return true;
}

// ── goal verification timeline part──
// 持久化契约（core events.ts persistDurableSessionEvent）：verifier 每次生命周期变化
// upsert 同一个 timeline part，身份 targetId_goalIteration，status 为最终生命周期态。
// 反向合成为 started(+终态) 事件对，复用投影既有 goalVerify marker 状态机。
// 旧 hydration 只认 context_compaction，goal_verification part 落入无人
// 消费的分支——每次冷恢复 goalVerify marker 都消失。
export function goalVerificationKeyOfPart(part: Extract<MessagePart, { type: "timeline" }>): string {
  if (part.timelineType !== "goal_verification") return String(part.id);
  return part.goalIteration !== undefined
    ? `${part.targetId}_${part.goalIteration}`
    : part.verificationId;
}

// 冷恢复无法证明历史 verifier 仍在运行（同 pending tool 收口为 cancelled 的先例）：
// started/未知态收口为 cancelled；completed/failed_closed 原样还原。
export function goalVerificationTerminalStatus(
  status: string | undefined,
): "completed" | "failed_closed" | "cancelled" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "failed_closed":
      return "failed_closed";
    default:
      return "cancelled";
  }
}

/** goal verify 事实的归一形态：timeline part（新契约）与 session_entry（legacy 主体）共用。 */
export interface GoalVerificationFact {
  key: string;
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  anchorAssistantMessageId?: string;
  anchorTurnId?: string;
  status?: string;
  verification?: unknown;
}

export function pushGoalVerificationFact(
  fact: GoalVerificationFact,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string | undefined,
): boolean {
  if (emittedGoalVerifications.has(fact.key)) return false;
  emittedGoalVerifications.add(fact.key);
  const base = {
    targetId: fact.targetId,
    verificationId: fact.verificationId,
    ...(fact.goalIteration !== undefined ? { goalIteration: fact.goalIteration } : {}),
    ...(fact.anchorAssistantMessageId
      ? { anchorAssistantMessageId: fact.anchorAssistantMessageId }
      : {}),
    ...(fact.anchorTurnId ? { anchorTurnId: fact.anchorTurnId } : {}),
  };
  push(SessionEventType.TargetCompletionVerification, { ...base, status: "started" }, turnId);
  push(
    SessionEventType.TargetCompletionVerification,
    {
      ...base,
      status: goalVerificationTerminalStatus(fact.status),
      ...(fact.verification ? { verification: fact.verification } : {}),
    },
    turnId,
  );
  return true;
}

export function goalVerificationFactOfPart(
  part: Extract<MessagePart, { type: "timeline" }>,
): GoalVerificationFact | null {
  if (part.timelineType !== "goal_verification") return null;
  return {
    key: goalVerificationKeyOfPart(part),
    targetId: part.targetId,
    verificationId: part.verificationId,
    ...(part.goalIteration !== undefined ? { goalIteration: part.goalIteration } : {}),
    ...(part.anchorMessageId ? { anchorAssistantMessageId: String(part.anchorMessageId) } : {}),
    ...(part.anchorTurnId ? { anchorTurnId: String(part.anchorTurnId) } : {}),
    ...(part.status ? { status: part.status } : {}),
    ...(part.verification ? { verification: part.verification } : {}),
  };
}

export function synthesizeGoalVerificationPart(
  part: MessagePart,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string,
): boolean {
  if (part.type !== "timeline") return false;
  const fact = goalVerificationFactOfPart(part);
  if (!fact) return false;
  pushGoalVerificationFact(fact, emittedGoalVerifications, push, turnId);
  return true;
}

// ── session_entry legacy 源──
// 历史上 goal verify 主要持久化在 session_entry（本机观测 1,402 行 vs timeline part
// 仅 10 行）；entry.data 保留了原始事件 payload。读取端跨源按 targetId_goalIteration
// 去重：timeline part 与 entry 表达同一事实时只发一次（先到先得，anchor 语义一致）。

/** SessionEntryInfo（target_completion_verification）→ 归一 entry；非法数据静默剔除。 */
export function goalVerificationEntriesFromSessionEntries(
  entries: readonly { data: unknown; time: { created: number } }[],
): HydratedGoalVerificationEntry[] {
  const parsed: HydratedGoalVerificationEntry[] = [];
  for (const entry of entries) {
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : null;
    const payload =
      data?.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    const targetId = typeof payload.targetId === "string" ? payload.targetId : null;
    const verificationId =
      typeof payload.verificationId === "string" ? payload.verificationId : null;
    if (!targetId || !verificationId) continue;
    parsed.push({
      payload: {
        targetId,
        verificationId,
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        ...(typeof payload.goalIteration === "number"
          ? { goalIteration: payload.goalIteration }
          : {}),
        ...(typeof payload.anchorAssistantMessageId === "string"
          ? { anchorAssistantMessageId: payload.anchorAssistantMessageId }
          : {}),
        ...(typeof payload.anchorTurnId === "string" ? { anchorTurnId: payload.anchorTurnId } : {}),
        ...(payload.verification !== undefined ? { verification: payload.verification } : {}),
      },
      ...(typeof data?.sequenceNumber === "number" ? { sequenceNumber: data.sequenceNumber } : {}),
      timeCreated: entry.time.created,
    });
  }
  // 同一 key 多条（started/terminal 各一条 entry）：按事件序取最新终态。
  parsed.sort(
    (left, right) =>
      (left.sequenceNumber ?? left.timeCreated) - (right.sequenceNumber ?? right.timeCreated),
  );
  return parsed;
}

export function goalVerificationFactOfEntry(entry: HydratedGoalVerificationEntry): GoalVerificationFact {
  const payload = entry.payload;
  return {
    key:
      payload.goalIteration !== undefined
        ? `${payload.targetId}_${payload.goalIteration}`
        : payload.verificationId,
    targetId: payload.targetId,
    verificationId: payload.verificationId,
    ...(payload.goalIteration !== undefined ? { goalIteration: payload.goalIteration } : {}),
    ...(payload.anchorAssistantMessageId
      ? { anchorAssistantMessageId: payload.anchorAssistantMessageId }
      : {}),
    ...(payload.anchorTurnId ? { anchorTurnId: payload.anchorTurnId } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.verification !== undefined ? { verification: payload.verification } : {}),
  };
}

/** 同一 key 的多条 entry（生命周期各一条）合并为单个 fact：终态覆盖 started。 */
export function mergeGoalVerificationEntryFacts(
  entries: readonly HydratedGoalVerificationEntry[],
): GoalVerificationFact[] {
  const byKey = new Map<string, GoalVerificationFact>();
  for (const entry of entries) {
    const fact = goalVerificationFactOfEntry(entry);
    const existing = byKey.get(fact.key);
    if (!existing) {
      byKey.set(fact.key, fact);
      continue;
    }
    // entries 已按事件序排序：后到的生命周期态（终态）覆盖，anchor 取先有值。
    byKey.set(fact.key, {
      ...existing,
      ...fact,
      anchorAssistantMessageId: existing.anchorAssistantMessageId ?? fact.anchorAssistantMessageId,
      anchorTurnId: existing.anchorTurnId ?? fact.anchorTurnId,
      verification: fact.verification ?? existing.verification,
    });
  }
  return [...byKey.values()];
}

// ── 轮次选型事实──
// modelChange marker 由投影在 TurnStarted 时对比 lastTurnModel 与 config 生成；
// 冷恢复没有 ModelSelected 事件，这里按每轮的持久化选型事实重建。
// 来源优先级：user prompt 的 model 快照（恒在场、与提交时 config 一致）；
// preface 轮（无 user）取 assistant 消息事实。合成 timeline 宿主消息
// （semantics.kind=timeline_event）的 model 是宿主兼容占位，不是本轮事实。
export interface HydratedTimelineModel {
  modelSelection: ModelSelection;
  previousModelSelection?: ModelSelection | null;
}

export function hydratedModelKey(modelSelection: ModelSelection): string {
  return `${modelSelection.providerId}\u0000${modelSelection.modelId}\u0000${modelSelection.options?.reasoningLevel ?? ""}`;
}

export function sessionModelSelectionOfHydratedMessage(
  modelSelection: ModelSelection,
): ModelSelection | null {
  // Bug 原因：加速卡是单轮执行 Selection（selectionScope=execution），消息保留它用于记录
  // 真实执行模型；但冷恢复曾把该字段误当成会话选型，重启后因此生成「加速 → 原模型」的
  // 虚假切换提示。live 路径的 execution 作用域本就不发 ModelSelected，cold 必须同语义。
  return isHighspeedProviderId(modelSelection.providerId) ? null : modelSelection;
}

export function turnModelSelectionOfUserMessage(message: MessageWithParts): ModelSelection | null {
  if (message.info.role !== "user") return null;
  const modelSelection = message.info.modelSelection;
  return modelSelection ? sessionModelSelectionOfHydratedMessage(modelSelection) : null;
}

export function assistantModelSelectionOf(message: MessageWithParts): ModelSelection | null {
  if (message.info.role !== "assistant") return null;
  if (message.info.semantics?.kind === "timeline_event") return null;
  if (!message.info.providerId || !message.info.modelId) return null;
  return sessionModelSelectionOfHydratedMessage({
    providerId: String(message.info.providerId),
    modelId: String(message.info.modelId),
    ...(message.info.reasoningLevel
      ? { options: { reasoningLevel: message.info.reasoningLevel } }
      : {}),
  });
}

export function modelChangeToModelOf(message: MessageWithParts): HydratedTimelineModel | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]!;
    if (part.type !== "timeline" || part.timelineType !== "model_change") continue;
    if (!part.toModel) return null;
    return {
      modelSelection: {
        providerId: part.toModel.providerId,
        modelId: part.toModel.modelId,
        ...(part.toModel.options ? { options: part.toModel.options } : {}),
      },
      previousModelSelection: part.fromModel
        ? {
            providerId: part.fromModel.providerId,
            modelId: part.fromModel.modelId,
            ...(part.fromModel.options ? { options: part.fromModel.options } : {}),
          }
        : null,
    };
  }
  return null;
}

export function modelChangeKeyOfPart(
  part: Extract<MessagePart, { type: "timeline" }> & { timelineType: "model_change" },
): string {
  const from = part.fromModel
    ? `${part.fromModel.providerId}/${part.fromModel.modelId}/${part.fromModel.options?.reasoningLevel ?? ""}`
    : "<unknown>";
  const to = part.toModel
    ? `${part.toModel.providerId}/${part.toModel.modelId}/${part.toModel.options?.reasoningLevel ?? ""}`
    : "<unknown>";
  return `${String(part.anchorMessageId ?? part.messageID)}\u0000${from}\u0000${to}`;
}

// preface 轮开轮门槛：只含 model_change/session_fork 宿主等不可渲染内容的 assistant
// 消息不开轮，避免合成出只有「已工作」壳的空轮。
export function assistantMessageHasSynthesizableContent(message: MessageWithParts): boolean {
  return message.parts.some((part) => {
    switch (part.type) {
      case "text":
        return part.ignored !== true && part.text.length > 0;
      case "reasoning":
        return part.text.length > 0;
      case "tool":
        return !shouldHideInvalidToolCallFromProduct(part.tool, part.metadata);
      case "subtask":
      case "compaction":
        return true;
      case "timeline":
        return (
          part.timelineType === "context_compaction" || part.timelineType === "goal_verification"
        );
      default:
        return false;
    }
  });
}

export function synthesizeSubtaskPart(
  part: Extract<MessagePart, { type: "subtask" }>,
  push: PushEvent,
  turnId: string,
): void {
  synthesizeSubagentLifecycle(
    {
      agentId: String(part.id),
      agentType: part.agent,
      description: part.description,
      prompt: part.prompt,
      summaryText: part.description,
    },
    "completed",
    push,
    turnId,
  );
}

export function synthesizeAssistantParts(
  message: MessageWithParts,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  let resultType: TurnResultForHydration =
    message.info.role === "assistant" && message.info.error
      ? isPersistedAssistantCancellation(message.info.error)
        ? "cancelled"
        : isPersistedStreamRecoveryDiscard(message.info.error)
          ? "success"
          : "error_during_execution"
      : message.info.role === "assistant" && message.info.time.completed === undefined
        ? // Bug 根因：进程退出可能只持久化 step-start/partial，却没有 assistant error；
          // 旧 cold hydration 默认 success，伪造正常 TurnComplete 并让异常 Worked 被收起。
          "cancelled"
        : (persistedTurnResultMarkerOf(message) ?? "success");
  let toolCallCount = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        synthesizeTextPart(
          part,
          String(message.info.id),
          messageCreatedAtMs(message),
          push,
          turnId,
        );
        break;
      case "reasoning":
        // cold hydration 过去没有把 transcript assistant message 身份带到
        // reasoning_start，导致恢复后的 ReasoningRow 无法复用 live projection 的 response 边界。
        synthesizeReasoningPart(part, String(message.info.id), push, turnId);
        break;
      case "tool": {
        const state = synthesizeToolPart(part, String(message.info.id), push, turnId);
        toolCallCount += state.toolCallCount;
        resultType = normalizeTurnResult(resultType, state.resultType);
        break;
      }
      case "timeline":
        if (synthesizeGoalVerificationPart(part, emittedGoalVerifications, push, turnId)) {
          break;
        }
        synthesizeCompactPart(
          part,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          push,
          turnId,
        );
        break;
      case "compaction":
        synthesizeCompactPart(
          part,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          push,
          turnId,
        );
        break;
      case "subtask":
        synthesizeSubtaskPart(part, push, turnId);
        break;
      default:
        break;
    }
  }
  const assistantFeedback = message.info.metadata?.assistantFeedback;
  if (assistantFeedback === "like" || assistantFeedback === "dislike") {
    push(
      SessionEventType.AssistantFeedbackUpdated,
      { entityId: String(message.info.id), feedback: assistantFeedback },
      turnId,
    );
  }
  return { resultType, toolCallCount };
}

// ── model-only 唤醒轮──
// live 路径的 background wake / goal continuation 以 TurnStarted(inputVisibility=
// model-only) 开独立轮；冷路径不能把这类 synthetic user 跳过、让其后的 assistant 并进
// 上一轮——live/cold 必须结构一致。触发 source 由 shared projection policy
// 唯一维护；compact summary / rewind notice 等非触发型 synthetic context 照旧不开轮。

// ── guide steer 内联──
// drain 持久化的 user message 带 metadata.turnSteerDelivery：guide=内联当前轮
// （不是轮边界），queue=独立轮（真实 starter，与 live 切分一致）。legacy 无标记按 queue。
export function steerDeliveryOfMessage(message: MessageWithParts): "guide" | "queue" | null {
  if (message.info.role !== "user") return null;
  const metadata = (message.info as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const delivery = (metadata as Record<string, unknown>).turnSteerDelivery;
  return delivery === "guide" || delivery === "queue" ? delivery : null;
}

/**
 * 轮边界判定：真实 user starter（guide steer 除外——内联当前轮）或 model-only
 * 唤醒触发（background wake / goal continuation 各开一轮）。
 * 注：live 的「合流」场景（active loop 未结束时通知并入当前轮）冷路径无法从持久
 * 事实区分，统一按边界处理——内容不丢、无气泡，仅轮归属与 live 合流场景有已知差异。
 */
export function isTurnBoundaryStarter(message: MessageWithParts): boolean {
  if (isRealUserTurnStarter(message)) {
    return steerDeliveryOfMessage(message) !== "guide";
  }
  // 启动轮是可见 controlOnly 用户轮，必须作为边界让前一轮输出收集在此停下（一会话一 run 下
  // 它本就是首条消息，但语义上仍是独立轮边界，不能被并进上一轮）。
  if (workflowLaunchOfMessage(message)) return true;
  return getConversationModelOnlyTurnTriggerSource(message) !== null;
}
