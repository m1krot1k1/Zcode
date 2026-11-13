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
import { BOT_REPLY_GRANULARITIES, DEFAULT_BOT_REPLY_GRANULARITY, botAllowedCommandsSchema, botAutoReplyGuardSchema, botBackgroundHistorySchema, botCurrentOptionsSchema, botDraftOptionsSchema, botGroupDeliverySchema, botGroupInputProgressSchema, botGroupInputSourceSchema, botPendingElicitationSchema, botProviders, botTopicPreparationSchema } from "./shared-bots-part1.js";
import type { BotActor, BotConfig, BotContextMode, BotCurrentOptions, BotDraftOptions, BotGroupCard, BotGroupDelivery, BotGroupInputProgress, BotInboundAttachment, BotOutboundMessage, BotPendingElicitation, BotPendingPermissionOption, BotProvider, BotReplyGranularity, BotRuntimeInfo, BotStructuredElicitationResponse, BotTopicPreparation, FeishuBotProvider } from "./shared-bots-part1.js";

// Часть 2/2 модуля shared-bots: вынесено по лимиту строк.

export const botConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    provider: z.enum(botProviders),
    enabled: z.boolean(),
    credentialRef: z.string().min(1).optional(),
    webhookSecretRef: z.string().min(1).optional(),
    webhookUrl: z.string().url().optional(),
    webhookAuthHeaderName: z.string().min(1).optional(),
    feishuAppId: z.string().min(1).optional(),
    providerUserId: z.string().min(1).optional(),
    displayName: z.string().optional(),
    allowedWorkspaces: z.array(z.string().min(1)),
    allowedCommands: botAllowedCommandsSchema,
    currentOptions: botCurrentOptionsSchema,
    replyMode: z.enum([
      "assistant_changes",
      "assistant_toolcalls_changes",
      "summary_changes",
      "streaming_card",
    ]),
  })
  .strict();

export function isFeishuBotProvider(provider: BotProvider): provider is FeishuBotProvider {
  return provider === "feishu" || provider === "lark";
}

export interface BotsConfigFile {
  version: 3;
  bots: BotConfig[];
}

export type BotGroupInputSource = z.infer<typeof botGroupInputSourceSchema>;

export interface BotInboundMessage {
  /** 仅供命令/纯唤醒识别；原文 text 和 contentParts 保持完整。 */
  commandText?: string;
  /** Provider 核验的当前机器人身份，不从正文推断。 */
  botOpenId?: string;
  /** Provider 校验的发送者类型；机器人正文不具有控制命令权限。 */
  senderType?: "user" | "app";
  contentParts?: ChannelContentPart[];
  /** 由 Provider 根据真实 mention 身份设置；不是正文解析结果。 */
  mentionedBot?: boolean;
  /** 原生根消息经 Provider 核验确为当前机器人发送。 */
  topicRootIsCurrentBot?: boolean;
  /** 可信 Provider 校验后的明确引用，不参与控制命令解析。 */
  referencedMessage?: import("./conversationSelection.js").ConversationSelectionText & {
    messageId: string;
  };
  groupCard?: BotGroupCard;
  groupCardAction?: boolean;
  botId: string;
  actor: BotActor;
  text: string;
  attachments?: BotInboundAttachment[];
  elicitationResponse?: BotStructuredElicitationResponse;
  receivedAt?: number;
}

export interface BotServiceStatus {
  botsCount: number;
  enabledBotsCount: number;
  contextsCount: number;
  botRuntime: BotRuntimeInfo[];
}

export interface BotProviderCallbackResult {
  ok: boolean;
  replies: BotOutboundMessage[];
  responseBody?: unknown;
  status?: number;
}

export const botsConfigFileSchema = z
  .object({
    version: z.literal(3),
    bots: z.array(botConfigSchema),
  })
  .strict();

