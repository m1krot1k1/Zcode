import { conversationQuotesSchema } from "../conversationSelection.js";
import { botGroupInputSourceSchema } from "../bots.js";
// CLI admission 后的自包含输入事实。
// queue / guide / runtime / transcript 只能携带同一个 intent，不允许各层重建字段。
import { z } from "zod";
import { timestampSchema } from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { highspeedMessageMetaSchema } from "../highspeed.js";
import { modelSelectionSchema } from "../model-selection.js";
import { submissionModeSchema } from "./submission.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";

/** Execution route is separate from ModelSelection: ACP owns its own agent/tool loop. */
export const openCodeAgentModelRouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("catalog"), modelId: z.string().trim().min(1).max(512) }).strict(),
]);

export const conversationExecutionRouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("zcode") }).strict(),
  z
    .object({
      kind: z.literal("opencode-acp"),
      model: openCodeAgentModelRouteSchema,
    })
    .strict(),
]);

/** Legacy senders omit the field; omission means the existing ZCode model route. */
export const sendTextExecutionRouteSchema = conversationExecutionRouteSchema.default({
  kind: "zcode",
});

/**
 * 用户输入的结构化来源：插件 UI 经 `ui/message`
 * 代用户发送时带上，落库后卡片显示"来自插件 X"。缺省即用户亲自输入。
 */
const pluginUiInputSourceSchema = z
  .object({
    kind: z.literal("pluginUi"),
    pluginId: z.string().min(1),
    toolCallId: z.string().min(1),
  })
  .strict();
export const conversationInputSourceSchema = z.discriminatedUnion("kind", [
  pluginUiInputSourceSchema,
  z
    .object({
      kind: z.literal("genUi"),
      path: z.string().min(1).max(4096),
      title: z.string().max(250).optional(),
    })
    .strict(),
]);
export type ConversationInputSource = z.infer<typeof conversationInputSourceSchema>;

export const conversationInputDeliverySchema = z
  .object({
    requested: z.enum(["auto", "startNow", "queue", "guide"]),
    admitted: z.enum(["startNow", "queue", "guide"]),
    fallbackReasonCode: z.string().optional(),
  })
  .strict();

export const conversationInputOrderSchema = z
  .object({
    admissionSeq: z.number().int().nonnegative(),
    queuePosition: z.number().int().nonnegative().optional(),
  })
  .strict();

export const conversationInputSteerSchema = z
  .object({
    state: z.enum(["notRequested", "submitting", "steering", "guided", "fellBack"]),
    reasonCode: z.string().optional(),
  })
  .strict();

export const conversationInputDispatchSchema = z
  .object({
    state: z.enum(["admitted", "queued", "reserved", "promoting", "drained"]),
    reservationId: z.string().optional(),
  })
  .strict();

export const conversationInputIntentSchema = z
  .object({
    inputOrigin: z.enum(["desktop", "mobile"]).optional(),
    botGroupSource: botGroupInputSourceSchema.optional(),
    conversationQuotes: conversationQuotesSchema.optional(),
    sourceCommandId: z.string().min(1),
    queueItemId: z.string().min(1),
    clientId: z.string().min(1),
    // compact 是可排队的维护意图；消费时走 compact lifecycle，不投影为 user row。
    kind: z.enum(["sendText", "sendGoalCommand", "compact"]),
    text: z.string(),
    executionRoute: sendTextExecutionRouteSchema,
    attachments: z.array(attachmentRefSchema).default([]),
    // optional 只服务旧 snapshot hydration；新 admission 必须填入完整 Submission。
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    // Явный режим оркестрации является частью canonical intent, а не состоянием сессии.
    orchestrationMode: z.literal("swarm").optional(),
    sharedContextRefs: z.array(sharedContextRefSchema).max(1).optional(),
    delivery: conversationInputDeliverySchema,
    order: conversationInputOrderSchema,
    steer: conversationInputSteerSchema,
    dispatch: conversationInputDispatchSchema,
    admittedAt: timestampSchema,
    highspeed: highspeedMessageMetaSchema.optional(),
    provenance: z
      .object({
        sourceCommandId: z.string().min(1),
        queueItemId: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    source: conversationInputSourceSchema.optional(),
  })
  .superRefine((intent, context) => {
    if (intent.executionRoute.kind !== "opencode-acp") return;
    const reject = (field: string, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message, path: [field] });
    if (intent.kind !== "sendText") reject("kind", "OpenCode ACP route requires sendText");
    if (intent.modelSelection !== undefined)
      reject("modelSelection", "OpenCode ACP route forbids modelSelection");
    if (intent.mode !== undefined) reject("mode", "OpenCode ACP route forbids ZCode mode");
    if (intent.planEnabled !== undefined)
      reject("planEnabled", "OpenCode ACP route forbids ZCode plan mode");
    if (intent.orchestrationMode !== undefined)
      reject("orchestrationMode", "OpenCode ACP route forbids ZCode swarm orchestration");
    if (intent.attachments.length > 0) reject("attachments", "OpenCode ACP route is text-only");
    if (intent.sharedContextRefs?.length)
      reject("sharedContextRefs", "OpenCode ACP route forbids shared context");
    if (intent.highspeed !== undefined)
      reject("highspeed", "OpenCode ACP route forbids model execution metadata");
    if (intent.source !== undefined)
      reject("source", "OpenCode ACP route forbids Composer/plugin context");
    if (
      intent.delivery.requested === "queue" ||
      intent.delivery.requested === "guide" ||
      intent.delivery.admitted !== "startNow"
    ) {
      reject("delivery", "OpenCode ACP route requires immediate delivery");
    }
    if (intent.steer.state !== "notRequested")
      reject("steer", "OpenCode ACP route forbids steering");
    if (!intent.text.trim()) reject("text", "OpenCode ACP route requires text");
  })
  .strict();

export type ConversationInputIntent = z.infer<typeof conversationInputIntentSchema>;
