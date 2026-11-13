import {
  createGroupMemberDirectory,
  type GroupMemberPage,
} from "#src/bots/providers/groupMemberDirectory.js";
import {
  createGroupInputReactionUpdater,
  type GroupInputReaction,
} from "#src/bots/providers/groupInputReaction.js";
import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";
import type {
  BotConfig,
  BotInboundAttachment,
  BotInboundMessage,
  BotOutboundMessage,
} from "@zcode/shared";
import type { BotStreamingReplyCardHandle, BotTransientInteractionCardHandle } from "../types.js";
import { readTenantAccessToken } from "./auth.js";
import { getFeishuBaseUrl, getFeishuDomainProvider, type FeishuProviderDeps } from "./common.js";
import { buildFeishuInteractiveCardPayload } from "./cards.js";
import { buildFeishuElicitationCardPayload } from "./elicitation.js";
import {
  readFeishuCardOriginalText,
  readFeishuCardUpdateOpenIds,
  readFeishuCardUpdateToken,
} from "./messages.js";

interface FeishuSendMessageResponse {
  code?: number;
  msg?: string;
  error?: {
    log_id?: string;
  };
  data?: {
    message_id?: string;
  };
}

interface FeishuReactionResponse {
  code?: number;
  msg?: string;
  data?: {
    reaction_id?: string;
  };
}

const FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const typingReactionIds = new Map<string, string>();

function resolveFeishuReceiveIdType(receiveId: string): "chat_id" | "open_id" {
  return receiveId.startsWith("oc_") ? "chat_id" : "open_id";
}

function createFeishuMessageError(
  operation: string,
  status: number,
  payload: FeishuSendMessageResponse | undefined,
  responseLogId?: string,
  receiveIdType?: string,
): Error {
  const details = [
    typeof payload?.code === "number" ? `code=${payload.code}` : null,
    payload?.msg ? `msg=${payload.msg}` : null,
    payload?.error?.log_id || responseLogId
      ? `log_id=${payload?.error?.log_id ?? responseLogId}`
      : null,
    receiveIdType ? `receive_id_type=${receiveIdType}` : null,
  ].filter((detail): detail is string => Boolean(detail));
  // 修复原因：飞书的 HTTP 400 会在响应体中携带业务错误码、原因和排查 log_id。
  // 旧实现先按 HTTP 状态抛错，导致这些已解析的信息永久丢失，无法区分权限、限流和卡片错误。
  return Object.assign(
    new Error(
      `Feishu ${operation} failed: HTTP ${status}${details.length > 0 ? `, ${details.join(", ")}` : ""}`,
    ),
    {
      // 无业务回执的服务端错误，以及“正在发送”，都不能证明本次发送未发生。
      deliveryRejected:
        payload?.code !== 230049 &&
        ((typeof payload?.code === "number" && payload.code !== 0) ||
          (status >= 400 && status < 500 && status !== 408)),
      ...(payload?.code === 230011 ? { deliveryReplyUnavailable: true } : {}),
      ...(status === 429 || payload?.code === 230020 || payload?.code === 99991400
        ? { retryAfterMs: 1000 }
        : {}),
    },
  );
}

export function resolveFeishuReplyTarget(message: BotOutboundMessage) {
  const replyToMessageId =
    message.replyToMessageId || (message.threadId ? message.rootMessageId : undefined);
  // 原因：临时审批／问答卡曾跳过话题路由，直接发到群主聊天；统一解析并拒绝无锚点投递。
  if (message.threadId && !replyToMessageId)
    throw Object.assign(new Error("Topic reply target is unavailable"), {
      deliveryRejected: true,
    });
  return { replyToMessageId, replyInThread: Boolean(message.threadId) };
}

