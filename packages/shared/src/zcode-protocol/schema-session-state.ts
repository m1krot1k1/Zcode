import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import {
  zcodeInteractionRequestOriginSchema,
  zcodeMessageWithPartsSchema,
  zcodeSessionApiRetryStatusSchema,
  zcodeSessionContextUsageSchema,
  zcodeSessionGoalSchema,
  zcodeSessionGoalVerificationSchema,
  zcodeSessionGoalVerificationTimelineSchema,
  zcodeSessionInfoSchema,
  zcodeSessionKindSchema,
  zcodeSessionModeSchema,
  zcodeSessionRuntimeStateSchema,
  zcodeSessionStatusSchema,
  zcodeToolRepairAttemptRecordSchema,
  zcodeToolRepairStageSchema,
  zcodeToolStateSchema,
  zcodeTurnStateTransitionRecordSchema,
  type ZCodeToolRepairAttemptRecord,
  type ZCodeToolRepairStage,
  type ZCodeTurnStateTransitionRecord,
} from "../zcode-protocol-legacy-types.js";
import { errorAttributionSchema } from "../zcode-protocol-v4/snapshot.js";
import {
  jsonObjectSchema,
  nonEmptyString,
  timestampMsSchema,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
} from "./schema-core.js";
import { zcodePermissionOptionSchema } from "./schema-mcp.js";
import { zcodeModelOptionSchema, zcodeThoughtLevelOptionSchema } from "./schema-model.js";

export type ZCodeSessionMode = z.infer<typeof zcodeSessionModeSchema>;

export type ZCodeSessionKind = z.infer<typeof zcodeSessionKindSchema>;

export type ZCodeSessionGoal = z.infer<typeof zcodeSessionGoalSchema>;

export const zcodeSessionTodoItemSchema = z
  .object({
    content: nonEmptyString,
    status: z.enum(["pending", "in_progress", "completed"]),
    priority: z.enum(["high", "medium", "low"]),
  })
  .strict();

export const zcodeSessionGoalStatsSchema = z
  .object({
    timeUsedSeconds: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    iterationCount: z.number().int().nonnegative(),
  })
  .strict();

export type ZCodeSessionGoalStats = z.infer<typeof zcodeSessionGoalStatsSchema>;

export type ZCodeSessionGoalVerification = z.infer<typeof zcodeSessionGoalVerificationSchema>;

export type ZCodeSessionGoalVerificationTimeline = z.infer<
  typeof zcodeSessionGoalVerificationTimelineSchema
>;

export const zcodeSessionTodoGroupSchema = z
  .object({
    id: nonEmptyString,
    source: z.enum(["goal_iteration", "session"]),
    goalIteration: z.number().int().positive().optional(),
    targetId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema.optional(),
    todos: z.array(zcodeSessionTodoItemSchema),
  })
  .strict();

export type ZCodeSessionTodoGroup = z.infer<typeof zcodeSessionTodoGroupSchema>;

export const zcodeSessionSettingsStateSchema = z
  .object({
    model: z
      .object({
        // 未绑定是合法恢复状态；不能为满足协议而伪造模型或阻断历史读取。
        current: modelSelectionSchema.optional(),
        available: z.array(zcodeModelOptionSchema),
        lastUsed: modelSelectionSchema.optional(),
      })
      .strict(),
    thoughtLevel: z
      .object({
        enabled: z.boolean(),
        current: nonEmptyString.optional(),
        defaultLevel: nonEmptyString.optional(),
        available: z.array(zcodeThoughtLevelOptionSchema),
      })
      .strict(),
    mode: z
      .object({
        current: zcodeSessionModeSchema,
      })
      .strict(),
    permission: z
      .object({
        mode: zcodeSessionModeSchema.optional(),
        rulesRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ZCodeSessionSettingsState = z.infer<typeof zcodeSessionSettingsStateSchema>;

export const zcodePendingPermissionSchema = z
  .object({
    requestId: nonEmptyString,
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown().optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
    requestedAt: timestampMsSchema,
  })
  .strict();

export type ZCodePendingPermission = z.infer<typeof zcodePendingPermissionSchema>;

export const zcodeActiveToolCallSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    status: z.enum(["pending", "running", "completed", "failed", "denied"]),
    startedAt: timestampMsSchema.optional(),
  })
  .strict();

export type ZCodeActiveToolCall = z.infer<typeof zcodeActiveToolCallSchema>;

export const zcodeSessionProjectionSchema = z
  .object({
    sessionId: nonEmptyString,
    status: zcodeSessionStatusSchema,
    mode: zcodeSessionModeSchema,
    turnCount: z.number().int().nonnegative(),
    totalTokenCount: z.number().int().nonnegative(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    currentTurnId: nonEmptyString.optional(),
    pendingPermissions: z.array(zcodePendingPermissionSchema),
    activeToolCalls: z.array(zcodeActiveToolCallSchema),
    backgroundJobs: z.array(jsonObjectSchema),
    target: zcodeSessionGoalSchema.nullable().optional(),
    lastError: z
      .object({
        type: nonEmptyString,
        code: nonEmptyString.optional(),
        message: nonEmptyString,
        detail: z.string().optional(),
        attribution: errorAttributionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ZCodeSessionProjection = z.infer<typeof zcodeSessionProjectionSchema>;

export type ZCodeToolState = z.infer<typeof zcodeToolStateSchema>;
export {
  zcodeToolRepairAttemptRecordSchema,
  zcodeToolRepairStageSchema,
  zcodeTurnStateTransitionRecordSchema,
  type ZCodeToolRepairAttemptRecord,
  type ZCodeToolRepairStage,
  type ZCodeTurnStateTransitionRecord,
};

export const zcodeSlashCommandSchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    inputHint: z.string().optional(),
    source: z.enum(["builtin", "custom"]).optional(),
  })
  .strict();

export type ZCodeSessionApiRetryStatus = z.infer<typeof zcodeSessionApiRetryStatusSchema>;

export type ZCodeSessionContextUsage = z.infer<typeof zcodeSessionContextUsageSchema>;

export const zcodeModelStreamingKindSchema = z.enum([
  "start",
  "finish",
  "error",
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
]);

export const zcodeModelStreamingEventPayloadSchema = z
  .object({
    assistantMessageId: z.string().optional(),
    delta: z.string().optional(),
    done: z.boolean().optional(),
    input: z.unknown().optional(),
    kind: zcodeModelStreamingKindSchema,
    partId: z.string().optional(),
    providerExecuted: z.boolean().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();

export const zcodeSessionStateSnapshotSchema = z
  .object({
    protocol: z
      .object({
        name: z.literal(ZCODE_PROTOCOL_NAME),
        version: z.literal(ZCODE_PROTOCOL_VERSION),
      })
      .strict(),
    session: zcodeSessionInfoSchema,
    settings: zcodeSessionSettingsStateSchema,
    projection: zcodeSessionProjectionSchema,
    runtime: zcodeSessionRuntimeStateSchema,
    messages: z.array(zcodeMessageWithPartsSchema),
    goalStats: zcodeSessionGoalStatsSchema.optional(),
    todos: z.array(zcodeSessionTodoItemSchema).optional(),
    todoGroups: z.array(zcodeSessionTodoGroupSchema).optional(),
    slashCommands: z.array(zcodeSlashCommandSchema).optional(),
  })
  .strict();

export type ZCodeSessionStateSnapshot = z.infer<typeof zcodeSessionStateSnapshotSchema>;
