import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS,
  botsLogger,
  createOutbound,
  isRecord,
  readNestedString,
  summarizeCallbackPayload,
  webhookSecretEquals,
} from "./botsServiceSupport.js";
import { findBot, findCallbackBot } from "./botConfigHelpers.js";
import { parseBotCommand } from "./commandParser.js";
import { getBotConversationKey } from "./groupSessions.js";
import {
  type BotOutboundMessage,
  type BotProvider,
  type BotProviderCallbackResult,
  isFeishuBotProvider,
} from "@zcode/shared";
import { randomUUID } from "node:crypto";

export function createBotsServiceCallback(ctx: BotsServiceContext) {
  async function processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult> {
    const adapter = ctx.providers[provider];
    if (!adapter) {
      return { ok: false, replies: [], status: 400 };
    }
    const locale = await ctx.readMessageLocale();
    const config = await ctx.repo.readConfig();
    const callbackBot = findCallbackBot(config, provider, payload);
    // 在读取引用附件和处理退群事件之前验证回调，避免未验证事件产生读写副作用。
    if (callbackBot && isFeishuBotProvider(provider) && callbackBot.webhookSecretRef) {
      const expectedToken = await ctx.deps.credentialService.load(callbackBot.webhookSecretRef);
      const header = isRecord(payload) && isRecord(payload.header) ? payload.header : null;
      const inboundToken = isRecord(payload)
        ? (readNestedString(payload, "token") ?? readNestedString(header, "token"))
        : undefined;
      if (!webhookSecretEquals(expectedToken, inboundToken)) {
        return {
          ok: false,
          replies: [],
          status: 401,
          responseBody: { error: ctx.msg(locale, "webhookSecretInvalid") },
        };
      }
    }
    let materialPayload = payload;
    if (callbackBot && isFeishuBotProvider(provider) && isRecord(payload)) {
      const event = isRecord(payload.event) ? payload.event : payload;
      const native = isRecord(event.message) ? event.message : {};
      const chatId = readNestedString(native, "chat_id");
      const threadId = readNestedString(native, "thread_id");
      const topic =
        chatId && threadId
          ? (await ctx.repo.readState()).bots[
              getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId, threadId })
            ]
          : undefined;
      // 根引用属于首次输入，不属于 active 状态；退出再接入不能重复读取它。
      // 只信服务记录，外部回调不能声称已接收来跳过首次材料准备。
      materialPayload = {
        ...payload,
        zcodeTopicHasAcceptedInput: Object.values(topic?.group?.inputs ?? {}).some(
          (input) => input.admission === "accepted",
        ),
      };
    }
    const preparedPayload = callbackBot
      ? ((await adapter
          .prepareCallbackPayload?.(callbackBot, materialPayload)
          .catch((error: unknown) => ({
            zcodeCallbackPrepareError: error instanceof Error ? error.message : String(error),
          }))) ?? payload)
      : payload;
    if (
      isRecord(preparedPayload) &&
      typeof preparedPayload.zcodeCallbackPrepareError === "string"
    ) {
      return {
        ok: false,
        replies: [],
        responseBody: { error: preparedPayload.zcodeCallbackPrepareError },
        status: 401,
      };
    }
    const callbackResponse = callbackBot
      ? await adapter.handleCallbackResponse?.(callbackBot, preparedPayload)
      : null;
    if (callbackResponse?.responseBody !== undefined) {
      return {
        ok: (callbackResponse.status ?? 200) < 400,
        replies: [],
        responseBody: callbackResponse.responseBody,
        status: callbackResponse.status,
      };
    }
    if (
      callbackBot &&
      isFeishuBotProvider(provider) &&
      isRecord(preparedPayload) &&
      preparedPayload.zcodeBotRemoved === true
    ) {
      const event = isRecord(preparedPayload.event) ? preparedPayload.event : preparedPayload;
      const chatId = readNestedString(event, "chat_id");
      if (chatId) {
        const state = (await ctx.repo.readState()).bots[
          getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId })
        ];
        if (state?.group) {
          await ctx.writeContext(
            { ...state, group: { ...state.group, enabled: false, authorizationId: randomUUID() } },
            true,
          );
          await ctx.cancelGroupTopicInputs({
            botId: callbackBot.id,
            provider: callbackBot.provider,
            chatType: "group",
            chatId,
            providerUserId: state.group.ownerId,
          });
        }
      }
      return { ok: true, replies: [] };
    }
    let parsePayload =
      isFeishuBotProvider(provider) && isRecord(preparedPayload)
        ? { ...preparedPayload, zcodeProvider: provider }
        : preparedPayload;
    if (callbackBot && isFeishuBotProvider(provider) && isRecord(parsePayload)) {
      const event = isRecord(parsePayload.event) ? parsePayload.event : parsePayload;
      const cardContext = isRecord(event.context) ? event.context : null;
      const cardChatId =
        readNestedString(cardContext, "open_chat_id") ?? readNestedString(cardContext, "chat_id");
      if (cardChatId) {
        const states = await ctx.repo.readState();
        const group =
          states.bots[
            getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId: cardChatId })
          ];
        if (group?.group) parsePayload = { ...parsePayload, zcodeChatType: "group" };
      }
    }
    const parsedInboundMessages = adapter.parseCallback(parsePayload);
    if (isFeishuBotProvider(provider)) {
      // Bugfix: 飞书 WebSocket connected 只代表长连接已建成，不代表事件订阅已经推到本机。
      // 这里记录入口 payload 摘要和解析数量，方便区分“飞书未推事件”和“payload 形状未被解析”。
      botsLogger.debug(
        undefined,
        `provider callback parsed provider=${provider} count=${parsedInboundMessages.length} ${summarizeCallbackPayload(preparedPayload)}`,
      );
    }
    const replies: BotOutboundMessage[] = [];
    let hadBusinessFailure = false;
    const inboundSecret =
      isRecord(preparedPayload) && typeof preparedPayload.webhookSecret === "string"
        ? preparedPayload.webhookSecret
        : undefined;
    for (const inbound of parsedInboundMessages) {
      const bot = findBot(config, inbound.botId);
      if (bot?.provider === "webhook" && bot.webhookSecretRef) {
        const expectedSecret = await ctx.deps.credentialService.load(bot.webhookSecretRef);
        if (expectedSecret && !webhookSecretEquals(expectedSecret, inboundSecret)) {
          replies.push(createOutbound(inbound.actor, ctx.msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
      if (bot && isFeishuBotProvider(bot.provider) && bot.webhookSecretRef) {
        const expectedToken = await ctx.deps.credentialService.load(bot.webhookSecretRef);
        const payloadHeader =
          isRecord(preparedPayload) && isRecord(preparedPayload.header)
            ? preparedPayload.header
            : null;
        const inboundToken =
          isRecord(preparedPayload) && typeof preparedPayload.token === "string"
            ? preparedPayload.token
            : typeof payloadHeader?.token === "string"
              ? payloadHeader.token
              : undefined;
        if (expectedToken && !webhookSecretEquals(expectedToken, inboundToken)) {
          replies.push(createOutbound(inbound.actor, ctx.msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
      let inboundMessage = inbound;
      if (bot && !inbound.actor.displayName && adapter.resolveActorDisplayName) {
        try {
          const displayName = await adapter.resolveActorDisplayName(bot, inbound.actor);
          if (displayName?.trim()) {
            inboundMessage = {
              ...inbound,
              actor: {
                ...inbound.actor,
                displayName: displayName.trim(),
              },
            };
          }
        } catch (error) {
          // Bugfix: 飞书 displayName 需要额外通讯录权限，权限缺失时不能阻断消息处理和绑定。
          botsLogger.debug(
            undefined,
            `resolve actor displayName failed provider=${provider} bot=${inbound.botId} user=${inbound.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!ctx.markInboundDelivery(inboundMessage)) {
        botsLogger.debug(
          undefined,
          `provider callback duplicated provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
        );
        continue;
      }
      botsLogger.debug(
        undefined,
        `provider callback provider=${provider} bot=${inboundMessage.botId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
      );
      // 回调失败和重连也走相同的话题提醒规则，保留 Provider 核验的提及事实。
      inboundMessage = {
        ...inboundMessage,
        actor: { ...inboundMessage.actor, mentionedBot: inboundMessage.mentionedBot === true },
      };
      let outbound: BotOutboundMessage[];
      let reconnectStartingReply: BotOutboundMessage | null = null;
      let inboundBusinessFailure = false;
      try {
        const command = parseBotCommand(inboundMessage.commandText ?? inboundMessage.text);
        if (bot && inboundMessage.senderType !== "app" && command.type === "reconnect") {
          outbound = await ctx.handleReconnect(inboundMessage, {
            onReconnectStart: async (auth) => {
              reconnectStartingReply = createOutbound(
                inboundMessage.actor,
                ctx.msg(auth.locale, "remoteReconnectStarting", {
                  workspacePath: auth.context.workspacePath,
                }),
              );
              await ctx.sendOutbound(bot, reconnectStartingReply);
            },
          });
        } else {
          outbound = await ctx.service.handleInboundMessage(inboundMessage);
        }
      } catch (error) {
        ctx.releaseInboundDelivery(inboundMessage);
        hadBusinessFailure = true;
        inboundBusinessFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        const userFacingMessage = ctx.formatUserFacingBotError(error, locale);
        botsLogger.warn(
          undefined,
          `provider callback failed provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId}: ${message}`,
        );
        outbound = [
          ctx.administratorErrorReply(
            inboundMessage.actor,
            bot,
            error,
            createOutbound(
              inboundMessage.actor,
              ctx.isSessionExpiredError(error)
                ? userFacingMessage
                : ctx.msg(locale, "callbackFailed", { message: userFacingMessage }),
            ),
          ),
        ];
      }
      if (reconnectStartingReply) {
        replies.push(reconnectStartingReply);
      }
      replies.push(...outbound);
      if (inboundBusinessFailure) {
        // Bugfix：错误提示发送成功不等于业务消息已经消费成功。此处不能执行 callback ACK，
        // 否则飞书会移除按钮；最终 ok=false 也会阻止 Telegram/微信提交外部游标。
        if (bot) {
          for (const outboundMessage of outbound) {
            await ctx.sendOutbound(bot, outboundMessage).catch((sendError) => {
              botsLogger.warn(
                undefined,
                `provider callback failure notice failed provider=${provider} bot=${bot.id}: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
              );
            });
          }
          await ctx.stopInboundTyping(bot, inboundMessage.actor).catch(() => undefined);
        }
        continue;
      }
      if (bot) {
        const transientCard = ctx.transientInteractionCards.get(
          ctx.getActorContextKey(inboundMessage.actor),
        );
        const handledByFeishuSynchronousCardAction =
          isFeishuBotProvider(provider) &&
          isRecord(preparedPayload) &&
          ((preparedPayload.zcodeFeishuSynchronousCardAction === true &&
            !(
              isRecord(preparedPayload.zcodeFeishuCardResponseState) &&
              preparedPayload.zcodeFeishuCardResponseState.deferred === true
            ) &&
            Boolean(outbound[0])) ||
            (inboundMessage.groupCardAction === true && outbound[0]?.callbackToastOnly === true));
        // Bugfix: 只做空 ACK 会让 Telegram 顶部 loading 消失但没有任何可见反馈。
        // 这里在业务处理后把结果写进 answerCallbackQuery 的 toast，即使后续 sendMessage 失败，用户也能看到按钮结果。
        const callbackText = outbound[0]?.text ?? ctx.msg(locale, "received");
        let acknowledgeResult:
          | Awaited<ReturnType<NonNullable<typeof adapter.acknowledgeCallback>>>
          | undefined;
        const acknowledgeController = new AbortController();
        const acknowledgeTimeout = setTimeout(() => {
          acknowledgeController.abort(
            new Error(
              `Bot provider callback acknowledgement timed out after ${BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS}ms.`,
            ),
          );
        }, BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS);
        try {
          acknowledgeResult = await Promise.race([
            handledByFeishuSynchronousCardAction || (transientCard && !outbound[0]?.elicitation)
              ? Promise.resolve(undefined)
              : adapter.acknowledgeCallback?.(
                  bot,
                  preparedPayload,
                  callbackText,
                  outbound[0],
                  acknowledgeController.signal,
                ),
            new Promise<never>((_resolve, reject) => {
              acknowledgeController.signal.addEventListener(
                "abort",
                () => reject(acknowledgeController.signal.reason),
                { once: true },
              );
            }),
          ]);
        } catch (error) {
          // 修复原因：飞书第二题原本必须等待 card/update 完成；credential 或 SDK 内部
          // 任一步骤悬挂都会压住 fallback。主流程自己设 deadline，超时后立即另发下一题。
          botsLogger.warn(
            undefined,
            `provider callback acknowledge failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearTimeout(acknowledgeTimeout);
        }
        const callbackHandledByCardUpdate =
          handledByFeishuSynchronousCardAction || acknowledgeResult?.handled === true;
        const administratorNotice = outbound.find(
          (reply) => reply.callbackToastOnly && reply.administratorAttention,
        );
        if (callbackHandledByCardUpdate && administratorNotice) {
          await ctx.sendOutbound(bot, {
            ...administratorNotice,
            callbackToastOnly: undefined,
            administratorAttention: undefined,
          });
        }
        if (
          !handledByFeishuSynchronousCardAction &&
          callbackHandledByCardUpdate &&
          transientCard &&
          outbound[0]?.elicitation
        ) {
          // 修复原因：真实飞书日志确认 card/update 返回成功后客户端仍可能停在旧题。
          // callback token 负责点击 ACK，随后再 PATCH 同一 message_id 强制刷新可见结构；
          // 两次写入始终指向同一张卡，禁止退回“新建后撤回”的闪烁方案。
          await ctx.providers[transientCard.bot.provider]
            ?.updateTransientInteractionCard?.(transientCard.bot, transientCard.handle, outbound[0])
            .catch((error) => {
              // 业务回答已被 Agent 接受且 callback token 已完成 ACK，PATCH 失败不能让
              // Telegram/微信式外部游标重试整次回答，否则会重复提交同一交互。
              botsLogger.warn(
                undefined,
                `refresh transient interaction card failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        if (
          callbackHandledByCardUpdate &&
          transientCard &&
          !outbound[0]?.callbackToastOnly &&
          outbound[0]?.elicitation?.status !== "pending"
        ) {
          // 修复原因：card_update_token 已把同一消息更新为只读终态，此时只释放内存句柄，
          // 不能再 PATCH、DELETE 或另发结果卡。
          ctx.transientInteractionCards.delete(ctx.getActorContextKey(inboundMessage.actor));
        }
        // Bugfix: /reconnect 的“正在重连”必须在 ensureConnected 前实时发送。
        // handleReconnect 只返回最终结果，避免重连完成后才把过期的开始状态一起吐给用户。
        try {
          for (const outboundMessage of callbackHandledByCardUpdate ? [] : outbound) {
            if (transientCard && !outboundMessage.callbackToastOnly) {
              if (outboundMessage.selection || outboundMessage.elicitation?.status === "pending") {
                await ctx.upsertTransientInteractionCard(
                  bot,
                  inboundMessage.actor,
                  transientCard.taskId,
                  outboundMessage,
                );
                continue;
              }
              if (
                outboundMessage.elicitation ||
                /^\/(?:approve|deny)(?:\s|$)/u.test(inboundMessage.text)
              ) {
                await ctx.finalizeTransientInteractionCard(inboundMessage.actor, outboundMessage);
                continue;
              }
            }
            await ctx.sendOutbound(bot, outboundMessage);
          }
          await ctx.stopInboundTyping(bot, inboundMessage.actor);
        } catch (error) {
          ctx.releaseInboundDelivery(inboundMessage);
          throw error;
        }
      }
    }
    return {
      ok: !hadBusinessFailure,
      replies,
      ...(hadBusinessFailure ? { status: 503 } : {}),
    };
  }

  return {
    processProviderCallback,
  };
}