export async function sendFeishuInteractiveCard(
  bot: BotConfig,
  token: string,
  receiveId: string,
  card: Record<string, unknown>,
  signal?: AbortSignal,
  delivery?: {
    replyToMessageId?: string;
    uuid?: string;
    replyInThread?: boolean;
  },
): Promise<string | null> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    delivery?.replyToMessageId
      ? `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(delivery.replyToMessageId)}/reply`
      : `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages?receive_id_type=${resolveFeishuReceiveIdType(receiveId)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...(!delivery?.replyToMessageId ? { receive_id: receiveId } : {}),
        ...(delivery?.uuid ? { uuid: delivery.uuid } : {}),
        ...(delivery?.replyInThread ? { reply_in_thread: true } : {}),
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal,
    },
  );
  const payload = response.payload ?? {};
  // HTTP 成功也可能携带业务拒绝，必须保留错误码和请求 ID。
  if (!response.ok || payload.code !== 0) {
    throw createFeishuMessageError(
      "send interactive message",
      response.status,
      payload,
      response.responseLogId,
      resolveFeishuReceiveIdType(receiveId),
    );
  }
  if ((delivery?.uuid || delivery?.replyToMessageId) && !payload.data?.message_id)
    throw new Error("Feishu delivery outcome is unknown: no message_id");
  return payload.data?.message_id ?? null;
}

export async function updateFeishuInteractiveMessage(
  bot: BotConfig,
  token: string,
  handle: BotStreamingReplyCardHandle,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(handle.providerMessageId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal,
    },
  );
  const payload = response.payload ?? {};
  // HTTP 成功也可能携带业务拒绝，必须保留错误码和请求 ID。
  if (!response.ok || payload.code !== 0) {
    throw createFeishuMessageError(
      "update streaming card",
      response.status,
      payload,
      response.responseLogId,
    );
  }
}

export async function deleteFeishuInteractiveMessage(
  bot: BotConfig,
  token: string,
  handle: BotTransientInteractionCardHandle,
): Promise<void> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(handle.providerMessageId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu recall interaction card failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu recall interaction card failed.");
  }
}

function getFeishuTypingReactionKey(bot: BotConfig, messageId: string): string {
  return `${bot.id}:${messageId}`;
}

export async function addFeishuTypingReaction(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  messageId: string,
): Promise<void> {
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return;
  }
  const key = getFeishuTypingReactionKey(bot, messageId);
  if (typingReactionIds.has(key)) {
    return;
  }
  const response = await fetchBotProviderJson<FeishuReactionResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${messageId}/reactions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        reaction_type: {
          emoji_type: "Typing",
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu add typing reaction failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu add typing reaction failed.");
  }
  if (payload.data?.reaction_id) {
    typingReactionIds.set(key, payload.data.reaction_id);
  }
}

export async function deleteFeishuTypingReaction(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  messageId: string,
): Promise<void> {
  const key = getFeishuTypingReactionKey(bot, messageId);
  const reactionId = typingReactionIds.get(key);
  if (!reactionId) {
    return;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return;
  }
  const response = await fetchBotProviderJson<FeishuReactionResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu delete typing reaction failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu delete typing reaction failed.");
  }
  typingReactionIds.delete(key);
}

export function createFeishuGroupMemberReader(deps: FeishuProviderDeps) {
  const readDirectory = createGroupMemberDirectory();
  const getGroupMemberNames = (bot: BotConfig, chatId: string) => {
    const key = JSON.stringify([
      getFeishuDomainProvider(bot),
      bot.id,
      bot.feishuAppId,
      bot.credentialRef,
      chatId,
    ]);
    return readDirectory(key, async (cursor) => {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) throw new Error("Feishu credentials are unavailable");
      const query = new URLSearchParams({
        member_id_type: "open_id",
        page_size: "100",
      });
      if (cursor) query.set("page_token", cursor);
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: GroupMemberPage;
      }>(
        `${getFeishuBaseUrl(bot)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok || response.payload?.code !== 0 || !response.payload.data)
        throw new Error(response.payload?.msg || "Cannot read group members");
      return response.payload.data;
    });
  };
  return getGroupMemberNames;
}

