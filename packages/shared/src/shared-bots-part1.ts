import { zcodeProtocolTraceSchema, type ZCodeProtocolTrace } from "./zcode-protocol/trace.js";
import { channelContentPartsSchema, type ChannelContentPart } from "./channel-mention.js";
import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import { conversationQuotesSchema } from "./conversationSelection.js";
import { ZCODE_AGENT_PROVIDER, ZCODE_AGENT_PROVIDER_LABEL } from "./zcode-agent-policy.js";
import type {
  ZCodeConfigOption,
  ZCodeElicitationRequest,
  ZCodeElicitationQuestion,
  ZCodePermissionRequest,
  ZCodePromptAttachment,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
  ZCodeTaskRuntimeStatus,
} from "./zcode-task-types-core.js";
import {
  zcodeInteractionRequestOriginSchema,
  zcodePermissionResponseSchema,
  type ZCodeInteractionRequestOrigin,
  type ZCodePermissionResponse,
} from "./zcode-protocol-legacy-types.js";
import type { Locale } from "./protocol.js";

// Часть 1/2 модуля shared-bots: вынесено по лимиту строк.

export const botProviders = [
  "telegram",
  "webhook",
  "feishu",
  "lark",
  "weixin",
  "discord",
  "wecom",
] as const;

/**
 * 定时任务完成后的 Bot 回推目标。只保留未来仍稳定的会话地址；当前消息 id/context token
 * 属于一次入站交互，不能持久化后复用。该字段由 Host 注入，模型工具参数不直接暴露。
 */
export const zcodeAutomationBotDeliveryTargetSchema = z
  .object({
    provider: z.enum(["feishu", "lark", "weixin"]),
    botId: z.string().trim().min(1),
    providerUserId: z.string().trim().min(1),
    chatType: z.enum(["private", "group"]),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().min(1).optional(),
  })
  .strict();

export type BotContextMode = "draft" | "task";

export type BotReplyGranularity =
  | "assistant_changes"
  | "assistant_toolcalls_changes"
  | "summary_changes"
  | "streaming_card";

export const ALL_BOT_WORKSPACES = "*";

export const BOT_BIND_CODE_TTL_MS = 30_000;

export interface BotWorkspaceRef {
  id: string;
  label: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 新版选择虚拟项目；旧协议字段名保留。空 roots 在提交时才分配 cwd。 */
  projectId?: string;
  hostId?: string;
  rootPaths?: string[];
}

export interface BotAllowedCommands {
  status: boolean;
  new: boolean;
  workspace: boolean;
  model: boolean;
  mode?: boolean;
  thoughtLevel: boolean;
  sandboxMode?: boolean;
  approvalPolicy?: boolean;
  reply: boolean;
}

export interface BotCurrentOptions {
  modelSelection?: ModelSelection;
  mode?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
}

export interface BotPendingPermissionOption {
  requestId: string;
  optionId: string;
  command: "approve" | "deny";
  label: string;
  response: ZCodePermissionResponse;
  handledAt?: number;
}

export interface BotPendingElicitation {
  taskId: string;
  requestId: string;
  runId: string;
  origin?: ZCodeInteractionRequestOrigin;
  actorKey?: string;
  currentQuestionIndex: number;
  questions: ZCodeElicitationQuestion[];
  answers: Record<string, string[]>;
  renderContext?: {
    kind: "plan_approval";
    plan: string;
  };
  expandedCustomAnswerQuestionIndexes?: number[];
  handledAt?: number;
}

