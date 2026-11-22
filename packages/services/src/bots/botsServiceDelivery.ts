import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS,
  BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS,
  BOT_TYPING_INTERVAL_MS,
  botsLogger,
} from "./botsServiceSupport.js";
import { findBot } from "./botConfigHelpers.js";
import type { BotAutomationRunWatchParams } from "./bots.js";
import { getBotConversationKey } from "./groupSessions.js";
import { splitFeishuText } from "./providers/feishuProvider.js";
import type { BotProviderAdapter, BotTypingTarget } from "./providers/types.js";
import {
  formatStatusStreamToolProgress,
  normalizeStatusProgressText,
  truncateLiveStatusProgressText,
} from "./statusFormatting.js";
import {
  BOT_TASK_BROADCAST_CHANNEL,
  BOT_TASK_STREAM_BROADCAST_CHANNEL,
  type BotActor,
  type BotConfig,
  type BotContextState,
  type BotGroupDelivery,
  type BotInboundMessage,
  type BotOutboundMessage,
  type BotTaskBroadcastPayload,
  type BotTaskStreamBroadcastPayload,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeStreamEvent,
  isFeishuBotProvider,
} from "@zcode/shared";
import { createGroupResultDelivery } from "#src/bots/groupResultDelivery.js";
import { createHash } from "node:crypto";

