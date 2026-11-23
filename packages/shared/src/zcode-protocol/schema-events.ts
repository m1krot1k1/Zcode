import { z } from "zod";
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import {
  zcodeDeliveryKindSchema,
  zcodeInteractionRequestOriginSchema,
  zcodeMessagePartSchema,
  zcodeMessageVisibilitySchema,
  zcodeMessageWithPartsSchema,
  zcodePermissionDecisionSchema,
  zcodePermissionUpdateSchema,
  zcodeSessionModeSchema,
  zcodeWorkspaceRefSchema,
} from "../zcode-protocol-legacy-types.js";
import { errorAttributionSchema } from "../zcode-protocol-v4/snapshot.js";
import {
  jsonObjectSchema,
  nonEmptyString,
  protocolInstantSchema,
  timestampMsSchema,
  zcodeToolResultObjectSchema,
} from "./schema-core.js";
import { zcodePermissionOptionSchema, zcodeTurnInputSourceSchema } from "./schema-mcp.js";
import { zcodeFileTransactionEventPayloadSchema } from "./schema-file-transaction.js";
import {
  zcodeModelStreamingEventPayloadSchema,
  zcodeSessionStateSnapshotSchema,
} from "./schema-session-state.js";

export const zcodeEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    seq: z.number().int().nonnegative(),
    traceId: nonEmptyString.optional(),
    timestamp: timestampMsSchema,
    deliveryKind: zcodeDeliveryKindSchema.optional(),
  })
  .strict();

const zcodeComputerUseOperationEventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    sequenceNumber: z.number().int().nonnegative(),
    sessionId: nonEmptyString,
    timestamp: timestampMsSchema,
  })
  .strict();

const zcodeComputerUseTurnStartedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-started"),
  turnId: nonEmptyString,
});

const zcodeComputerUseTurnCompletedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-completed"),
  turnId: nonEmptyString,
});

const zcodeComputerUseTurnFailedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-failed"),
  turnId: nonEmptyString,
});

const zcodeComputerUseToolScheduledEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-scheduled"),
  turnId: nonEmptyString,
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  // 这个 cell 是否在用 Computer Use。只表达布尔事实，不再携带动作名——旧的
  // operationAction 靠从模型源码里抽取动作名得到，SDK 面一变就整体失配（见
  // bootstrap/src/zcode-protocol/computer-use-operation-event.ts 的 usesComputerUse）。
  // 只挂在 scheduled 上：ToolCallStartedPayload 没有 input，start 时已拿不到模型源码。
  computerUse: z.literal(true).optional(),
});

const zcodeComputerUseToolStartedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-started"),
  turnId: nonEmptyString.optional(),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString.optional(),
});

const zcodeComputerUseSessionClosedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("session-closed"),
});

export const zcodeComputerUseOperationEventSchema = z.discriminatedUnion("kind", [
  zcodeComputerUseTurnStartedEventSchema,
  zcodeComputerUseTurnCompletedEventSchema,
  zcodeComputerUseTurnFailedEventSchema,
  zcodeComputerUseToolScheduledEventSchema,
  zcodeComputerUseToolStartedEventSchema,
  zcodeComputerUseSessionClosedEventSchema,
]);

export type ZCodeComputerUseOperationEvent = z.infer<typeof zcodeComputerUseOperationEventSchema>;

export const zcodeSessionEventTypeSchema = z.enum([
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  // Durable refusal of one attributed task item; emitted once before takeover attempts.
  "model.refusal",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "userInput.requested",
  "userInput.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
  // Реактивная синхронизация транзакций ФС (Инкремент 4.2): один факт,
  // полная и компактная проекции различаются полем `compact` в payload.
  "fileTransaction.updated",
]);

export type ZCodeSessionEventType = z.infer<typeof zcodeSessionEventTypeSchema>;

