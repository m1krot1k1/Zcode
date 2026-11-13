import type { BotsServiceContext } from "./botsServicePorts.js";
import { botsLogger } from "./botsServiceSupport.js";
import { findBot } from "./botConfigHelpers.js";
import type { IBotsService } from "./bots.js";
import { getBotConversationKey } from "./groupSessions.js";
import { getWorkspaceKey } from "./workspaceHelpers.js";
import { replyToBotChannel } from "#src/bots/channelReply.js";
import { authorizeTopicResource, readAuthorizedTopicResource } from "#src/bots/topicResource.js";
import { Buffer } from "node:buffer";

export function createBotsServiceApiTopics(ctx: BotsServiceContext): Partial<IBotsService> {
  return {
    async validateTopicResource(params) {
      await authorizeTopicResource(params, {
        readState: () => ctx.repo.readState(),
        readConfig: () => ctx.repo.readConfig(),
      });
    },

    async readTopicResource(params) {
      botsLogger.debug(
        `topic resource read task=${params.taskId} message=${params.messageId} trace=${params.trace?.traceId ?? "none"}`,
      );
      const result = await readAuthorizedTopicResource(params, {
        readState: () => ctx.repo.readState(),
        readConfig: () => ctx.repo.readConfig(),
        readMessage: async (bot, target, signal) => {
          const reader = ctx.providers[bot.provider]?.readTopicResourceMessage;
          if (!reader) throw new Error("Topic resource provider unavailable");
          return reader(bot, target, signal);
        },
        download: async (bot, attachment, target, signal) => {
          const result = await ctx.providers[bot.provider]?.downloadAttachment?.(
            bot,
            attachment,
            {
              botId: bot.id,
              provider: bot.provider,
              chatType: "group",
              chatId: target.chatId,
              threadId: target.threadId,
              providerUserId: bot.providerUserId!,
              providerMessageId: target.messageId,
            },
            signal,
          );
          if (!result) throw new Error("Topic resource download unavailable");
          return result;
        },
      });
      if (result.attachment.kind !== "file" && result.attachment.kind !== "image")
        throw new Error("Topic resource format unsupported");
      return {
        kind: result.attachment.kind,
        filename: result.attachment.filename,
        mimeType: result.attachment.mimeType || "application/octet-stream",
        sizeBytes: result.data.byteLength,
        dataBase64: Buffer.from(result.data).toString("base64"),
      };
    },

    async getTopicDetails(params) {
      const state = await ctx.repo.readState();
      const context =
        state.bots[
          getBotConversationKey({
            botId: params.botId,
            chatId: params.chatId,
            chatType: "group",
            threadId: params.threadId,
          })
        ];
      const workspace = context?.group?.taskWorkspaces?.[params.taskId] ?? context;
      if (
        !context?.group?.taskIds.includes(params.taskId) ||
        !workspace ||
        (workspace.workspaceIdentity?.trim() || workspace.workspacePath) !==
          (params.workspaceIdentity?.trim() || params.workspacePath)
      )
        throw new Error("Topic task scope mismatch");
      const bot = findBot(await ctx.repo.readConfig(), params.botId);
      if (!bot || context.group.ownerId !== bot.providerUserId)
        throw new Error("Topic owner scope mismatch");
      const batches = Object.values(context.group.inputs ?? {})
        .filter((input) => input.taskId === params.taskId && input.admission === "accepted")
        .flatMap((input) => (input.source.topicContext ? [input.source.topicContext] : []));
      const parent =
        state.bots[
          getBotConversationKey({ botId: params.botId, chatId: params.chatId, chatType: "group" })
        ];
      const service = await ctx.resolveZCodeTaskServiceForContext({ ...context, ...workspace });
      const summaries =
        (await service.readBotTopicSummaries?.({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })) ?? [];
      return {
        messageCount: new Set(batches.flatMap((batch) => batch.messages.map((record) => record.id)))
          .size,
        hasGap: batches.some((batch) => batch.hasGap),
        historyEnabled: parent?.group?.historyEnabled !== false,
        summaries,
      };
    },

    async retryTopicPreparation(params) {
      const key = getBotConversationKey({ ...params, chatType: "group" });
      const context = (await ctx.repo.readState()).bots[key];
      const bot = findBot(await ctx.repo.readConfig(), params.botId);
      if (!bot?.enabled || !context?.group?.enabled || context.group.ownerId !== bot.providerUserId)
        throw new Error("Topic preparation target is no longer authorized");
      if (context.activeTaskId !== params.taskId) throw new Error("Topic preparation task changed");
      if (
        getWorkspaceKey(context.workspacePath, context.workspaceIdentity) !==
        getWorkspaceKey(params.workspacePath, params.workspaceIdentity)
      )
        throw new Error("Topic preparation workspace changed");
      await ctx.topicContinuations.get(key)?.settled();
      // 已提交命令只能查询原接收结果；材料重试不能绕过去重，留下永久准备状态。
      const latest = (await ctx.repo.readState()).bots[key];
      if (
        Object.values(latest?.group?.inputs ?? {}).some(
          (input) =>
            input.source.messageId === params.messageId ||
            input.source.messages?.some((original) => original.messageId === params.messageId),
        )
      )
        throw new Error("Topic input was already submitted; preparation cannot be retried");
      const message = ctx.topicPreparation.retry(key, params.messageId);
      if (!message) throw new Error("Topic preparation is no longer retryable");
      ctx.topicPreparation.update(key, [params.messageId], "preparing");
      await ctx.publishTopicPreparation();
      const replies = await ctx.service.handleInboundMessage(message);
      for (const reply of replies) await ctx.sendOutbound(bot, reply);
    },

    async replyToChannel(request) {
      return replyToBotChannel(request, {
        readState: () => ctx.repo.readState(),
        readConfig: () => ctx.repo.readConfig(),
        listMembers: async (bot, chatId) => {
          const read = ctx.providers[bot.provider]?.getGroupMemberNames;
          if (!read) throw new Error("Channel member lookup unavailable");
          return read(bot, chatId);
        },
        deliver: (bot, chatId, threadId, result) =>
          ctx.getGroupDeliverySender(bot, chatId, threadId)(result),
      });
    },

    async getBotStates() {
      return Object.entries((await ctx.repo.readState()).bots).map(([key, context]) => {
        if (context.group)
          context = {
            ...context,
            group: { ...context.group, preparation: ctx.topicPreparation.snapshot(key) },
          };
        const sender = ctx.groupDeliverySenders.get(key);
        if (!context.group || !sender) return context;
        return {
          ...context,
          group: {
            ...context.group,
            deliveries: Object.fromEntries(
              Object.entries(context.group.deliveries ?? {}).map(([id, result]) => [
                id,
                sender.project(result),
              ]),
            ),
          },
        };
      });
    },
  };
}