export function createBotsServiceDelivery(ctx: BotsServiceContext) {
  function getGroupDeliverySender(bot: BotConfig, chatId: string, threadId?: string) {
    const key = getBotConversationKey({ botId: bot.id, chatType: "group", chatId, threadId });
    const existing = ctx.groupDeliverySenders.get(key);
    if (existing) return existing;
    const authorized = async (result: BotGroupDelivery): Promise<boolean> => {
      const state = (await ctx.repo.readState()).bots[key];
      const currentBot = findBot(await ctx.repo.readConfig(), bot.id);
      return Boolean(
        currentBot?.enabled &&
        (!result.appId || result.appId === currentBot.feishuAppId) &&
        (!result.contentParts ||
          !["cancelled", "discarded", "stopped"].includes(
            state?.group?.inputs?.[result.sourceCommandId ?? ""]?.progress?.status ?? "",
          )) &&
        state?.group?.enabled &&
        state.group.ownerId === currentBot.providerUserId &&
        state.activeTaskId === result.taskId &&
        state.group.deliveries?.[result.id]?.status !== "invalidated" &&
        (!result.authorizationId || result.authorizationId === state.group.authorizationId),
      );
    };
    const sender = createGroupResultDelivery({
      onSettled: async () => {
        await ctx.deps.broadcastService
          ?.send({ channel: "bots:group-state", payload: { botId: bot.id, chatId } })
          .catch(() => undefined);
      },
      read: async (id) => (await ctx.repo.readState()).bots[key]?.group?.deliveries?.[id],
      authorized,
      write: async (result) => {
        const operation = ctx.stateWriteTail
          .catch(() => undefined)
          .then(async () => {
            const state = await ctx.repo.readState();
            const context = state.bots[key];
            if (!context?.group) return;
            const invalidated =
              !context.group.enabled ||
              context.activeTaskId !== result.taskId ||
              (Boolean(result.authorizationId) &&
                context.group.authorizationId !== result.authorizationId) ||
              context.group.deliveries?.[result.id]?.status === "invalidated";
            state.bots[key] = {
              ...context,
              group: {
                ...context.group,
                deliveries: {
                  ...context.group.deliveries,
                  [result.id]: invalidated ? { ...result, status: "invalidated" } : result,
                },
              },
            };
            await ctx.repo.writeState(state);
          });
        ctx.stateWriteTail = operation;
        await operation;
        await ctx.deps.broadcastService
          ?.send({ channel: "bots:group-state", payload: { botId: bot.id, chatId } })
          .catch(() => undefined);
      },
      send: async (result) => {
        await ctx.waitForGroupDeliverySlot(`${bot.provider}:${chatId}`);
        if (!(await authorized(result)))
          throw Object.assign(new Error("Group delivery authorization changed"), {
            deliveryRejected: true,
          });
        const currentBot = findBot(await ctx.repo.readConfig(), bot.id);
        const adapter = currentBot && ctx.providers[currentBot.provider];
        if (!adapter || !currentBot)
          throw Object.assign(new Error("Bot provider unavailable"), { deliveryRejected: true });
        if (
          result.contentParts &&
          (currentBot.provider !== bot.provider || currentBot.feishuAppId !== result.appId)
        )
          throw Object.assign(new Error("Channel reply application changed"), {
            deliveryRejected: true,
          });
        return adapter.send(currentBot, {
          botId: bot.id,
          provider: bot.provider,
          providerUserId: chatId,
          text: result.text,
          deliveryId: result.id,
          replyToMessageId: result.replyToMessageId,
          mentionedUserIds: result.mentionedUserIds,
          contentParts: result.contentParts,
          trace: result.trace,
          threadId: result.threadId ?? threadId,
          rootMessageId:
            result.rootMessageId ?? (await ctx.repo.readState()).bots[key]?.group?.rootMessageId,
        });
      },
    });
    ctx.groupDeliverySenders.set(key, sender);
    return sender;
  }

  async function sendOutbound(
    bot: BotConfig,
    message: BotOutboundMessage,
    authorize?: () => Promise<boolean>,
  ): Promise<void> {
    const conversationThreadId =
      message.conversationThreadId !== undefined
        ? (message.conversationThreadId ?? undefined)
        : message.threadId;
    if (isFeishuBotProvider(bot.provider) && message.groupTaskId && message.deliveryId) {
      const parts = splitFeishuText(message.text);
      const group = (await ctx.repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: message.providerUserId,
          threadId: message.threadId,
          conversationThreadId: message.conversationThreadId,
        })
      ]?.group;
      const authorizationId = message.groupCard?.authorizationId ?? group?.authorizationId;
      for (const [index, text] of parts.entries()) {
        const id = createHash("sha256").update(`${message.deliveryId}:${index}`).digest("hex");
        const result: BotGroupDelivery = {
          authorizationId,
          id,
          taskId: message.groupTaskId,
          sourceCommandId: message.groupSourceCommandId,
          text,
          replyToMessageId: message.replyToMessageId,
          mentionedUserIds: index === 0 ? message.mentionedUserIds : undefined,
          threadId: message.threadId,
          rootMessageId: message.rootMessageId,
          status: "pending",
          updatedAt: Date.now(),
        };
        await getGroupDeliverySender(bot, message.providerUserId, conversationThreadId)(result);
      }
      return;
    }
    if (isFeishuBotProvider(bot.provider) && message.providerUserId.startsWith("oc_")) {
      await ctx.waitForGroupDeliverySlot(`${bot.provider}:${message.providerUserId}`);
    }
    // 定时任务也使用稳定群目标；等待发送额度之后重新检查启用状态。
    if (authorize && !(await authorize())) return;
    if (isFeishuBotProvider(bot.provider) && message.groupTaskId) {
      const groupState = (await ctx.repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: message.providerUserId,
          threadId: message.threadId,
          conversationThreadId: message.conversationThreadId,
        })
      ];
      const currentBot = findBot(await ctx.repo.readConfig(), bot.id);
      if (
        !currentBot?.enabled ||
        !groupState?.group?.enabled ||
        groupState.group.ownerId !== currentBot.providerUserId ||
        groupState.activeTaskId !== message.groupTaskId
      )
        return;
    }
    const adapter = ctx.providers[bot.provider];
    if (!adapter) {
      return;
    }
    if (bot.provider === "weixin") {
      const token = await ctx.deps.credentialService.load(
        ctx.weixinContextKey(bot, message.providerUserId),
      );
      if (token) message = { ...message, providerContextToken: token };
    }
    let handle: Awaited<ReturnType<BotProviderAdapter["send"]>>;
    try {
      handle = await adapter.send(bot, message);
      ctx.onDeliveryResult(bot, undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const locale = await ctx.readMessageLocale();
      ctx.onDeliveryResult(
        bot,
        bot.provider === "weixin"
          ? locale === "en-US"
            ? `${detail}. Send a message to the bot in Weixin, then retry.`
            : `${detail}。请在微信给机器人发一条消息后重试。`
          : detail,
      );
      throw error;
    }
    if (
      message.selection?.action === "queue.cancel" &&
      message.groupSourceCommandId &&
      message.groupCard?.taskId &&
      handle?.providerMessageId
    ) {
      await ctx.queueCards
        .attach(
          JSON.stringify([
            bot.id,
            message.groupCard.chatId,
            message.groupCard.taskId,
            message.groupCard.authorizationId,
            message.groupSourceCommandId,
            message.groupCard.conversationThreadId !== undefined
              ? message.groupCard.conversationThreadId
              : message.groupCard.threadId,
          ]),
          handle.providerMessageId,
        )
        .catch((error) => {
          botsLogger.warn(
            undefined,
            `queue card catch-up failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  function buildInboundDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  function releaseInboundDelivery(message: BotInboundMessage): void {
    const deliveryKey = buildInboundDeliveryKey(message);
    if (deliveryKey) {
      ctx.recentInboundDeliveryAtByKey.delete(deliveryKey);
    }
  }

  async function enqueueInboundProcessing<T>(
    actor: BotActor,
    task: () => Promise<T>,
    control = false,
  ): Promise<T> {
    // 控制请求独立串行，不能被等待附件或 admission 的普通输入挡住。
    const actorContextKey = `${getBotConversationKey(actor)}${control ? ":control" : ""}`;
    const previous = ctx.inboundProcessingQueuesByContext.get(actorContextKey) ?? Promise.resolve();
    let releaseQueue = (): void => undefined;
    const current = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            releaseQueue = resolve;
          }),
      );
    ctx.inboundProcessingQueuesByContext.set(actorContextKey, current);
    await previous.catch(() => undefined);
    try {
      // Bugfix: 同一个用户可能连续点击 AskUserQuestion 按钮或快速回复多条消息。
      // 这里按 actor 串行化入站处理，避免两个并发请求同时读取同一个 pendingElicitation 并重复 respondElicitation。
      return await task();
    } finally {
      releaseQueue();
      if (ctx.inboundProcessingQueuesByContext.get(actorContextKey) === current) {
        ctx.inboundProcessingQueuesByContext.delete(actorContextKey);
      }
    }
  }

  function pruneRecentInboundDeliveryDedupe(now: number): void {
    for (const [key, at] of ctx.recentInboundDeliveryAtByKey) {
      if (now - at >= BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS) {
        ctx.recentInboundDeliveryAtByKey.delete(key);
      }
    }
  }

  function markInboundDelivery(message: BotInboundMessage): boolean {
    const now = Date.now();
    pruneRecentInboundDeliveryDedupe(now);
    const deliveryKey = buildInboundDeliveryKey(message);
    if (!deliveryKey) {
      return true;
    }
    if (ctx.recentInboundDeliveryAtByKey.has(deliveryKey)) {
      return false;
    }
    // Bugfix: 飞书 WebSocket 可能重投同一条 im.message.receive_v1，微信/Telegram 也可能在重试后重放同一 message id。
    // 普通消息有创建/发送任务的副作用，必须在进入业务处理前按 provider message id 幂等，避免同一句 hello 被执行两轮。
    ctx.recentInboundDeliveryAtByKey.set(deliveryKey, now);
    return true;
  }

  async function sendTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = ctx.providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter?.sendTyping || !targetId) {
      return;
    }
    await adapter
      .sendTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  async function stopInboundTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = ctx.providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter?.stopTyping || !targetId || !actor.providerMessageId) {
      return;
    }
    const isLongRunningTyping = Array.from(ctx.typingTargets.values()).some(
      (typing) =>
        typing.bot.id === bot.id && typing.target.providerMessageId === actor.providerMessageId,
    );
    if (isLongRunningTyping) {
      return;
    }
    // Bugfix: 飞书 sendTyping 只负责给本次入站消息加 Typing reaction。
    // 短命令回复发送完成后必须按同一 messageId 显式删除，避免依赖定时兜底或等下一条命令清理。
    await adapter
      .stopTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  function startTyping(bot: BotConfig, actor: BotActor, taskId: string): void {
    const adapter = ctx.providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter || !targetId || ctx.typingTargets.has(taskId) || ctx.typingIntervals.has(taskId)) {
      return;
    }
    const target: BotTypingTarget = {
      providerUserId: targetId,
      providerMessageId: actor.providerMessageId,
      providerContextToken: actor.providerContextToken,
    };
    if (adapter.startTyping) {
      ctx.typingTargets.set(taskId, { bot, target });
      void adapter.startTyping(bot, target).catch(() => undefined);
      return;
    }
    if (adapter.sendTyping) {
      void adapter.sendTyping(bot, target).catch(() => undefined);
      ctx.typingIntervals.set(
        taskId,
        setInterval(() => {
          void adapter.sendTyping?.(bot, target).catch(() => undefined);
        }, BOT_TYPING_INTERVAL_MS),
      );
    }
  }

  function stopTyping(taskId: string): void {
    const activeTyping = ctx.typingTargets.get(taskId);
    if (activeTyping) {
      ctx.typingTargets.delete(taskId);
      const adapter = ctx.providers[activeTyping.bot.provider];
      void adapter?.stopTyping?.(activeTyping.bot, activeTyping.target).catch(() => undefined);
    }
    const intervalId = ctx.typingIntervals.get(taskId);
    if (!intervalId) {
      return;
    }
    clearInterval(intervalId);
    ctx.typingIntervals.delete(taskId);
  }

  function updateLiveStatusProgress(event: ZCodeStreamEvent): void {
    if (event.type === "agent_message_chunk" || event.type === "agent_thought_chunk") {
      const text = normalizeStatusProgressText(event.content);
      if (!text) {
        return;
      }
      const kind = event.type === "agent_message_chunk" ? "message" : "thought";
      const previous = ctx.liveStatusProgressByTaskId.get(event.taskId);
      ctx.liveStatusProgressByTaskId.set(event.taskId, {
        kind,
        text: truncateLiveStatusProgressText(
          previous?.kind === kind ? `${previous.text}${text}` : text,
        ),
      });
      return;
    }
    if (event.type === "tool_call" || event.type === "tool_call_update") {
      const text = formatStatusStreamToolProgress(event);
      if (text) {
        ctx.liveStatusProgressByTaskId.set(event.taskId, { kind: "tool", text });
      }
    }
  }

  async function broadcastTaskListChange(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
    event: BotTaskBroadcastPayload["event"],
    extras: Partial<
      Pick<
        BotTaskBroadcastPayload,
        | "task"
        | "provider"
        | "configOptions"
        | "prompt"
        | "permissionRequest"
        | "elicitationRequest"
        | "requestId"
        | "error"
      >
    > = {},
  ): Promise<void> {
    await ctx.deps.broadcastService
      ?.send({
        channel: BOT_TASK_BROADCAST_CHANNEL,
        payload: {
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          taskId,
          event,
          updatedAt: Date.now(),
          ...extras,
        },
      })
      .catch(() => undefined);
  }

  async function broadcastTaskStreamEvent(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    event: ZCodeStreamEvent,
  ): Promise<void> {
    const payload: BotTaskStreamBroadcastPayload = {
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      taskId: event.taskId,
      event,
      updatedAt: Date.now(),
    };
    await ctx.deps.broadcastService
      ?.send({
        channel: BOT_TASK_STREAM_BROADCAST_CHANNEL,
        payload,
      })
      .catch(() => undefined);
  }

  function warnAutomationDeliveryOnce(params: {
    target: ZCodeAutomationBotDeliveryTarget;
    reason: string;
  }): void {
    const key = `${params.target.provider}:${params.target.botId}:${params.reason}`;
    const now = Date.now();
    const previousAt = ctx.automationDeliveryWarningAtByKey.get(key) ?? 0;
    if (now - previousAt < BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS) return;
    ctx.automationDeliveryWarningAtByKey.set(key, now);
    botsLogger.warn(
      undefined,
      `automation Bot delivery skipped provider=${params.target.provider} bot=${params.target.botId} reason=${params.reason}`,
    );
  }

  async function watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void> {
    const config = await ctx.repo.readConfig();
    const bot = findBot(config, params.target.botId);
    if (!bot) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_missing" });
      return;
    }
    if (!bot.enabled) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_disabled" });
      return;
    }
    if (bot.provider !== params.target.provider) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "provider_mismatch" });
      return;
    }
    if (params.target.chatType === "private") await ctx.reconcilePrivateSynchronization(bot.id);
    let conversationThreadId: string | null | undefined;
    if (params.target.chatType === "group") {
      const states = (await ctx.repo.readState()).bots;
      const state =
        states[
          getBotConversationKey({
            botId: bot.id,
            chatType: "group",
            chatId: params.target.providerUserId,
            threadId: params.target.threadId,
          })
        ];
      if (!state?.group?.enabled || state.group.ownerId !== bot.providerUserId) {
        warnAutomationDeliveryOnce({ target: params.target, reason: "group_not_authorized" });
        return;
      }
      // 旧 alias 不能继续回退到默认任务；话题投递必须存在独立的授权会话。
      conversationThreadId = state.group.threadId ?? null;
    }
    const actor: BotActor = {
      provider: params.target.provider,
      botId: params.target.botId,
      providerUserId: params.target.providerUserId,
      chatType: params.target.chatType,
      threadId: params.target.threadId,
      conversationThreadId,
      rootMessageId: params.target.rootMessageId,
      ...(params.target.chatType === "group" ? { chatId: params.target.providerUserId } : {}),
    };
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      mode: "task",
      activeTaskId: params.taskId,
      updatedAt: Date.now(),
    };
    // Automation 回推固定为终态摘要；不能复用用户当前 replyMode，否则 streaming/card
    // 会在后台任务执行过程中向原会话持续发送中间过程。
    await ctx.watchTaskStream(
      bot,
      actor,
      context,
      {
        ...bot,
        replyMode: "summary_changes",
      },
      params.runId ?? true,
    );
  }

  return {
    getGroupDeliverySender,
    sendOutbound,
    buildInboundDeliveryKey,
    releaseInboundDelivery,
    enqueueInboundProcessing,
    pruneRecentInboundDeliveryDedupe,
    markInboundDelivery,
    sendTyping,
    stopInboundTyping,
    startTyping,
    stopTyping,
    updateLiveStatusProgress,
    broadcastTaskListChange,
    broadcastTaskStreamEvent,
    warnAutomationDeliveryOnce,
    watchAutomationRun,
  };
}