export function createFeishuInputReactionUpdater(deps: FeishuProviderDeps) {
  const reactionBots = new Map<string, BotConfig>();
  const updateReaction = createGroupInputReactionUpdater(async (key, state) => {
    const [botKey, messageId] = JSON.parse(key) as [string, string];
    const bot = reactionBots.get(botKey)!;
    const token = await readTenantAccessToken(bot, deps);
    if (!token) throw new Error("Feishu reaction credentials unavailable");
    const url = `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const emoji = {
      waiting: "OneSecond",
      working: "OnIt",
      done: "CheckMark",
      failed: "CrossMark",
      cancelled: null,
    }[state];
    const ownedTypes = new Set(["OK", "OneSecond", "OnIt", "CheckMark", "CrossMark"]);
    const obsolete: string[] = [];
    let found = false;
    let cursor = "";
    const cursors = new Set<string>();
    do {
      if (cursors.has(cursor)) throw new Error("Feishu reaction pagination repeated");
      cursors.add(cursor);
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: {
          has_more?: boolean;
          page_token?: string;
          items?: Array<{
            reaction_id: string;
            operator?: { operator_type?: string; operator_id?: string };
            reaction_type?: { emoji_type?: string };
          }>;
        };
      }>(`${url}?page_size=50${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ""}`, {
        method: "GET",
        headers,
      });
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu list reactions failed");
      for (const item of response.payload.data?.items ?? []) {
        // 重启后从平台核对本应用状态，绝不删除群成员或其他机器人的表情。
        if (
          item.operator?.operator_type !== "app" ||
          item.operator.operator_id !== bot.feishuAppId ||
          !ownedTypes.has(item.reaction_type?.emoji_type ?? "")
        )
          continue;
        if (item.reaction_type?.emoji_type === emoji && !found) found = true;
        else obsolete.push(item.reaction_id);
      }
      cursor = response.payload.data?.has_more ? (response.payload.data.page_token ?? "") : "";
      if (response.payload.data?.has_more && !cursor)
        throw new Error("Feishu reaction cursor missing");
    } while (cursor);
    for (const id of obsolete) {
      const response = await fetchBotProviderJson<FeishuReactionResponse>(
        `${url}/${encodeURIComponent(id)}`,
        { method: "DELETE", headers },
      );
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu delete status reaction failed");
    }
    if (emoji && !found) {
      const response = await fetchBotProviderJson<FeishuReactionResponse>(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ reaction_type: { emoji_type: emoji } }),
      });
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu add status reaction failed");
    }
  });
  return async (bot: BotConfig, messageId: string, state: GroupInputReaction): Promise<void> => {
    const botKey = JSON.stringify([bot.provider, bot.id, bot.feishuAppId, bot.credentialRef]);
    reactionBots.set(botKey, bot);
    await updateReaction(JSON.stringify([botKey, messageId]), state);
  };
}

export async function acknowledgeFeishuCallback(
  deps: FeishuProviderDeps,
  bot: BotConfig,
  payload: unknown,
  text: string | undefined,
  message: BotOutboundMessage | undefined,
  signal: AbortSignal | undefined,
) {
  const token = await readTenantAccessToken(bot, deps, signal);
  const cardUpdateToken = readFeishuCardUpdateToken(payload);
  const openIds = readFeishuCardUpdateOpenIds(payload);
  const originalText = readFeishuCardOriginalText(payload);
  if (!token || !cardUpdateToken || (!text?.trim() && !message?.elicitation)) {
    return;
  }
  // Bugfix: 飞书卡片按钮点击后不会像 Telegram inline keyboard 一样自动消失。
  // 使用回调携带的 card update token 更新原卡片为处理结果，避免旧选项继续留在聊天里被重复点击。
  // 非共享卡片延时更新还需要带 open_ids，否则飞书会返回 300090，旧卡片会继续留在会话里。
  // Bugfix: 用户选择后应保留原问题文案并移除按钮；仅依赖 WebSocket 回调 return 的卡片更新不稳定。
  // 因此即使按钮 value 里带了原文，也必须继续调用 card/update，只是更新文案优先使用原文。
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/interactive/v1/card/update`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      signal,
      body: JSON.stringify({
        token: cardUpdateToken,
        // Bugfix: Card JSON 2.0 根节点不接受 open_ids；把 open_ids 塞进 card 会触发
        // “unknown property: open_ids” 并导致按钮点击后原卡片无法移除选项。
        ...(openIds.length > 0 ? { open_ids: openIds } : {}),
        // 修复原因：新建下一题再撤回旧卡会在飞书会话中显示明显的撤回痕迹。
        // callback token 是本次点击对应的权威原地更新能力，问答推进和终态都复用同一张卡。
        card: message?.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload({
              botId: bot.id,
              provider: bot.provider,
              providerUserId: "",
              // Bugfix: 飞书按钮点击后业务结果会另发一条消息；原卡片只需要移除选项按钮。
              // 之前把原卡片改成结果文案，飞书侧会出现额外状态变化，也不符合用户对“选项消失”的预期。
              text: originalText?.trim() || (text ?? ""),
            }),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu update interactive card failed: HTTP ${response.status}`);
  }
  const result = response.payload ?? {};
  if (result.code !== 0) {
    throw new Error(result.msg || "Feishu update interactive card failed.");
  }
  return message?.elicitation ? { handled: true } : undefined;
}

export async function downloadFeishuAttachment(
  deps: FeishuProviderDeps,
  bot: BotConfig,
  attachment: BotInboundAttachment,
  actor: BotInboundMessage["actor"] | undefined,
  signal: AbortSignal | undefined,
) {
  signal?.throwIfAborted();
  const token = await readTenantAccessToken(bot, deps, signal);
  if (!token || !attachment.providerFileId || !actor?.providerMessageId) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(attachment.providerMetadata?.resourceMessageId ?? actor.providerMessageId)}/resources/${encodeURIComponent(attachment.providerFileId)}?type=${attachment.kind === "image" ? "image" : attachment.kind === "video" ? "media" : attachment.kind}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Feishu attachment download failed: HTTP ${response.status}`);
    }
    return {
      attachment,
      data: new Uint8Array(await response.arrayBuffer()),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as { name?: unknown })?.name === "AbortError") {
      // Bugfix: 飞书资源接口偶发长时间不返回，必须让 bot 回调在可预期时间内给用户失败提示。
      throw new Error("Feishu attachment download timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
