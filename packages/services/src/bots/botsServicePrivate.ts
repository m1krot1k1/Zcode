import type { BotsServiceContext } from "./botsServicePorts.js";
import { botsLogger, createOutbound } from "./botsServiceSupport.js";
import { findAuthorizedBot, findBot } from "./botConfigHelpers.js";
import { getBotConversationKey, getBotStateKey } from "./groupSessions.js";
import { getWorkspaceKey, isWorkspaceAllowed } from "./workspaceHelpers.js";
import {
  type BotActor,
  type BotCommand,
  type BotConfig,
  type BotContextState,
  type BotDraftOptions,
  type BotInboundMessage,
  type BotOutboundMessage,
  isFeishuBotProvider,
} from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";

export function createBotsServicePrivate(ctx: BotsServiceContext) {
  function privateSyncSupported(bot: BotConfig): boolean {
    return ["feishu", "lark", "telegram", "weixin"].includes(bot.provider);
  }

  function taskStreamKey(context: BotContextState, actor: BotActor): string {
    return [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
      getBotConversationKey(actor),
    ].join("::");
  }

  async function reconcilePrivateSynchronization(botId: string): Promise<void> {
    const previous = ctx.privateReconciliations.get(botId) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => restorePrivateSynchronization(botId))
      .catch(async (error: unknown) => {
        const bot = findBot(await ctx.repo.readConfig(), botId);
        if (bot) ctx.onDeliveryResult(bot, error instanceof Error ? error.message : String(error));
        botsLogger.warn(undefined, `Private Bot subscription failed bot=${botId}`);
      });
    ctx.privateReconciliations.set(botId, pending);
    try {
      await pending;
    } finally {
      if (ctx.privateReconciliations.get(botId) === pending)
        ctx.privateReconciliations.delete(botId);
    }
  }

  async function restorePrivateSynchronization(botId: string): Promise<void> {
    const bot = findBot(await ctx.repo.readConfig(), botId);
    let context = (await ctx.repo.readState()).bots[botId];
    const recipient =
      bot?.provider === "weixin" ? context?.privateRecipientId : bot?.providerUserId;
    const valid =
      !ctx.shutdownPromise &&
      bot?.enabled &&
      recipient &&
      privateSyncSupported(bot) &&
      context &&
      !context.group &&
      context.mode === "task" &&
      context.activeTaskId &&
      isWorkspaceAllowed(
        context.workspaceId ?? getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
        bot.allowedWorkspaces,
      ) &&
      (await ctx.isRemoteWorkspaceConnected(context));
    if (valid && context && !context.privateBindingId) {
      await ctx.serializeStateWrite(async () => {
        const state = await ctx.repo.readState();
        const latest = state.bots[botId];
        if (latest && !latest.privateBindingId) {
          state.bots[botId] = { ...latest, privateBindingId: randomUUID() };
          await ctx.repo.writeState(state);
        }
      });
      context = (await ctx.repo.readState()).bots[botId];
    }
    const signature = valid
      ? JSON.stringify([
          context?.privateBindingId,
          bot?.provider,
          recipient,
          context?.activeTaskId,
          context?.workspacePath,
          context?.workspaceIdentity,
        ])
      : "";
    const existing = ctx.privateWatches.get(botId);
    if (existing && existing.signature !== signature) {
      ctx.streamSubscriptions.get(existing.key)?.dispose();
      ctx.streamSubscriptions.delete(existing.key);
      ctx.privateWatches.delete(botId);
      ctx.failedPrivateDeliveries.delete(botId);
      const runtime = ctx.runtimeByBotId.get(botId);
      if (runtime)
        ctx.setRuntimeStatus({ ...runtime, deliveryRetryId: undefined, deliveryError: undefined });
    }
    if (!valid || !bot || !context || !signature || ctx.privateWatches.has(botId)) return;
    if (!(await ctx.isRemoteWorkspaceConnected(context))) return;
    const taskService = await ctx.resolveZCodeTaskServiceForContext(context);
    const deleted = await taskService.listDeletedTaskIds?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (deleted?.includes(context.activeTaskId!)) return;
    // 只读取权威快照以冷恢复，不提交输入，也不回放快照中的历史正文。
    await taskService.getTaskSnapshot({
      taskId: context.activeTaskId!,
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      clientMode: "desktop-continuous",
    });
    if (ctx.shutdownPromise) return;
    const actor: BotActor = {
      botId,
      provider: bot.provider,
      providerUserId: recipient!,
      chatType: "private",
    };
    const key = taskStreamKey(context, actor);
    await ctx.watchTaskStream(bot, actor, context, bot);
    ctx.privateWatches.set(botId, { signature, key });
  }

  function weixinContextKey(bot: BotConfig, userId: string): string {
    // 凭证按账号和接收人隔离；不进入普通 Bot 状态或日志。
    return `bot-weixin-context-${createHash("sha256")
      .update(JSON.stringify([bot.id, bot.providerUserId, bot.credentialRef, userId]))
      .digest("hex")}`;
  }

  async function capturePrivateContextToken(message: BotInboundMessage): Promise<void> {
    if (message.actor.provider !== "weixin" || message.actor.chatType !== "private") return;
    const bot = findAuthorizedBot(await ctx.repo.readConfig(), message.actor);
    if (!bot || bot.id !== message.botId) return;
    const context = await ctx.readContext(message.actor, bot);
    if (!context) return;
    // iLink 的 config.providerUserId 是机器人身份，不能把它当成出站接收人。
    await ctx.serializeStateWrite(async () => {
      const state = await ctx.repo.readState();
      const latest = state.bots[bot.id];
      if (!latest) return;
      if (latest.privateRecipientId !== message.actor.providerUserId) {
        state.bots[bot.id] = {
          ...latest,
          privateRecipientId: message.actor.providerUserId,
          privateBindingId: randomUUID(),
        };
        await ctx.repo.writeState(state);
      }
    });
    if (message.actor.providerContextToken)
      await ctx.deps.credentialService.save(
        weixinContextKey(bot, message.actor.providerUserId),
        message.actor.providerContextToken,
      );
    await reconcilePrivateSynchronization(bot.id);
  }

  function stopGroupSynchronization(context: BotContextState): void {
    if (!context.group || !context.activeTaskId) return;
    const key = [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
      getBotStateKey(context),
    ].join("::");
    ctx.streamSubscriptions.get(key)?.dispose();
    ctx.streamSubscriptions.delete(key);
  }

  async function restoreGroupSynchronization(context: BotContextState): Promise<void> {
    if (!context.group?.enabled || !context.activeTaskId || ctx.shutdownPromise) return;
    const bot = findBot(await ctx.repo.readConfig(), context.botId);
    if (
      !bot?.enabled ||
      !isFeishuBotProvider(bot.provider) ||
      bot.providerUserId !== context.group.ownerId
    )
      return;
    // 恢复仅订阅后续事件；远端断开时不建立新连接，也不重放已接收输入。
    if (!(await ctx.isRemoteWorkspaceConnected(context))) return;
    await ctx.watchTaskStream(
      bot,
      {
        botId: bot.id,
        provider: bot.provider,
        chatType: "group",
        chatId: context.group.chatId,
        threadId: context.group.threadId,
        rootMessageId: context.group.rootMessageId,
        providerUserId: context.group.ownerId,
      },
      context,
      { ...bot, currentOptions: context.group.currentOptions, replyMode: "summary_changes" },
    );
  }

  async function handleGroupActivation(
    message: BotInboundMessage,
    enabled: boolean,
  ): Promise<BotOutboundMessage[]> {
    const locale = await ctx.readMessageLocale();
    const config = await ctx.repo.readConfig();
    const bot = findBot(config, message.botId);
    if (
      !bot?.enabled ||
      !isFeishuBotProvider(bot.provider) ||
      message.actor.chatType !== "group" ||
      !message.actor.chatId
    ) {
      return [createOutbound(message.actor, ctx.msg(locale, "privateChatOnly"))];
    }
    if (bot.providerUserId !== message.actor.providerUserId) {
      return [
        {
          ...ctx.administratorReply(
            message.actor,
            bot,
            "owner-command",
            createOutbound(message.actor, ctx.msg(locale, "groupOwnerOnly")),
          ),
          callbackToastOnly: true,
        },
      ];
    }
    // 群启用不等于平台授权；首次与再次启用都提供同一权限入口。
    const activationValues = {
      permissionsUrl:
        bot.provider === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app",
    };
    const key = getBotConversationKey({
      ...message.actor,
      threadId: undefined,
      conversationThreadId: undefined,
    });
    const existing = (await ctx.repo.readState()).bots[key];
    if (existing?.group?.ownerId === bot.providerUserId) {
      if (existing.group.enabled !== enabled) {
        stopGroupSynchronization(existing);
        const updated = {
          ...existing,
          group: { ...existing.group, enabled, authorizationId: randomUUID() },
        };
        await ctx.writeContext(updated, true);
        if (!enabled) await ctx.cancelGroupTopicInputs(message.actor);
        if (enabled) {
          for (const candidate of Object.values((await ctx.repo.readState()).bots)) {
            if (candidate.botId === bot.id && candidate.group?.chatId === message.actor.chatId)
              await restoreGroupSynchronization(candidate);
          }
        }
      }
      return [
        createOutbound(
          message.actor,
          ctx.msg(locale, enabled ? "groupEnabled" : "groupDisabled", activationValues),
        ),
      ];
    }
    if (!enabled) return [createOutbound(message.actor, ctx.msg(locale, "groupDisabled"))];
    const privateContext = await ctx.readContext(
      { ...message.actor, chatType: "private", chatId: undefined },
      bot,
    );
    if (!privateContext)
      return [
        ctx.administratorReply(
          message.actor,
          bot,
          "workspace",
          createOutbound(message.actor, ctx.msg(locale, "noWorkspaceAllowed")),
        ),
      ];
    const inherited = await ctx.buildActiveTaskDraftOptions(privateContext);
    const info = await ctx.providers[bot.provider]?.getGroupInfo?.(bot, message.actor.chatId);
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: privateContext.workspacePath,
      workspaceIdentity: privateContext.workspaceIdentity,
      workspaceId: privateContext.workspaceId,
      mode: "draft",
      activeTaskId: null,
      updatedAt: Date.now(),
      draftOptions: { ...inherited, mode: "default" },
      group: {
        chatId: message.actor.chatId,
        chatMode: info?.chatMode,
        name: info?.name ?? message.actor.chatId,
        ownerId: bot.providerUserId!,
        enabled: true,
        authorizationId: randomUUID(),
        taskIds: [],
        currentOptions: {
          // 模型重构后需继承完整选择，旧 model/thoughtLevel 字段已不再持久化。
          modelSelection: bot.currentOptions.modelSelection,
          mode: "default",
        },
      },
    };
    await ctx.writeContext(context, true);
    return [createOutbound(message.actor, ctx.msg(locale, "groupEnabled", activationValues))];
  }

  async function handleGroupHistory(
    message: BotInboundMessage,
    enabled?: boolean,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    if (!auth.context.group)
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "Topic history is configured in a group."
            : "请在群里配置话题历史读取。",
        ),
      ];
    const key = getBotConversationKey({
      ...message.actor,
      threadId: undefined,
      conversationThreadId: undefined,
    });
    let active = false;
    await ctx.serializeStateWrite(async () => {
      const state = await ctx.repo.readState();
      const parent = state.bots[key];
      if (!parent?.group?.enabled || parent.group.ownerId !== message.actor.providerUserId)
        throw new Error("Group authorization changed");
      if (enabled !== undefined) {
        parent.group.historyEnabled = enabled;
        await ctx.repo.writeState(state);
      }
      if (enabled !== undefined) {
        const key = JSON.stringify([message.botId, parent.group.chatId]);
        ctx.groupHistoryEpoch.set(key, (ctx.groupHistoryEpoch.get(key) ?? 0) + 1);
      }
      active = parent.group.historyEnabled !== false;
    });
    if (enabled === false) await ctx.cancelGroupTopicInputs(message.actor);
    return [
      createOutbound(
        message.actor,
        auth.locale === "en-US"
          ? active
            ? "Topic history enabled. The next topic input reconciles discussion history."
            : "Topic history is off. Topic input is paused."
          : active
            ? "已开启话题历史读取。下次话题输入会补齐讨论历史。"
            : "话题历史读取已关闭，话题输入已暂停。",
      ),
    ];
  }

  async function writeDraftContext(
    context: BotContextState,
    draftOptions?: BotDraftOptions,
  ): Promise<BotContextState> {
    // Bugfix: 新建草稿状态以前散落在 /new 和 /workspace 分支里，各自手写 activeTaskId=null。
    // workspace 切换后如果还带着旧 task/pending permission，Telegram 权限按钮会命中错误上下文。
    // 这里把“进入新任务草稿”的服务端状态变更收口到同一个 helper，避免跨 workspace 复用旧任务状态。
    const draftContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions,
      pendingPermissionOptions: undefined,
      pendingElicitation: undefined,
    };
    if (context.group) {
      const prefix = `${context.botId}::`;
      for (const key of ctx.pendingSelectionsByContext.keys()) {
        if (key.startsWith(prefix) && key.includes(`::${context.group.chatId}::`)) {
          ctx.pendingSelectionsByContext.delete(key);
          ctx.pendingTaskSelectionsByContext.delete(key);
          ctx.pendingWorkspaceSelectionsByContext.delete(key);
        }
      }
    } else ctx.clearPrivatePendingSelectionsForBot(context.botId);
    await ctx.writeContext(draftContext);
    stopGroupSynchronization(context);
    return draftContext;
  }

  async function handleWeixinFirstActivation(
    message: BotInboundMessage,
    command: BotCommand,
  ): Promise<BotOutboundMessage[] | null> {
    if (message.actor.provider !== "weixin" || command.type !== "message") {
      return null;
    }
    const state = await ctx.repo.readState();
    const existing = state.bots[message.botId];
    if (
      existing?.weixinActivatedAt ||
      existing?.draftOptions ||
      existing?.activeTaskId ||
      existing?.pendingPermissionOptions ||
      existing?.pendingElicitation
    ) {
      return null;
    }
    const auth = await ctx.withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    if (auth.context.weixinActivatedAt) {
      return null;
    }
    // Bugfix: 微信扫码登录只返回 bot token/id，不返回可投递的用户 id。
    // 第一条微信入站消息用于建立会话目标，因此只回激活说明，不把“你好”这类激活文本误当成任务 prompt。
    await ctx.writeContext({
      ...auth.context,
      weixinActivatedAt: Date.now(),
    });
    return [
      createOutbound(
        message.actor,
        [
          ctx.msg(auth.locale, "weixinActivatedWelcome"),
          ctx.buildHelpText(auth.locale, auth.bot),
        ].join("\n\n"),
      ),
    ];
  }

  return {
    privateSyncSupported,
    taskStreamKey,
    reconcilePrivateSynchronization,
    restorePrivateSynchronization,
    weixinContextKey,
    capturePrivateContextToken,
    stopGroupSynchronization,
    restoreGroupSynchronization,
    handleGroupActivation,
    handleGroupHistory,
    writeDraftContext,
    handleWeixinFirstActivation,
  };
}