export interface BotStructuredElicitationResponse {
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface BotOutboundElicitationRequest {
  requestId: string;
  taskId: string;
  runId: string;
  currentQuestionIndex: number;
  questions: ZCodeElicitationQuestion[];
  answers?: Record<string, string[]>;
  status?: "pending" | "completed" | "cancelled";
  expandedCustomAnswerQuestionIndexes?: number[];
  schema?: unknown;
}

export interface BotDraftOptions {
  provider: ZCodeProvider;
  modelSelection?: ModelSelection;
  mode?: string;
}

export const botGroupDeliverySchema = z
  .object({
    /** 名字解析前的请求指纹；重复调用只读原回执，不因目录变化改发给其他人。 */
    channelReplyRequestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    appId: z.string().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
    authorizationId: z.string().optional(),
    id: z.string().min(1),
    taskId: z.string().min(1),
    sourceCommandId: z.string().min(1).optional(),
    text: z.string(),
    replyToMessageId: z.string().optional(),
    mentionedUserIds: z.array(z.string().min(1)).max(200).optional(),
    contentParts: channelContentPartsSchema.optional(),
    providerMessageId: z.string().optional(),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().optional(),
    status: z.enum(["pending", "sent", "failed", "unknown", "invalidated"]),
    lastError: z.string().optional(),
    updatedAt: z.number(),
  })
  .strict();

export const botGroupCardSchema = z
  .object({
    chatId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    conversationThreadId: z.string().min(1).nullable().optional(),
    taskId: z.string().nullable(),
    authorizationId: z.string().min(1),
  })
  .strict();

export const botTopicMessageSchema = z
  .object({
    id: z.string().min(1),
    chatId: z.string().min(1),
    threadId: z.string().min(1),
    senderId: z.string(),
    senderName: z.string().optional(),
    parentId: z.string().optional(),
    attachments: z.array(z.object({ name: z.string(), kind: z.string() }).strict()).optional(),
    senderType: z.enum(["user", "app"]),
    text: z.string(),
    createdAt: z.number(),
    kind: z.string(),
    controlCard: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .strict();

export interface BotTopicHistoryRequest {
  chatId: string;
  threadId: string;
  rootMessageId: string;
  messageId: string;
  checkpoint?: string;
}

export const botIdentitySchema = z
  .object({ name: z.string().min(1), openId: z.string().min(1).optional() })
  .strict();

export const botBackgroundHistorySchema = z
  .object({ revision: z.string().min(1), checkpoint: z.string().min(1).optional() })
  .strict();

export const botAutoReplyGuardSchema = z
  .object({
    consecutive: z.number().int().min(0).max(5),
    messageIds: z.array(z.string().min(1)),
  })
  .strict();

export const botGroupInputStatusSchema = z.enum([
  "waiting",
  "working",
  "done",
  "failed",
  "stopped",
  "cancelled",
  "discarded",
]);

export const botTopicPreparationSchema = z
  .object({
    contentParts: channelContentPartsSchema.optional(),
    messageId: z.string().min(1),
    senderName: z.string(),
    text: z.string(),
    status: z.enum(["preparing", "waitingStop", "failed"]),
    error: z.string().optional(),
  })
  .strict();

/** CLI 只接收轻量材料索引；原文留在 Host 归档及文本附件。 */
export const botTopicHistorySourceSchema = z
  .object({
    checkpoint: z.string().min(1).max(256),
    hasGap: z.boolean(),
    messageCount: z.number().int().min(0).max(201),
    resourceMessages: z
      .array(
        z
          .object({
            messageId: z.string().min(1).max(256),
            count: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .max(201),
  })
  .strict();

export const botTopicInputMessageSchema = z
  .object({
    contentParts: channelContentPartsSchema.optional(),
    messageId: z.string().min(1),
    senderId: z.string().min(1),
    senderName: z.string(),
    mentionedBot: z.boolean().optional(),
    text: z.string(),
    conversationQuotes: conversationQuotesSchema.optional(),
    attachmentIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict();

export type BotInboundAttachmentKind = "image" | "audio" | "video" | "file";

export type BotCommand =
  | { type: "group.history"; enabled?: boolean }
  | { type: "queue.cancel"; commandId: string }
  | { type: "group.enable" }
  | { type: "group.disable" }
  | { type: "bind"; code: string }
  | { type: "help" }
  | { type: "status" }
  | { type: "new" }
  | { type: "reconnect" }
  | { type: "workspace.list" }
  | { type: "workspace.set"; value: string }
  | { type: "model.list" }
  | { type: "model.provider.set"; value: string }
  | { type: "model.set"; value: string }
  | { type: "mode.list" }
  | { type: "mode.set"; value: string }
  | { type: "thoughtLevel.list" }
  | { type: "thoughtLevel.set"; value: string }
  | { type: "task.list" }
  | { type: "task.set"; value: string }
  | { type: "reply.list" }
  | { type: "reply.set"; value: string }
  | { type: "stop" }
  | { type: "topic.leave" }
  | { type: "permission.respond"; value: string }
  | { type: "elicitation.respond"; value: string }
  | { type: "elicitation.submit" }
  | { type: "approve"; requestId: string; optionId: string }
  | { type: "deny"; requestId: string }
  | { type: "unknown"; name: string; raw: string }
  | { type: "selection.cancel" }
  | { type: "message"; text: string };

export interface SelectionPrompt {
  id: string;
  token?: string;
  title: string;
  currentId?: string;
  cancelLabel?: string;
  showCancel?: boolean;
  action:
    | "queue.cancel"
    | "workspace.set"
    | "model.provider.set"
    | "model.set"
    | "mode.set"
    | "thoughtLevel.set"
    | "task.set"
    | "reply.set"
    | "permission.respond"
    | "elicitation.respond";
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
}

export interface BotTaskSummary {
  taskId: string;
  title: string;
  status: ZCodeTaskRuntimeStatus | "persisted-completed" | "persisted-error" | "unknown";
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  model?: string;
}

export const BOT_TASK_BROADCAST_CHANNEL = "bots:task";

export const BOT_TASK_STREAM_BROADCAST_CHANNEL = "bots:task-stream";

export type BotTaskBroadcastEvent =
  | "created"
  | "prompt_sent"
  | "resumed"
  | "streaming"
  | "permission_request"
  | "permission_resolved"
  | "elicitation_request"
  | "elicitation_resolved"
  | "updated"
  | "completed"
  | "error";

export interface BotTaskStreamBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: ZCodeStreamEvent;
  updatedAt: number;
}

export const botAllowedCommandsSchema = z
  .object({
    status: z.boolean(),
    new: z.boolean(),
    workspace: z.boolean(),
    model: z.boolean(),
    mode: z.boolean().optional(),
    thoughtLevel: z.boolean(),
    sandboxMode: z.boolean().optional(),
    approvalPolicy: z.boolean().optional(),
    // 兼容旧 bot-config.json；/cli 命令已移除，新配置不会再写入这个字段。
    cli: z.boolean().optional(),
    reply: z.boolean(),
  })
  .strict();

// 修复原因：第三方 CLI provider 已移除，ZCodeProvider 只剩 glm，但旧 bot 配置与状态文件里可能仍存有
// 已移除 provider 的历史值。改成严格 literal 会让整份文件 parse 失败、Bot 全部不可用；
// 因此解析时继续接受这些历史值，并统一归一到当前唯一的 agent provider。
export const legacyBotAgentProviderSchema = z
  .enum(["codex", "claude", "opencode", "gemini", "glm"])
  .transform((): typeof ZCODE_AGENT_PROVIDER => ZCODE_AGENT_PROVIDER);

export const botElicitationOptionSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })
  .strict();

export const BOT_ZCODE_PROVIDER_OPTIONS: Array<{
  id: ZCodeProvider;
  label: string;
}> = [{ id: ZCODE_AGENT_PROVIDER, label: ZCODE_AGENT_PROVIDER_LABEL }];

export type BotProvider = (typeof botProviders)[number];

export type ZCodeAutomationBotDeliveryTarget = z.infer<
  typeof zcodeAutomationBotDeliveryTargetSchema
>;

export const BOT_REPLY_GRANULARITIES = [
  "assistant_changes",
  "assistant_toolcalls_changes",
  "summary_changes",
  "streaming_card",
] as const satisfies readonly BotReplyGranularity[];

export type BotCommandPolicy = BotAllowedCommands;

export type BotReplyMode = BotReplyGranularity;

export type BotGroupDelivery = z.infer<typeof botGroupDeliverySchema>;

export type BotGroupCard = z.infer<typeof botGroupCardSchema>;

export type BotTopicMessage = z.infer<typeof botTopicMessageSchema>;

export const botTopicContextSchema = z
  .object({
    messages: z.array(botTopicMessageSchema).max(201),
    checkpoint: z.string().min(1),
    hasGap: z.boolean(),
  })
  .strict();

export type BotGroupInputStatus = z.infer<typeof botGroupInputStatusSchema>;

export type BotTopicPreparation = z.infer<typeof botTopicPreparationSchema>;

export const botGroupInputProgressSchema = z
  .object({
    status: botGroupInputStatusSchema,
    interruptionReason: z.literal("newMessage").optional(),
    cardMessageId: z.string().min(1).optional(),
    cardStatus: botGroupInputStatusSchema.optional(),
  })
  .strict();

export interface BotInboundAttachment {
  id: string;
  kind: BotInboundAttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  providerFileId?: string;
  downloadUrl?: string;
  dataBase64?: string;
  localPath?: string;
  providerMetadata?: Record<string, string>;
}

export interface BotTaskBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: BotTaskBroadcastEvent;
  updatedAt: number;
  task?: ZCodeTaskMeta;
  provider?: ZCodeProvider;
  configOptions?: ZCodeConfigOption[];
  prompt?: {
    content: string;
    attachments?: ZCodePromptAttachment[];
    messageId: string;
    sentAt: number;
  };
  permissionRequest?: ZCodePermissionRequest;
  elicitationRequest?: ZCodeElicitationRequest;
  requestId?: string;
  error?: string;
}

export const botCurrentOptionsSchema = z
  .object({
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().min(1).optional(),
    sandboxMode: z.string().min(1).optional(),
    approvalPolicy: z.string().min(1).optional(),
    // 兼容旧 bot-config.json；CLI provider 现在统一由 ZCode Protocol 侧配置决定。
    cli: legacyBotAgentProviderSchema.optional(),
  })
  .strict();

export const botDraftOptionsSchema = z
  .object({
    provider: legacyBotAgentProviderSchema,
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().min(1).optional(),
  })
  .strict();

export const botElicitationQuestionSchema = z
  .object({
    question: z.string(),
    header: z.string(),
    options: z.array(botElicitationOptionSchema),
    multiSelect: z.boolean().optional(),
  })
  .strict();

export const DEFAULT_BOT_COMMANDS: BotAllowedCommands = {
  status: true,
  new: true,
  workspace: true,
  model: true,
  mode: true,
  thoughtLevel: true,
  reply: true,
};

export const DEFAULT_BOT_REPLY_GRANULARITY: BotReplyGranularity = "assistant_changes";

export type FeishuBotProvider = Extract<BotProvider, "feishu" | "lark">;

export interface BotConfig {
  id: string;
  name: string;
  provider: BotProvider;
  enabled: boolean;
  credentialRef?: string;
  webhookSecretRef?: string;
  webhookUrl?: string;
  webhookAuthHeaderName?: string;
  feishuAppId?: string;
  providerUserId?: string;
  displayName?: string;
  allowedWorkspaces: string[];
  allowedCommands: BotAllowedCommands;
  currentOptions: BotCurrentOptions;
  replyMode: BotReplyMode;
}

export type BotTopicHistoryBatch = z.infer<typeof botTopicContextSchema>;

export type BotGroupInputProgress = z.infer<typeof botGroupInputProgressSchema>;

/** 可信 Host 注入的输入来源；身份展示不能反向授予执行权限。 */
export const botGroupInputSourceSchema = z
  .object({
    botIdentity: botIdentitySchema.optional(),
    appId: z.string().min(1).optional(),
    contentParts: channelContentPartsSchema.optional(),
    authorizationId: z.string().min(1).optional(),
    botId: z.string().min(1),
    provider: z.enum(["feishu", "lark"]),
    chatId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().optional(),
    senderId: z.string().min(1),
    senderName: z.string(),
    mentionedBot: z.boolean().optional(),
    messageId: z.string().min(1),
    messages: z.array(botTopicInputMessageSchema).min(1).max(200).optional(),
    topicContext: botTopicContextSchema.optional(),
    topicHistory: botTopicHistorySourceSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (
      source.messages &&
      (!source.threadId ||
        source.messages.at(-1)?.messageId !== source.messageId ||
        new Set(source.messages.map((message) => message.messageId)).size !==
          source.messages.length)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Topic batch boundary mismatch",
      });
    }

    if (
      source.topicHistory &&
      (!source.threadId || source.topicHistory.checkpoint !== source.messageId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["topicHistory"],
        message: "Topic history scope mismatch",
      });
    }
    if (
      source.topicContext &&
      (!source.threadId ||
        source.topicContext.checkpoint !== source.messageId ||
        source.topicContext.messages.some(
          (m) => m.chatId !== source.chatId || m.threadId !== source.threadId,
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["topicContext"],
        message: "Topic context scope mismatch",
      });
  });

export interface BotRuntimeInfo {
  /** 最近一次消息投递错误；独立于长连接状态，成功投递后清除。 */
  deliveryError?: string;
  /** 当前进程保留的失败单聊回复；显式重试可能重复此前已收到的内容。 */
  deliveryRetryId?: string;
  botId: string;
  provider: BotProvider;
  status: "disabled" | "idle" | "polling" | "connected" | "error";
  messageId?: string;
  message?: string;
  lastUpdateAt?: number;
  offset?: number;
}

export interface BotActor {
  /** 本次可信输入是否明确提及机器人；用于话题回复提醒。 */
  mentionedBot?: boolean;
  provider: BotProvider;
  botId: string;
  providerUserId: string;
  displayName?: string;
  chatType: "private" | "group";
  chatId?: string;
  threadId?: string;
  /** 仅服务根据已保存的结果关联设置；null 表示原群默认任务。 */
  conversationThreadId?: string | null;
  rootMessageId?: string;
  topicTitle?: string;
  topicUrl?: string;
  providerMessageId?: string;
  providerContextToken?: string;
}

export interface BotOutboundMessage {
  trace?: ZCodeProtocolTrace;
  contentParts?: ChannelContentPart[];
  groupCard?: BotGroupCard;
  threadId?: string;
  conversationThreadId?: string | null;
  rootMessageId?: string;
  botId: string;
  provider: BotProvider;
  providerUserId: string;
  text: string;
  locale?: Locale;
  selection?: SelectionPrompt;
  elicitation?: BotOutboundElicitationRequest;
  providerContextToken?: string;
  /** 无权限/过期回调只能提示操作者，不能覆盖群共享卡片。 */
  callbackToastOnly?: boolean;
  /** 管理员待办独立通知，不允许用拒绝提示覆盖共享卡片。 */
  administratorAttention?: boolean;
  replyToMessageId?: string;
  /** 可信输入决定的提醒对象；只作展示，不授予群操作权限。 */
  mentionedUserIds?: string[];
  deliveryId?: string;
  /** 任务回推需在实际发送前重新验证群当前关联。控制命令回复不携带。 */
  groupTaskId?: string;
  /** 可信任务事件中的输入命令，用于将投递状态定位到对应回复。 */
  groupSourceCommandId?: string;
}

export const botPendingElicitationSchema = z
  .object({
    taskId: z.string().min(1),
    requestId: z.string().min(1),
    runId: z.string().min(1),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    actorKey: z.string().min(1).optional(),
    currentQuestionIndex: z.number().int().min(0),
    questions: z.array(botElicitationQuestionSchema),
    answers: z.record(z.string(), z.array(z.string())),
    renderContext: z
      .object({
        kind: z.literal("plan_approval"),
        plan: z.string().min(1),
      })
      .strict()
      .optional(),
    expandedCustomAnswerQuestionIndexes: z.array(z.number().int().min(0)).optional(),
    handledAt: z.number().optional(),
  })
  .strict();
