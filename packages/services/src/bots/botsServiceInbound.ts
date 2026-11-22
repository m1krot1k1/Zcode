import type { BotsServiceContext } from "./botsServicePorts.js";
import { createOutbound, groupCardFor } from "./botsServiceSupport.js";
import { findBot } from "./botConfigHelpers.js";
import type { IBotsService } from "./bots.js";
import { parseBotCommand } from "./commandParser.js";
import { getBotConversationKey } from "./groupSessions.js";
import type { BotActor, BotInboundMessage } from "@zcode/shared";
import { randomUUID } from "node:crypto";

export function createBotsServiceInbound(ctx: BotsServiceContext): Partial<IBotsService> {
  return {
    async handleInboundMessage(message: BotInboundMessage) {
      if (ctx.shutdownPromise) return [];
      if (message.senderType === "app") {
        // 机器人只能使用真人已启用的群/话题；原生 @ 可触发普通群输入，不能获取控制权限。
        if (
          message.actor.chatType !== "group" ||
          message.groupCardAction ||
          message.elicitationResponse
        )
          return [];
        const topic = (await ctx.repo.readState()).bots[
          getBotConversationKey({ ...message.actor, conversationThreadId: undefined })
        ];
        if (!topic?.group?.enabled) return [];
        if (message.actor.threadId) {
          if (topic.group.topicActive !== true) return [];
        } else if (message.mentionedBot !== true || topic.group.chatMode === "topic") {
          return [];
        }
      }
      message = {
        ...message,
        actor: { ...message.actor, mentionedBot: message.mentionedBot === true },
      };
      if (
        message.actor.chatType === "group" &&
        message.mentionedBot === false &&
        !message.groupCardAction
      ) {
        const topic = (await ctx.repo.readState()).bots[
          getBotConversationKey({ ...message.actor, conversationThreadId: undefined })
        ];
        if (
          !message.actor.threadId ||
          topic?.group?.topicActive === false ||
          (!topic?.group?.topicActive &&
            message.topicRootIsCurrentBot !== true &&
            !ctx.topicContinuations.has(getBotConversationKey(message.actor)))
        )
          return [];
      }

      if (message.actor.chatType === "group" && message.actor.threadId) {
        const actor: BotActor = { ...message.actor, conversationThreadId: undefined };
        const state = await ctx.repo.readState();
        if (!state.bots[getBotConversationKey(actor)]) {
          // alias 仅用于一次性安全迁移检查，不能再把话题路由到默认任务。
          for (const candidate of Object.values(state.bots)) {
            const group = candidate.group;
            if (!group || candidate.botId !== actor.botId || group.chatId !== actor.chatId)
              continue;
            const alias = group.topicAliases?.[actor.threadId!];
            if (!alias) continue;
            // 默认会话可能已切换工作区；迁移检查必须使用旧任务自己的完整工作区身份。
            const workspace = group.taskWorkspaces?.[alias.taskId] ?? candidate;
            const service = await ctx.resolveZCodeTaskServiceForContext({
              ...candidate,
              ...workspace,
            });
            if (
              !service.getBotGroupTaskBlockReason ||
              (await service.getBotGroupTaskBlockReason({
                taskId: alias.taskId,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
              }))
            ) {
              return [createOutbound(actor, "原话题任务仍在执行，请结束后重新接入话题。")];
            }
          }
        }
        message = { ...message, actor };
      }
      if (message.actor.chatType === "group" && !message.groupCardAction) {
        const parent = (await ctx.repo.readState()).bots[
          getBotConversationKey({
            ...message.actor,
            threadId: undefined,
            conversationThreadId: undefined,
          })
        ];
        // 专用话题群根事件可能缺失 thread_id，必须通过原生消息解析，不能进入默认任务。
        if (
          parent?.group?.enabled &&
          parent.group.chatMode === "topic" &&
          !message.actor.threadId
        ) {
          const bot = findBot(await ctx.repo.readConfig(), message.botId);
          const resolve = bot && ctx.providers[bot.provider]?.resolveTopic;
          if (!bot || !resolve) throw new Error("Topic routing is unavailable");
          message = {
            ...message,
            actor: { ...message.actor, ...(await resolve(bot, message.actor)) },
          };
        }
      }
      if (
        message.actor.chatType === "group" &&
        !message.groupCardAction &&
        !message.elicitationResponse &&
        message.mentionedBot === false &&
        message.contentParts?.some((part) => part.type === "channelMention")
      ) {
        // 已接入话题曾把发给别人的任务也当成新指令；只记录补读边界，不触发停止或 CLI admission。
        if (message.actor.threadId)
          await ctx.serializeStateWrite(async () => {
            const state = await ctx.repo.readState();
            const current = state.bots[getBotConversationKey(message.actor)];
            if (!current?.group?.enabled || current.group.topicActive !== true) return;
            const accepted = Object.values(current.group.inputs ?? {}).filter(
              (input) => input.admission === "accepted",
            );
            current.group.backgroundHistory = {
              revision: randomUUID(),
              checkpoint: current.group.backgroundHistory
                ? current.group.backgroundHistory.checkpoint
                : accepted.at(-1)?.source.messageId,
            };
            await ctx.repo.writeState(state);
          });
        return [];
      }
      // 机器人生成的 slash/审批文字只能作为输入材料，不能进入控制分支。
      const commandType =
        message.senderType === "app"
          ? "message"
          : parseBotCommand(message.commandText ?? message.text).type;
      const isGroupControl =
        message.actor.chatType === "group" &&
        (Boolean(message.elicitationResponse) ||
          [
            "queue.cancel",
            "stop",
            "topic.leave",
            "permission.respond",
            "approve",
            "deny",
            "elicitation.respond",
            "elicitation.submit",
          ].includes(commandType));
      const processInbound = async () => {
        await ctx.capturePrivateContextToken(message);
        if (message.elicitationResponse) {
          return ctx.handleStructuredElicitationResponse(message, message.elicitationResponse);
        }
        const parsedCommand = parseBotCommand(message.commandText ?? message.text);
        // 群主聊天也会进入此分发器；仅改外层 commandType 不能阻止机器人触发控制/数字选择。
        const command =
          message.senderType === "app"
            ? ({ type: "message", text: message.text } as const)
            : parsedCommand.type === "message"
              ? (ctx.resolvePendingSelectionCommand(message.actor, parsedCommand.text) ??
                parsedCommand)
              : parsedCommand.type === "selection.cancel" &&
                  message.actor.provider !== "weixin" &&
                  (message.commandText ?? message.text).trim() === "0"
                ? (ctx.clearPendingSelection(message.actor),
                  { type: "message", text: message.text } as const)
                : parsedCommand;
        const weixinActivationReply = await ctx.handleWeixinFirstActivation(message, command);
        if (weixinActivationReply) {
          await ctx.capturePrivateContextToken(message);
          return weixinActivationReply;
        }
        switch (command.type) {
          case "queue.cancel":
            return ctx.cancelGroupInput(message, command.commandId);
          case "group.enable":
            return ctx.handleGroupActivation(message, true);
          case "group.disable":
            return ctx.handleGroupActivation(message, false);
          case "group.history":
            return ctx.handleGroupHistory(message, command.enabled);
          case "selection.cancel":
            return ctx.handleSelectionCancel(message);
          case "bind":
            return ctx.handleBind(message, command.code);
          case "help":
            return ctx.handleHelp(message);
          case "status":
            return ctx.handleStatus(message);
          case "reconnect":
            return ctx.handleReconnect(message);
          case "new":
            return ctx.handleNewCommand(message, command);
          case "workspace.list":
            return ctx.handleWorkspaceListCommand(message, command);
          case "workspace.set":
            return ctx.handleWorkspaceSetCommand(message, command);
          case "model.list":
            return ctx.handleModelListCommand(message, command);
          case "model.provider.set":
            return ctx.handleModelProviderSetCommand(message, command);
          case "model.set":
            return ctx.handleModelSetCommand(message, command);
          case "mode.list":
          case "thoughtLevel.list":
            return ctx.handleConfigListCommand(message, command);
          case "mode.set":
          case "thoughtLevel.set":
            return ctx.handleConfigSetCommand(message, command);
          case "task.list":
            return ctx.handleTaskList(message);
          case "task.set":
            return ctx.handleTaskSetCommand(message, command);
          case "reply.list":
            return ctx.handleReplyListCommand(message, command);
          case "reply.set":
            return ctx.handleReplySetCommand(message, command);
          case "topic.leave":
            return ctx.handleTopicLeaveCommand(message, command);
          case "stop":
            return ctx.handleStopCommand(message, command);
          case "permission.respond":
            return ctx.handlePermissionRespondCommand(message, command);
          case "elicitation.respond":
            return ctx.handleElicitationRespondCommand(message, command);
          case "elicitation.submit":
            return ctx.handleElicitationSubmitCommand(message, command);
          case "approve":
            return ctx.handleApproveCommand(message, command);
          case "deny":
            return ctx.handleDenyCommand(message, command);
          case "unknown":
            return ctx.handleUnknownCommand(message, command);
          case "message":
            return ctx.handleMessage(message);
        }
      };
      if (!(await ctx.admitAutoReplyTurn(message))) return [];
      const replies =
        message.actor.chatType === "group" && message.actor.threadId && commandType === "message"
          ? await ctx.receiveTopicMessage(message)
          : await ctx.enqueueInboundProcessing(message.actor, processInbound, isGroupControl);
      if (message.actor.chatType !== "group") return replies;
      const current = (await ctx.repo.readState()).bots[getBotConversationKey(message.actor)];
      return replies.map((reply) =>
        reply.selection && current?.group?.authorizationId
          ? {
              ...reply,
              threadId: message.actor.threadId ?? current.group.threadId,
              rootMessageId: message.actor.rootMessageId ?? current.group.rootMessageId,
              groupCard: groupCardFor(message.actor, current),
            }
          : reply,
      );
    },
  };
}
