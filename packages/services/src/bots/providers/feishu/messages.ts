import {
  isFeishuBotSender,
  isGroupControlCard,
  readGroupConversationCardText,
  readGroupMessage,
} from "#src/bots/providers/feishuGroupMessages.js";
import { botGroupCardSchema } from "@zcode/shared";
import type { BotInboundAttachment, BotInboundMessage } from "@zcode/shared";
import {
  isRecord,
  parseJsonRecord,
  readFeishuCallbackEvent,
  readFeishuChatType,
  readFeishuPayloadProvider,
  readString,
} from "./common.js";
import {
  buildFeishuElicitationFormCommand,
  FEISHU_ELICITATION_FORM_FIELD_NAME,
  FEISHU_ELICITATION_FORM_VALUE_PREFIX,
} from "./elicitation.js";

function stripFeishuMentions(text: string): string {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/giu, "")
    .replace(/@\S+/gu, "")
    .trim();
}

export function readFeishuPostLocaleContent(content: Record<string, unknown>): unknown {
  const post = isRecord(content.post) ? content.post : null;
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null;
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null;
  return content.content ?? zhCn?.content ?? enUs?.content;
}

function readFeishuPostLocaleTitle(content: Record<string, unknown>): string {
  const post = isRecord(content.post) ? content.post : null;
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null;
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null;
  return readString(content, "title") || readString(zhCn, "title") || readString(enUs, "title");
}

function formatFeishuPostToken(token: unknown, botOpenId?: string, mentions?: unknown): string {
  if (typeof token === "string") {
    return token;
  }
  if (Array.isArray(token)) {
    return token
      .map((item) => formatFeishuPostToken(item, botOpenId, mentions))
      .filter(Boolean)
      .join("");
  }
  if (!isRecord(token)) {
    return "";
  }
  const tag = readString(token, "tag");
  if (tag === "at") {
    if (!botOpenId) return "";
    // 群富文本中的自身 @ 也须进入有序 mention，不能在转文本时提前丢掉。
    const id = readString(token, "user_id");
    const mention = (Array.isArray(mentions) ? mentions : []).find(
      (item) => isRecord(item) && isRecord(item.id) && item.id.open_id === id,
    );
    if (isRecord(mention) && typeof mention.key === "string") return mention.key;
    return id.startsWith("@_") ? id : `@${readString(token, "user_name") || id}`;
  }
  const nested = token.content ?? token.children ?? token.elements;
  const nestedText = Array.isArray(nested)
    ? formatFeishuPostToken(nested, botOpenId, mentions)
    : "";
  const text =
    readString(token, "text") ||
    readString(token, "un_escape_text") ||
    readString(token, "name") ||
    nestedText;
  if (tag === "a") {
    const href = readString(token, "href");
    if (href && href !== text) {
      return text ? `${text} ${href}` : href;
    }
  }
  return text;
}

export function readFeishuPostText(
  content: Record<string, unknown> | null,
  botOpenId?: string,
  mentions?: unknown,
): string {
  if (!content) {
    return "";
  }
  const postContent = readFeishuPostLocaleContent(content);
  const lines = Array.isArray(postContent)
    ? postContent
        .map((line) => formatFeishuPostToken(line, botOpenId, mentions).trim())
        .filter(Boolean)
    : [];
  const title = readFeishuPostLocaleTitle(content).trim();
  const body = lines.join("\n").trim();
  if (title && body) {
    return `${title}\n${body}`;
  }
  return body || title;
}

function inferFeishuAttachmentKind(msgType: string): BotInboundAttachment["kind"] {
  if (msgType === "image") return "image";
  if (msgType === "audio") return "audio";
  if (msgType === "media" || msgType === "video") return "video";
  return "file";
}

