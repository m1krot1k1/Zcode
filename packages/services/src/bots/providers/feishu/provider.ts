import { getUnavailableReplyFallback } from "#src/bots/groupReply.js";
import { channelContentPartsSchema, channelContentText } from "@zcode/shared";
import type { BotConfig, BotInboundMessage, BotOutboundMessage } from "@zcode/shared";
import type { BotProviderAdapter } from "../types.js";
import {
  acknowledgeFeishuCallback,
  addFeishuTypingReaction,
  createFeishuGroupMemberReader,
  createFeishuInputReactionUpdater,
  deleteFeishuInteractiveMessage,
  deleteFeishuTypingReaction,
  downloadFeishuAttachment,
  resolveFeishuReplyTarget,
  sendFeishuInteractiveCard,
  updateFeishuInteractiveMessage,
} from "./api.js";
import {
  readFeishuAppDisplayName,
  readFeishuUserDisplayName,
  readTenantAccessToken,
} from "./auth.js";
import { createFeishuCallbackPreparer } from "./callback.js";
import {
  buildFeishuInteractiveCardPayload,
  buildFeishuStreamingCardPayload,
  splitFeishuStreamingCardStates,
} from "./cards.js";
import type { FeishuProviderDeps } from "./common.js";
import { isRecord, readString } from "./common.js";
import { buildFeishuElicitationCardPayload } from "./elicitation.js";
import { readFeishuCardAction, readFeishuTextMessage, splitFeishuText } from "./messages.js";
import { createFeishuTopics } from "./topics.js";

