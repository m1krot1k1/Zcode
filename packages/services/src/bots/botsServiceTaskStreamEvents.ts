import type { BotTaskStreamRun } from "./botsServiceTaskStreamTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  formatBotPermissionOptionDescription,
  formatBotPermissionOptionLabel,
  isBotPermissionRejectOption,
  sortBotPermissionOptions,
} from "./botsServiceOptions.js";
import { botsLogger, createOutbound, groupCardFor } from "./botsServiceSupport.js";
import { findBot } from "./botConfigHelpers.js";
import { getBotStateKey } from "./groupSessions.js";
import {
  extractBotAssistantResponseMessages,
  formatBotAssistantReplyBlocks,
  formatBotPermissionRequestSummary,
  formatBotToolCallReply,
  isBotToolCallReplyTerminal,
  updateBotReplyToolCalls,
} from "./replyFormatter.js";
import { readLatestAssistantTurnChangeSummary } from "./statusFormatting.js";
import { getWorkspaceKey, isWorkspaceAllowed } from "./workspaceHelpers.js";
import {
  type BotActor,
  type BotConfig,
  type BotOutboundMessage,
  type SelectionPrompt,
  type TaskStreamMirrorableEvent,
  type ZCodeStreamEvent,
  appendAssistantMessagePart,
  normalizeBotReplyGranularity,
} from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";