function defaultFeishuMimeType(kind: BotInboundAttachment["kind"]): string {
  if (kind === "image") return "image/jpeg";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

export function readFeishuAttachment(
  msgType: string,
  content: Record<string, unknown> | null,
): BotInboundAttachment | null {
  if (!content) {
    return null;
  }
  const providerFileId =
    readString(content, "image_key") ||
    readString(content, "file_key") ||
    readString(content, "media_key") ||
    readString(content, "audio_key") ||
    readString(content, "key");
  if (!providerFileId) {
    return null;
  }
  const kind = inferFeishuAttachmentKind(msgType);
  const filename =
    readString(content, "file_name") ||
    readString(content, "filename") ||
    `${msgType}-${providerFileId.slice(0, 8)}`;
  const mimeType =
    readString(content, "mime_type") ||
    readString(content, "mimeType") ||
    defaultFeishuMimeType(kind);
  return {
    id: providerFileId,
    kind,
    filename,
    mimeType,
    ...(typeof content.size === "number" ? { sizeBytes: content.size } : {}),
    providerFileId,
  };
}

export function readFeishuTextMessage(
  botId: string,
  payload: Record<string, unknown>,
): BotInboundMessage | null {
  const provider = readFeishuPayloadProvider(payload);
  // Bugfix: 飞书 node-sdk 的 WebSocket EventDispatcher 在不同事件/版本下可能把 event 字段摊平到顶层。
  // 之前只读 payload.event.message，长连接确实收到消息时也会解析成 0 条 inbound。
  const event = isRecord(payload.event) ? payload.event : payload;
  const message = isRecord(event?.message) ? event.message : null;
  const sender = isRecord(event?.sender) ? event.sender : null;
  const senderId = isRecord(sender?.sender_id) ? sender.sender_id : null;
  const content = isRecord(payload.zcodeNativeCardContent)
    ? payload.zcodeNativeCardContent
    : parseJsonRecord(message?.content);
  const msgType = readString(message, "message_type") || readString(message, "msg_type");
  // 交互卡及其机器人确认回复属于控制流程，过去提取卡片文字会误触发另一机器人。
  if (
    payload.zcodeIgnoreInteractionMessage === true ||
    (isFeishuBotSender(readString(sender, "sender_type")) &&
      msgType === "interactive" &&
      isGroupControlCard(content))
  )
    return null;
  const attachment = readFeishuAttachment(msgType, content);
  const attachments: BotInboundAttachment[] = attachment ? [attachment] : [];
  if (isRecord(payload.zcodeReferencedAttachment)) {
    const ref = payload.zcodeReferencedAttachment;
    if (
      (ref.kind === "image" || ref.kind === "file") &&
      typeof ref.providerFileId === "string" &&
      typeof ref.filename === "string" &&
      typeof ref.mimeType === "string"
    ) {
      const metadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : null;
      const resourceMessageId = readString(metadata, "resourceMessageId");
      if (resourceMessageId)
        attachments.push({
          id: ref.providerFileId,
          kind: ref.kind,
          providerFileId: ref.providerFileId,
          filename: ref.filename,
          mimeType: ref.mimeType,
          providerMetadata: { resourceMessageId },
        });
    }
  }
  if (Array.isArray(payload.zcodeReferencedInlineImages)) {
    for (const image of payload.zcodeReferencedInlineImages) {
      if (
        isRecord(image) &&
        typeof image.imageKey === "string" &&
        typeof image.messageId === "string"
      ) {
        const item = readFeishuAttachment("image", {
          image_key: image.imageKey,
        });
        if (item)
          attachments.push({
            ...item,
            providerMetadata: { resourceMessageId: image.messageId },
          });
      }
    }
  }
  let malformedInlineImage = false;
  if (msgType === "post" && content) {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (!isRecord(node)) return;
      if (node.tag === "img") {
        const image = readFeishuAttachment("image", node);
        if (image) attachments.push(image);
        else malformedInlineImage = true;
      }
      visit(node.content ?? node.children ?? node.elements);
    };
    visit(readFeishuPostLocaleContent(content));
  }
  // 缺少图片引用不能静默降级成只执行正文。
  if (malformedInlineImage) return null;
  // Bugfix: 飞书客户端里看起来像普通文字的富文本/带链接消息会以 message_type=post 推送。
  // 之前只读 content.text，post 消息被解析成空文本并直接丢弃，所以用户侧表现为“发了普通消息但 app 没反应”。
  const rawText =
    (msgType === "interactive" ? readGroupConversationCardText(content, message?.mentions) : "") ||
    readString(content, "text") ||
    readFeishuPostText(
      content,
      readString(payload, "zcodeBotOpenId") || undefined,
      message?.mentions,
    ) ||
    readString(event, "text_without_at_bot") ||
    readString(event, "text");
  const incomingChatType = readString(message, "chat_type") || readString(event, "chat_type");
  if (incomingChatType === "topic_group") return null;
  const groupMessage =
    incomingChatType === "group"
      ? readGroupMessage(
          rawText,
          message?.mentions,
          readString(payload, "zcodeBotOpenId"),
          readString(sender, "sender_type"),
          readString(senderId, "open_id"),
        )
      : undefined;
  // Provider 验证发送者与 mention 身份；机器人群主聊天必须原生 @，群/话题启用状态由服务校验。
  if (
    isFeishuBotSender(readString(sender, "sender_type")) &&
    (incomingChatType !== "group" ||
      (!readString(message, "thread_id") && !groupMessage?.mentionedBot))
  )
    return null;
  if (
    incomingChatType === "group" &&
    (!groupMessage || (!groupMessage.mentionedBot && !readString(message, "thread_id")))
  )
    return null;
  const text = groupMessage?.text ?? stripFeishuMentions(rawText);
  // 群权限只使用应用内 open_id，不能把其他 ID 命名空间误当作绑定身份。
  if (incomingChatType === "group" && !readString(senderId, "open_id")) return null;
  const userId =
    readString(senderId, "open_id") ||
    readString(senderId, "user_id") ||
    readString(senderId, "union_id") ||
    readString(event, "open_id") ||
    readString(event, "user_id") ||
    readString(event, "union_id");
  const chatId = readString(message, "chat_id") || readString(event, "open_chat_id");
  const messageId = readString(message, "message_id");
  // 群内仅 @ 仍是有效唤起，空需求由服务结合引用/话题背景处理。
  if ((!text && attachments.length === 0 && incomingChatType !== "group") || !userId) {
    return null;
  }
  const chatType = readFeishuChatType(
    readString(message, "chat_type") || readString(event, "chat_type"),
  );
  return {
    botId,
    text,
    ...(groupMessage
      ? {
          ...(isFeishuBotSender(readString(sender, "sender_type"))
            ? { senderType: "app" as const }
            : {}),
          botOpenId: readString(payload, "zcodeBotOpenId") || undefined,
          mentionedBot: groupMessage.mentionedBot,
          commandText: groupMessage.commandText,
          ...(groupMessage.contentParts
            ? {
                contentParts: groupMessage.contentParts.map((part) =>
                  part.type === "text"
                    ? part
                    : {
                        ...part,
                        channel: provider === "lark" ? ("lark" as const) : ("feishu" as const),
                        refId: `${messageId}:${part.refId}`,
                      },
                ),
              }
            : {}),
          topicRootIsCurrentBot: payload.zcodeTopicRootIsCurrentBot === true,
        }
      : {}),
    ...(isRecord(payload.zcodeReferencedMessage) &&
    typeof payload.zcodeReferencedMessage.messageId === "string" &&
    typeof payload.zcodeReferencedMessage.text === "string"
      ? {
          referencedMessage: {
            ...payload.zcodeReferencedMessage,
            messageId: payload.zcodeReferencedMessage.messageId,
            text: payload.zcodeReferencedMessage.text,
          },
        }
      : {}),
    ...(attachments.length ? { attachments } : {}),
    actor: {
      provider,
      botId,
      providerUserId: userId,
      displayName: readString(sender, "sender_name") || undefined,
      chatType,
      chatId: chatType === "group" && chatId ? chatId : undefined,
      ...(chatType === "group" && readString(message, "thread_id")
        ? {
            threadId: readString(message, "thread_id"),
            rootMessageId: readString(message, "root_id") || messageId,
          }
        : {}),
      providerMessageId: messageId || undefined,
    },
  };
}