export function createFeishuBotProvider(deps: FeishuProviderDeps): BotProviderAdapter {
  const updateReaction = createFeishuInputReactionUpdater(deps);
  const getGroupMemberNames = createFeishuGroupMemberReader(deps);
  const topics = createFeishuTopics({ deps, getGroupMemberNames });
  const callback = createFeishuCallbackPreparer({ deps, getGroupMemberNames });
  async function trackDelivery<T>(
    bot: BotConfig,
    signal: AbortSignal | undefined,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await write();
      if (!signal?.aborted) deps.onDeliveryResult?.(bot, undefined);
      return result;
    } catch (error) {
      // 主动取消不代表飞书拒绝投递，也不能覆盖已有诊断；任务超时仍由 watcher 处理。
      if (!signal?.aborted)
        deps.onDeliveryResult?.(bot, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  const sendCard = (...args: Parameters<typeof sendFeishuInteractiveCard>) =>
    trackDelivery(args[0], args[4], () => sendFeishuInteractiveCard(...args));
  const updateCard = (...args: Parameters<typeof updateFeishuInteractiveMessage>) =>
    trackDelivery(args[0], args[4], () => updateFeishuInteractiveMessage(...args));
  const sendReplyCard = async (
    bot: BotConfig,
    token: string,
    message: BotOutboundMessage,
    card: Record<string, unknown>,
    uuid?: string,
  ): Promise<string | null> => {
    let target = message;
    for (;;) {
      try {
        return await sendCard(bot, token, message.providerUserId, card, undefined, {
          ...resolveFeishuReplyTarget(target),
          ...(uuid ? { uuid } : {}),
        });
      } catch (error) {
        const details = error as {
          deliveryRejected?: boolean;
          deliveryReplyUnavailable?: boolean;
        } | null;
        // 持久化结果由 delivery owner 记录降级目标；这里只处理命令和临时卡。
        if (
          message.deliveryId ||
          !message.providerUserId.startsWith("oc_") ||
          !details?.deliveryRejected ||
          !details.deliveryReplyUnavailable
        )
          throw error;
        const fallback = getUnavailableReplyFallback(target);
        if (!fallback) throw error;
        target = { ...target, ...fallback };
      }
    }
  };
  return {
    getGroupMemberNames,
    resolveTopic: topics.resolveTopic,
    readTopicResourceMessage: topics.readTopicResourceMessage,
    readTopicHistory: topics.readTopicHistory,
    getGroupInfo: topics.getGroupInfo,
    prepareCallbackPayload: callback.prepareCallbackPayload,
    splitStreamingReplyCardStates: splitFeishuStreamingCardStates,
    async test(bot) {
      if (!bot.enabled) {
        return { ok: false, message: "Feishu bot is disabled." };
      }
      if (!bot.feishuAppId || !bot.credentialRef) {
        return {
          ok: false,
          message: "Feishu App ID and App Secret are required.",
        };
      }
      const token = await readTenantAccessToken(bot, deps);
      return token
        ? { ok: true, message: "Feishu app credentials are valid." }
        : { ok: false, message: "Feishu app credentials are missing." };
    },

    async resolveName(bot) {
      // Bugfix: Feishu 创建向导以前只能使用手填/默认名称，容易和真实机器人名称不一致。
      // 飞书机器人能力挂在自建应用上，这里读取应用信息中的名称作为 bot 展示名。
      return readFeishuAppDisplayName(bot, deps);
    },

    async resolveActorDisplayName(bot, actor) {
      // 群事件不保证携带姓名；群成员接口避免依赖组织通讯录可见范围。
      if (actor.chatType === "group") {
        if (!actor.chatId) return null;
        return (await getGroupMemberNames(bot, actor.chatId))[actor.providerUserId] ?? null;
      }
      return readFeishuUserDisplayName(bot, deps, actor.providerUserId);
    },

    async send(bot, message) {
      resolveFeishuReplyTarget(message);
      if (message.contentParts) {
        const parts = channelContentPartsSchema.parse(message.contentParts);
        if (
          message.selection ||
          !message.providerUserId.startsWith("oc_") ||
          parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider) ||
          channelContentText(parts) !== message.text ||
          message.text.length > 2000
        )
          throw Object.assign(new Error("Invalid native channel reply"), {
            deliveryRejected: true,
          });
      }
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        if (message.deliveryId)
          throw Object.assign(new Error("Feishu credentials unavailable"), {
            deliveryRejected: true,
          });
        return;
      }
      if (message.selection) {
        const providerMessageId = await sendReplyCard(
          bot,
          token,
          message,
          message.elicitation
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload(message),
        );
        return message.selection.action === "queue.cancel" && providerMessageId
          ? { providerMessageId }
          : undefined;
      }
      let partIndex = 0;
      let providerMessageId: string | null = null;
      for (const text of splitFeishuText(message.text)) {
        // Bugfix: Feishu 普通文本消息会把 Markdown 原样展示，和 Telegram 的 Markdown 回复不一致。
        // 改用交互卡片的 markdown 元素承载普通回复，选择消息也继续复用同一套卡片结构。
        providerMessageId = await sendReplyCard(
          bot,
          token,
          message,
          buildFeishuInteractiveCardPayload({
            ...message,
            text,
            mentionedUserIds: partIndex === 0 ? message.mentionedUserIds : undefined,
            selection: undefined,
          }),
          message.deliveryId ? `${message.deliveryId.slice(0, 40)}-${partIndex}` : undefined,
        );
        partIndex += 1;
      }
      return message.deliveryId && providerMessageId ? { providerMessageId } : undefined;
    },

    async createStreamingReplyCard(bot, state, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) {
        return null;
      }
      const providerMessageId = await sendCard(
        bot,
        token,
        state.providerUserId,
        buildFeishuStreamingCardPayload(state),
        signal,
      );
      return providerMessageId ? { providerMessageId } : null;
    },

    async updateStreamingReplyCard(bot, handle, state, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) {
        return;
      }
      await updateCard(bot, token, handle, buildFeishuStreamingCardPayload(state), signal);
    },

    async createTransientInteractionCard(bot, message) {
      resolveFeishuReplyTarget(message);
      if (message.contentParts) {
        const parts = channelContentPartsSchema.parse(message.contentParts);
        if (
          message.selection ||
          !message.providerUserId.startsWith("oc_") ||
          parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider) ||
          channelContentText(parts) !== message.text ||
          message.text.length > 2000
        )
          throw Object.assign(new Error("Invalid native channel reply"), {
            deliveryRejected: true,
          });
      }
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return null;
      }
      const providerMessageId = await sendReplyCard(
        bot,
        token,
        message,
        message.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload(message),
      );
      return providerMessageId ? { providerMessageId } : null;
    },

    async updateTransientInteractionCard(bot, handle, message) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      await updateCard(
        bot,
        token,
        handle,
        message.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload(message),
      );
    },

    async deleteTransientInteractionCard(bot, handle) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      await deleteFeishuInteractiveMessage(bot, token, handle);
    },

    async updateInputReaction(bot, messageId, state) {
      await updateReaction(bot, messageId, state);
    },

    async sendTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      // Bugfix: 飞书/Lark 普通命令不会进入长任务 stream，之前只实现 startTyping/stopTyping，
      // 所以 /状态、/项目 等命令没有任何处理中反馈。这里只加 Typing reaction，删除由 BotService 在同步回复发送完成后显式收口。
      await addFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async startTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      // Bugfix: 飞书没有原生 typing 状态，只能用 Typing reaction 模拟。
      // reaction 不会自动消失，所以必须记录 reaction_id，任务结束或进入权限等待时再删除。
      await addFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async stopTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      await deleteFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async acknowledgeCallback(bot, payload, text, message, signal) {
      return acknowledgeFeishuCallback(deps, bot, payload, text, message, signal);
    },

    async downloadAttachment(bot, attachment, actor, signal) {
      return downloadFeishuAttachment(deps, bot, attachment, actor, signal);
    },

    parseCallback(payload): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = readString(payload, "botId");
      if (!botId) {
        return [];
      }
      const message = readFeishuTextMessage(botId, payload) ?? readFeishuCardAction(botId, payload);
      return message ? [message] : [];
    },
  };
}
