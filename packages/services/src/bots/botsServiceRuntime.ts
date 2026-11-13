import type { BotsServiceRuntimeState } from "./botsServiceContext.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import { botsLogger, summarizeCallbackPayload } from "./botsServiceSupport.js";
import { createFeishuChannelRuntime } from "./feishuChannelRuntime.js";
import { createFeishuBotProvider } from "./providers/feishuProvider.js";
import { createTelegramBotProvider } from "./providers/telegramProvider.js";
import type { BotProviderAdapter } from "./providers/types.js";
import { createWebhookBotProvider } from "./providers/webhookProvider.js";
import { createWeixinBotProvider } from "./providers/weixinProvider.js";
import { createTelegramChannelRuntime } from "./telegramChannelRuntime.js";
import { createWeixinChannelRuntime } from "./weixinChannelRuntime.js";
import type { BotGroupInputProgress, BotGroupInputStatus, BotProvider } from "@zcode/shared";
import { createGroupQueueCardSync } from "#src/bots/groupQueueCard.js";

export function createBotsServiceRuntime(ctx: BotsServiceContext): BotsServiceRuntimeState {
  const providers: Record<BotProvider, BotProviderAdapter | null> = {
    telegram: createTelegramBotProvider({
      loadCredential: (key) => ctx.deps.credentialService.load(key),
    }),
    webhook: createWebhookBotProvider({
      loadCredential: (key) => ctx.deps.credentialService.load(key),
    }),
    feishu: createFeishuBotProvider({
      onDeliveryResult: ctx.onDeliveryResult,
      loadCredential: (key) => ctx.deps.credentialService.load(key),
    }),
    lark: createFeishuBotProvider({
      onDeliveryResult: ctx.onDeliveryResult,
      loadCredential: (key) => ctx.deps.credentialService.load(key),
    }),
    weixin: createWeixinBotProvider({
      loadCredential: (key) => ctx.deps.credentialService.load(key),
    }),
    discord: null,
    wecom: null,
  };

  const statusSink = {
    getRuntimeStatus(botId: string) {
      return ctx.runtimeByBotId.get(botId);
    },
    setRuntimeStatus: ctx.setRuntimeStatus,
  };

  const telegramRuntime = createTelegramChannelRuntime({
    runBackgroundTasks: ctx.runStartupBackgroundTasks,
    credentialService: ctx.deps.credentialService,
    telegramProvider: providers.telegram,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated: ctx.ensureBotStorageMigrated,
    readConfig: () => ctx.repo.readConfig(),
    readTelegramOffset: ctx.readTelegramOffset,
    writeTelegramOffset: ctx.writeTelegramOffset,
    processProviderCallback: ctx.processProviderCallback,
  });

  const weixinRuntime = createWeixinChannelRuntime({
    runBackgroundTasks: ctx.runStartupBackgroundTasks,
    credentialService: ctx.deps.credentialService,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated: ctx.ensureBotStorageMigrated,
    readConfig: () => ctx.repo.readConfig(),
    readWeixinGetUpdatesBuf: ctx.readWeixinGetUpdatesBuf,
    writeWeixinGetUpdatesBuf: ctx.writeWeixinGetUpdatesBuf,
    processProviderCallback: ctx.processProviderCallback,
  });

  const feishuRuntime = createFeishuChannelRuntime({
    runBackgroundTasks: ctx.runStartupBackgroundTasks,
    credentialService: ctx.deps.credentialService,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated: ctx.ensureBotStorageMigrated,
    readConfig: () => ctx.repo.readConfig(),
    summarizeCallbackPayload,
    onConnectionInvalidated: (botId) =>
      ctx.botHistoryEpoch.set(botId, (ctx.botHistoryEpoch.get(botId) ?? 0) + 1),
    processProviderCallback: ctx.processProviderCallback,
  });

  const queueCards = createGroupQueueCardSync({
    read: async (key) => (await ctx.readQueueCardScope(key))?.input.progress ?? undefined,
    mutate: async (key, update) => {
      let result: BotGroupInputProgress | undefined;
      await ctx.serializeStateWrite(async () => {
        const scope = await ctx.readQueueCardScope(key);
        if (!scope) return;
        result = update(scope.input.progress ?? { status: "waiting" });
        scope.input.progress = result;
        await ctx.repo.writeState(scope.state);
      });
      return result;
    },
    render: async (key, providerMessageId, status) => {
      const scope = await ctx.readQueueCardScope(key);
      // 话题复用单向状态记录，但不渲染或更新历史遗留排队卡。
      if (!scope || scope.context.group?.threadId) return;
      const english = (await ctx.readMessageLocale()) === "en-US";
      const text: Record<BotGroupInputStatus, string> = english
        ? {
            waiting: "Waiting to run",
            working: "Running",
            done: "Completed",
            failed: "Failed",
            stopped: "Stopped",
            cancelled: "Cancelled",
            discarded: "Not executed",
          }
        : {
            waiting: "等待执行",
            working: "正在执行",
            done: "已完成",
            failed: "执行失败",
            stopped: "已停止",
            cancelled: "已取消",
            discarded: "未执行",
          };
      const adapter = providers[scope.bot.provider];
      if (!adapter?.updateTransientInteractionCard)
        throw new Error("Queue card update unavailable");
      await adapter.updateTransientInteractionCard(
        scope.bot,
        { providerMessageId },
        {
          botId: scope.bot.id,
          provider: scope.bot.provider,
          providerUserId: scope.context.group!.chatId,
          text: text[status],
        },
      );
    },
  });

  return {
    providers,
    statusSink,
    telegramRuntime,
    weixinRuntime,
    feishuRuntime,
    queueCards,
  };
}
