import { isGroupControlCard, readGroupCardText } from "#src/bots/providers/feishuGroupMessages.js";
import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";
import { readTopicHistory, TopicHistoryPermissionError } from "#src/bots/topicHistory.js";
import { botTopicMessageSchema } from "@zcode/shared";
import type { BotConfig, BotInboundAttachment } from "@zcode/shared";
import { readTenantAccessToken } from "./auth.js";
import { getFeishuBaseUrl, isRecord, parseJsonRecord, readString } from "./common.js";
import type { FeishuProviderDeps } from "./common.js";
import type { BotProviderAdapter } from "../types.js";
import { readFeishuAttachment, readFeishuPostText } from "./messages.js";

export function createFeishuTopics(params: {
  deps: FeishuProviderDeps;
  getGroupMemberNames: (bot: BotConfig, chatId: string) => Promise<Record<string, string>>;
}): Required<
  Pick<
    BotProviderAdapter,
    "resolveTopic" | "readTopicResourceMessage" | "readTopicHistory" | "getGroupInfo"
  >
> {
  const { deps, getGroupMemberNames } = params;
  return {
    async resolveTopic(bot, actor) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token || !actor.chatId || !actor.providerMessageId)
        throw new Error("Topic identity unavailable");
      const get = async (id: string) => {
        const response = await fetchBotProviderJson<{
          code?: number;
          data?: { items?: Array<Record<string, unknown>> };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const item = response.payload?.data?.items?.find((entry) => entry.message_id === id);
        if (!response.ok || response.payload?.code !== 0 || !item || item.chat_id !== actor.chatId)
          throw new Error("Topic message scope could not be verified");
        return item;
      };
      const message = await get(actor.providerMessageId);
      const threadId = readString(message, "thread_id");
      if (!threadId || (actor.threadId && actor.threadId !== threadId))
        throw new Error("Topic scope mismatch");
      const rootMessageId = readString(message, "root_id") || actor.providerMessageId;
      const root = rootMessageId === actor.providerMessageId ? message : await get(rootMessageId);
      if (root.thread_id !== threadId) throw new Error("Topic root scope mismatch");
      const body = isRecord(root.body) ? root.body : null;
      const content = parseJsonRecord(readString(body, "content"));
      const title = readString(content, "text") || readFeishuPostText(content) || threadId;
      const position = root.thread_message_position;
      const topicUrl =
        (typeof position === "number" || typeof position === "string") &&
        /^\d+$/.test(String(position))
          ? `https://${bot.provider === "lark" ? "applink.larksuite.com" : "applink.feishu.cn"}/client/thread/open?${new URLSearchParams(
              {
                openthreadid: threadId,
                openchatid: actor.chatId,
                open_thread_id: threadId,
                open_chat_id: actor.chatId,
                thread_position: String(position),
              },
            )}`
          : undefined;
      return {
        threadId,
        rootMessageId,
        topicTitle: title.replace(/\s+/gu, " ").slice(0, 80),
        ...(topicUrl ? { topicUrl } : {}),
      };
    },
    async readTopicResourceMessage(bot, target, signal) {
      signal?.throwIfAborted();
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) throw new Error("Feishu credentials unavailable");
      const response = await fetchBotProviderJson<{
        code?: number;
        data?: { items?: Array<Record<string, unknown>> };
      }>(
        `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(target.messageId)}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal,
        },
      );
      const native = response.payload?.data?.items?.find(
        (item) => item.message_id === target.messageId,
      );
      if (
        !response.ok ||
        response.payload?.code !== 0 ||
        !native ||
        native.deleted === true ||
        native.chat_id !== target.chatId ||
        native.thread_id !== target.threadId
      )
        throw new Error("Archived resource must be readable in the same topic");
      const body = isRecord(native.body) ? native.body : null;
      const content = parseJsonRecord(readString(body, "content"));
      const kind = readString(native, "msg_type");
      const attachments: BotInboundAttachment[] = [];
      const add = (attachment: BotInboundAttachment | null | undefined) => {
        if (!attachment) throw new Error("Archived resource metadata unavailable");
        attachments.push({
          ...attachment,
          providerMetadata: { resourceMessageId: target.messageId },
        });
      };
      if (kind === "file" || kind === "image") add(readFeishuAttachment(kind, content));
      else if (kind === "post") {
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          if (!isRecord(value)) return;
          if (value.tag === "img") add(readFeishuAttachment("image", value));
          else Object.values(value).forEach(visit);
        };
        visit(content);
      }
      if (!attachments.length) throw new Error("Archived message has no supported resources");
      return { ...target, attachments };
    },
    async readTopicHistory(bot, request) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) throw new Error("Feishu credentials unavailable");
      const read = async (suffix: string) => {
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          data?: { items?: unknown[]; has_more?: boolean; page_token?: string };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages${suffix}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok || response.payload?.code !== 0) {
          const message = response.payload?.msg || "Topic history unavailable";
          if (response.payload?.code === 99991672 || message.includes("im:message.group_msg"))
            throw new TopicHistoryPermissionError(message);
          throw new Error(message);
        }
        return response.payload.data;
      };
      const readHistoryAttachments = (kind: string, content: Record<string, unknown> | null) => {
        const items: Array<{ name: string; kind: string }> = [];
        const add = (type: "image" | "file", value: Record<string, unknown> | null) => {
          const attachment = readFeishuAttachment(type, value);
          if (attachment) items.push({ name: attachment.filename, kind: type });
        };
        if (kind === "image" || kind === "file") add(kind, content);
        else if (kind === "post") {
          const visit = (value: unknown): void => {
            if (Array.isArray(value)) {
              value.forEach(visit);
              return;
            }
            if (!isRecord(value)) return;
            if (value.tag === "img") add("image", value);
            else Object.values(value).forEach(visit);
          };
          visit(content);
        }
        return items;
      };
      const rawMessages = new Map<string, unknown>();
      const normalize = async (raw: unknown, expandCard = false) => {
        if (!isRecord(raw)) throw new Error("Invalid topic history message");
        const sender = isRecord(raw.sender) ? raw.sender : null;
        const body = isRecord(raw.body) ? raw.body : null;
        let content = parseJsonRecord(readString(body, "content"));
        const kind = readString(raw, "msg_type");
        if (
          expandCard &&
          kind === "interactive" &&
          readString(sender, "sender_type") === "app" &&
          !isRecord(content?.body)
        ) {
          // 历史接口也会返回升级客户端占位图，不能据此把操作卡片误判为普通回复。
          const data = await read(
            `/${encodeURIComponent(readString(raw, "message_id"))}?card_msg_content_type=user_card_content`,
          );
          const native = data?.items?.find(
            (item) => isRecord(item) && item.message_id === readString(raw, "message_id"),
          );
          if (
            !isRecord(native) ||
            native.chat_id !== raw.chat_id ||
            native.thread_id !== raw.thread_id
          )
            throw new Error("History card scope unavailable");
          content = parseJsonRecord(isRecord(native.body) ? native.body.content : undefined);
          if (!content) throw new Error("History card content unavailable");
        }
        rawMessages.set(readString(raw, "message_id"), raw);
        return botTopicMessageSchema.parse({
          id: readString(raw, "message_id"),
          chatId: readString(raw, "chat_id"),
          threadId: readString(raw, "thread_id"),
          senderId: readString(sender, "id"),
          senderType: readString(sender, "sender_type"),
          senderName: readString(sender, "name") || undefined,
          parentId: readString(raw, "parent_id") || undefined,
          attachments: readHistoryAttachments(kind, content),
          createdAt: Number(readString(raw, "create_time")),
          kind,
          ...(kind === "interactive" ? { controlCard: isGroupControlCard(content) } : {}),
          text:
            kind === "interactive"
              ? readGroupCardText(content)
              : kind === "text"
                ? readString(content, "text")
                : kind === "post"
                  ? readFeishuPostText(content)
                  : `[${kind}${readString(content, "file_name") ? `: ${readString(content, "file_name")}` : ""}]`,
          deleted: raw.deleted === true,
        });
      };
      const history = await readTopicHistory(request, {
        list: async (page) => {
          const query = new URLSearchParams({
            container_id_type: "thread",
            container_id: request.threadId,
            sort_type: "ByCreateTimeDesc",
            page_size: "50",
            ...(page ? { page_token: page } : {}),
          });
          const data = await read(`?${query}`);
          if (!Array.isArray(data?.items)) throw new Error("Topic history page unavailable");
          if (data.has_more && !data.page_token)
            throw new Error("Topic history cursor unavailable");
          return {
            messages: await Promise.all(data.items.map((raw) => normalize(raw))),
            next: data.has_more ? data.page_token : undefined,
          };
        },
        // 由历史读取器先确定窗口，正文展开不再作用于整页消息。
        hydrate: (message) => normalize(rawMessages.get(message.id), true),
        get: async (id) => {
          const data = await read(`/${encodeURIComponent(id)}`);
          const raw = data?.items?.find((item) => isRecord(item) && item.message_id === id);
          return normalize(raw);
        },
      });
      if (history.messages.length) {
        const names = await getGroupMemberNames(bot, request.chatId).catch(
          () => ({}) as Record<string, string>,
        );
        history.messages = history.messages.map((message) => ({
          ...message,
          senderName: names[message.senderId] || message.senderName,
        }));
      }
      return history;
    },
    async getGroupInfo(bot, chatId) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) throw new Error("Feishu credentials are unavailable");
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: { name?: string; chat_mode?: string };
      }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Cannot read group information");
      return {
        name: response.payload.data?.name || chatId,
        chatMode: response.payload.data?.chat_mode === "topic" ? "topic" : "group",
      };
    },
  };
}