export function createBotsServiceTaskStreamEvents(ctx: BotsServiceContext, run: BotTaskStreamRun) {
  return {
    isPrivateAuthorized: async (): Promise<boolean> => {
      if (!run.persistentPrivate) {
        if (run.context.group) return true;
        const currentBot = findBot(await ctx.repo.readConfig(), run.bot.id);
        return Boolean(
          currentBot?.enabled &&
          currentBot.provider === run.bot.provider &&
          currentBot.providerUserId === run.bot.providerUserId &&
          currentBot.credentialRef === run.bot.credentialRef,
        );
      }
      const currentBot = findBot(await ctx.repo.readConfig(), run.bot.id);
      const latest = (await ctx.repo.readState()).bots[run.bot.id];
      const recipient =
        currentBot?.provider === "weixin" ? latest?.privateRecipientId : currentBot?.providerUserId;
      return Boolean(
        currentBot?.enabled &&
        currentBot.provider === run.bot.provider &&
        recipient === run.actor.providerUserId &&
        latest &&
        latest.privateBindingId === run.bindingId &&
        isWorkspaceAllowed(
          latest.workspaceId ?? getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity),
          currentBot.allowedWorkspaces,
        ) &&
        latest?.activeTaskId === run.context.activeTaskId &&
        getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity) ===
          getWorkspaceKey(run.context.workspacePath, run.context.workspaceIdentity),
      );
    },

    sendTaskOutbound: async (targetBot: BotConfig, message: BotOutboundMessage): Promise<void> => {
      const automationGroupKey = run.automationGroupKey;
      if (run.disposed && (run.context.group || run.persistentPrivate)) return;
      if (!(await run.isPrivateAuthorized())) return;
      if (run.privateDeliveryFailed) return;
      if (
        run.persistentPrivate &&
        run.bot.provider === "weixin" &&
        !run.imInteractionRun &&
        !(await ctx.deps.credentialService.load(
          ctx.weixinContextKey(run.bot, run.actor.providerUserId),
        ))
      ) {
        run.privateDeliveryFailed = true;
        const locale = await ctx.readMessageLocale();
        ctx.onDeliveryResult(
          run.bot,
          locale === "en-US"
            ? "Send a message to the bot in Weixin, then retry."
            : "请在微信给机器人发一条消息后重试。",
        );
        return;
      }
      if (automationGroupKey) {
        const current = (await ctx.repo.readState()).bots[automationGroupKey]?.group;
        const currentBot = findBot(await ctx.repo.readConfig(), run.bot.id);
        if (
          !current?.enabled ||
          !currentBot?.enabled ||
          current.ownerId !== currentBot.providerUserId ||
          current.authorizationId !== run.automationAuthorizationId
        )
          return;
      }
      try {
        await ctx.sendOutbound(
          targetBot,
          run.context.group
            ? {
                ...message,
                groupTaskId: run.context.activeTaskId!,
                threadId: run.actor.threadId ?? run.context.group.threadId,
                rootMessageId: run.actor.rootMessageId ?? run.context.group.rootMessageId,
                conversationThreadId: run.actor.conversationThreadId,
                groupSourceCommandId: run.resultSourceCommandId,
                groupCard: groupCardFor(run.actor, run.context),
                replyToMessageId: run.actor.providerMessageId,
                mentionedUserIds:
                  message.mentionedUserIds ??
                  (message.selection || run.resultPart === 0
                    ? run.resultMentionedUserIds
                    : undefined),
                ...(!message.selection && run.resultRunId
                  ? {
                      deliveryId: createHash("sha256")
                        .update(
                          JSON.stringify([
                            run.bot.id,
                            run.context.group.chatId,
                            run.context.activeTaskId,
                            run.resultRunId,
                            run.resultPart++,
                          ]),
                        )
                        .digest("hex"),
                    }
                  : {}),
                // 来源保留在关联元数据中；拼进正文会产生多余的 Desktop／Mobile Web 标签。
                text: message.text,
              }
            : message,
          automationGroupKey
            ? async () => {
                const current = (await ctx.repo.readState()).bots[automationGroupKey]?.group;
                const currentBot = findBot(await ctx.repo.readConfig(), run.bot.id);
                return Boolean(
                  current?.enabled &&
                  currentBot?.enabled &&
                  current.ownerId === currentBot.providerUserId &&
                  current.authorizationId === run.automationAuthorizationId,
                );
              }
            : undefined,
        );
      } catch (error) {
        if (!run.persistentPrivate) throw error;
        run.privateDeliveryFailed = true;
      }
    },

    getMode: () =>
      run.context.group || run.automationRun
        ? "summary_changes"
        : normalizeBotReplyGranularity(run.bot.provider, run.user.replyMode),

    flushAssistantReplyBuffer: async (force = false) => {
      if (
        run.getMode() === "summary_changes" ||
        run.supportsStreamingCardReply() ||
        !run.assistantReplyBuffer
      ) {
        return;
      }
      const extracted = extractBotAssistantResponseMessages(run.assistantReplyBuffer, force);
      run.assistantReplyBuffer = extracted.rest;
      for (const text of extracted.messages) {
        run.sentAnyAssistantReply = true;
        await run.sendTaskOutbound(run.bot, createOutbound(run.actor, text));
      }
    },

    handleStreamEventImpl: async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
      if (run.disposed) return;
      if (event.type === "task_stream_mirror_batch") {
        if (shouldBroadcast) {
          await ctx.broadcastTaskStreamEvent(run.context, event);
        }
        // Bugfix: 共享 host / 远控下 UI 收到的是 workspace 级 mirror batch。
        // 旧逻辑只识别裸 stream event，导致 UI 正常流式显示但 Bot channel 没有任何可发送回复。
        for (const op of event.ops) {
          if (op.kind === "stream_event") {
            await run.handleStreamEvent(op.event, false);
          }
        }
        return;
      }
      if (
        typeof run.automation === "string" &&
        !run.persistentPrivate &&
        event.traceId !== run.automation &&
        event.inputId !== run.automation
      )
        return;
      if (run.persistentPrivate) {
        if (!(await run.isPrivateAuthorized())) return;
        const runId = event.inputId ?? event.traceId;
        if (event.type === "task_run_started") {
          if (runId && (run.terminalRuns.has(runId) || run.resultRunId === runId)) return;
          run.resultRunId = runId ?? "";
          run.privateDeliveryFailed = false;
          run.privateCardDeliveryUnknown = false;
          run.user = findBot(await ctx.repo.readConfig(), run.bot.id) ?? run.user;
          run.resultSourceCommandId = event.inputId;
          run.automationRun =
            run.automationRuns.delete(runId ?? "") ||
            run.automationRuns.delete(event.traceId) ||
            run.automationPending;
          run.automationPending = false;
          // 桌面/手机轮次只能同步输出，不能凭常驻订阅增加 IM 审批入口。
          run.imInteractionRun = ctx.privateImTraces.has(
            JSON.stringify([run.streamSubscriptionKey, event.traceId]),
          );
          run.assistantParts = [];
          run.assistantReplyBuffer = "";
          run.sentAnyAssistantReply = false;
          run.assistantPartToolIds.clear();
          run.toolCalls.clear();
          run.sentToolCallReplyIds.clear();
          run.streamingCardHandle = null;
          run.streamingCardBlocks.length = 0;
          run.streamingCardSegmentIndex = 0;
          run.streamingCardStatus = "running";
          run.streamingCardLastUpdateAt = 0;
          run.streamingCardConsecutiveFailures = 0;
          run.streamingCardNextAttemptAt = 0;
          run.streamingCardCircuitOpen = false;
        } else {
          if (runId && run.terminalRuns.has(runId)) return;
          if (!run.resultRunId && runId) run.resultRunId = runId;
          if (
            run.resultSourceCommandId &&
            event.inputId &&
            run.resultSourceCommandId !== event.inputId
          )
            return;
        }
        if (event.type === "task_complete" || event.type === "task_error") {
          if (runId) run.terminalRuns.add(runId);
          // continuous 不重放旧轮；有界保留重复终态保护。
          if (run.terminalRuns.size > 128)
            run.terminalRuns.delete(run.terminalRuns.values().next().value!);
        }
        if (
          !run.imInteractionRun &&
          (event.type === "permission_request" || event.type === "elicitation_request")
        )
          return;
      }
      if (run.context.group) {
        const latest = (await ctx.repo.readState()).bots[getBotStateKey(run.context)];
        const currentBot = findBot(await ctx.repo.readConfig(), run.bot.id);
        if (
          !latest?.group?.enabled ||
          latest.activeTaskId !== run.context.activeTaskId ||
          latest.group.ownerId !== currentBot?.providerUserId ||
          !currentBot.enabled
        )
          return;
        // 停止续接后旧输入可能迟到；不能用它覆盖新轮的缓存、表情或投递目标。
        if (
          latest.group.threadId &&
          run.resultSourceCommandId &&
          event.inputId &&
          event.type !== "task_run_started" &&
          event.inputId !== run.resultSourceCommandId
        )
          return;
        if (event.type === "task_complete" || event.type === "task_error") {
          const terminalKey = event.inputId ?? event.traceId ?? run.resultRunId;
          if (terminalKey && run.terminalRuns.has(terminalKey)) return;
          if (terminalKey) run.terminalRuns.add(terminalKey);
        }
        if (event.type === "turn_steer_status" && event.status !== "drained") {
          for (const id of event.pendingInputIds ?? []) {
            const input = latest.group.inputs?.[id];
            if (!input || input.taskId !== run.context.activeTaskId) continue;
            await ctx.updateGroupInputReaction(
              run.bot,
              run.context,
              input.source.messageId,
              event.reason === "session_resumed" ? "discarded" : "cancelled",
            );
            // 话题不再提供排队/Steer 交互；旧运行丢弃事件只更新原输入状态与表情。
            if (latest.group.threadId) continue;
            const locale = await ctx.readMessageLocale();
            const text =
              event.reason === "session_resumed"
                ? locale === "en-US"
                  ? "Queued input was discarded after runtime restart; it was not executed."
                  : "排队输入已在运行时重启后丢弃，未执行。"
                : locale === "en-US"
                  ? "Queued input was removed or rejected; it will not execute."
                  : "排队输入已删除或被拒绝，不会执行。";
            const inputActor: BotActor = {
              ...run.actor,
              providerUserId: input.source.senderId,
              providerMessageId: input.source.messageId,
              mentionedBot: input.source.mentionedBot,
              threadId: input.source.threadId ?? run.context.group.threadId,
              rootMessageId: input.source.rootMessageId ?? run.context.group.rootMessageId,
              conversationThreadId: run.context.group.threadId ?? null,
            };
            await ctx.sendOutbound(run.bot, {
              ...createOutbound(inputActor, text),
              groupTaskId: run.context.activeTaskId!,
              groupCard: groupCardFor(inputActor, run.context),
              replyToMessageId: input.source.messageId,
              deliveryId: createHash("sha256")
                .update(`${id}:${event.status}:${event.reason}`)
                .digest("hex"),
            });
          }
          return;
        }
        if (event.type === "task_run_started")
          run.resultInputOrigin = event.inputOrigin ?? "desktop";
        if (event.type === "task_run_started" || event.inputId) {
          const source = event.inputId ? latest.group.inputs?.[event.inputId]?.source : undefined;
          // 按本轮可信输入解析，不能把无来源的桌面结果或重试归给群 owner/最近发言者。
          const isTopicReply = !!(source?.threadId ?? latest.group.threadId);
          run.resultMentionedUserIds = source
            ? [
                ...new Set(
                  (source.messages ?? [source])
                    .filter((item) => !isTopicReply || item.mentionedBot === true)
                    .map((item) => item.senderId),
                ),
              ]
            : undefined;
          if (!run.resultMentionedUserIds?.length) run.resultMentionedUserIds = undefined;
          run.actor = {
            ...run.actor,
            providerUserId: source?.senderId ?? latest.group.ownerId,
            displayName:
              source?.senderName ?? (run.resultInputOrigin === "mobile" ? "Mobile Web" : "Desktop"),
            providerMessageId: source?.messageId,
            mentionedBot: source?.mentionedBot,
            threadId: source?.threadId ?? latest.group.threadId,
            rootMessageId: source?.rootMessageId ?? latest.group.rootMessageId,
            conversationThreadId:
              source?.threadId && source.threadId !== latest.group.threadId
                ? (latest.group.threadId ?? null)
                : undefined,
          };
          run.context.group = { ...latest.group, initiatorId: source?.senderId };
        }
        if (event.type === "task_run_started") {
          await ctx.updateGroupInputReaction(
            run.bot,
            run.context,
            run.actor.providerMessageId,
            "working",
          );
          run.resultRunId = event.inputId ?? event.traceId;
          run.resultSourceCommandId = event.inputId;
          run.resultPart = 0;
          run.assistantParts = [];
          run.assistantReplyBuffer = "";
          run.sentAnyAssistantReply = false;
          run.assistantPartToolIds.clear();
          run.toolCalls.clear();
          run.sentToolCallReplyIds.clear();
          await ctx.writeContext(run.context, false, run.context.activeTaskId);
        }
      }
      if (run.context.group && !run.resultRunId) {
        run.resultRunId = event.inputId ?? event.traceId;
        run.resultSourceCommandId = event.inputId;
      }
      if (shouldBroadcast) {
        await ctx.broadcastTaskStreamEvent(run.context, event);
      }
      // Bugfix: 第三方默认回复需要随 AssistantMessageResponse 流式发送；
      // 但 /status Progress 仍然要独立缓存，避免受发送颗粒度影响。
      ctx.updateLiveStatusProgress(event);
      if (event.type === "agent_message_chunk") {
        run.assistantParts = appendAssistantMessagePart(run.assistantParts, {
          type: "content",
          content: event.content,
        });
        if (run.supportsStreamingCardReply()) {
          run.appendStreamingCardMessageChunk(event.content);
          await run.syncStreamingCardReply(event.type, false);
          return;
        }
        if (run.getMode() !== "summary_changes") {
          run.assistantReplyBuffer += event.content;
          // 第三方平台消息是离散气泡；formatter 负责把当前 buffer 按长度约束拆成可发送消息。
          await run.flushAssistantReplyBuffer(false);
        }
        return;
      }
      if (event.type === "agent_thought_chunk") {
        run.assistantParts = appendAssistantMessagePart(run.assistantParts, {
          type: "thought",
          content: event.content,
        });
      }
      if (event.type === "tool_call" || event.type === "tool_call_update") {
        if (run.supportsStreamingCardReply()) {
          run.appendStreamingCardTool(event.toolId);
        }
        if (!run.supportsStreamingCardReply()) {
          await run.flushAssistantReplyBuffer(true);
        }
        // Bugfix: summary_changes 完成消息需要参考 UI latestPart。
        // tool_call_update 可能在缺少 tool_call 首帧时先到，需像 UI 一样补一个 tool-call part 边界。
        if (!run.assistantPartToolIds.has(event.toolId)) {
          run.assistantPartToolIds.add(event.toolId);
          run.assistantParts = appendAssistantMessagePart(run.assistantParts, {
            type: "tool-call",
            toolId: event.toolId,
          });
        }
      }
      updateBotReplyToolCalls(run.toolCalls, event);
      if (event.type === "tool_call" && run.supportsStreamingCardReply()) {
        await run.syncStreamingCardReply(event.type, true);
      }
      if (event.type === "tool_call_update" && run.supportsStreamingCardReply()) {
        await run.syncStreamingCardReply(event.type, isBotToolCallReplyTerminal(event.status));
      }
      if (
        event.type === "tool_call_update" &&
        run.getMode() === "assistant_toolcalls_changes" &&
        isBotToolCallReplyTerminal(event.status) &&
        !run.sentToolCallReplyIds.has(event.toolId)
      ) {
        const toolCall = run.toolCalls.get(event.toolId);
        if (toolCall) {
          run.sentToolCallReplyIds.add(event.toolId);
          run.sentAnyAssistantReply = true;
          await run.sendTaskOutbound(
            run.bot,
            createOutbound(
              run.actor,
              formatBotToolCallReply(toolCall, {
                workspacePath: run.context.workspacePath,
                locale: await ctx.readMessageLocale(),
              }),
            ),
          );
        }
      }
      if (event.type === "permission_request") {
        const locale = await ctx.readMessageLocale();
        ctx.stopTyping(event.taskId);
        await run.sealStreamingCardReply();
        await ctx.broadcastTaskListChange(run.context, event.taskId, "permission_request", {
          permissionRequest: event,
        });
        // Bugfix: UI 会把 ZCode Agent 原始权限选项规整成“允许/始终允许/拒绝”的固定顺序和文案；
        // 机器人之前直接展示 provider 原始英文 name，还额外加取消按钮，导致同一个权限请求在飞书和 UI 看起来不一致。
        const permissionOptions = sortBotPermissionOptions(event.options);
        const permissionSelection: SelectionPrompt = {
          id: `permission-${event.requestId}`,
          title: formatBotPermissionRequestSummary(event, {
            locale,
            workspacePath: run.context.workspacePath,
          }),
          action: "permission.respond",
          showCancel: false,
          options: permissionOptions.map((option) => {
            const isDenyOption = isBotPermissionRejectOption(option);
            return {
              id: isDenyOption
                ? `/deny ${event.requestId}`
                : `/approve ${event.requestId} ${option.optionId}`,
              label: formatBotPermissionOptionLabel(option, locale),
              description: formatBotPermissionOptionDescription(option, event, locale),
            };
          }),
        };
        // Bugfix: Telegram callback_data 只有 64 字节，真实 toolCallId/requestId 可能过长。
        // 因此按钮只回传短序号，真实 requestId/optionId 暂存在当前 bot context 中再解析。
        const pendingPermissionOptions = permissionOptions.map((option) => {
          const isDenyCommand = isBotPermissionRejectOption(option);
          return {
            requestId: event.requestId,
            optionId: option.optionId,
            command: isDenyCommand ? ("deny" as const) : ("approve" as const),
            label: formatBotPermissionOptionLabel(option, locale),
            response: option.response,
          };
        });
        Object.assign(run.context, { pendingPermissionOptions });
        await ctx.writeContext(
          { ...run.context, pendingPermissionOptions },
          false,
          run.context.activeTaskId,
        );
        const [permissionReply] = await ctx.createSelectionReply(
          run.actor,
          permissionSelection,
          await ctx.readMessageLocale(),
        );
        if (permissionReply) {
          if (ctx.shouldUseTransientInteractionCard(run.bot, run.user)) {
            // 原因：Feishu 群配置归一化后也会走临时卡分支，不能因此跳过群卡授权字段。
            await ctx.upsertTransientInteractionCard(
              run.bot,
              run.actor,
              event.taskId,
              run.context.group
                ? {
                    ...permissionReply,
                    mentionedUserIds: ctx.adminAttention.mention(
                      run.actor,
                      run.bot.providerUserId,
                      `permission:${event.taskId}:${event.requestId}`,
                    ),
                    groupTaskId: run.context.activeTaskId!,
                    groupCard: groupCardFor(run.actor, run.context),
                  }
                : permissionReply,
            );
          } else {
            await run.sendTaskOutbound(
              run.bot,
              run.context.group
                ? ctx.administratorReply(
                    run.actor,
                    run.bot,
                    `permission:${event.taskId}:${event.requestId}`,
                    permissionReply,
                  )
                : permissionReply,
            );
          }
        }
        return;
      }
      if (event.type === "elicitation_request") {
        await run.sealStreamingCardReply();
        await ctx.handleElicitationRequest(
          run.bot,
          run.user,
          run.actor,
          run.context,
          event,
          run.resultMentionedUserIds,
        );
        return;
      }
      if (event.type === "elicitation_response") {
        await ctx.clearPendingElicitationForRequest(run.context, event.requestId);
        await ctx.broadcastTaskListChange(run.context, event.taskId, "elicitation_resolved", {
          requestId: event.requestId,
        });
        return;
      }
      if (event.type === "task_complete" || event.type === "task_error") {
        if (run.context.group) {
          await ctx.updateGroupInputReaction(
            run.bot,
            run.context,
            run.actor.providerMessageId,
            event.type === "task_error"
              ? "failed"
              : /stop|cancel|interrupt|abort/iu.test(event.stopReason)
                ? "stopped"
                : "done",
          );
        }
        ctx.privateImTraces.delete(JSON.stringify([run.streamSubscriptionKey, event.traceId]));
        ctx.runningTasks.delete(event.taskId);
        ctx.liveStatusProgressByTaskId.delete(event.taskId);
        ctx.stopTyping(event.taskId);
        if (run.context.pendingElicitation?.taskId === event.taskId) {
          ctx.clearPendingElicitationSelection(run.context.pendingElicitation);
          await ctx.writeContext(
            { ...run.context, pendingElicitation: undefined },
            false,
            run.context.activeTaskId,
          );
        }
        const transientCard = ctx.transientInteractionCards.get(ctx.getActorContextKey(run.actor));
        if (transientCard?.taskId === event.taskId) {
          const pendingElicitation = run.context.pendingElicitation;
          await ctx.finalizeTransientInteractionCard(
            run.actor,
            pendingElicitation
              ? ctx.createCompletedElicitationOutbound(
                  run.actor,
                  pendingElicitation,
                  await ctx.readMessageLocale(),
                  "cancel",
                )
              : createOutbound(
                  run.actor,
                  event.type === "task_error"
                    ? ctx.msg(await ctx.readMessageLocale(), "taskFailed", {
                        message: event.error,
                      })
                    : ctx.msg(await ctx.readMessageLocale(), "received"),
                ),
          );
        }
        // Bugfix: ZCode Agent 终态事件可能先于 task index/meta 落盘广播到 Bots。
        // 如果这里立刻用旧 meta 更新 sidebar，随后列表再刷新到终态 meta，会出现状态/摘要跳一下。
        // 因此终态广播前短重试读取一次稳定 meta，尽量用同一帧完成 UI 增量更新。
        const completedTask = await ctx
          .readTerminalTaskMeta(run.context, event.taskId, event.type)
          .catch(() => null);
        await ctx.broadcastTaskListChange(
          run.context,
          event.taskId,
          event.type === "task_error" ? "error" : "completed",
          {
            ...(completedTask ? { task: completedTask } : {}),
            ...(event.type === "task_error" ? { error: event.error } : {}),
          },
        );
        if (!run.context.group && !run.persistentPrivate) {
          ctx.streamSubscriptions.get(run.streamSubscriptionKey)?.dispose();
          ctx.streamSubscriptions.delete(run.streamSubscriptionKey);
        }
        if (event.type === "task_error") {
          if (run.supportsStreamingCardReply()) {
            run.streamingCardStatus = "error";
            if (!run.hasStreamingCardMessageText()) {
              run.appendStreamingCardMessages([
                ctx.msg(await ctx.readMessageLocale(), "taskFailed", {
                  message: event.error,
                }),
              ]);
            }
            await run.syncStreamingCardReply(event.type, true);
            return;
          }
          await run.sendTaskOutbound(
            run.bot,
            createOutbound(
              run.actor,
              ctx.msg(await ctx.readMessageLocale(), "taskFailed", {
                message: event.error,
              }),
            ),
          );
          return;
        }

        if (run.context.group && /stop|cancel|interrupt|abort/iu.test(event.stopReason)) {
          // 停止通知会触发群内其他机器人继续回复；主聊天与话题统一静默，前面的状态清理仍保留。
          return;
        }
        const mode = run.getMode();
        const locale = await ctx.readMessageLocale();
        const completedSnapshot = await run.zcodeTaskService
          .getTaskSnapshot({
            taskId: event.taskId,
            workspacePath: run.context.workspacePath,
            workspaceIdentity: run.context.workspaceIdentity,
          })
          .catch(() => null);
        const latestTurnChangeSummary = readLatestAssistantTurnChangeSummary(completedSnapshot);
        if (run.supportsStreamingCardReply()) {
          const changeSummaryMessages = formatBotAssistantReplyBlocks(
            ctx.createAssistantReplyBlocks([], new Map(), mode, latestTurnChangeSummary),
            {
              workspacePath: run.context.workspacePath,
              locale,
            },
          );
          if (changeSummaryMessages.length > 0) {
            run.appendStreamingCardMessages(changeSummaryMessages);
          }
          run.streamingCardStatus = "completed";
          await run.syncStreamingCardReply(event.type, true);
          run.sentAnyAssistantReply = true;
          return;
        }
        let replyMessages: string[] = [];
        if (mode === "summary_changes") {
          const replyBlocks = ctx.createAssistantReplyBlocks(
            run.assistantParts,
            run.toolCalls,
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(replyBlocks, {
            workspacePath: run.context.workspacePath,
            locale,
          });
        } else {
          await run.flushAssistantReplyBuffer(true);
          const changeSummaryBlocks = ctx.createAssistantReplyBlocks(
            [],
            new Map(),
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(changeSummaryBlocks, {
            workspacePath: run.context.workspacePath,
            locale,
          });
        }
        if (replyMessages.length === 0 && !run.sentAnyAssistantReply) {
          const source = run.resultSourceCommandId
            ? run.context.group?.inputs?.[run.resultSourceCommandId]?.source
            : undefined;
          // 无 @ 续聊允许模型不参与，空输出不能再被“任务已完成”兜底变成抢答。
          if (
            run.context.group?.threadId &&
            source?.botIdentity &&
            source.mentionedBot === false &&
            !source.messages?.some((message) => message.mentionedBot === true)
          )
            return;
          await run.sendTaskOutbound(
            run.bot,
            createOutbound(run.actor, locale === "en-US" ? "Task completed." : "任务已完成。"),
          );
          return;
        }
        for (const text of replyMessages) {
          run.sentAnyAssistantReply = true;
          await run.sendTaskOutbound(run.bot, createOutbound(run.actor, text));
        }
      }
    },

    handleStreamEvent: async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
      try {
        await run.handleStreamEventImpl(event, shouldBroadcast);
      } finally {
        if (
          run.persistentPrivate &&
          run.privateDeliveryFailed &&
          (event.type === "task_complete" || event.type === "task_error") &&
          (await run.isPrivateAuthorized())
        ) {
          const locale = await ctx.readMessageLocale();
          const texts = formatBotAssistantReplyBlocks(
            ctx.createAssistantReplyBlocks(
              run.assistantParts,
              run.toolCalls,
              "assistant_changes",
              undefined,
            ),
            { workspacePath: run.context.workspacePath, locale },
          );
          const text =
            texts.join("\n\n") ||
            (event.type === "task_error" ? event.error : ctx.msg(locale, "received"));
          const id = randomUUID();
          run.privateDeliveryFailed = false;
          ctx.failedPrivateDeliveries.set(run.bot.id, {
            id,
            bindingId: run.bindingId,
            taskId: run.context.activeTaskId!,
            message: createOutbound(run.actor, text),
            sending: false,
          });
          const runtime = ctx.runtimeByBotId.get(run.bot.id);
          ctx.setRuntimeStatus({
            botId: run.bot.id,
            provider: run.bot.provider,
            status: runtime?.status ?? "idle",
            deliveryRetryId: id,
          });
        }
      }
    },

    enqueueStreamEvent: (event: ZCodeStreamEvent | TaskStreamMirrorableEvent): Promise<void> => {
      const shouldBroadcast = !ctx.forwardedTaskEvents.has(event);
      ctx.forwardedTaskEvents.add(event);
      const nextStreamEvent = run.streamEventQueue.then(() =>
        run.handleStreamEvent(event, shouldBroadcast),
      );
      // Bugfix: ZCode Agent 事件分发不保证等待 async listener。微信这类离散消息如果并发发送，
      // task_complete 的 Change summary 可能抢在前面正文 flush 之前到达客户端，所以这里按任务串行消费。
      run.streamEventQueue = nextStreamEvent.catch((error: unknown) => {
        botsLogger.warn(
          event.traceId,
          `bot task stream event failed task=${event.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return run.streamEventQueue;
    },
  };
}
