import type { PreparedTopicMessage } from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import { createOutbound } from "./botsServiceSupport.js";
import { findBot } from "./botConfigHelpers.js";
import { parseBotCommand } from "./commandParser.js";
import { getBotConversationKey, getBotStateKey } from "./groupSessions.js";
import { getWorkspaceKey } from "./workspaceHelpers.js";
import type {
  BotActor,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  ModelSelection,
  ZCodeAutomationBotDeliveryTarget,
  ZCodePromptAttachment,
} from "@zcode/shared";
import { BotReplyError } from "#src/bots/groupAdminAttention.js";
import { createTopicContinuation } from "#src/bots/topicContinuation.js";

export function createBotsServiceGroupInput(ctx: BotsServiceContext) {
  function sendPromptInBackground(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    taskId: string,
    traceId: string,
    content: string,
    attachments: ZCodePromptAttachment[],
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget,
    modelSelection?: ModelSelection,
  ): void {
    ctx.privateImTraces.add(JSON.stringify([ctx.taskStreamKey(context, actor), traceId]));
    ctx.streamSubscriptions.get(ctx.taskStreamKey(context, actor))?.imInput();
    // 私聊常驻订阅不再随每轮建立；必须在本次输入派发前接管 Typing，
    // 否则回调收尾会将它当作短命令表情立即删除。终态/交互等待沿用原清理路径。
    if (!context.group) ctx.startTyping(bot, actor, taskId);
    // Bugfix: Telegram polling 是单循环顺序处理 update。如果这里 await session/prompt，
    // 权限按钮 callback 会一直排队到整轮任务结束，导致用户点 inline keyboard 没反应。
    // 因此 prompt 必须后台跑，polling loop 才能继续接收 /permission 回调。
    void ctx
      .resolveZCodeTaskServiceForContext(context)
      .then((zcodeTaskService) =>
        zcodeTaskService.sendPrompt({
          taskId,
          traceId,
          content,
          attachments: attachments.length > 0 ? attachments : undefined,
          botDeliveryTarget,
          modelSelection,
        }),
      )
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const locale = await ctx.readMessageLocale();
        const userFacingMessage = ctx.formatUserFacingBotError(error, locale);
        ctx.runningTasks.delete(taskId);
        ctx.stopTyping(taskId);
        await ctx.broadcastTaskListChange(context, taskId, "error", {
          error: message,
        });
        await ctx
          .sendOutbound(
            bot,
            createOutbound(
              actor,
              ctx.isSessionExpiredError(error)
                ? userFacingMessage
                : ctx.msg(locale, "taskFailed", { message: userFacingMessage }),
            ),
          )
          .catch(() => undefined);
      });
  }

  async function stopTopicRun(
    context: BotContextState,
    executionId: string,
    sourceCommandId?: string,
  ): Promise<void> {
    const taskId = context.activeTaskId;
    if (!taskId) return;
    const key = JSON.stringify([
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      taskId,
      executionId,
    ]);
    const existing = ctx.topicStops.get(key);
    if (existing) return existing;
    const stopping = ctx.resolveZCodeTaskServiceForContext(context).then(async (service) => {
      if (!service.stopBotTopicExecution) throw new Error("Topic stop is unavailable");
      await service.stopBotTopicExecution({
        taskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        executionId,
      });
      if (sourceCommandId)
        await ctx.serializeStateWrite(async () => {
          const state = await ctx.repo.readState();
          const latest = state.bots[getBotStateKey(context)];
          const input = latest?.group?.inputs?.[sourceCommandId];
          if (
            !input ||
            input.taskId !== taskId ||
            input.progress?.status === "done" ||
            input.progress?.status === "failed"
          )
            return;
          input.progress = {
            ...input.progress,
            status: "stopped",
            interruptionReason: "newMessage",
          };
          await ctx.repo.writeState(state);
        });
      if (sourceCommandId)
        await ctx.deps.broadcastService?.send({ channel: "bots:group-state", payload: {} });
    });
    ctx.topicStops.set(key, stopping);
    const release = () => {
      if (ctx.topicStops.get(key) === stopping) ctx.topicStops.delete(key);
    };
    void stopping.then(release, release);
    return stopping;
  }

  async function cancelGroupTopicInputs(actor: BotActor): Promise<void> {
    // 群级撤销必须覆盖所有话题，包括尚未创建任务、仍在准备历史的输入。
    const states = (await ctx.repo.readState()).bots;
    const keys = new Set([...Object.keys(states), ...ctx.topicContinuations.keys()]);
    await Promise.all(
      [...keys].flatMap((key) => {
        if (!key.startsWith("[")) return [];
        const [botId, chatId, threadId] = JSON.parse(key) as string[];
        return botId === actor.botId && chatId === actor.chatId && threadId
          ? [cancelTopicInputs({ ...actor, threadId, conversationThreadId: undefined })]
          : [];
      }),
    );
  }

  async function cancelTopicInputs(actor: BotActor): Promise<void> {
    const key = getBotConversationKey(actor);
    ctx.topicPreparation.clear(key);
    ctx.topicGenerations.set(key, (ctx.topicGenerations.get(key) ?? 0) + 1);
    ctx.topicHistoryReady.delete(key);
    ctx.topicContinuations.get(key)?.cancel();
    const cancelledIds = [...(ctx.topicReplies.get(key)?.keys() ?? [])];
    for (const resolve of ctx.topicReplies.get(key)?.values() ?? []) resolve([]);
    ctx.topicReplies.get(key)?.clear();
    const context = (await ctx.repo.readState()).bots[key];
    const bot = findBot(await ctx.repo.readConfig(), actor.botId);
    if (context && bot) {
      await Promise.all(
        cancelledIds.map((id) => ctx.updateGroupInputReaction(bot, context, id, "cancelled")),
      );
    }
    if (context?.activeTaskId) {
      const service = await ctx.resolveZCodeTaskServiceForContext(context);
      if (!service.invalidateBotTopicInputs)
        throw new Error("Topic preparation cancellation is unavailable");
      await service.invalidateBotTopicInputs({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
    }
    await ctx.publishTopicPreparation();
  }

  async function admitAutoReplyTurn(message: BotInboundMessage): Promise<boolean> {
    if (
      message.actor.chatType !== "group" ||
      message.groupCardAction ||
      message.elicitationResponse
    )
      return true;
    const id = message.actor.providerMessageId;
    if (!id) return message.senderType !== "app";
    let admitted = false;
    // 新消息 ID 去重不足以阻断两台机器人互答。必须在停止/准备前原子占用次数，
    // 与去重一起持久化；准备失败仍占一次，避免重投、并发和重启绕过上限。
    await ctx.serializeStateWrite(async () => {
      const state = await ctx.repo.readState();
      const context = state.bots[getBotConversationKey(message.actor)];
      const group = context?.group;
      if (!group?.enabled) {
        admitted = message.senderType !== "app";
        return;
      }
      const bot = findBot(await ctx.repo.readConfig(), message.botId);
      if (!bot?.enabled || bot.providerUserId !== group.ownerId) return;
      if (
        !group.autoReplyGuard &&
        message.senderType !== "app" &&
        parseBotCommand(message.commandText ?? message.text).type !== "message"
      ) {
        admitted = true;
        return;
      }
      const guard = group.autoReplyGuard ?? { consecutive: 0, messageIds: [] };
      if (
        guard.messageIds.includes(id) ||
        Object.values(group.inputs ?? {}).some(
          (input) =>
            input.source.messageId === id ||
            input.source.messages?.some((original) => original.messageId === id),
        )
      ) {
        // 真人重试仍走原有准备/命令幂等流程，但不能重复恢复机器人额度。
        admitted = message.senderType !== "app";
        return;
      }
      if (
        message.senderType === "app" &&
        (guard.consecutive >= 5 ||
          (message.actor.threadId ? group.topicActive !== true : message.mentionedBot !== true))
      )
        return;
      group.autoReplyGuard = {
        consecutive: message.senderType === "app" ? guard.consecutive + 1 : 0,
        messageIds: [...guard.messageIds, id],
      };
      await ctx.repo.writeState(state);
      admitted = true;
    });
    return admitted;
  }

  async function receiveTopicMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const key = getBotConversationKey(message.actor);
    const id = message.actor.providerMessageId;
    if (!id) throw new Error("Topic message identity is missing");
    // 去重必须早于停止副作用；重投的已接收事件不能打断正在运行的新轮。
    const stored = (await ctx.repo.readState()).bots[key];
    if (
      Object.values(stored?.group?.inputs ?? {}).some(
        (input) =>
          input.source.messageId === id ||
          input.source.messages?.some((original) => original.messageId === id),
      )
    )
      return [];

    let replies = ctx.topicReplies.get(key);
    if (!replies) {
      replies = new Map();
      ctx.topicReplies.set(key, replies);
    }
    // 持久化接收去重在 handleMessage；这里只合并同时到达的同一事件。
    if (replies.has(id)) return [];
    const pendingReplies = replies;
    const result = new Promise<BotOutboundMessage[]>((resolve) => pendingReplies.set(id, resolve));
    let continuation = ctx.topicContinuations.get(key);
    if (!continuation) {
      const continuationGeneration = ctx.topicGenerations.get(key) ?? 0;
      const current = async () => (await ctx.repo.readState()).bots[key];
      let observedSourceCommandId: string | undefined;
      continuation = createTopicContinuation<PreparedTopicMessage>({
        readRunningRun: async () => {
          const context = await current();
          if (!context?.activeTaskId) return undefined;
          const service = await ctx.resolveZCodeTaskServiceForContext(context);
          if (!service.readBotTopicExecution)
            throw new Error("Topic runtime control is unavailable");
          const execution = await service.readBotTopicExecution({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          });
          observedSourceCommandId = execution?.sourceCommandId;
          return execution?.executionId;
        },
        stopAndWait: async (executionId) => {
          const context = await current();
          if (!context?.activeTaskId) throw new Error("Topic task disappeared during stop");
          ctx.topicPreparation.setWaitingStop(key, true);
          await ctx.publishTopicPreparation();
          try {
            await stopTopicRun(context, executionId, observedSourceCommandId);
          } finally {
            if (continuationGeneration === (ctx.topicGenerations.get(key) ?? 0)) {
              ctx.topicPreparation.setWaitingStop(key, false);
              await ctx.publishTopicPreparation();
            }
          }
        },
        submit: async (batch) => {
          ctx.topicPreparation.update(
            key,
            batch.map((entry) => entry.message.actor.providerMessageId!),
            "preparing",
          );
          await ctx.publishTopicPreparation();
          const last = batch.at(-1)!;
          const combined = {
            ...last.message,
            text:
              batch.length === 1
                ? last.message.text
                : batch
                    .map(
                      ({ message: original }) =>
                        `${original.actor.displayName || original.actor.providerUserId}: ${original.text}`,
                    )
                    .join("\n\n"),
          };
          const isCurrent = () =>
            batch.every((entry) => entry.generation === (ctx.topicGenerations.get(key) ?? 0));
          const outgoing = await ctx.handleMessage(combined, batch, isCurrent);
          const context = await current();
          const accepted = Object.values(context?.group?.inputs ?? {}).some(
            (input) =>
              input.admission === "accepted" &&
              input.source.messageId === last.message.actor.providerMessageId,
          );
          if (isCurrent() && !accepted && context) {
            const bot = findBot(await ctx.repo.readConfig(), message.botId);
            if (bot)
              await Promise.all(
                batch.map((entry) =>
                  ctx.updateGroupInputReaction(
                    bot,
                    context,
                    entry.message.actor.providerMessageId,
                    "failed",
                  ),
                ),
              );
          }
          const ids = batch.map((entry) => entry.message.actor.providerMessageId!);
          if (isCurrent()) {
            if (accepted) ctx.topicPreparation.remove(key, ids);
            else
              ctx.topicPreparation.update(
                key,
                ids,
                "failed",
                outgoing.map((reply) => reply.text).join("\n"),
              );
            await ctx.publishTopicPreparation();
          }
          for (const entry of batch) {
            const messageId = entry.message.actor.providerMessageId!;
            pendingReplies.get(messageId)?.(entry === last ? outgoing : []);
            pendingReplies.delete(messageId);
          }
        },
        failed: async (ids, error) => {
          // 取消后的旧下载/停止异常不得修改新一代消息的状态或表情。
          if (continuationGeneration !== (ctx.topicGenerations.get(key) ?? 0)) return;
          ctx.topicPreparation.update(
            key,
            ids,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
          await ctx.publishTopicPreparation();
          const context = await current();
          const bot = findBot(await ctx.repo.readConfig(), message.botId);
          if (context && bot)
            await Promise.all(
              ids.map((id) => ctx.updateGroupInputReaction(bot, context, id, "failed")),
            );
          for (const messageId of ids) {
            pendingReplies.get(messageId)?.(
              error instanceof BotReplyError
                ? error.replies
                : [
                    ctx.administratorErrorReply(
                      message.actor,
                      bot,
                      error,
                      createOutbound(
                        message.actor,
                        error instanceof Error ? error.message : String(error),
                      ),
                    ),
                  ],
            );
            pendingReplies.delete(messageId);
          }
        },
      });
      ctx.topicContinuations.set(key, continuation);
    }
    const generation = ctx.topicGenerations.get(key) ?? 0;
    const received = continuation.receive(id, async () => {
      const auth = await ctx.withAuthorizedContext(message, "message");
      if (!auth.ok) throw new BotReplyError(auth.reply);
      if (generation !== (ctx.topicGenerations.get(key) ?? 0))
        throw new Error("Topic input cancelled");
      ctx.topicPreparation.add(key, message);
      await ctx.publishTopicPreparation();
      await ctx.updateGroupInputReaction(auth.bot, auth.context, id, "waiting");
      return {
        message,
        generation,
        prepared: await ctx.prepareBotMessageContent(auth.bot, message, auth.locale),
      };
    });
    if (!received) {
      pendingReplies.get(id)?.([]);
      pendingReplies.delete(id);
    }
    const active = continuation;
    void active.settled().finally(() => {
      if (pendingReplies.size === 0 && ctx.topicContinuations.get(key) === active) {
        ctx.topicContinuations.delete(key);
        ctx.topicReplies.delete(key);
      }
    });
    return result;
  }

  return {
    sendPromptInBackground,
    stopTopicRun,
    cancelGroupTopicInputs,
    cancelTopicInputs,
    admitAutoReplyTurn,
    receiveTopicMessage,
  };
}
