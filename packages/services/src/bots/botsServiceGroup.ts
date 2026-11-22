import type { PreparedBotMessageContent, PreparedTopicMessage } from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import { botsLogger, createOutbound } from "./botsServiceSupport.js";
import { findBot } from "./botConfigHelpers.js";
import { getBotConversationKey, getBotStateKey } from "./groupSessions.js";
import {
  type BotConfig,
  type BotContextState,
  type BotGroupInputStatus,
  type BotInboundMessage,
  type BotOutboundMessage,
  type Locale,
  type ZCodePromptAttachment,
  isFeishuBotProvider,
} from "@zcode/shared";
import { botGroupCommandId } from "#src/bots/topicHistoryAttachment.js";

export function createBotsServiceGroup(ctx: BotsServiceContext) {
  function historyGeneration(context: BotContextState): string {
    const groupKey = JSON.stringify([context.botId, context.group?.chatId]);
    return `${ctx.botHistoryEpoch.get(context.botId) ?? 0}:${ctx.groupHistoryEpoch.get(groupKey) ?? 0}:${context.group?.backgroundHistory?.revision ?? ""}`;
  }

  async function prepareGroupTopicHistory(
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
  ) {
    const messageId = message.actor.providerMessageId!;
    if (!context.group) return {};
    let topicContext: import("@zcode/shared").BotTopicHistoryBatch | undefined;
    let historyError: unknown;

    const generation = historyGeneration(context);
    // 在异步读历史之前固定 revision，不能把等待期间的新背景误当成本轮已读。
    const backgroundRevision = context.group.backgroundHistory?.revision;
    let historyDisabled = false;
    const inputThreadId = message.actor.threadId ?? context.group.threadId;
    const inputRootMessageId = message.actor.rootMessageId ?? context.group.rootMessageId;
    if (inputThreadId) {
      const parent = (await ctx.repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: context.group.chatId,
        })
      ];
      historyDisabled = parent?.group?.historyEnabled === false;
      if (!historyDisabled && ctx.topicHistoryReady.get(getBotStateKey(context)) !== generation) {
        const accepted = Object.values(context.group.inputs ?? {}).filter(
          (input) => input.admission === "accepted" && input.source.threadId === inputThreadId,
        );
        const checkpoint = context.group.backgroundHistory
          ? context.group.backgroundHistory.checkpoint
          : accepted.at(-1)?.source.messageId;
        try {
          const reader = ctx.providers[bot.provider]?.readTopicHistory;
          if (!reader || !inputRootMessageId) throw new Error("Topic history reader unavailable");
          topicContext = await reader(bot, {
            chatId: context.group.chatId,
            threadId: inputThreadId,
            rootMessageId: inputRootMessageId,
            messageId,
            checkpoint,
          });
          const ingested = new Set(
            accepted.flatMap(
              (input) =>
                input.source.messages?.map((original) => original.messageId) ?? [
                  input.source.messageId,
                ],
            ),
          );
          topicContext.messages = topicContext.messages.filter(
            (item) => !ingested.has(item.id) && item.id !== message.referencedMessage?.messageId,
          );
        } catch (error) {
          botsLogger.warn(
            undefined,
            `topic history preparation failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // 读取失败必须阻止提交，不能用缺口附件替代必需历史后启动任务。
          topicContext = undefined;
          historyError = error || new Error("Topic history unavailable");
        }
      }
    }
    return {
      topicContext,
      historyError,
      historyDisabled,
      generation,
      backgroundRevision,
    };
  }

  async function submitGroupMessage(
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
    prepared: PreparedBotMessageContent,
    locale: Locale | undefined,
    history: Awaited<ReturnType<typeof prepareGroupTopicHistory>>,
    topicBatch?: PreparedTopicMessage[],
    isCurrent = () => true,
  ): Promise<BotOutboundMessage[]> {
    if (!context.group || !context.activeTaskId || !isFeishuBotProvider(bot.provider))
      throw new Error("Group context is missing");
    const service = await ctx.resolveZCodeTaskServiceForContext(context);
    if (!service.submitBotGroupInput)
      throw new Error("Runtime does not support group input admission");
    const messageId = message.actor.providerMessageId;
    if (!messageId) throw new Error("Group message ID is required");
    const commandId = botGroupCommandId(bot.id, context.group.chatId, messageId);
    const { topicContext } = history;
    const inputThreadId = message.actor.threadId ?? context.group.threadId;
    const inputRootMessageId = message.actor.rootMessageId ?? context.group.rootMessageId;
    // 历史/附件准备期间控制通道可以停用群；不能用准备前的授权继续提交。
    const admissionContext = (await ctx.repo.readState()).bots[getBotStateKey(context)];
    const admissionBot = findBot(await ctx.repo.readConfig(), bot.id);
    if (
      !admissionContext?.group?.enabled ||
      !admissionBot?.enabled ||
      admissionContext.group.ownerId !== admissionBot.providerUserId ||
      admissionContext.group.authorizationId !== context.group.authorizationId ||
      admissionContext.activeTaskId !== context.activeTaskId
    )
      throw new Error("Group authorization changed before input admission");
    let attachmentOffset = 0;
    const admittedAttachments: ZCodePromptAttachment[] = [];
    // 多个回调可能在首次接收前已各自准备根引用；提交时再按权威记录去重。
    let rootIncluded = Object.values(admissionContext.group.inputs ?? {}).some(
      (input) => input.admission === "accepted",
    );
    const messages = topicBatch?.map(({ message: original, prepared: material }) => {
      const quote = original.referencedMessage;
      const isRoot = !!inputRootMessageId && quote?.messageId === inputRootMessageId;
      const includeQuote = quote && !(isRoot && rootIncluded);
      const attachmentIndexes: number[] = [];
      let hasRootAttachment = false;
      material.zcodeAttachments.forEach((attachment, index) => {
        const resourceMessageId =
          original.attachments?.[index]?.providerMetadata?.resourceMessageId;
        const rootAttachment = !!inputRootMessageId && resourceMessageId === inputRootMessageId;
        hasRootAttachment ||= rootAttachment;
        // 根引用可能在上一轮接收前就已下载；提交时同时去重资源，不能只隐藏引用正文。
        if (rootAttachment && rootIncluded) return;
        attachmentIndexes.push(admittedAttachments.length);
        admittedAttachments.push(attachment);
      });
      attachmentOffset += material.zcodeAttachments.length;
      if ((isRoot && includeQuote) || hasRootAttachment) rootIncluded = true;
      return {
        messageId: original.actor.providerMessageId!,
        senderId: original.actor.providerUserId,
        mentionedBot: original.mentionedBot === true,
        contentParts: original.contentParts,
        senderName: original.actor.displayName ?? original.actor.providerUserId,
        text: original.text,
        ...(includeQuote ? { conversationQuotes: [quote] } : {}),
        attachmentIndexes,
      };
    });
    // 历史文本附件在各条原始附件之后追加，保留它且不归给后续消息。
    if (topicBatch) admittedAttachments.push(...prepared.zcodeAttachments.slice(attachmentOffset));
    const source = {
      authorizationId: context.group.authorizationId,
      botIdentity: { name: bot.name, ...(message.botOpenId ? { openId: message.botOpenId } : {}) },
      provider: bot.provider,
      botId: bot.id,
      chatId: context.group.chatId,
      threadId: inputThreadId,
      rootMessageId: inputRootMessageId,
      appId: bot.feishuAppId,
      contentParts: message.contentParts,
      senderId: message.actor.providerUserId,
      mentionedBot: message.mentionedBot === true,
      senderName: message.actor.displayName ?? message.actor.providerUserId,
      messageId,
      ...(messages ? { messages } : {}),
      ...(topicContext ? { topicContext } : {}),
    };
    const isFirstTaskInput = !Object.values(context.group.inputs ?? {}).some(
      (input) => input.taskId === context.activeTaskId,
    );
    context.group = {
      ...context.group,
      inputs: {
        ...context.group.inputs,
        [commandId]: { taskId: context.activeTaskId, source, admission: "pending" },
      },
    };
    await ctx.writeContext(context);
    await ctx.watchTaskStream(bot, message.actor, context, {
      ...bot,
      replyMode: "summary_changes",
    });
    // 原文已经寄存为文本附件；不能再通过来源元信息把整份历史塞进 command frame。
    const { topicContext: archive, ...runtimeSource } = source;
    if (!isCurrent()) return [];
    const ack = await service.submitBotGroupInput({
      taskId: context.activeTaskId,
      commandId,
      content: prepared.content,
      ...(topicBatch
        ? {
            conversationQuotes: messages?.flatMap((entry) => entry.conversationQuotes ?? []) ?? [],
          }
        : message.referencedMessage
          ? { conversationQuotes: [message.referencedMessage] }
          : {}),
      attachments: topicBatch ? admittedAttachments : prepared.zcodeAttachments,
      source: {
        ...runtimeSource,
        ...(archive
          ? {
              topicHistory: {
                checkpoint: archive.checkpoint,
                hasGap: archive.hasGap,
                messageCount: archive.messages.length,
                resourceMessages: archive.messages
                  .filter((record) => record.attachments?.length)
                  .map((record) => ({ messageId: record.id, count: record.attachments!.length })),
              },
            }
          : {}),
      },
    });
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      context.group.inputs![commandId]!.admission = "rejected";
      await ctx.writeContext(context, false, context.activeTaskId);
      throw new Error(ack.message ?? ack.reasonCode ?? "Input rejected");
    }
    if (ack.result?.type !== "inputAccepted") throw new Error("Input admission outcome is unknown");
    ctx.adminAttention.clear(message.actor, bot.providerUserId);
    context.group.inputs![commandId]!.admission = "accepted";
    if (context.group.threadId) context.group.topicActive = true;
    await ctx.writeContext(context, false, context.activeTaskId);
    if (context.group.threadId && isCurrent() && history.generation) {
      ctx.topicHistoryReady.set(getBotStateKey(context), history.generation);
    }
    if (context.group.threadId && isCurrent()) {
      await ctx.serializeStateWrite(async () => {
        const state = await ctx.repo.readState();
        const current = state.bots[getBotStateKey(context)];
        if (current?.group && isCurrent()) {
          current.group.topicActive = true;
          // 只清除本轮已补读且没有被新背景替换的检查点；准备期间来的背景留给下一轮。
          if (
            history.topicContext &&
            history.backgroundRevision &&
            current.group.backgroundHistory?.revision === history.backgroundRevision
          ) {
            delete current.group.backgroundHistory;
            ctx.topicHistoryReady.set(getBotStateKey(current), historyGeneration(current));
          }
        }
        for (const candidate of Object.values(state.bots)) {
          if (candidate.botId === bot.id && candidate.group?.chatId === context.group!.chatId) {
            delete candidate.group.topicAliases?.[context.group!.threadId!];
          }
        }
        await ctx.repo.writeState(state);
      });
    }
    if (isFirstTaskInput && service.renameTask) {
      await service
        .renameTask({
          taskId: context.activeTaskId,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          title: `${bot.provider === "lark" ? "Lark" : "飞书"} · ${context.group.name}${context.group.threadId ? ` · ${context.group.topicTitle || context.group.threadId}` : ""}`,
        })
        .catch((error: unknown) => {
          // 输入已经被 CLI 接受，标题写入失败不能释放去重并重新执行输入。
          botsLogger.warn(
            undefined,
            `persist group task title failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    await updateGroupInputReaction(
      bot,
      context,
      messageId,
      ack.result.delivery === "queue" ? "waiting" : "working",
    );
    const replies =
      ack.result.delivery === "queue" && !context.group?.threadId
        ? [
            createOutbound(
              message.actor,
              locale === "en-US" ? "Waiting to run" : "等待执行",
              {
                id: `queue-${commandId}`,
                title: locale === "en-US" ? "Queued" : "已排队",
                action: "queue.cancel",
                showCancel: false,
                options: [
                  {
                    id: `/queue-cancel ${commandId}`,
                    label: locale === "en-US" ? "Cancel" : "取消",
                  },
                ],
              },
              { locale, groupSourceCommandId: commandId, groupTaskId: context.activeTaskId },
            ),
          ]
        : [];
    return replies;
  }

  async function updateGroupInputReaction(
    bot: BotConfig,
    context: BotContextState,
    messageId: string | undefined,
    state: BotGroupInputStatus,
  ): Promise<void> {
    if (!messageId) return;
    try {
      const entry = Object.entries(context.group?.inputs ?? {}).find(
        ([, input]) => input.source.messageId === messageId,
      );
      const inputId = entry?.[0];
      if (inputId && context.group) {
        await ctx.queueCards
          .update(
            JSON.stringify([
              bot.id,
              context.group.chatId,
              context.activeTaskId,
              context.group.authorizationId,
              inputId,
              context.group.threadId,
            ]),
            state,
          )
          .catch((error) => {
            botsLogger.warn(
              undefined,
              `queue card update failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      // CLI 终态可能早于 admission ACK；表情必须采用保存后的单向状态。
      if (inputId) {
        const latest = (await ctx.repo.readState()).bots[getBotStateKey(context)];
        state = latest?.group?.inputs?.[inputId]?.progress?.status ?? state;
      }
      // 合批只合并执行，表情仍属于每条原消息，不能只更新最后一条。
      const messageIds = entry?.[1].source.messages?.map((message) => message.messageId) ?? [
        messageId,
      ];
      await Promise.all(
        messageIds.map((originalId) =>
          ctx.providers[bot.provider]?.updateInputReaction?.(
            bot,
            originalId,
            state === "stopped" || state === "discarded" ? "cancelled" : state,
          ),
        ),
      );
    } catch (error) {
      // 表情只是状态投影；平台失败不能把已接受输入变成失败或触发重跑。
      botsLogger.warn(
        undefined,
        `group input reaction update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function cancelGroupInput(
    message: BotInboundMessage,
    sourceCommandId: string,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const group = auth.context.group;
    const input = group?.inputs?.[sourceCommandId];
    // 旧话题排队卡可能仍留在飞书，不能让它操作新话题的停止续接输入。
    if (group?.threadId) {
      return [
        {
          ...createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "This topic queue card has expired. Use /stop to stop the topic."
              : "该话题排队卡已失效，请使用 /stop 停止话题。",
          ),
          callbackToastOnly: true,
        },
      ];
    }
    if (
      !group ||
      !input ||
      input.taskId !== auth.context.activeTaskId ||
      (message.actor.providerUserId !== group.ownerId &&
        input.source.senderId !== message.actor.providerUserId)
    ) {
      return [
        {
          ...(group && input && input.taskId === auth.context.activeTaskId
            ? ctx.administratorReply(
                message.actor,
                auth.bot,
                `queue-cancel:${sourceCommandId}`,
                createOutbound(message.actor, ctx.msg(auth.locale, "groupOwnerOnly")),
              )
            : createOutbound(message.actor, ctx.msg(auth.locale, "groupOwnerOnly"))),
          callbackToastOnly: true,
        },
      ];
    }
    const taskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
    if (!taskService.cancelBotGroupInput) throw new Error("Runtime cannot cancel queued input");
    const ack = await taskService.cancelBotGroupInput({
      taskId: input.taskId,
      commandId: `cancel-${sourceCommandId}-${message.actor.providerMessageId}`,
      sourceCommandId,
      actorId: message.actor.providerUserId,
      ownerId: group.ownerId,
      botId: auth.bot.id,
      chatId: group.chatId,
    });
    const accepted = ack.status === "accepted" || ack.status === "duplicate";
    if (accepted)
      await updateGroupInputReaction(auth.bot, auth.context, input.source.messageId, "cancelled");
    return [
      createOutbound(
        message.actor,
        accepted
          ? auth.locale === "en-US"
            ? "Queued input cancelled."
            : "已取消该排队输入。"
          : auth.locale === "en-US"
            ? "Input changed or started; cancellation was not applied."
            : "输入已变化或开始执行，未取消。",
      ),
    ];
  }

  return {
    historyGeneration,
    prepareGroupTopicHistory,
    submitGroupMessage,
    updateGroupInputReaction,
    cancelGroupInput,
  };
}
