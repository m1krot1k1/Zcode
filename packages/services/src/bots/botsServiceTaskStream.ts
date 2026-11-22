import { createBotsServiceStreamingCard } from "./botsServiceStreamingCard.js";
import { createBotsServiceTaskStreamEvents } from "./botsServiceTaskStreamEvents.js";
import type { BotTaskStreamRun } from "./botsServiceTaskStreamTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import { botsLogger } from "./botsServiceSupport.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { getBotConversationKey } from "./groupSessions.js";
import type { BotReplyToolCallState } from "./replyFormatter.js";
import { getWorkspaceKey } from "./workspaceHelpers.js";
import type { BotActor, BotConfig, BotContextState } from "@zcode/shared";

export function createBotsServiceTaskStream(ctx: BotsServiceContext) {
  async function watchTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation: boolean | string = false,
  ): Promise<void> {
    const key = ctx.taskStreamKey(context, actor);
    const previous = ctx.watchStarts.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => startTaskStream(bot, actor, context, user, automation));
    ctx.watchStarts.set(key, pending);
    try {
      await pending;
    } finally {
      if (ctx.watchStarts.get(key) === pending) ctx.watchStarts.delete(key);
    }
  }

  async function startTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation: boolean | string = false,
  ): Promise<void> {
    if (!context.activeTaskId) {
      return;
    }
    for (const [inputId, input] of Object.entries(context.group?.inputs ?? {})) {
      if (
        input.taskId !== context.activeTaskId ||
        !input.progress?.cardMessageId ||
        input.progress.cardStatus === input.progress.status
      )
        continue;
      await ctx.queueCards
        .update(
          JSON.stringify([
            bot.id,
            context.group!.chatId,
            context.activeTaskId,
            context.group!.authorizationId,
            inputId,
            context.group!.threadId,
          ]),
          input.progress.status,
        )
        .catch((error) => {
          botsLogger.warn(
            undefined,
            `restore queue card state failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    const streamSubscriptionKey = ctx.taskStreamKey(context, actor);
    const existingSubscription = ctx.streamSubscriptions.get(streamSubscriptionKey);
    if (existingSubscription) {
      if (automation)
        existingSubscription.automation(typeof automation === "string" ? automation : undefined);
      return;
    }
    const persistentPrivate = !context.group && !automation && ctx.privateSyncSupported(bot);
    const bindingId = context.privateBindingId;
    let automationPending = automation === true;
    let automationRun = Boolean(automation);
    const automationRuns = new Set<string>(typeof automation === "string" ? [automation] : []);
    let imInteractionRun = !persistentPrivate;
    let privateDeliveryFailed = false;
    let privateCardDeliveryUnknown = false;

    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(context);
    if (context.group) {
      // Bug 原因：旧会话尚未冷恢复时建立结果订阅会耗尽重试；先读取权威状态，
      // 再监听未来事件，避免新请求执行结束后无人消费结果。这里不提交历史输入。
      await zcodeTaskService.getBotGroupTaskBlockReason?.({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
      // 启动恢复与首条输入可能并发，等待期间另一路已建立订阅时直接复用。
      if (ctx.streamSubscriptions.has(streamSubscriptionKey)) return;
    }
    const automationGroupKey =
      actor.chatType === "group" && !context.group ? getBotConversationKey(actor) : null;
    const automationAuthorizationId = automationGroupKey
      ? (await ctx.repo.readState()).bots[automationGroupKey]?.group?.authorizationId
      : undefined;
    const run = {
      bot,
      actor,
      context,
      user,
      automation,
      streamSubscriptionKey,
      persistentPrivate,
      bindingId,
      automationPending,
      automationRun,
      automationRuns,
      imInteractionRun,
      privateDeliveryFailed,
      privateCardDeliveryUnknown,
      zcodeTaskService,
      automationGroupKey,
      automationAuthorizationId,
      disposed: false,
      resultRunId: "",
      resultSourceCommandId: undefined,
      resultInputOrigin: "desktop",
      resultPart: 0,
      resultMentionedUserIds: undefined,
      terminalRuns: new Set<string>(),
      assistantParts: [],
      assistantReplyBuffer: "",
      sentAnyAssistantReply: false,
      assistantPartToolIds: new Set<string>(),
      toolCalls: new Map<string, BotReplyToolCallState>(),
      sentToolCallReplyIds: new Set<string>(),
      streamingCardHandle: null,
      streamingCardSegmentIndex: 0,
      streamingCardBlocks: [],
      streamingCardStatus: "running",
      streamingCardLastUpdateAt: 0,
      streamingCardConsecutiveFailures: 0,
      streamingCardNextAttemptAt: 0,
      streamingCardCircuitOpen: false,
      streamingCardQueue: Promise.resolve(),
      streamEventQueue: Promise.resolve(),
    } as unknown as BotTaskStreamRun;
    Object.assign(run, createBotsServiceStreamingCard(ctx, run));
    Object.assign(run, createBotsServiceTaskStreamEvents(ctx, run));

    const dynamicTaskEvent = (
      run.zcodeTaskService as Partial<Pick<IZCodeTaskService, "onDynamicTaskEvent">>
    ).onDynamicTaskEvent;
    // Bugfix: 远控/共享 host 场景会通过 workspace+task mirror 分发流事件。
    // 这里优先订阅 workspace 级事件，避免只监听本地 taskId relay 时漏掉 channel 回复。
    const streamDisposable = ctx.taskStreamHub.add(
      JSON.stringify([
        getWorkspaceKey(run.context.workspacePath, run.context.workspaceIdentity),
        run.context.activeTaskId,
      ]),
      run.streamSubscriptionKey,
      (receive) =>
        dynamicTaskEvent
          ? dynamicTaskEvent({
              workspacePath: run.context.workspacePath,
              workspaceIdentity: run.context.workspaceIdentity,
              taskId: run.context.activeTaskId!,
              // Bugfix: Bot channel 使用 direct stream 语义。
              // 手机远控 replayable 的 mirror replay / snapshot gap recovery 会改变 bot 回复边界，
              // 这里使用 bot 专属 continuous 订阅，避免远控恢复逻辑影响飞书/微信等 channel。
              deliveryKind: "bot-channel-continuous",
            })(receive)
          : run.zcodeTaskService.onDynamicStreamEvent(run.context.activeTaskId!)(receive),
      run.enqueueStreamEvent,
    );
    ctx.streamSubscriptions.set(run.streamSubscriptionKey, {
      imInput() {
        if (!run.resultRunId) run.imInteractionRun = true;
      },
      automation(runId) {
        if (runId) run.automationRuns.add(runId);
        else {
          run.automationPending = true;
          if (!run.resultRunId) run.automationRun = true;
        }
      },
      dispose() {
        run.disposed = true;
        streamDisposable.dispose();
      },
    });
    if (!run.context.group && !run.persistentPrivate)
      ctx.startTyping(run.bot, run.actor, run.context.activeTaskId!);
  }

  return {
    watchTaskStream,
    startTaskStream,
  };
}
