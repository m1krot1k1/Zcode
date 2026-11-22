import type { BotsServiceContext } from "./botsServicePorts.js";
import { findBot } from "./botConfigHelpers.js";
import { getBotConversationKey, getBotStateKey } from "./groupSessions.js";
import {
  createWorkspaceRef,
  firstAllowedWorkspace,
  getWorkspaceKey,
  normalizeConfiguredAllowedWorkspaces,
} from "./workspaceHelpers.js";
import type {
  BotActor,
  BotConfig,
  BotContextState,
  BotRuntimeInfo,
  BotsConfigFile,
} from "@zcode/shared";
import { readProjectCatalog } from "#src/project-catalog/index.js";
import { randomUUID } from "node:crypto";

export function createBotsServiceState(ctx: BotsServiceContext) {
  function onDeliveryResult(bot: BotConfig, deliveryError: string | undefined): void {
    // 收消息正常不代表回复已投递，不能把投递错误混成连接错误。
    const current = ctx.runtimeByBotId.get(bot.id);
    setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: current?.status ?? (bot.enabled ? "idle" : "disabled"),
      deliveryError:
        deliveryError ??
        (ctx.failedPrivateDeliveries.has(bot.id) ? current?.deliveryError : undefined),
    });
  }

  function setRuntimeStatus(status: BotRuntimeInfo): void {
    ctx.runtimeByBotId.set(status.botId, {
      ...ctx.runtimeByBotId.get(status.botId),
      ...status,
      lastUpdateAt: Date.now(),
    });
  }

  async function readTelegramOffset(botId: string): Promise<number | undefined> {
    return (await ctx.repo.readState()).bots[botId]?.telegramOffset;
  }

  async function writeTelegramOffset(botId: string, offset: number): Promise<void> {
    await updateProviderCursor(botId, { telegramOffset: offset });
  }

  async function readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined> {
    return (await ctx.repo.readState()).bots[botId]?.weixinGetUpdatesBuf;
  }

  async function writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void> {
    await updateProviderCursor(botId, { weixinGetUpdatesBuf: buf });
  }

  async function updateProviderCursor(
    botId: string,
    patch: Pick<BotContextState, "telegramOffset" | "weixinGetUpdatesBuf">,
  ): Promise<void> {
    const bot = findBot(await ctx.repo.readConfig(), botId);
    if (!bot) return;
    const context = await readContext(
      {
        botId,
        chatType: "private",
        provider: bot.provider,
        providerUserId: bot.providerUserId ?? "",
      },
      bot,
    );
    if (!context) return;
    await serializeStateWrite(async () => {
      await ctx.repo.updateContext(botId, (current) =>
        current ? { ...current, ...patch, updatedAt: Date.now() } : undefined,
      );
    });
  }

  async function readContext(actor: BotActor, bot: BotConfig): Promise<BotContextState | null> {
    await ctx.ensureBotStorageMigrated();
    const state = await ctx.repo.readState();
    const existing = state.bots[getBotConversationKey(actor)];
    if (existing) {
      if (existing.hostId !== undefined) return existing;
      // 旧 SSH alias 必须先由可信 Host 解析，再匹配项目；不能以相同路径猜测 Source。
      const resolved = await ctx.normalizeWorkspaceRef(
        createWorkspaceRef(existing.workspacePath, existing.workspaceIdentity),
      );
      const next = ctx.upgradeLegacyContext(
        {
          ...existing,
          workspacePath: resolved.workspacePath,
          workspaceIdentity: resolved.workspaceIdentity,
        },
        await readProjectCatalog(ctx.deps),
      );
      return (
        (await ctx.repo.updateContext(getBotConversationKey(actor), (current) =>
          current?.hostId !== undefined ? current : { ...current, ...next },
        )) ?? null
      );
    }
    if (actor.chatType === "group") {
      if (!actor.threadId) return null;
      const parent =
        state.bots[
          getBotConversationKey({ ...actor, threadId: undefined, conversationThreadId: undefined })
        ];
      if (!parent?.group?.enabled || parent.group.ownerId !== bot.providerUserId) return null;
      let topicTitle = actor.topicTitle;
      let topicUrl = actor.topicUrl;
      let rootMessageId = actor.rootMessageId;
      if (!topicTitle && actor.providerMessageId) {
        try {
          const resolved = await ctx.providers[bot.provider]?.resolveTopic?.(bot, actor);
          topicTitle = resolved?.topicTitle;
          topicUrl = resolved?.topicUrl;
          rootMessageId = resolved?.rootMessageId ?? rootMessageId;
        } catch {
          // 原生事件已带话题身份时，缺少额外读取权限仅影响标题；不扩大历史读取范围。
          topicTitle = actor.threadId;
        }
      }
      // 话题只继承配置快照；不能复制默认任务的输入、问答或审批授权。
      const topic: BotContextState = {
        botId: bot.id,
        workspacePath: parent.workspacePath,
        workspaceIdentity: parent.workspaceIdentity,
        workspaceId: parent.workspaceId,
        projectId: parent.projectId,
        hostId: parent.hostId,
        additionalDirectories: parent.additionalDirectories,
        mode: "draft",
        activeTaskId: null,
        updatedAt: Date.now(),
        draftOptions: { ...(await ctx.buildActiveTaskDraftOptions(parent)), mode: "default" },
        group: {
          chatId: parent.group.chatId,
          threadId: actor.threadId,
          rootMessageId,
          topicTitle,
          topicUrl,
          name: parent.group.name,
          ownerId: parent.group.ownerId,
          enabled: true,
          authorizationId: parent.group.authorizationId,
          taskIds: [],
          currentOptions: { ...parent.group.currentOptions, mode: "default" },
        },
      };
      await serializeStateWrite(async () => {
        const latest = await ctx.repo.readState();
        const currentParent = latest.bots[getBotStateKey(parent)];
        const key = getBotStateKey(topic);
        if (
          latest.bots[key] ||
          !currentParent?.group?.enabled ||
          currentParent.group.authorizationId !== topic.group!.authorizationId
        )
          return;
        latest.bots[key] = topic;
        await ctx.repo.writeState(latest);
      });
      return (await ctx.repo.readState()).bots[getBotStateKey(topic)] ?? null;
    }
    const workspaces = await ctx.listWorkspaceRefs();
    const workspace = firstAllowedWorkspace(workspaces, {
      ...bot,
      allowedWorkspaces: normalizeConfiguredAllowedWorkspaces(bot.allowedWorkspaces, workspaces),
    });
    if (!workspace) return null;
    const execution = await ctx.bindProject(workspace);
    const context: BotContextState = {
      botId: bot.id,
      ...execution,
      mode: "draft",
      activeTaskId: null,
      draftOptions: await ctx.buildInitializedDraftOptions(execution),
      updatedAt: Date.now(),
    };
    return (
      (await ctx.repo.updateContext(bot.id, (current) =>
        current?.hostId !== undefined ? current : { ...current, ...context },
      )) ?? null
    );
  }

  async function readQueueCardScope(key: string) {
    const [botId, chatId, taskId, authorizationId, inputId, threadId] = JSON.parse(key) as string[];
    const state = await ctx.repo.readState();
    const context =
      state.bots[getBotConversationKey({ botId: botId!, chatType: "group", chatId, threadId })];
    const bot = findBot(await ctx.repo.readConfig(), botId!);
    const input = context?.group?.inputs?.[inputId!];
    if (
      !bot?.enabled ||
      !context?.group?.enabled ||
      context.group.ownerId !== bot.providerUserId ||
      context.group.authorizationId !== authorizationId ||
      context.activeTaskId !== taskId ||
      input?.taskId !== taskId
    )
      return undefined;
    return { state, context, bot, input };
  }

  function serializeStateWrite(operation: () => Promise<void>): Promise<void> {
    const next = ctx.stateWriteTail.catch(() => undefined).then(operation);
    ctx.stateWriteTail = next;
    return next;
  }

  async function writeBotConfig(next: BotsConfigFile): Promise<BotsConfigFile> {
    const invalidatedTopics: BotActor[] = [];
    const previous = await ctx.repo.readConfig();
    const saved = await ctx.repo.writeConfig(next);
    const changedBindings = new Set(
      previous.bots
        .filter((before) => {
          const after = saved.bots.find((bot) => bot.id === before.id);
          return (
            !after ||
            before.providerUserId !== after.providerUserId ||
            before.provider !== after.provider ||
            before.feishuAppId !== after.feishuAppId ||
            before.credentialRef !== after.credentialRef
          );
        })
        .map((bot) => bot.id),
    );
    const operation = ctx.stateWriteTail
      .catch(() => undefined)
      .then(async () => {
        const state = await ctx.repo.readState();
        let changed = false;
        for (const [key, context] of Object.entries(state.bots)) {
          const group = context.group;
          if (!group) {
            const before = previous.bots.find((item) => item.id === context.botId);
            const after = saved.bots.find((item) => item.id === context.botId);
            if (changedBindings.has(context.botId) || before?.enabled !== after?.enabled) {
              if (
                changedBindings.has(context.botId) &&
                before?.provider === "weixin" &&
                context.privateRecipientId
              )
                await ctx.deps.credentialService.delete(
                  ctx.weixinContextKey(before, context.privateRecipientId),
                );
              state.bots[key] = {
                ...context,
                privateBindingId: randomUUID(),
                ...(changedBindings.has(context.botId) ? { privateRecipientId: undefined } : {}),
              };
              changed = true;
            }
            continue;
          }
          const current = saved.bots.find((bot) => bot.id === context.botId);
          if (!changedBindings.has(context.botId) && current?.providerUserId === group.ownerId)
            continue;
          const originalBot = previous.bots.find((bot) => bot.id === context.botId);
          if (group.threadId && originalBot)
            invalidatedTopics.push({
              botId: context.botId,
              provider: originalBot.provider,
              chatType: "group",
              chatId: group.chatId,
              threadId: group.threadId,
              providerUserId: group.ownerId,
            });
          state.bots[key] = {
            ...context,
            group: {
              ...group,
              enabled: false,
              authorizationId: randomUUID(),
              deliveries: Object.fromEntries(
                Object.entries(group.deliveries ?? {}).map(([id, result]) => [
                  id,
                  result.status === "sent" ? result : { ...result, status: "invalidated" as const },
                ]),
              ),
            },
          };
          changed = true;
        }
        if (changed) await ctx.repo.writeState(state);
      });
    ctx.stateWriteTail = operation;
    await operation;
    // 授权变更还必须失效尚未提交的材料，不能等旧准备返回后再生成回复。
    await Promise.all(invalidatedTopics.map(ctx.cancelTopicInputs));
    if (changedBindings.size)
      await ctx.deps.broadcastService
        ?.send({ channel: "bots:group-state", payload: {} })
        .catch(() => undefined);
    for (const botId of new Set([...previous.bots, ...saved.bots].map((item) => item.id)))
      await ctx.reconcilePrivateSynchronization(botId);
    return saved;
  }

  async function writeContext(
    context: BotContextState,
    updateAuthorization = false,
    expectedTaskId?: string | null,
  ): Promise<void> {
    const next = ctx.stateWriteTail
      .catch(() => undefined)
      .then(async () => {
        const state = await ctx.repo.readState();
        const key = getBotStateKey(context);
        const latest = state.bots[key];
        const latestGroup = latest?.group;
        if (
          !context.group &&
          expectedTaskId !== undefined &&
          (latest?.activeTaskId !== expectedTaskId ||
            latest?.privateBindingId !== context.privateBindingId)
        )
          return;
        // 群事件可能在停用、换绑或切换任务前开始处理；旧事件不能恢复已经撤销的关联。
        if (
          context.group &&
          !updateAuthorization &&
          latestGroup &&
          (latestGroup.authorizationId !== context.group.authorizationId ||
            (expectedTaskId !== undefined && latest?.activeTaskId !== expectedTaskId))
        )
          return;
        const group =
          context.group && latestGroup && !updateAuthorization
            ? {
                ...context.group,
                enabled: latestGroup.enabled,
                ownerId: latestGroup.ownerId,
                authorizationId: latestGroup.authorizationId,
                // 其他话题可能已更新群级历史开关，旧输入回写不能覆盖最新配置。
                historyEnabled: latestGroup.historyEnabled,
                topicActive: latestGroup.topicActive ?? context.group.topicActive,
                taskIds: [...new Set([...latestGroup.taskIds, ...context.group.taskIds])],
                // 已确认的 admission 是终态，迟到的流事件不能写回 pending。
                inputs: Object.fromEntries(
                  Object.entries({ ...latestGroup.inputs, ...context.group.inputs }).map(
                    ([id, input]) => {
                      const latestInput = latestGroup.inputs?.[id];
                      const selected =
                        latestInput?.admission === "accepted" ||
                        latestInput?.admission === "rejected"
                          ? latestInput
                          : input;
                      // 流事件可能先于 admission 返回；写回接收结果时保留已推进的卡片状态。
                      return [
                        id,
                        { ...selected, progress: latestInput?.progress ?? selected.progress },
                      ];
                    },
                  ),
                ),
                taskWorkspaces: { ...latestGroup.taskWorkspaces, ...context.group.taskWorkspaces },
                topicAliases: latestGroup.topicAliases,
                deliveries: latestGroup.deliveries,
              }
            : context.group;
        // 自动互答次数由入口串行持久化；迟到的任务/授权回写不能用旧快照恢复额度。
        if (group && latestGroup?.autoReplyGuard) group.autoReplyGuard = latestGroup.autoReplyGuard;
        // 背景检查点由入口/接收提交更新，旧任务快照不能覆盖或复活它。
        if (group && latestGroup) group.backgroundHistory = latestGroup.backgroundHistory;
        if (group && (!group.enabled || state.bots[key]?.activeTaskId !== context.activeTaskId)) {
          group.deliveries = Object.fromEntries(
            Object.entries(group.deliveries ?? {}).map(([id, entry]) => [
              id,
              entry.status === "sent" ? entry : { ...entry, status: "invalidated" as const },
            ]),
          );
        }
        const taskIds =
          group && context.activeTaskId
            ? [...new Set([...group.taskIds, context.activeTaskId])]
            : group?.taskIds;
        state.bots[key] = {
          ...context,
          telegramOffset: latest?.telegramOffset ?? context.telegramOffset,
          weixinGetUpdatesBuf: latest?.weixinGetUpdatesBuf ?? context.weixinGetUpdatesBuf,
          ...(!group
            ? {
                privateBindingId:
                  latest?.activeTaskId === context.activeTaskId &&
                  getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity) ===
                    getWorkspaceKey(context.workspacePath, context.workspaceIdentity)
                    ? (latest.privateBindingId ?? randomUUID())
                    : randomUUID(),
              }
            : {}),
          ...(group
            ? {
                group: {
                  ...group,
                  taskIds: taskIds!,
                  taskWorkspaces: {
                    ...group.taskWorkspaces,
                    ...(context.activeTaskId
                      ? {
                          [context.activeTaskId]: {
                            workspacePath: context.workspacePath,
                            workspaceIdentity: context.workspaceIdentity,
                          },
                        }
                      : {}),
                  },
                },
              }
            : {}),
          updatedAt: Date.now(),
        };
        if (updateAuthorization && group && !group.threadId) {
          // 群授权是单一权威；停用或换绑必须在同一次写入中使所有话题卡片失效。
          for (const [topicKey, topic] of Object.entries(state.bots)) {
            if (
              topic.botId !== context.botId ||
              topic.group?.chatId !== group.chatId ||
              !topic.group.threadId
            )
              continue;
            ctx.stopGroupSynchronization(topic);
            state.bots[topicKey] = {
              ...topic,
              group: {
                ...topic.group,
                enabled: group.enabled,
                ownerId: group.ownerId,
                authorizationId: group.authorizationId,
                deliveries: Object.fromEntries(
                  Object.entries(topic.group.deliveries ?? {}).map(([id, result]) => [
                    id,
                    result.status === "sent"
                      ? result
                      : { ...result, status: "invalidated" as const },
                  ]),
                ),
              },
            };
          }
        }
        await ctx.repo.writeState(state);
      });
    ctx.stateWriteTail = next;
    await next;
    if (!context.group) {
      context.privateBindingId = (await ctx.repo.readState()).bots[context.botId]?.privateBindingId;
      await ctx.reconcilePrivateSynchronization(context.botId);
    }
    if (context.group)
      await ctx.deps.broadcastService
        ?.send({
          channel: "bots:group-state",
          payload: { botId: context.botId, chatId: context.group.chatId },
        })
        .catch(() => undefined);
  }

  return {
    onDeliveryResult,
    setRuntimeStatus,
    readTelegramOffset,
    writeTelegramOffset,
    readWeixinGetUpdatesBuf,
    writeWeixinGetUpdatesBuf,
    updateProviderCursor,
    readContext,
    readQueueCardScope,
    serializeStateWrite,
    writeBotConfig,
    writeContext,
  };
}
