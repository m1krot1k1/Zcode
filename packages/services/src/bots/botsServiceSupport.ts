import { BOT_MENU_COMMAND_ORDER } from "./commandOrder.js";
import type { BotMessageId } from "./messages.js";
import {
  type BotActor,
  type BotConfig,
  type BotContextState,
  type BotOutboundMessage,
  type BotProvider,
  type BotsConfigFile,
  type SelectionPrompt,
  ZCODE_AGENT_PROVIDER,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeProvider,
  isFeishuBotProvider,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const botsLogger = createServiceLogger("bots");

const BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS = new Set<BotProvider>(["telegram", "feishu", "lark"]);

export const FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS = 1_000;

export const FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS = 15_000;

export const FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS = 1_000;

export const FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD = 3;

export const BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS = 1_000;

export const BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS = 3_000;

export const helpMessageByCommand = {
  help: "helpHelp",
  bind: "helpBind",
  status: "helpStatus",
  new: "helpNew",
  workspace: "helpWorkspace",
  model: "helpModel",
  mode: "helpMode",
  thoughtLevel: "helpThoughtLevel",
  reply: "helpReply",
} as const satisfies Record<(typeof BOT_MENU_COMMAND_ORDER)[number], BotMessageId>;

export function validateBotConfig(config: BotsConfigFile, candidate: BotConfig): void {
  if (!candidate.id.trim()) {
    throw new Error("Bot id is required.");
  }
  if (candidate.enabled && candidate.providerUserId?.trim()) {
    const duplicateBinding = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.providerUserId === candidate.providerUserId,
    );
    if (duplicateBinding) {
      throw new Error("An enabled bot with this provider user already exists.");
    }
  }
  if (
    candidate.enabled &&
    candidate.credentialRef?.trim() &&
    BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS.has(candidate.provider)
  ) {
    const duplicateCredential = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.credentialRef === candidate.credentialRef,
    );
    if (duplicateCredential) {
      throw new Error("Enabled polling bots cannot share the same credential.");
    }
  }
}

export function webhookSecretEquals(
  expected: string | null | undefined,
  inbound: string | null | undefined,
): boolean {
  if (!expected || !inbound) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const inboundBytes = Buffer.from(inbound, "utf8");
  if (expectedBytes.length !== inboundBytes.length) return false;
  return timingSafeEqual(expectedBytes, inboundBytes);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNestedRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return isRecord(nested) ? nested : null;
}

export function readNestedString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" && nested.trim().length > 0 ? nested : undefined;
}

export function summarizeCallbackPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return `type=${typeof payload}`;
  }
  const header = readNestedRecord(payload, "header");
  const event = readNestedRecord(payload, "event") ?? payload;
  const message = readNestedRecord(event, "message");
  const context = readNestedRecord(payload, "context");
  const action = readNestedRecord(payload, "action");
  const keys = Object.keys(payload).slice(0, 16).join(",");
  return [
    `keys=${keys || "none"}`,
    `botId=${readNestedString(payload, "botId") ?? "none"}`,
    `eventType=${readNestedString(header, "event_type") ?? readNestedString(header, "type") ?? readNestedString(payload, "event_type") ?? "none"}`,
    `messageType=${readNestedString(message, "message_type") ?? "none"}`,
    `chatType=${readNestedString(message, "chat_type") ?? readNestedString(context, "chat_type") ?? readNestedString(payload, "chat_type") ?? "none"}`,
    `hasAction=${action ? "true" : "false"}`,
  ].join(" ");
}

export function createCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

export function createOutbound(
  actor: BotActor,
  text: string,
  selection?: SelectionPrompt,
  extras: Pick<
    BotOutboundMessage,
    "elicitation" | "locale" | "groupSourceCommandId" | "groupTaskId"
  > = {},
): BotOutboundMessage {
  return {
    botId: actor.botId,
    provider: actor.provider,
    providerUserId: actor.chatId ?? actor.providerUserId,
    ...(isFeishuBotProvider(actor.provider) && actor.chatType === "group" && actor.providerMessageId
      ? {
          replyToMessageId: actor.providerMessageId,
          mentionedUserIds:
            !actor.threadId || actor.mentionedBot === true ? [actor.providerUserId] : undefined,
        }
      : {}),
    ...(actor.threadId ? { threadId: actor.threadId, rootMessageId: actor.rootMessageId } : {}),
    ...(actor.conversationThreadId !== undefined
      ? { conversationThreadId: actor.conversationThreadId }
      : {}),
    text,
    ...(selection ? { selection } : {}),
    ...extras,
    ...(actor.providerContextToken ? { providerContextToken: actor.providerContextToken } : {}),
  };
}

export function groupCardFor(
  actor: BotActor,
  context: BotContextState,
): import("@zcode/shared").BotGroupCard {
  const group = context.group!;
  const threadId = actor.threadId ?? group.threadId;
  return {
    chatId: group.chatId,
    threadId,
    taskId: context.activeTaskId,
    authorizationId: group.authorizationId!,
    ...(threadId !== group.threadId ? { conversationThreadId: group.threadId ?? null } : {}),
  };
}

export function resolveAutomationBotDeliveryTarget(
  actor: BotActor,
): ZCodeAutomationBotDeliveryTarget | undefined {
  if (actor.provider !== "feishu" && actor.provider !== "lark" && actor.provider !== "weixin") {
    return undefined;
  }
  const providerUserId = actor.chatId?.trim() || actor.providerUserId.trim();
  if (!providerUserId) return undefined;
  return {
    provider: actor.provider,
    botId: actor.botId,
    providerUserId,
    chatType: actor.chatType,
    ...(actor.threadId ? { threadId: actor.threadId, rootMessageId: actor.rootMessageId } : {}),
  };
}

export const DEFAULT_BOT_ZCODE_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;

export const BOT_FORCED_MODE = "yolo";

export const BOT_TYPING_INTERVAL_MS = 4_000;

export const BOT_TASK_META_RETRY_DELAYS_MS = [80, 160, 320] as const;

export const BOT_MAX_ATTACHMENTS_PER_MESSAGE = 4;

export const BOT_MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;

export const BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

export const REMOTE_RECONNECT_DEDUPE_TTL_MS = 3_000;

export const REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;

export const BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;

export const BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS = 5 * 60_000;

export const BOT_ELICITATION_CUSTOM_OPTION_ID = "__custom__";

export const BOT_ELICITATION_SUBMIT_OPTION_ID = "__submit__";

export const BOT_ELICITATION_SKIP_OPTION_ID = "__skip__";

export const BOT_ELICITATION_FORM_VALUE_PREFIX = "__form__:";
