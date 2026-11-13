import type { BotsServiceContext } from "./botsServicePorts.js";
import { findBot } from "./botConfigHelpers.js";
import type { IBotsService } from "./bots.js";
import { getBotConversationKey } from "./groupSessions.js";
import { type BotGroupDelivery, isFeishuBotProvider } from "@zcode/shared";

export function createBotsServiceApiGroups(ctx: BotsServiceContext): Partial<IBotsService> {
  return {
    async reconcileGroupResult(params: {
      botId: string;
      chatId: string;
      deliveryId: string;
      threadId?: string;
      received: boolean;
    }) {
      const key = getBotConversationKey({
        botId: params.botId,
        chatType: "group",
        chatId: params.chatId,
        threadId: params.threadId,
      });
      let reconciled: BotGroupDelivery | undefined;
      await ctx.serializeStateWrite(async () => {
        const bot = findBot(await ctx.repo.readConfig(), params.botId);
        const state = await ctx.repo.readState();
        const context = state.bots[key];
        const result = context?.group?.deliveries?.[params.deliveryId];
        if (
          !bot?.enabled ||
          !context?.group?.enabled ||
          context.group.ownerId !== bot.providerUserId ||
          !result ||
          result.taskId !== context.activeTaskId ||
          result.status !== "unknown" ||
          ctx.groupDeliverySenders.get(key)?.isInFlight(params.deliveryId)
        ) {
          throw new Error("Saved group result cannot be reconciled in the current state");
        }
        reconciled = {
          ...result,
          status: params.received ? "sent" : "failed",
          lastError: undefined,
          updatedAt: Date.now(),
        };
        context.group.deliveries = { ...context.group.deliveries, [result.id]: reconciled };
        await ctx.repo.writeState(state);
      });
      await ctx.deps.broadcastService
        ?.send({
          channel: "bots:group-state",
          payload: { botId: params.botId, chatId: params.chatId },
        })
        .catch(() => undefined);
      return reconciled!;
    },

    async resendGroupResult(params: {
      botId: string;
      chatId: string;
      threadId?: string;
      deliveryId: string;
    }) {
      const bot = findBot(await ctx.repo.readConfig(), params.botId);
      if (!bot || !isFeishuBotProvider(bot.provider)) throw new Error("Group bot unavailable");
      const key = getBotConversationKey({
        botId: params.botId,
        chatType: "group",
        chatId: params.chatId,
        threadId: params.threadId,
      });
      const result = (await ctx.repo.readState()).bots[key]?.group?.deliveries?.[params.deliveryId];
      if (!result) throw new Error("Saved group result unavailable");
      await ctx.getGroupDeliverySender(bot, params.chatId, params.threadId)(result, true);
      return (
        (await ctx.repo.readState()).bots[key]?.group?.deliveries?.[params.deliveryId] ?? result
      );
    },

    async setGroupEnabled(params: { botId: string; chatId: string; enabled: boolean }) {
      const bot = findBot(await ctx.repo.readConfig(), params.botId);
      if (!bot?.providerUserId) throw new Error("Bot owner unavailable");
      await ctx.handleGroupActivation(
        {
          botId: bot.id,
          actor: {
            provider: bot.provider,
            botId: bot.id,
            chatType: "group",
            chatId: params.chatId,
            providerUserId: bot.providerUserId,
          },
          text: params.enabled ? "/enable" : "/disable",
        },
        params.enabled,
      );
    },

    async retryPrivateDelivery({ botId, deliveryId }) {
      const failed = ctx.failedPrivateDeliveries.get(botId);
      const bot = findBot(await ctx.repo.readConfig(), botId);
      const context = (await ctx.repo.readState()).bots[botId];
      const recipient =
        bot?.provider === "weixin" ? context?.privateRecipientId : bot?.providerUserId;
      if (
        !failed ||
        failed.id !== deliveryId ||
        failed.sending ||
        !bot?.enabled ||
        context?.privateBindingId !== failed.bindingId ||
        context?.activeTaskId !== failed.taskId ||
        recipient !== failed.message.providerUserId
      )
        throw new Error("Private delivery is no longer available");
      failed.sending = true;
      try {
        await ctx.sendOutbound(bot, failed.message);
        if (ctx.failedPrivateDeliveries.get(botId) === failed) {
          ctx.failedPrivateDeliveries.delete(botId);
          const runtime = ctx.runtimeByBotId.get(botId);
          if (runtime)
            ctx.setRuntimeStatus({
              ...runtime,
              deliveryRetryId: undefined,
              deliveryError: undefined,
            });
        }
      } finally {
        failed.sending = false;
      }
    },

    async resetBotState(contextKey: string) {
      await ctx.repo.updateContext(contextKey, () => undefined);
      await ctx.reconcilePrivateSynchronization(contextKey);
    },
  };
}
