import type { BotsServiceContext } from "./botsServicePorts.js";
import { delay } from "./botsServiceOptions.js";
import { botsLogger, createCode, validateBotConfig } from "./botsServiceSupport.js";
import { findBot, normalizeBotConfig, normalizeConfigBots } from "./botConfigHelpers.js";
import type {
  BotBindCodeResult,
  BotCreateBindCodeParams,
  BotSaveBotParams,
  BotTestResult,
  IBotsService,
} from "./bots.js";
import {
  BOT_BIND_CODE_TTL_MS,
  buildBotCredentialKey,
  buildBotWebhookSecretKey,
  normalizeBotCommandPolicy,
  normalizeBotCurrentOptions,
} from "./config.js";
import { getBotConversationKey } from "./groupSessions.js";
import {
  beginFeishuAppRegistration,
  pollFeishuAppRegistration,
} from "./providers/feishuAppRegistration.js";
import {
  beginWeixinRegistration as beginWeixinQrRegistration,
  pollWeixinRegistration as pollWeixinQrRegistration,
} from "./providers/weixinRegistration.js";
import { normalizeAllowedWorkspaces } from "./workspaceHelpers.js";
import {
  ALL_BOT_WORKSPACES,
  type BotConfig,
  type BotProvider,
  isFeishuBotProvider,
  normalizeBotReplyGranularity,
} from "@zcode/shared";