export const zcodeProtocolErrorDetailSchema = z
  .object({
    type: nonEmptyString,
    message: nonEmptyString,
    stack: z.string().optional(),
    code: z.string().optional(),
    detail: z.string().optional(),
    underlyingErrorMessage: z.string().optional(),
    underlyingErrorDetail: z.string().optional(),
    attribution: errorAttributionSchema.optional(),
    retryable: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .strict();

export const zcodeSessionCreatedEventPayloadSchema = z
  .object({
    mode: zcodeSessionModeSchema,
    contextWindow: z.number().int().nonnegative(),
  })
  .strict();

export const zcodeSessionResumedEventPayloadSchema = z
  .object({
    directory: nonEmptyString,
    interruptedToolCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    partCount: z.number().int().nonnegative(),
    recoveredCompactTimelineCount: z.number().int().nonnegative().optional(),
    recoveredSteerInputCount: z.number().int().nonnegative().optional(),
    resumedTodoCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const zcodeSessionTitleUpdatedEventPayloadSchema = z
  .object({
    messageID: nonEmptyString.optional(),
    previousTitle: z.string(),
    source: z.enum(["default", "first_input", "generated", "custom"]),
    title: z.string(),
  })
  .strict();

export const zcodeTurnStartedEventPayloadSchema = z
  .object({
    // CLI 的高精度执行时间可含小数；漏声明会使 strict 校验丢弃整条开始事件，Bot 因此无法清空上一轮回复。
    executionStartedAt: z.number().nonnegative().optional(),
    turnNumber: z.number().int().nonnegative(),
    input: z.string(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    inputSource: zcodeTurnInputSourceSchema.optional(),
    inputVisibility: zcodeMessageVisibilitySchema.optional(),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    targetId: nonEmptyString.optional(),
    messageId: nonEmptyString.optional(),
    foregroundExecutionId: nonEmptyString.optional(),
    intent: jsonObjectSchema.optional(),
    originMeta: jsonObjectSchema.optional(),
    // runtime 会透传后台唤醒来源，strict schema 必须同步声明以免丢弃整条事件。
    backgroundSource: z.enum(["bash", "subagent"]).optional(),
    attachments: z.array(jsonObjectSchema).optional(),
  })
  .strict();

const zcodeTurnSteerSourceSchema = z.enum(["plan_approval_feedback", "workflow_refine_feedback"]);

const zcodeTurnSteerCommandKindSchema = z.enum(["sendText", "sendGoalCommand", "compact"]);

const zcodeTurnSteerDeliverySchema = z.enum(["queue", "guide"]);

export const zcodeTurnSteerQueuedEventPayloadSchema = z
  .object({
    pendingInputId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    input: z.string(),
    inputPreview: z.string(),
    inputSize: z.number().int().nonnegative(),
    commandKind: zcodeTurnSteerCommandKindSchema.optional(),
    source: zcodeTurnSteerSourceSchema.optional(),
    toolDisallowlist: z.array(nonEmptyString).optional(),
    delivery: zcodeTurnSteerDeliverySchema.optional(),
    targetTurnId: nonEmptyString,
    queueLength: z.number().int().nonnegative(),
    intent: jsonObjectSchema.optional(),
  })
  .strict();

export const zcodeTurnSteerDrainedEventPayloadSchema = z
  .object({
    pendingInputIds: z.array(nonEmptyString),
    queryIds: z.array(nonEmptyString).optional(),
    targetTurnId: nonEmptyString,
    injectedMessageIds: z.array(nonEmptyString),
    drainedInputs: z
      .array(
        z
          .object({
            pendingInputId: nonEmptyString,
            messageId: nonEmptyString,
            text: z.string(),
            delivery: zcodeTurnSteerDeliverySchema.optional(),
            intent: jsonObjectSchema.optional(),
            toolDisallowlist: z.array(nonEmptyString).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const zcodeTurnCompletedEventPayloadSchema = z
  .object({
    response: z.string(),
    tokenCount: z.number().int().nonnegative(),
    usage: z.unknown().optional(),
    toolCallCount: z.number().int().nonnegative(),
    historyRoundCount: z.number().int().nonnegative().optional(),
    duration: z.number().nonnegative(),
    // runtime turn.completed 会附带 cacheStats，协议 schema 之前漏掉该字段。
    // strict 校验失败会让桌面端丢掉终态事件，表现为消息已完成但 UI 一直没有回复。
    cacheStats: z
      .object({
        totalMessages: z.number().int().nonnegative(),
        cachedMessages: z.number().int().nonnegative(),
        lastCacheHit: z.boolean(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    inputId: nonEmptyString.optional(),
    resultType: z.enum([
      "success",
      // "cancelled": 用户主动中断属于正常结束，复用 turn.completed 上报，避免被映射成 turn.failed。
      "cancelled",
      "error_max_turns",
      "error_max_budget",
      "error_during_execution",
      "error_max_tool_calls",
    ]),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();

export const zcodeTurnFailedEventPayloadSchema = z
  .object({
    error: zcodeProtocolErrorDetailSchema,
    turnPhase: z.string(),
    inputId: nonEmptyString.optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();

export const zcodeMessageUpsertedEventPayloadSchema = z
  .object({
    content: z.string(),
    attachments: z.array(z.unknown()).optional(),
    toolCalls: z.array(z.unknown()).optional(),
    type: z.string().optional(),
    compactBoundary: z.unknown().optional(),
  })
  .strict();

export const zcodeMessageRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();

export const zcodeMessagePartDeltaEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    field: z.enum(["text", "reasoning", "input", "output"]).optional(),
    delta: z.string(),
  })
  .strict();

export const zcodeMessagePartUpsertedEventPayloadSchema = z
  .object({
    part: zcodeMessagePartSchema,
  })
  .strict();

export const zcodeMessagePartRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();

const zcodeToolCallBasePayloadSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: z.string().optional(),
    parentToolCallId: nonEmptyString.optional(),
    source: z.enum(["subagent"]).optional(),
    agentId: nonEmptyString.optional(),
    agentType: nonEmptyString.optional(),
    // subagent mirror 会携带后台归因；strict schema 漏字段会让 session/event 整条被丢弃。
    background: z.boolean().optional(),
    childSessionId: nonEmptyString.optional(),
    childToolCallId: nonEmptyString.optional(),
    description: z.string().optional(),
  })
  .strict();

export const zcodeToolUpdatedEventPayloadSchema = z.discriminatedUnion("kind", [
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("scheduled"),
      // 修复：CLI 调度事件已携带所属消息 ID；漏声明会让严格校验丢弃整条事件。
      assistantMessageId: nonEmptyString.optional(),
      toolName: nonEmptyString,
      input: z.unknown().optional(),
      inputByteLength: z.number().int().nonnegative().optional(),
      inputOmitted: z.boolean().optional(),
      inputRef: z.literal("model_stream").optional(),
      dependencies: z.array(nonEmptyString).optional(),
      parallelGroupIndex: z.number().int().nonnegative().optional(),
      canRunParallel: z.boolean().optional(),
      schedule: jsonObjectSchema.optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("started"),
      startedAt: protocolInstantSchema,
      // 修复依据：CLI 在执行前已发出解析后的 capability，漏掉字段会让 v3 严格校验丢弃整条工具事件。
      readOnly: z.boolean().optional(),
      sideEffectScope: z
        .enum(["none", "workspace", "git", "network", "system", "session", "userInteraction"])
        .optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("progress"),
      elapsedMs: z.number().nonnegative().optional(),
      pid: z.number().int().optional(),
      stdoutBytes: z.number().int().nonnegative().optional(),
      stderrBytes: z.number().int().nonnegative().optional(),
      outputBytes: z.number().int().nonnegative().optional(),
      outputPreview: executionOutputPreviewSchema.optional(),
      stdoutTail: z.string().optional(),
      stderrTail: z.string().optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("result"),
      result: zcodeToolResultObjectSchema,
      duration: z.number().nonnegative(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("error"),
      error: zcodeProtocolErrorDetailSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch"),
      toolCallIds: z.array(nonEmptyString),
      successCount: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("raw"),
      payload: jsonObjectSchema,
    })
    .strict(),
]);

export const zcodePermissionRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    reason: z.string(),
    input: z.unknown(),
    suggestedPermissionUpdates: z.array(zcodePermissionUpdateSchema).optional(),
    approvalMode: z.literal("user-once").optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();

export const zcodePermissionResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    decision: zcodePermissionDecisionSchema.optional(),
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    inputSummary: z.unknown().optional(),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();

export const zcodeUserInputRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    prompt: z.string(),
    inputType: z.enum(["text", "choice", "confirm"]).optional(),
    choices: z.array(z.string()).optional(),
  })
  .strict();

export const zcodeUserInputResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    value: z.unknown().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();

export const zcodeSessionClosedEventPayloadSchema = z
  .object({
    reason: z.string().optional(),
  })
  .strict();

/** `model.refusal`: exactly the refused item plus the normalized provider reason. */
export const zcodeModelRefusalEventPayloadSchema = z
  .object({
    taskId: nonEmptyString,
    itemIndex: z.number().int().nonnegative(),
    itemText: z.string().min(1).max(4000),
    reason: nonEmptyString,
  })
  .strict();

export type ZCodeModelRefusalEventPayload = z.infer<typeof zcodeModelRefusalEventPayloadSchema>;

function zcodeSessionEventEnvelopeFor<T extends ZCodeSessionEventType>(
  type: T,
  payload: z.ZodTypeAny,
) {
  return zcodeEventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: payload.optional(),
  });
}

export const zcodeSessionEventSchema = z.discriminatedUnion("type", [
  zcodeSessionEventEnvelopeFor("session.created", zcodeSessionCreatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.resumed", zcodeSessionResumedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.updated", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("session.titleUpdated", zcodeSessionTitleUpdatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.closed", zcodeSessionClosedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.started", zcodeTurnStartedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.steerQueued", zcodeTurnSteerQueuedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.steerDrained", zcodeTurnSteerDrainedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.completed", zcodeTurnCompletedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.failed", zcodeTurnFailedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("message.upserted", zcodeMessageUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("message.removed", zcodeMessageRemovedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.started", zcodeMessagePartUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.delta", zcodeMessagePartDeltaEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.upserted", zcodeMessagePartUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.removed", zcodeMessagePartRemovedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("model.streaming", zcodeModelStreamingEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("model.refusal", zcodeModelRefusalEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("tool.updated", zcodeToolUpdatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("permission.requested", zcodePermissionRequestedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("permission.resolved", zcodePermissionResolvedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("userInput.requested", zcodeUserInputRequestedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("userInput.resolved", zcodeUserInputResolvedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("checkpoint.created", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("rewind.triggered", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("streamRecovery.updated", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("fileTransaction.updated", zcodeFileTransactionEventPayloadSchema),
]);

export type ZCodeSessionEvent = z.infer<typeof zcodeSessionEventSchema>;

export const zcodeSessionEventsResultSchema = z
  .object({
    events: z.array(zcodeSessionEventSchema),
  })
  .strict();

export const zcodeSessionMessagesResultSchema = z
  .object({
    messages: z.array(zcodeMessageWithPartsSchema),
  })
  .strict();

export const zcodeStateUpdatedNotificationSchema = z
  .object({
    type: z.literal("state.updated"),
    scope: z.enum(["server", "workspace", "session"]),
    workspace: zcodeWorkspaceRefSchema.optional(),
    sessionId: nonEmptyString.optional(),
    revision: z.number().int().nonnegative(),
    reason: z.string().optional(),
    patch: z.unknown(),
  })
  .strict();

export type ZCodeStateUpdatedNotification = z.infer<typeof zcodeStateUpdatedNotificationSchema>;

export const zcodeSessionSubscribeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zcodeDeliveryKindSchema,
    afterSeq: z.number().int().nonnegative().optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();

export type ZCodeSessionSubscribeParams = z.infer<typeof zcodeSessionSubscribeParamsSchema>;

export const zcodeSessionSubscribeResultSchema = z
  .object({
    sessionId: nonEmptyString,
    eventSeq: z.number().int().nonnegative(),
    events: z.array(zcodeSessionEventSchema),
    snapshot: zcodeSessionStateSnapshotSchema.optional(),
  })
  .strict();
