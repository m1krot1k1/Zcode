import type { PreparedBotMessageContent } from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  BOT_MAX_ATTACHMENTS_PER_MESSAGE,
  BOT_MAX_ATTACHMENT_SIZE_BYTES,
} from "./botsServiceSupport.js";
import { getAppConfigDir } from "../paths.js";
import { type BotMessageId, formatBotMessage } from "./messages.js";
import type {
  BotActor,
  BotConfig,
  BotInboundAttachment,
  BotInboundMessage,
  BotOutboundMessage,
  Locale,
  ZCodePromptAttachment,
} from "@zcode/shared";
import { BotAdminRequiredError } from "#src/bots/groupAdminAttention.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function createBotsServiceReply(ctx: BotsServiceContext) {
  function administratorReply(
    actor: BotActor,
    bot: Pick<BotConfig, "providerUserId">,
    reason: string,
    reply: BotOutboundMessage,
  ): BotOutboundMessage {
    if (actor.chatType !== "group") return reply;
    const mentionedUserIds = ctx.adminAttention.mention(actor, bot.providerUserId, reason);
    return { ...reply, mentionedUserIds, administratorAttention: !!mentionedUserIds?.length };
  }

  function administratorErrorReply(
    actor: BotActor,
    bot: BotConfig | null | undefined,
    error: unknown,
    reply: BotOutboundMessage,
  ): BotOutboundMessage {
    if (!bot || actor.chatType !== "group" || !(error instanceof BotAdminRequiredError))
      return reply;
    const hint =
      error.reason === "model"
        ? ctx.cachedLocale === "en-US"
          ? "Please check this conversation's model configuration."
          : "请机器人管理员检查当前会话的模型配置。"
        : undefined;
    return administratorReply(
      actor,
      bot,
      error.reason,
      hint ? { ...reply, text: `${reply.text}\n\n${hint}` } : reply,
    );
  }

  async function readMessageLocale(): Promise<Locale | undefined> {
    const settings = await ctx.deps.settingService?.get().catch(() => null);
    ctx.cachedLocale = settings?.locale ?? ctx.cachedLocale;
    return ctx.cachedLocale;
  }

  function msg(
    locale: Locale | undefined,
    id: BotMessageId,
    values?: Record<string, string | number | undefined>,
  ): string {
    return formatBotMessage(locale, id, values);
  }

  function isSessionExpiredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  function formatUserFacingBotError(error: unknown, locale: Locale | undefined): string {
    // Bugfix: 旧 bot 消息或脏 task index 会让协议层抛出 Session not found。
    // 直接把 session id 发给用户不可操作；这里保留日志原文，只引导用户新建任务恢复。
    if (isSessionExpiredError(error)) {
      return msg(locale, "sessionExpiredNewTaskHint");
    }
    return error instanceof Error ? error.message : String(error);
  }

  function sanitizeAttachmentFilename(filename: string): string {
    const normalized = Array.from(filename.trim())
      .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char))
      .join("");
    return normalized.length > 0 ? normalized.slice(0, 160) : "attachment";
  }

  function formatAttachmentSize(sizeBytes: number | undefined): string {
    if (!sizeBytes || sizeBytes <= 0) {
      return "unknown size";
    }
    if (sizeBytes >= 1024 * 1024) {
      return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    if (sizeBytes >= 1024) {
      return `${Math.ceil(sizeBytes / 1024)}KB`;
    }
    return `${sizeBytes}B`;
  }

  function formatAttachmentRejectedReason(error: unknown, locale: Locale | undefined): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/exceeds 5MB/i.test(message)) {
      return msg(locale, "attachmentTooLarge");
    }
    if (
      /attachment download failed/i.test(message) ||
      /file download failed/i.test(message) ||
      /download .+ failed: HTTP/i.test(message) ||
      /file download timed out/i.test(message) ||
      /attachment download timed out/i.test(message) ||
      /download .+ timed out/i.test(message)
    ) {
      // Bugfix: provider 下载错误会包含 Feishu/Telegram/HTTP 等内部细节，直接回给用户既不友好也不可行动。
      return msg(locale, "attachmentDownloadUnavailable");
    }
    return message;
  }

  function buildAttachmentCachePath(params: {
    botId: string;
    providerMessageId?: string;
    attachment: BotInboundAttachment;
  }): string {
    const messageKey = params.providerMessageId?.trim() || `message-${Date.now()}`;
    const digest = createHash("sha256")
      .update(`${params.botId}:${messageKey}:${params.attachment.id}`)
      .digest("hex")
      .slice(0, 16);
    return join(
      getAppConfigDir(),
      "bot-attachments",
      sanitizeAttachmentFilename(params.botId),
      sanitizeAttachmentFilename(messageKey),
      `${digest}-${sanitizeAttachmentFilename(params.attachment.filename)}`,
    );
  }

  async function fetchAttachmentDownloadUrl(
    attachment: BotInboundAttachment,
  ): Promise<Uint8Array | null> {
    if (!attachment.downloadUrl) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(attachment.downloadUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`download ${attachment.filename} failed: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if ((error as { name?: unknown })?.name === "AbortError") {
        // Bugfix: 附件下载卡住时必须尽快失败并回复用户，不能让 bot 回调一直悬挂。
        throw new Error(`download ${attachment.filename} timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveAttachmentBytes(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    actor: BotActor,
  ): Promise<{ attachment: BotInboundAttachment; data: Uint8Array } | null> {
    if (attachment.dataBase64) {
      return {
        attachment,
        data: Buffer.from(attachment.dataBase64, "base64"),
      };
    }
    if (attachment.localPath) {
      return {
        attachment,
        data: await readFile(attachment.localPath),
      };
    }
    const provider = ctx.providers[bot.provider];
    const downloaded = await provider?.downloadAttachment?.(bot, attachment, actor);
    if (downloaded) {
      return downloaded;
    }
    const fromUrl = await fetchAttachmentDownloadUrl(attachment);
    return fromUrl ? { attachment, data: fromUrl } : null;
  }

  async function cacheResolvedAttachment(params: {
    bot: BotConfig;
    message: BotInboundMessage;
    attachment: BotInboundAttachment;
    data: Uint8Array;
  }): Promise<BotInboundAttachment> {
    const localPath = buildAttachmentCachePath({
      botId: params.bot.id,
      providerMessageId: params.message.actor.providerMessageId,
      attachment: params.attachment,
    });
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, params.data);
    return {
      ...params.attachment,
      localPath,
      sizeBytes: params.data.byteLength,
    };
  }

  async function prepareBotMessageContent(
    bot: BotConfig,
    message: BotInboundMessage,
    locale: Locale | undefined,
  ): Promise<PreparedBotMessageContent> {
    const isGroup = message.actor.chatType === "group";
    if (isGroup && (message.attachments?.length ?? 0) > BOT_MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(
        locale === "en-US"
          ? "Attach at most 4 files per message."
          : "每条消息最多提交 4 个附件，请拆分后发送。",
      );
    }
    const rawAttachments = (message.attachments ?? []).slice(0, BOT_MAX_ATTACHMENTS_PER_MESSAGE);
    const zcodeAttachments: ZCodePromptAttachment[] = [];
    const fileLines: string[] = [];
    for (const rawAttachment of rawAttachments) {
      const resolved = await resolveAttachmentBytes(bot, rawAttachment, message.actor);
      if (!resolved) {
        if (isGroup) throw new Error("attachment download failed");
        fileLines.push(
          `附件：${rawAttachment.filename} (${rawAttachment.mimeType}, ${formatAttachmentSize(rawAttachment.sizeBytes)})，未能下载。`,
        );
        continue;
      }
      if (resolved.data.byteLength > BOT_MAX_ATTACHMENT_SIZE_BYTES) {
        throw new Error(`${resolved.attachment.filename} exceeds 5MB.`);
      }
      const cached = await cacheResolvedAttachment({
        bot,
        message,
        attachment: resolved.attachment,
        data: resolved.data,
      });
      const dataBase64 = Buffer.from(resolved.data).toString("base64");
      if (isGroup) {
        // 旧兼容入口只把文件路径拼进正文，既丢失 V4 附件又破坏末尾引用块；群输入只走标准寄存。
        zcodeAttachments.push({
          kind: cached.kind === "image" || cached.kind === "audio" ? cached.kind : "file",
          filename: cached.filename,
          mimeType: cached.mimeType,
          sizeBytes: resolved.data.byteLength,
          dataBase64,
          localPath: cached.localPath,
        });
        continue;
      }
      if (cached.kind === "image" || cached.kind === "audio") {
        zcodeAttachments.push({
          kind: cached.kind,
          filename: cached.filename,
          mimeType: cached.mimeType,
          dataBase64,
          // Bugfix：Bot 已把附件缓存到本地，ZCodePromptAttachment 也必须携带该路径。
          // 只在 prompt 文本里描述路径会让下游附件策略无法选择本地文件读取。
          localPath: cached.localPath,
        });
        // Bugfix: bot 附件已经被 gateway 下载并缓存到本地。只把图片作为 ZCode Agent image block 传入时，
        // 下游 agent 可能把内部临时 URL 再 curl 到 /tmp，导致重复下载、额外权限请求和模型安全拦截。
        // 因此同时把本地缓存路径写进 prompt，明确后续工具操作只能围绕本地文件进行。
        fileLines.push(
          `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已作为${cached.kind === "image" ? "图片" : "音频"}输入提供，并保存到：${cached.localPath}。如需读取附件，请直接使用这个本地路径，不要下载或访问临时/远程 URL。`,
        );
        continue;
      }
      fileLines.push(
        `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已保存到：${cached.localPath}`,
      );
    }
    const trimmed = message.text.trim();
    const baseContent =
      trimmed || (rawAttachments.length > 0 ? msg(locale, "attachmentOnlyPrompt") : "");
    return {
      content: [baseContent, ...fileLines].filter(Boolean).join("\n\n"),
      zcodeAttachments,
    };
  }

  return {
    administratorReply,
    administratorErrorReply,
    readMessageLocale,
    msg,
    isSessionExpiredError,
    formatUserFacingBotError,
    sanitizeAttachmentFilename,
    formatAttachmentSize,
    formatAttachmentRejectedReason,
    buildAttachmentCachePath,
    fetchAttachmentDownloadUrl,
    resolveAttachmentBytes,
    cacheResolvedAttachment,
    prepareBotMessageContent,
  };
}