export function readFeishuCardAction(
  botId: string,
  payload: Record<string, unknown>,
): BotInboundMessage | null {
  const provider = readFeishuPayloadProvider(payload);
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  const formValue = isRecord(action?.form_value) ? action.form_value : null;
  const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  const rawCommand =
    readString(value, "command") ||
    readString(value, "text") ||
    readString(behaviorValue, "command") ||
    readString(behaviorValue, "text");
  const submittedAnswer = formValue?.[FEISHU_ELICITATION_FORM_FIELD_NAME];
  const command =
    rawCommand && rawCommand.includes(FEISHU_ELICITATION_FORM_VALUE_PREFIX)
      ? buildFeishuElicitationFormCommand(rawCommand.split(/\s+/u)[1] ?? "", submittedAnswer)
      : rawCommand;
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readString(operatorId, "open_id") ||
    readString(operator, "open_id") ||
    readString(event, "open_id") ||
    readString(event, "user_id") ||
    readString(payload, "open_id") ||
    readString(payload, "user_id");
  const context = isRecord(event.context) ? event.context : null;
  const contextChatType =
    readString(context, "chat_type") ||
    readString(event, "chat_type") ||
    readString(payload, "chat_type");
  const chatId = readString(context, "open_chat_id") || readString(context, "chat_id");
  const message = isRecord(event.message) ? event.message : null;
  const header = isRecord(payload.header) ? payload.header : null;
  const providerMessageId =
    readString(event, "event_id") ||
    readString(header, "event_id") ||
    readString(payload, "uuid") ||
    readString(payload, "event_id") ||
    readString(context, "open_message_id") ||
    readString(context, "message_id") ||
    readString(message, "message_id") ||
    readString(action, "value_id");
  if (!command || !openId) {
    return null;
  }
  // Bugfix: 飞书卡片回调的 context.open_chat_id 在私聊按钮里也可能存在。
  // 之前用 chatId 是否存在判断群聊，会把私聊里的卡片按钮误拒成“只支持私聊”。
  const chatType = readFeishuChatType(readString(payload, "zcodeChatType") || contextChatType);
  const groupCard = botGroupCardSchema.safeParse(value?.groupCard ?? behaviorValue?.groupCard);
  return {
    botId,
    ...(chatType === "group"
      ? {
          groupCardAction: true,
          ...(groupCard.success ? { groupCard: groupCard.data } : {}),
        }
      : {}),
    text: command,
    actor: {
      provider,
      botId,
      providerUserId: openId,
      chatType,
      chatId: chatType === "group" && chatId ? chatId : undefined,
      ...(chatType === "group" && groupCard.success && groupCard.data.threadId
        ? { threadId: groupCard.data.threadId }
        : {}),
      ...(providerMessageId ? { providerMessageId } : {}),
    },
  };
}