export function createBotsServiceApiBots(ctx: BotsServiceContext): Partial<IBotsService> {
  return {
    async syncAppRuntimePreferences(preferences) {
      await ctx.deps.remoteWorkspaceService?.syncAppRuntimePreferences?.(preferences);
    },

    async getStatus() {
      const config = await ctx.repo.readConfig();
      const state = await ctx.repo.readState();
      return {
        botsCount: config.bots.length,
        enabledBotsCount: config.bots.filter((bot) => bot.enabled).length,
        contextsCount: Object.keys(state.bots).length,
        botRuntime: config.bots.map((bot) => {
          const runtime = ctx.runtimeByBotId.get(bot.id);
          return (
            runtime ?? {
              botId: bot.id,
              provider: bot.provider,
              status: bot.enabled ? "idle" : "disabled",
              message: bot.enabled ? "Bot is configured." : "Bot is disabled.",
              offset: state.bots[bot.id]?.telegramOffset,
            }
          );
        }),
      };
    },

    getConfig: () => ctx.repo.readConfig(),

    beginFeishuRegistration(params) {
      return beginFeishuAppRegistration(params?.domain);
    },

    pollFeishuRegistration(params) {
      return pollFeishuAppRegistration(params);
    },

    beginWeixinRegistration() {
      return beginWeixinQrRegistration();
    },

    pollWeixinRegistration(params) {
      return pollWeixinQrRegistration(params);
    },

    async saveConfig(config) {
      const savedConfig = await ctx.writeBotConfig(normalizeConfigBots(config));
      ctx.telegramRuntime.scheduleRefresh(savedConfig);
      ctx.weixinRuntime.scheduleRefresh(savedConfig);
      ctx.feishuRuntime.scheduleRefresh(savedConfig);
      return savedConfig;
    },

    async listBots() {
      return (await ctx.repo.readConfig()).bots;
    },

    async saveBot(params: BotSaveBotParams) {
      const config = await ctx.repo.readConfig();
      let bot: BotConfig = {
        ...params.bot,
        id: params.bot.id.trim(),
        name: params.bot.name.trim(),
        allowedWorkspaces: normalizeAllowedWorkspaces(params.bot.allowedWorkspaces),
        allowedCommands: normalizeBotCommandPolicy(params.bot.allowedCommands),
        currentOptions: normalizeBotCurrentOptions(params.bot.currentOptions),
        replyMode: normalizeBotReplyGranularity(params.bot.provider, params.bot.replyMode),
      };
      if (params.credentialValue?.trim()) {
        const key = buildBotCredentialKey(bot.id);
        await ctx.deps.credentialService.save(key, params.credentialValue.trim());
        bot = { ...bot, credentialRef: key };
      }
      if (params.webhookSecretValue?.trim()) {
        const key = buildBotWebhookSecretKey(bot.id);
        await ctx.deps.credentialService.save(key, params.webhookSecretValue.trim());
        bot = { ...bot, webhookSecretRef: key };
      }
      if (params.credentialValue?.trim() || !bot.name.trim()) {
        const adapter = ctx.providers[bot.provider];
        const resolveRetryDelaysMs = isFeishuBotProvider(bot.provider) ? [0, 800, 1_800] : [0];
        let resolvedName: string | null | undefined = null;
        let lastResolveNameError: unknown;
        for (const retryDelayMs of resolveRetryDelaysMs) {
          if (retryDelayMs > 0) {
            // Bugfix: 飞书 / Lark 扫码创建应用后，应用信息接口可能短暂不可读；重试后再回填 Bot 名称。
            await delay(retryDelayMs);
          }
          try {
            resolvedName = await adapter?.resolveName?.(bot);
            if (resolvedName?.trim()) {
              break;
            }
          } catch (error) {
            lastResolveNameError = error;
          }
        }
        if (resolvedName?.trim()) {
          bot = { ...bot, name: resolvedName.trim() };
        } else if (lastResolveNameError) {
          botsLogger.warn(
            undefined,
            `resolve bot name failed bot=${bot.id}: ${lastResolveNameError instanceof Error ? lastResolveNameError.message : String(lastResolveNameError)}`,
          );
        }
      }
      bot = normalizeBotConfig(bot);
      validateBotConfig(config, bot);
      const bots = config.bots.filter((item) => item.id !== bot.id);
      bots.push(bot);
      const savedConfig = await ctx.writeBotConfig({ ...config, bots });
      ctx.telegramRuntime.scheduleRefresh(savedConfig);
      ctx.weixinRuntime.scheduleRefresh(savedConfig);
      ctx.feishuRuntime.scheduleRefresh(savedConfig);
      return bot;
    },

    async removeBotSecret(botId: string) {
      const config = await ctx.repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      if (bot.provider === "telegram") {
        void ctx.telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (isFeishuBotProvider(bot.provider)) {
        ctx.feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot.provider === "weixin") {
        ctx.weixinRuntime.stopPolling(bot.id);
      }
      // Bugfix: 只移除密钥时如果保留旧绑定身份，UI 会显示“已连通”，但运行时已经没有 token 可用。
      // 这里同步清理绑定状态，让 Bot token 行回到可重新添加的状态。
      const nextBot = normalizeBotConfig({
        ...bot,
        credentialRef: undefined,
        webhookSecretRef: undefined,
        providerUserId: undefined,
        displayName: undefined,
        feishuAppId: isFeishuBotProvider(bot.provider) ? undefined : bot.feishuAppId,
      });
      const savedConfig = await ctx.writeBotConfig({
        ...config,
        bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
      });
      await ctx.repo.updateContext(bot.id, () => undefined);
      ctx.telegramRuntime.scheduleRefresh(savedConfig);
      ctx.weixinRuntime.scheduleRefresh(savedConfig);
      ctx.feishuRuntime.scheduleRefresh(savedConfig);
      if (bot.credentialRef) {
        await ctx.deps.credentialService.delete(bot.credentialRef);
      }
      if (bot.webhookSecretRef) {
        await ctx.deps.credentialService.delete(bot.webhookSecretRef);
      }
      return nextBot;
    },

    async deleteBot(botId: string) {
      const config = await ctx.repo.readConfig();
      const bot = findBot(config, botId);
      if (bot?.provider === "telegram") {
        void ctx.telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (bot && isFeishuBotProvider(bot.provider)) {
        ctx.feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot?.provider === "weixin") {
        ctx.weixinRuntime.stopPolling(bot.id);
      }
      await ctx.writeBotConfig({
        ...config,
        bots: config.bots.filter((item) => item.id !== botId),
      });
      ctx.telegramRuntime.scheduleRefresh();
      ctx.weixinRuntime.scheduleRefresh();
      await ctx.repo.updateContext(botId, () => undefined);
      if (bot?.credentialRef) {
        await ctx.deps.credentialService.delete(bot.credentialRef);
      }
      if (bot?.webhookSecretRef) {
        await ctx.deps.credentialService.delete(bot.webhookSecretRef);
      }
    },

    async testBot(botId: string): Promise<BotTestResult> {
      const config = await ctx.repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        return { ok: false, message: "Bot not found." };
      }
      const adapter = ctx.providers[bot.provider];
      if (!adapter) {
        return {
          ok: false,
          message: `${bot.provider} is reserved for a future version.`,
          provider: bot.provider,
        };
      }
      return { ...(await adapter.test(bot)), provider: bot.provider };
    },

    async createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult> {
      const config = await ctx.repo.readConfig();
      const botId = params.botId ?? params.botId;
      if (!botId) {
        throw new Error("Bot id is required.");
      }
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      const code = createCode();
      const expiresAt = Date.now() + (params.ttlMs ?? BOT_BIND_CODE_TTL_MS);
      const allowedWorkspaces = normalizeAllowedWorkspaces(
        params.allowedWorkspaces ?? [ALL_BOT_WORKSPACES],
      );
      ctx.bindCodes.set(code, {
        botId: botId,
        code,
        allowedWorkspaces,
        expiresAt,
      });
      return { code, expiresAt };
    },

    async getGroupMemberNames(params: { botId: string; chatId: string }) {
      const key = getBotConversationKey({ ...params, chatType: "group" });
      const authorize = async () => {
        const bot = findBot(await ctx.repo.readConfig(), params.botId);
        const group = (await ctx.repo.readState()).bots[key]?.group;
        if (
          !bot?.enabled ||
          !bot.providerUserId ||
          !group?.enabled ||
          group.ownerId !== bot.providerUserId
        )
          throw new Error("Group member names are unavailable for this group");
        return { bot, group };
      };
      const before = await authorize();
      const names =
        (await ctx.providers[before.bot.provider]?.getGroupMemberNames?.(
          before.bot,
          params.chatId,
        )) ?? {};
      const after = await authorize();
      // 查询期间停用、重新授权或切换凭据后，旧请求不得将姓名带回新会话。
      if (
        before.group.authorizationId !== after.group.authorizationId ||
        before.bot.providerUserId !== after.bot.providerUserId ||
        before.bot.credentialRef !== after.bot.credentialRef ||
        before.bot.feishuAppId !== after.bot.feishuAppId ||
        before.bot.provider !== after.bot.provider
      )
        throw new Error("Group authorization changed while resolving names");
      return names;
    },

    async handleProviderCallback(provider: BotProvider, payload: unknown) {
      return (await ctx.processProviderCallback(provider, payload)).replies;
    },

    async handleProviderCallbackResponse(provider: BotProvider, payload: unknown) {
      return ctx.processProviderCallback(provider, payload);
    },
  };
}