export const botsStateFileSchema = z
  .object({
    version: z.literal(3),
    bots: z.record(
      z.string(),
      z.object({
        botId: z.string().min(1),
        group: z
          .object({
            chatId: z.string().trim().min(1),
            chatMode: z.enum(["group", "topic"]).optional(),
            threadId: z.string().trim().min(1).optional(),
            rootMessageId: z.string().min(1).optional(),
            topicTitle: z.string().optional(),
            topicUrl: z.string().url().optional(),
            historyEnabled: z.boolean().optional(),
            topicActive: z.boolean().optional(),
            preparation: z.array(botTopicPreparationSchema).optional(),
            topicAliases: z
              .record(
                z.string(),
                z.object({ taskId: z.string().min(1), rootMessageId: z.string().min(1) }).strict(),
              )
              .optional(),
            name: z.string(),
            ownerId: z.string().min(1),
            enabled: z.boolean(),
            taskIds: z.array(z.string().min(1)),
            taskWorkspaces: z
              .record(
                z.string(),
                z
                  .object({
                    workspacePath: z.string().min(1),
                    workspaceIdentity: z.string().optional(),
                  })
                  .strict(),
              )
              .optional(),
            currentOptions: botCurrentOptionsSchema,
            initiatorId: z.string().optional(),
            authorizationId: z.string().optional(),
            deliveries: z.record(z.string(), botGroupDeliverySchema).optional(),
            autoReplyGuard: botAutoReplyGuardSchema.optional(),
            backgroundHistory: botBackgroundHistorySchema.optional(),
            inputs: z
              .record(
                z.string(),
                z
                  .object({
                    taskId: z.string().min(1),
                    source: botGroupInputSourceSchema,
                    admission: z.enum(["pending", "accepted", "rejected"]).optional(),
                    progress: botGroupInputProgressSchema.optional(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict()
          .optional(),
        workspacePath: z.string().min(1),
        workspaceIdentity: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        projectId: z.string().min(1).nullable().optional(),
        hostId: z.string().min(1).optional(),
        additionalDirectories: z.array(z.string().min(1)).max(256).optional(),
        mode: z.enum(["draft", "task"]),
        activeTaskId: z.string().min(1).nullable(),
        draftOptions: botDraftOptionsSchema.optional(),
        pendingPermissionOptions: z
          .array(
            z.object({
              requestId: z.string().min(1),
              optionId: z.string().min(1),
              command: z.enum(["approve", "deny"]),
              label: z.string().min(1),
              response: zcodePermissionResponseSchema,
              handledAt: z.number().optional(),
            }),
          )
          .optional(),
        pendingElicitation: botPendingElicitationSchema.optional(),
        telegramOffset: z.number().optional(),
        weixinGetUpdatesBuf: z.string().optional(),
        weixinActivatedAt: z.number().optional(),
        privateBindingId: z.string().min(1).optional(),
        privateRecipientId: z.string().min(1).optional(),
        updatedAt: z.number(),
      }),
    ),
  })
  .strict();

export interface BotGroupSession {
  preparation?: BotTopicPreparation[];
  chatId: string;
  chatMode?: "group" | "topic";
  threadId?: string;
  rootMessageId?: string;
  topicTitle?: string;
  topicUrl?: string;
  /** 仅群默认记录拥有此配置；话题按群授权检查读取。 */
  historyEnabled?: boolean;
  /** 仅成功接收首次输入后接入；leave 后保留任务但停止普通消息触发。 */
  topicActive?: boolean;
  topicAliases?: Record<string, { taskId: string; rootMessageId: string }>;
  name: string;
  ownerId: string;
  enabled: boolean;
  taskIds: string[];
  taskWorkspaces?: Record<string, { workspacePath: string; workspaceIdentity?: string }>;
  currentOptions: BotCurrentOptions;
  initiatorId?: string;
  authorizationId?: string;
  deliveries?: Record<string, BotGroupDelivery>;
  autoReplyGuard?: z.infer<typeof botAutoReplyGuardSchema>;
  backgroundHistory?: z.infer<typeof botBackgroundHistorySchema>;
  inputs?: Record<
    string,
    {
      taskId: string;
      source: BotGroupInputSource;
      admission?: "pending" | "accepted" | "rejected";
      progress?: BotGroupInputProgress;
    }
  >;
}

export function getSupportedBotReplyGranularities(
  provider: BotProvider,
): readonly BotReplyGranularity[] {
  return isFeishuBotProvider(provider)
    ? (["streaming_card"] as const)
    : BOT_REPLY_GRANULARITIES.filter(
        // Bugfix: streaming card 依赖 Feishu/Lark Card JSON 2.0，其他 channel 无法渲染或更新该消息形态。
        (granularity) => granularity !== "streaming_card",
      );
}

export interface BotState {
  botId: string;
  group?: BotGroupSession;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceId?: string;
  /** hostId 缺席表示旧状态待交接；明确 NULL 项目不会再次按目录归入。 */
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
  mode: BotContextMode;
  activeTaskId: string | null;
  draftOptions?: BotDraftOptions;
  pendingPermissionOptions?: BotPendingPermissionOption[];
  pendingElicitation?: BotPendingElicitation;
  telegramOffset?: number;
  weixinGetUpdatesBuf?: string;
  weixinActivatedAt?: number;
  /** 单聊绑定代际，阻止换绑后迟到事件恢复旧关联。 */
  privateBindingId?: string;
  /** iLink 登录返回机器人身份，单聊接收人来自已授权入站消息。 */
  privateRecipientId?: string;
  updatedAt: number;
}

export function normalizeBotReplyGranularity(
  provider: BotProvider,
  replyMode: BotReplyGranularity | undefined,
): BotReplyGranularity {
  const supported = getSupportedBotReplyGranularities(provider);
  const candidate = replyMode ?? DEFAULT_BOT_REPLY_GRANULARITY;
  return supported.includes(candidate) ? candidate : supported[0]!;
}

export type BotContextState = BotState;

export interface BotsStateFile {
  version: 3;
  bots: Record<string, BotState>;
}
