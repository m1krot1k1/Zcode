import {
  isFeishuBotSender,
  isGroupControlCard,
  readGroupCardText,
  readGroupMentionText,
} from "#src/bots/providers/feishuGroupMessages.js";
import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";
import { botGroupCardSchema } from "@zcode/shared";
import type { BotConfig, BotInboundAttachment, BotInboundMessage } from "@zcode/shared";
import { readTenantAccessToken } from "./auth.js";
import { getFeishuBaseUrl, isRecord, parseJsonRecord, readString } from "./common.js";
import type { FeishuProviderDeps } from "./common.js";
import type { BotProviderAdapter } from "../types.js";
import {
  readFeishuAttachment,
  readFeishuPostLocaleContent,
  readFeishuPostText,
} from "./messages.js";

export function createFeishuCallbackPreparer(params: {
  deps: FeishuProviderDeps;
  getGroupMemberNames: (bot: BotConfig, chatId: string) => Promise<Record<string, string>>;
}): Required<Pick<BotProviderAdapter, "prepareCallbackPayload">> {
  const { deps, getGroupMemberNames } = params;
  const botOpenIds = new Map<string, string>();
  return {
    async prepareCallbackPayload(bot, payload) {
      if (!isRecord(payload)) return payload;
      const event = isRecord(payload.event) ? payload.event : payload;
      const action = isRecord(event.action) ? event.action : null;
      const actionValue = isRecord(action?.value) ? action.value : null;
      const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
      const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
      const card = botGroupCardSchema.safeParse(actionValue?.groupCard ?? behaviorValue?.groupCard);
      if (card.success) {
        const context = isRecord(event.context) ? event.context : null;
        const chatId = readString(context, "open_chat_id") || readString(context, "chat_id");
        const cardId = readString(context, "open_message_id") || readString(context, "message_id");
        // 卡片回调只有短响应窗口，位置验证与 token 请求共用同一 deadline。
        const signal = AbortSignal.timeout(1500);
        const token = await readTenantAccessToken(bot, deps, signal);
        signal.throwIfAborted();
        if (!token || !cardId || chatId !== card.data.chatId)
          throw new Error("Card scope unavailable");
        const response = await fetchBotProviderJson<{
          code?: number;
          data?: { items?: Array<Record<string, unknown>> };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(cardId)}`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        });
        const native = response.payload?.data?.items?.find((item) => item.message_id === cardId);
        // 按钮参数不是原生位置真源；必须验证卡片实际所在的话题。
        if (
          !response.ok ||
          response.payload?.code !== 0 ||
          native?.chat_id !== chatId ||
          (readString(native ?? null, "thread_id") || undefined) !== card.data.threadId
        )
          throw new Error("Card topic scope mismatch");
        return payload;
      }
      const message = isRecord(event.message) ? event.message : null;
      if (readString(message, "chat_type") !== "group") return payload;
      const messageSender = isRecord(event.sender) ? event.sender : null;
      if (
        isFeishuBotSender(readString(messageSender, "sender_type")) &&
        (readString(message, "message_type") || readString(message, "msg_type")) ===
          "interactive" &&
        isGroupControlCard(parseJsonRecord(message?.content))
      )
        return payload;
      const identityKey = `${bot.provider}:${bot.feishuAppId}`;
      let openId = botOpenIds.get(identityKey);
      if (!openId) {
        const token = await readTenantAccessToken(bot, deps);
        if (!token) throw new Error("Feishu credentials are unavailable");
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          bot?: { open_id?: string };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/bot/v3/info`, {
          headers: { authorization: `Bearer ${token}` },
        });
        openId = response.payload?.bot?.open_id;
        if (!response.ok || response.payload?.code !== 0 || !openId)
          throw new Error(response.payload?.msg || "Cannot resolve Feishu bot identity");
        botOpenIds.set(identityKey, openId);
      }
      let nativeCardContent: Record<string, unknown> | undefined;
      if (
        isFeishuBotSender(readString(messageSender, "sender_type")) &&
        (readString(message, "message_type") || readString(message, "msg_type")) === "interactive"
      ) {
        const currentContent = parseJsonRecord(message?.content);
        // 默认事件/历史内容可能只是升级客户端占位图；先读取真实正文再分类。
        if (!isRecord(currentContent?.body)) {
          const token = await readTenantAccessToken(bot, deps);
          if (!token) throw new Error("Card credentials unavailable");
          const response = await fetchBotProviderJson<{
            code?: number;
            data?: {
              items?: Array<{
                message_id?: string;
                chat_id?: string;
                thread_id?: string;
                body?: { content?: string };
              }>;
            };
          }>(
            `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(readString(message, "message_id"))}?card_msg_content_type=user_card_content`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          const native = response.payload?.data?.items?.[0];
          if (
            !response.ok ||
            response.payload?.code !== 0 ||
            native?.message_id !== readString(message, "message_id") ||
            native.chat_id !== readString(message, "chat_id") ||
            (native.thread_id || "") !== readString(message, "thread_id")
          )
            throw new Error("Card message scope unavailable");
          nativeCardContent = parseJsonRecord(native.body?.content) ?? undefined;
          if (!nativeCardContent) throw new Error("Card content unavailable");
        }
      }
      const sender = isRecord(event.sender) ? event.sender : null;
      const parentId = readString(message, "parent_id");
      const rootId = readString(message, "root_id");
      let topicRootIsCurrentBot = false;
      let referencedAttachment: BotInboundAttachment | undefined;
      let referencedMessage: BotInboundMessage["referencedMessage"];
      const referencedInlineImages: Array<{
        imageKey: string;
        messageId: string;
      }> = [];
      if (
        parentId &&
        (readString(sender, "sender_type") === "user" ||
          (isFeishuBotSender(readString(sender, "sender_type")) &&
            readString(isRecord(sender?.sender_id) ? sender.sender_id : null, "open_id") !==
              openId)) &&
        !(
          payload.zcodeTopicHasAcceptedInput === true &&
          parentId === rootId &&
          !isFeishuBotSender(readString(sender, "sender_type"))
        ) &&
        (Boolean(readString(message, "thread_id")) ||
          readGroupMentionText(
            "",
            message?.mentions,
            openId,
            readString(sender, "sender_type"),
            readString(isRecord(sender?.sender_id) ? sender.sender_id : null, "open_id"),
          ) !== null)
      ) {
        const token = await readTenantAccessToken(bot, deps);
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          data?: {
            items?: Array<{
              message_id?: string;
              chat_id?: string;
              thread_id?: string;
              msg_type?: string;
              deleted?: boolean;
              create_time?: string;
              sender?: { id?: string; id_type?: string; sender_type?: string };
              body?: { content?: string };
            }>;
          };
        }>(
          // 默认卡片响应仅含“升级客户端”占位文案；必须请求真实卡片正文供引用解析。
          `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(parentId)}?card_msg_content_type=user_card_content`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const referenced = response.payload?.data?.items?.[0];
        if (
          !response.ok ||
          response.payload?.code !== 0 ||
          referenced?.message_id !== parentId ||
          referenced.chat_id !== readString(message, "chat_id") ||
          referenced.deleted
        )
          throw new Error("Referenced attachment must be readable in the same group");
        // 引用消息可来自同群另一个话题，不能只用 chat_id 证明附件归属。
        if (
          (referenced.thread_id || undefined) !== (readString(message, "thread_id") || undefined) &&
          !(parentId === rootId && !referenced.thread_id)
        )
          throw new Error("Referenced attachment must be readable in the same topic");
        topicRootIsCurrentBot =
          parentId === rootId &&
          referenced.sender?.sender_type === "app" &&
          ((referenced.sender.id_type === "app_id" && referenced.sender.id === bot.feishuAppId) ||
            (referenced.sender.id_type === "open_id" && referenced.sender.id === openId));
        if (!["text", "post", "image", "file", "interactive"].includes(referenced.msg_type ?? "")) {
          throw new Error("Referenced message type is unsupported");
        }
        if (referenced.msg_type === "interactive") {
          // 确认文字没有专用事件类型，须通过可信 parent 消息识别，不能依赖翻译文案。
          if (
            isFeishuBotSender(readString(sender, "sender_type")) &&
            isFeishuBotSender(referenced.sender?.sender_type ?? "") &&
            isGroupControlCard(parseJsonRecord(referenced.body?.content))
          )
            return { ...payload, zcodeIgnoreInteractionMessage: true };
          const text = readGroupCardText(parseJsonRecord(referenced.body?.content));
          if (!text) throw new Error("Referenced message has no readable text");
          referencedMessage = { messageId: parentId, text };
        }
        // 文字引用此前只做权限检查后丢弃，导致仅 @ 被误判为空消息。
        if (referenced.msg_type === "text" || referenced.msg_type === "post") {
          const body = parseJsonRecord(referenced.body?.content);
          const quotedText =
            referenced.msg_type === "text" ? readString(body, "text") : readFeishuPostText(body);
          if (referenced.msg_type === "post") {
            const visit = (value: unknown): void => {
              if (Array.isArray(value)) {
                value.forEach(visit);
                return;
              }
              if (!isRecord(value)) return;
              if (value.tag === "img") {
                const image = readFeishuAttachment("image", value);
                if (!image?.providerFileId) throw new Error("Referenced image is invalid");
                referencedInlineImages.push({
                  imageKey: image.providerFileId,
                  messageId: parentId,
                });
              }
              visit(value.content ?? value.children ?? value.elements);
            };
            if (body) visit(readFeishuPostLocaleContent(body));
          }
          if (!quotedText.trim() && !referencedInlineImages.length)
            throw new Error("Referenced message is empty or unavailable");
          referencedMessage = { messageId: parentId, text: quotedText };
        }
        if (referencedMessage) {
          const senderId = referenced.sender?.id;
          const names = senderId
            ? await getGroupMemberNames(bot, referenced.chat_id!).catch(
                () => ({}) as Record<string, string>,
              )
            : {};
          const sentAt = Number(referenced.create_time);
          referencedMessage = {
            ...referencedMessage,
            ...(senderId
              ? {
                  senderId,
                  senderName:
                    names[senderId] ||
                    (senderId === openId ||
                    (referenced.sender?.sender_type === "app" && senderId === bot.feishuAppId)
                      ? bot.name
                      : undefined),
                }
              : {}),
            ...(Number.isFinite(sentAt) && sentAt > 0
              ? { sentAt: new Date(sentAt).toISOString() }
              : {}),
          };
        }
        if (referenced.msg_type === "image" || referenced.msg_type === "file") {
          const attachment = readFeishuAttachment(
            referenced.msg_type,
            parseJsonRecord(referenced.body?.content),
          );
          if (!attachment) throw new Error("Referenced attachment is invalid");
          referencedAttachment = {
            ...attachment,
            providerMetadata: { resourceMessageId: parentId },
          };
        }
      }
      return {
        ...payload,
        zcodeBotOpenId: openId,
        ...(nativeCardContent ? { zcodeNativeCardContent: nativeCardContent } : {}),
        zcodeTopicRootIsCurrentBot: topicRootIsCurrentBot,
        zcodeReferencedAttachment: referencedAttachment,
        zcodeReferencedMessage: referencedMessage,
        zcodeReferencedInlineImages: referencedInlineImages,
      };
    },
  };
}
