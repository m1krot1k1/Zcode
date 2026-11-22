import { z } from "zod";
import { zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import { modelSelectionSchema } from "../model-selection.js";
import { zcodeTaskModeSchema } from "../zcode-task-mode-schema.js";
import { nonEmptyString, timestampMsSchema } from "./schema-core.js";

export const zcodeAutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();

export type ZCodeAutomationScheduleRuleProtocol = z.infer<typeof zcodeAutomationScheduleRuleSchema>;

/** 会话侧长间隔周期 carrier 的 unit 枚举（与 scheduleRule.unit 同集）。 */
export const zcodeAutomationIntervalUnitSchema = z.enum([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

export const zcodeAutomationProtocolSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zcodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: timestampMsSchema.optional(),
    lastRunAt: timestampMsSchema.optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    // 自定义重复规则；缺省时调度回退到解析 cronExpr。会话卡片必须读到本字段才能展示
    // cron 无法表达的真实间隔（如每50小时、每40天，兼容 cronExpr 只是 0 * * * *）。
    scheduleRule: zcodeAutomationScheduleRuleSchema.optional(),
  })
  .strict();

export type ZCodeAutomationProtocol = z.infer<typeof zcodeAutomationProtocolSchema>;

export const zcodeAutomationCreateParamsSchema = z
  .object({
    title: z.string().optional(),
    cronExpr: nonEmptyString,
    relativeDelayMinutes: z.number().int().positive().max(525_600).optional(),
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zcodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().optional(),
    // 会话侧自定义重复 carrier：每 N 分钟/小时/天/周/月/年均通过此字段归一化为权威 scheduleRule，
    // cronExpr 仅作合法兼容展示。
    intervalUnit: zcodeAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  // intervalUnit 与 interval 必须配对提交（只传一个无法确定真实间隔）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // 周期 carrier 与一次性相对延迟语义冲突，禁止同传。
  .refine((input) => input.intervalUnit === undefined || input.relativeDelayMinutes === undefined, {
    message: "intervalUnit cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });

export type ZCodeAutomationCreateProtocolParams = z.infer<typeof zcodeAutomationCreateParamsSchema>;

export const zcodeAutomationCreateResultSchema = z
  .object({ automation: zcodeAutomationProtocolSchema })
  .strict();

export type ZCodeAutomationCreateProtocolResult = z.infer<typeof zcodeAutomationCreateResultSchema>;

export const zcodeAutomationUpdateParamsSchema = z
  .object({
    automationId: nonEmptyString,
    title: nonEmptyString.optional(),
    cronExpr: nonEmptyString.optional(),
    prompt: nonEmptyString.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().nullable().optional(),
    // 会话侧自定义重复 carrier（同 create 侧语义）。
    intervalUnit: zcodeAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.cronExpr !== undefined ||
      input.prompt !== undefined ||
      input.recurring !== undefined ||
      input.maxRuns !== undefined ||
      input.intervalUnit !== undefined,
    { message: "automation update requires at least one field" },
  )
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "clearing maxRuns requires recurring=true",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit 与 interval 必须配对提交（同 create 侧语义）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );

export type ZCodeAutomationUpdateProtocolParams = z.infer<typeof zcodeAutomationUpdateParamsSchema>;

export const zcodeAutomationUpdateResultSchema = z
  .object({ automation: zcodeAutomationProtocolSchema })
  .strict();

export type ZCodeAutomationUpdateProtocolResult = z.infer<typeof zcodeAutomationUpdateResultSchema>;

export const zcodeAutomationListParamsSchema = z.object({}).strict();

export type ZCodeAutomationListProtocolParams = z.infer<typeof zcodeAutomationListParamsSchema>;

export const zcodeAutomationListResultSchema = z
  .object({ automations: z.array(zcodeAutomationProtocolSchema) })
  .strict();

export type ZCodeAutomationListProtocolResult = z.infer<typeof zcodeAutomationListResultSchema>;

export const zcodeAutomationCheckTaskBindingParamsSchema = z
  .object({ targetTaskId: nonEmptyString })
  .strict();

export type ZCodeAutomationCheckTaskBindingProtocolParams = z.infer<
  typeof zcodeAutomationCheckTaskBindingParamsSchema
>;

export const zcodeAutomationCheckTaskBindingResultSchema = z
  .object({ bound: z.boolean() })
  .strict();

export type ZCodeAutomationCheckTaskBindingProtocolResult = z.infer<
  typeof zcodeAutomationCheckTaskBindingResultSchema
>;

export const zcodeAutomationDeleteParamsSchema = z
  .object({ automationId: nonEmptyString })
  .strict();

export type ZCodeAutomationDeleteProtocolParams = z.infer<typeof zcodeAutomationDeleteParamsSchema>;

export const zcodeAutomationDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();

export type ZCodeAutomationDeleteProtocolResult = z.infer<typeof zcodeAutomationDeleteResultSchema>;

// ---- Off-Peak（闲时任务）会话内创建协议----
// 与 automation 兄弟并列（独立域，禁止互相复用标记/表）。workspace 由 host 端从
// 当前 session 注入，不进协议参数（对称 automation/create）。permissionMode 只开放产品
// 四档词表（D29-4）；缺省解析在 host 端（D49-4：yolo / allowed_models 末位 / 最高推理档）。
export const zcodeOffPeakPermissionModeSchema = z.enum([
  "build",
  "edit",
  "plan",
  "yolo",
  "guarded",
]);

export type ZCodeOffPeakProtocolPermissionMode = z.infer<typeof zcodeOffPeakPermissionModeSchema>;

export const zcodeOffPeakCreateParamsSchema = z
  .object({
    title: nonEmptyString,
    prompt: nonEmptyString,
    permissionMode: zcodeOffPeakPermissionModeSchema.optional(),
    model: nonEmptyString.optional(),
    thoughtLevel: nonEmptyString.optional(),
    // 会话内创建绑定当前会话（对齐 automation/create 的 targetTaskId），由 CLI 端口填入。
    boundSessionId: nonEmptyString.optional(),
  })
  .strict();

export type ZCodeOffPeakCreateProtocolParams = z.infer<typeof zcodeOffPeakCreateParamsSchema>;

// 协议侧任务快照：轮尾卡片与 OffPeakList 的最小字段面。
// 不暴露 serverTicketId（跨边界禁带）。
export const zcodeOffPeakTaskSnapshotSchema = z
  .object({
    offPeakTaskId: nonEmptyString,
    title: z.string(),
    status: z.enum(["queued", "paused", "running", "completed", "failed", "cancelled"]),
    queuePosition: z.number().int().positive().optional(),
    sessionId: nonEmptyString.optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type ZCodeOffPeakTaskProtocolSnapshot = z.infer<typeof zcodeOffPeakTaskSnapshotSchema>;

// 失败分类跨协议保真（镜像 shared OffPeakTaskCreateResult 的判别联合，错误不降级为字符串）。
// model 白名单预校失败复用 client_validation 分类 + errorCode "model_not_allowed"，不扩分类枚举。
export const zcodeOffPeakCreateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: zcodeOffPeakTaskSnapshotSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      failureStage: z.enum(["client_validation", "ticket_request", "local_persist"]),
      errorCategory: z.enum([
        "client_validation",
        "eligibility_3101",
        "quota_3103",
        "network",
        "invalid_response",
        "local_persist",
        "unknown",
      ]),
      errorCode: z.string(),
    })
    .strict(),
]);

export type ZCodeOffPeakCreateProtocolResult = z.infer<typeof zcodeOffPeakCreateResultSchema>;

export const zcodeOffPeakListParamsSchema = z.object({}).strict();

export type ZCodeOffPeakListProtocolParams = z.infer<typeof zcodeOffPeakListParamsSchema>;

export const zcodeOffPeakListResultSchema = z
  .object({ tasks: z.array(zcodeOffPeakTaskSnapshotSchema) })
  .strict();

export type ZCodeOffPeakListProtocolResult = z.infer<typeof zcodeOffPeakListResultSchema>;