export function readFeishuCardUpdateToken(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const context = isRecord(event.context) ? event.context : null;
  // Bugfix: Card JSON 2.0 回调的更新 token 不总在旧版 action.token 上。
  // 新版按钮由 behaviors.callback 触发时，飞书/Lark 可能把 token 放在事件或 context 上；漏读会让 card/update 静默跳过，按钮留在原卡片里。
  return (
    readString(event, "token") ||
    readString(event, "card_update_token") ||
    readString(event, "update_token") ||
    readString(payload, "token") ||
    readString(payload, "card_update_token") ||
    readString(payload, "update_token") ||
    readString(action, "token") ||
    readString(action, "card_update_token") ||
    readString(action, "update_token") ||
    readString(context, "token") ||
    readString(context, "card_update_token") ||
    readString(context, "update_token")
  );
}

export function readFeishuCardUpdateOpenIds(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const event = readFeishuCallbackEvent(payload);
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readString(operatorId, "open_id") ||
    readString(operator, "open_id") ||
    readString(event, "open_id") ||
    readString(payload, "open_id");
  return openId ? [openId] : [];
}

export function readFeishuCardOriginalText(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  return (
    readString(value, "zcodeCardText") ||
    readString(value, "cardText") ||
    readString(behaviorValue, "zcodeCardText") ||
    readString(behaviorValue, "cardText") ||
    null
  );
}

export function splitFeishuText(text: string): string[] {
  const limit = 1900;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}
