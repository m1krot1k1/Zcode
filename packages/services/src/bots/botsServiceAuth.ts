import type { BotAuthorizedCommand } from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import { createOutbound, validateBotConfig } from "./botsServiceSupport.js";
import {
  findAuthorizedBot,
  findBot,
  findBoundUser,
  isUserCommandAllowed,
} from "./botConfigHelpers.js";
import { parseBotCommand } from "./commandParser.js";
import { normalizeBotCommandPolicy } from "./config.js";
import {
  canAnswerGroupQuestion,
  getBotConversationKey,
  getBotStateKey,
  isGroupOwnerCommand,
} from "./groupSessions.js";
import {
  getWorkspaceKey,
  getWorkspaceLabel,
  isWorkspaceAllowed,
  normalizeAllowedWorkspaces,
} from "./workspaceHelpers.js";
import {
  type BotConfig,
  type BotContextState,
  type BotInboundMessage,
  type BotOutboundMessage,
  type BotsConfigFile,
  type Locale,
  isFeishuBotProvider,
  normalizeBotReplyGranularity,
} from "@zcode/shared";

export function createBotsServiceAuth(ctx: BotsServiceContext) {
  async function withAuthorizedContext(
    message: BotInboundMessage,
    requestedCommand: BotAuthorizedCommand,
  ): Promise<
    | {
        ok: true;
        config: BotsConfigFile;
        bot: BotConfig;
        user: BotConfig;
        context: BotContextState;
        locale: Locale | undefined;
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    const locale = await ctx.readMessageLocale();
    const config = await ctx.repo.readConfig();
    const bot = findAuthorizedBot(config, message.actor);
    if (!bot || bot.id !== message.botId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, ctx.msg(locale, "botDisabled"))],
      };
    }
    if (message.actor.chatType !== "private" && !isFeishuBotProvider(bot.provider)) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, ctx.msg(locale, "privateChatOnly"))],
      };
    }
    const groupContext =
      message.actor.chatType === "group" ? await ctx.readContext(message.actor, bot) : null;
    if (message.actor.chatType === "group") {
      if (!groupContext?.group?.enabled || groupContext.group.ownerId !== bot.providerUserId) {
        return {
          ok: false,
          reply: [
            {
              ...ctx.administratorReply(
                message.actor,
                bot,
                "group-disabled",
                createOutbound(message.actor, ctx.msg(locale, "groupNotEnabled")),
              ),
              callbackToastOnly: true,
            },
          ],
        };
      }
      if (message.groupCard || message.groupCardAction) {
        const card = message.groupCard;
        if (
          !card ||
          card.chatId !== groupContext.group.chatId ||
          card.threadId !== message.actor.threadId ||
          getBotConversationKey({ botId: bot.id, chatType: "group", ...card }) !==
            getBotStateKey(groupContext) ||
          card.taskId !== groupContext.activeTaskId ||
          card.authorizationId !== groupContext.group.authorizationId
        ) {
          return {
            ok: false,
            reply: [
              {
                ...createOutbound(message.actor, ctx.msg(locale, "elicitationExpired")),
                callbackToastOnly: true,
              },
            ],
          };
        }
      }
      ctx.adminAttention.clear(message.actor, bot.providerUserId, "group-disabled");
      if (
        requestedCommand === "reply" ||
        (isGroupOwnerCommand(requestedCommand) &&
          message.actor.providerUserId !== bot.providerUserId)
      ) {
        return {
          ok: false,
          reply: [
            {
              ...(requestedCommand === "reply"
                ? createOutbound(message.actor, ctx.msg(locale, "groupOwnerOnly"))
                : ctx.administratorReply(
                    message.actor,
                    bot,
                    requestedCommand === "approve" && groupContext.pendingPermissionOptions?.[0]
                      ? `permission:${groupContext.activeTaskId}:${groupContext.pendingPermissionOptions[0].requestId}`
                      : "owner-command",
                    createOutbound(message.actor, ctx.msg(locale, "groupOwnerOnly")),
                  )),
              callbackToastOnly: true,
            },
          ],
        };
      }
    }
    if (
      groupContext &&
      message.actor.providerUserId === bot.providerUserId &&
      isGroupOwnerCommand(requestedCommand)
    ) {
      ctx.adminAttention.clear(message.actor, bot.providerUserId, "owner-command");
    }
    const user = groupContext
      ? {
          ...bot,
          currentOptions: groupContext.group!.currentOptions,
          replyMode: "summary_changes" as const,
        }
      : findBoundUser(bot, message.actor);
    if (!user) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, ctx.msg(locale, "userNotBound"))],
      };
    }
    if (!isUserCommandAllowed(user, requestedCommand)) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, ctx.msg(locale, "commandNotAllowed"))],
      };
    }
    if (groupContext?.group) {
      const parsed = parseBotCommand(message.commandText ?? message.text);
      const isAnswer =
        message.senderType !== "app" &&
        (Boolean(message.elicitationResponse) ||
          parsed.type === "elicitation.respond" ||
          parsed.type === "elicitation.submit");
      if (
        isAnswer &&
        !canAnswerGroupQuestion(
          message.actor.providerUserId,
          groupContext.group.ownerId,
          groupContext.group.initiatorId,
          groupContext.pendingElicitation?.renderContext?.kind === "plan_approval",
        )
      ) {
        return {
          ok: false,
          reply: [
            {
              ...(groupContext.pendingElicitation?.renderContext?.kind === "plan_approval"
                ? ctx.administratorReply(
                    message.actor,
                    bot,
                    `plan:${groupContext.activeTaskId}:${groupContext.pendingElicitation.requestId}`,
                    createOutbound(message.actor, ctx.msg(locale, "groupOwnerOnly")),
                  )
                : createOutbound(message.actor, ctx.msg(locale, "groupOwnerOnly"))),
              callbackToastOnly: true,
            },
          ],
        };
      }
    }
    const context = groupContext ?? (await ctx.readContext(message.actor, bot));
    if (!context) {
      return {
        ok: false,
        reply: [
          ctx.administratorReply(
            message.actor,
            bot,
            "workspace",
            createOutbound(message.actor, ctx.msg(locale, "noWorkspaceAllowed")),
          ),
        ],
      };
    }
    const synced = context.group
      ? { config, bot, user }
      : await ctx.normalizeBotWorkspaceConfig(config, bot, {
          id:
            context.workspaceId ??
            getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
          label: getWorkspaceLabel(context.workspacePath),
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        });
    if (
      context.workspaceId &&
      !isWorkspaceAllowed(context.workspaceId, synced.user.allowedWorkspaces)
    ) {
      return {
        ok: false,
        reply: [
          ctx.administratorReply(
            message.actor,
            bot,
            "workspace",
            createOutbound(message.actor, ctx.msg(locale, "workspaceOutOfScope")),
          ),
        ],
      };
    }
    const remoteDisconnectedReply = await ctx.blockDisconnectedRemoteWorkspace({
      message,
      context,
      locale,
      requestedCommand,
    });
    if (remoteDisconnectedReply) {
      return { ok: false, reply: remoteDisconnectedReply };
    }
    if (isFeishuBotProvider(bot.provider) && !context.group) {
      // Bugfix: 飞书短命令 typing 现在由同步回复完成后显式删除。
      // 这里必须等 reaction 创建完成，否则 stopInboundTyping 可能先执行，最终留下无法清理的 Typing reaction。
      await ctx.sendTyping(bot, message.actor);
    } else if (!context.group) {
      void ctx.sendTyping(bot, message.actor);
    }
    return {
      ok: true,
      config: synced.config,
      bot: synced.bot,
      user: groupContext ? user : synced.user,
      context,
      locale,
    };
  }

  async function handleBind(
    message: BotInboundMessage,
    code: string,
  ): Promise<BotOutboundMessage[]> {
    const locale = await ctx.readMessageLocale();
    if (message.actor.chatType !== "private") {
      return [createOutbound(message.actor, ctx.msg(locale, "bindPrivateOnly"))];
    }
    const record = ctx.bindCodes.get(code.trim().toUpperCase());
    if (!record || record.expiresAt <= Date.now() || record.botId !== message.botId) {
      return [createOutbound(message.actor, ctx.msg(locale, "bindCodeInvalid"))];
    }
    const config = await ctx.repo.readConfig();
    const bot = findBot(config, record.botId);
    if (!bot) {
      return [createOutbound(message.actor, ctx.msg(locale, "bindBotMissing"))];
    }
    // Bot 配置化后 /bind 只绑定当前 bot，不再向 bot 追加 allowedUsers。
    // 重新绑定会覆盖旧 providerUserId，保证一个 bot 同一时间只有一个沟通对象。
    const nextBot: BotConfig = {
      ...bot,
      providerUserId: message.actor.providerUserId,
      displayName: message.actor.displayName,
      allowedWorkspaces: normalizeAllowedWorkspaces(record.allowedWorkspaces),
      allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
      replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
    };
    validateBotConfig(config, nextBot);
    await ctx.writeBotConfig({
      ...config,
      bots: config.bots.map((item) => (item.id === nextBot.id ? nextBot : item)),
    });
    ctx.bindCodes.delete(record.code);
    return [
      createOutbound(
        message.actor,
        [ctx.msg(locale, "bindSuccess"), ctx.buildHelpText(locale, nextBot)].join("\n\n"),
      ),
    ];
  }

  return {
    withAuthorizedContext,
    handleBind,
  };
}
