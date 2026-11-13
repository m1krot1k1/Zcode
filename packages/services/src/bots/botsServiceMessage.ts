import type { PreparedBotMessageContent, PreparedTopicMessage } from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  formatSelectionFallback,
  stripModelProviderDescriptionsForTextSelection,
} from "./botsServiceOptions.js";
import {
  botsLogger,
  createOutbound,
  resolveAutomationBotDeliveryTarget,
} from "./botsServiceSupport.js";
import { getWorkspaceKey } from "./workspaceHelpers.js";
import {
  type BotActor,
  type BotDraftOptions,
  type BotInboundMessage,
  type BotOutboundMessage,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  type Locale,
  type SelectionPrompt,
  generateTraceId,
} from "@zcode/shared";
import { BotAdminRequiredError } from "#src/bots/groupAdminAttention.js";
import { TopicHistoryPermissionError } from "#src/bots/topicHistory.js";
import {
  botGroupCommandId,
  createTopicHistoryAttachment,
} from "#src/bots/topicHistoryAttachment.js";
import { deriveSessionTitle as deriveTaskTitle } from "#src/session/sessionTitle.js";

export function createBotsServiceMessage(ctx: BotsServiceContext) {
  async function createSelectionReply(
    actor: BotActor,
    selection: SelectionPrompt,
    locale?: Locale,
    extras: Pick<BotOutboundMessage, "elicitation" | "locale"> = {},
  ): Promise<BotOutboundMessage[]> {
    const markedSelection = ctx.markCurrentSelection(selection, locale);
    // Bugfix: 微信没有原生选项卡能力，只能走纯文本编号选项。
    // 之前纯文本 fallback 会同时展示标题里的“当前”和选项上的“当前”标记，
    // 微信回复看起来像重复状态文案；这里让标题负责说明当前状态，列表只保留可回复的编号。
    const supportsStructuredSelection = actor.provider !== "weixin";
    // Bugfix: 微信 /model 第一层选择的是供应商，之前复用 description 把模型列表也拼进同一行，
    // 导致用户还没选供应商就看到两层信息。纯文本通道先只展示供应商，模型放到下一层再展示。
    const textSelection = stripModelProviderDescriptionsForTextSelection(selection);
    const displaySelection = supportsStructuredSelection
      ? markedSelection
      : { ...textSelection, cancelLabel: markedSelection.cancelLabel };
    ctx.pendingSelectionsByContext.set(ctx.getActorContextKey(actor), displaySelection);
    // 其他 provider 保留 selection，让 Telegram/飞书/Lark 渲染原生选项，也让 Webhook 接收结构化选项。
    const text = supportsStructuredSelection
      ? displaySelection.title
      : formatSelectionFallback(displaySelection, locale);
    return [
      createOutbound(actor, text, supportsStructuredSelection ? displaySelection : undefined, {
        ...extras,
        locale,
      }),
    ];
  }

  async function handleSelectionCancel(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const locale = await ctx.readMessageLocale();
    const actorContextKey = ctx.getActorContextKey(message.actor);
    const pendingSelection = ctx.pendingSelectionsByContext.get(actorContextKey);
    if (message.actor.chatType === "group") {
      const auth = await ctx.withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      ctx.clearPendingSelection(message.actor);
      return ctx.createStatusReply(message.actor, auth.context, locale);
    }
    if (pendingSelection?.action === "elicitation.respond") {
      const auth = await ctx.withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      const pending = auth.context.pendingElicitation;
      if (!pending) {
        ctx.clearPendingSelection(message.actor);
        return [createOutbound(message.actor, ctx.msg(auth.locale, "elicitationExpired"))];
      }
      ctx.clearPendingSelection(message.actor);
      return ctx.submitPendingElicitation(auth, message.actor, pending, "cancel");
    }
    if (!ctx.pendingSelectionsByContext.has(actorContextKey)) {
      const auth = await ctx.withAuthorizedContext(message, "message");
      if (auth.ok && auth.context.pendingElicitation) {
        return ctx.submitPendingElicitation(
          auth,
          message.actor,
          auth.context.pendingElicitation,
          "cancel",
        );
      }
      return [createOutbound(message.actor, ctx.msg(locale, "unknownCommand", { command: "0" }))];
    }
    ctx.clearPendingSelection(message.actor);
    const auth = await ctx.withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    return ctx.createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function handleMessage(
    message: BotInboundMessage,
    topicBatch?: PreparedTopicMessage[],
    isCurrent = () => true,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "message");
    if (!auth.ok) {
      return auth.reply;
    }
    const priorInput =
      auth.context.group && message.actor.providerMessageId
        ? Object.values(auth.context.group.inputs ?? {}).find(
            (input) =>
              input.source.messageId === message.actor.providerMessageId ||
              input.source.messages?.some(
                (item) => item.messageId === message.actor.providerMessageId,
              ),
          )
        : undefined;
    if (priorInput && priorInput.taskId !== auth.context.activeTaskId) {
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "This message belongs to an earlier task and will not be executed again."
            : "这条消息已关联到此前任务，不会在新任务中重复执行。",
        ),
      ];
    }
    // CLI 重启后幂等窗口可能已变化；持久化接收记录不能只依赖内存事件去重。
    if (priorInput) {
      if (priorInput.admission === "accepted") return [];
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "This message already has an admission record. Check the task before submitting another request."
            : "这条消息已有接收记录，请先在任务中核对执行状态，不会自动重复提交。",
        ),
      ];
    }
    const history = auth.context.group
      ? await ctx.prepareGroupTopicHistory(auth.bot, message, auth.context)
      : {};
    if (history.topicContext && topicBatch) {
      const ids = new Set(topicBatch.map((entry) => entry.message.actor.providerMessageId));
      history.topicContext.messages = history.topicContext.messages.filter(
        (entry) => !ids.has(entry.id),
      );
    }
    if (history.historyDisabled || history.historyError) {
      const en = auth.locale === "en-US";
      const permissionDenied = history.historyError instanceof TopicHistoryPermissionError;
      const platformUrl =
        auth.bot.provider === "lark"
          ? "https://open.larksuite.com/app"
          : "https://open.feishu.cn/app";
      const text = history.historyDisabled
        ? en
          ? "Topic history is disabled. Ask the bound user to enable /history on before using topics."
          : "话题历史已关闭，暂时无法处理话题消息。请绑定用户发送 /history on 后重新 @。"
        : permissionDenied
          ? en
            ? `Topic history permission is missing. No task was submitted. Ask the app administrator to open ${platformUrl}, select this bot app, enable the required application-identity message permissions (including im:message.group_msg), and publish the change. Then mention the bot again.`
            : `机器人缺少话题历史读取权限，未提交任务。请应用管理员打开 ${platformUrl}，选择当前机器人应用，在权限管理中开通应用身份的消息读取权限（包括 im:message.group_msg，获取群组中所有消息），并发布生效后重新 @。无需安装或授权 lark-cli。`
          : en
            ? "Topic history could not be read. No task was submitted. Please retry by mentioning the bot again later."
            : "暂时无法读取话题历史，未提交任务。请稍后重新 @ 重试。";
      return [
        history.historyDisabled
          ? ctx.administratorReply(
              message.actor,
              auth.bot,
              "history",
              createOutbound(message.actor, text),
            )
          : createOutbound(message.actor, text),
      ];
    }
    ctx.adminAttention.clear(message.actor, auth.bot.providerUserId, "history");
    // commandText 属于单条消息；尾部纯 @ 不能抹掉停止期间批次里其他成员的有效需求。
    const hasRequest = (topicBatch?.map((entry) => entry.message) ?? [message]).some((original) =>
      Boolean(
        (original.commandText ?? original.text).trim() ||
        original.attachments?.length ||
        original.referencedMessage,
      ),
    );
    if (auth.context.group && !hasRequest) {
      const hasBackground = (history.topicContext?.messages.length ?? 0) > 0;
      if (!message.referencedMessage && !hasBackground) {
        return [
          createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "Please add a request, or reply to the message you want me to handle and mention me."
              : "请补充需求，或回复要处理的消息并 @我。",
          ),
        ];
      }
      // 仅 @ 的输入已有引用或历史附件；补写指令会把系统文案伪装成用户正文。
      // 保留原文中的 @，由标准引用／附件承载材料，不重新解析材料里的命令。
    }
    if (message.referencedMessage) {
      // 原先拼接消息 ID 会诱使模型再次查飞书；标准引用只携带真实原文，并复用 UI 展示。
      const quote = message.referencedMessage.text;
      if (quote.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) {
        return [
          createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "The quoted text is too long. Please quote a shorter passage or attach it as a file."
              : "引用文字过长，请缩小引用范围或作为文件提交。",
          ),
        ];
      }
    }
    let deletedTaskId: string | undefined;
    if (auth.context.mode === "task" && auth.context.activeTaskId) {
      const taskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
      const deletedTaskIds = await taskService.listDeletedTaskIds({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
      });
      if (deletedTaskIds.includes(auth.context.activeTaskId)) {
        // 桌面软删除只留下 tombstone，CLI 仍可恢复旧 session。
        // Bot 不能只凭 activeTaskId 续跑隐藏任务；先清旧交互，再复用当前草稿有效选择和 V4 首发。
        // 仅以删除记录为准，不能把列表过滤、归档或查询失败当成删除。
        deletedTaskId = auth.context.activeTaskId;
        auth.context = await ctx.writeDraftContext(auth.context);
      }
    }
    const elicitationReply = auth.context.group
      ? null
      : await ctx.handlePendingElicitationText(auth, message.actor, message.text);
    if (elicitationReply) {
      return elicitationReply;
    }
    if (
      !auth.context.group &&
      auth.context.mode === "task" &&
      auth.context.activeTaskId &&
      (await ctx.getContextTaskBlockReason(auth.context))
    ) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "taskRunning"))];
    }
    let preparedMessage: PreparedBotMessageContent;
    try {
      preparedMessage = topicBatch
        ? {
            content: message.text,
            zcodeAttachments: topicBatch.flatMap((entry) => entry.prepared.zcodeAttachments),
          }
        : await ctx.prepareBotMessageContent(auth.bot, message, auth.locale);
      const historyMaterial = history.topicContext;
      if (auth.context.group && historyMaterial) {
        const attachment = createTopicHistoryAttachment(
          historyMaterial,
          botGroupCommandId(
            auth.bot.id,
            auth.context.group.chatId,
            message.actor.providerMessageId!,
          ),
          auth.context.group.topicTitle || auth.context.group.name,
        );
        if (attachment) preparedMessage.zcodeAttachments.push(attachment);
      }
    } catch (error) {
      return [
        createOutbound(
          message.actor,
          ctx.msg(auth.locale, "attachmentRejected", {
            message: ctx.formatAttachmentRejectedReason(error, auth.locale),
          }),
        ),
      ];
    }
    if (!isCurrent()) return [];
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions =
        auth.context.draftOptions ?? (await ctx.buildInitializedDraftOptions(auth.context));
      // 原因：直接提交旧账号身份会绕过统一解析。只在首次创建前解析原意图；
      // 后续创建、配置和首发固定这份结果；绑定后以 Session 原选择解析下一次新输入。
      const selectionView = await ctx.readModelSelectionView(
        auth.context,
        draftOptions.modelSelection,
      );
      const submissionModelSelection = draftOptions.modelSelection
        ? selectionView?.effectiveSelection
        : selectionView?.preferredSelection;
      if (
        !submissionModelSelection ||
        (draftOptions.modelSelection && selectionView?.selectionIssue)
      ) {
        throw new BotAdminRequiredError("model", "Bot 无法从目标 Host 解析 Submission 模型");
      }
      const submissionDraftOptions: BotDraftOptions = {
        ...draftOptions,
        modelSelection: {
          providerId: submissionModelSelection.providerId,
          modelId: submissionModelSelection.modelId,
          ...(submissionModelSelection.options
            ? { options: { ...submissionModelSelection.options } }
            : {}),
        },
      };
      const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
      const task = await zcodeTaskService.createTask({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
        projectId: auth.context.projectId ?? null,
        additionalDirectories: auth.context.additionalDirectories ?? [],
        provider: draftOptions.provider,
        modelSelection: submissionDraftOptions.modelSelection,
        // 修复原因：Bot 旧 createTask 走 legacy session/create，却紧接着用 v4 sendText，
        // 内存标志与 v4 draft 持久化边界不一致，session_input 会触发 FK。改为先创建
        // v4 draft，再沿既有能力校验应用配置，最后通过 v4 sendText 首发。
        v4Create: true,
        ...(auth.context.group ? { permissionScope: "session" as const } : {}),
      });
      const taskTitle = auth.context.group
        ? [
            auth.bot.provider === "lark" ? "Lark" : "飞书",
            auth.context.group.name,
            ...(auth.context.group.threadId
              ? [auth.context.group.topicTitle || auth.context.group.threadId]
              : []),
          ].join(" · ")
        : deriveTaskTitle(preparedMessage.content, preparedMessage.zcodeAttachments);
      const broadcastTask = taskTitle ? { ...task, title: taskTitle } : task;
      const traceId = generateTraceId(task.taskId);
      try {
        await ctx.applyDraftConfigOptions(
          { ...auth.context, draftOptions: submissionDraftOptions },
          task.taskId,
          traceId,
        );
      } catch (error) {
        // Bugfix: 初始配置失败时旧流程已把 context 切到 task，留下无法继续的空任务。
        // 在持久化 Bot task 状态前完成配置，并删除临时 task，让用户修正配置后可以直接重试。
        await zcodeTaskService
          .deleteTask({
            taskId: task.taskId,
            workspacePath: auth.context.workspacePath,
            workspaceIdentity: auth.context.workspaceIdentity,
          })
          .catch(() => undefined);
        throw error;
      }
      const context = {
        ...auth.context,
        mode: "task" as const,
        activeTaskId: task.taskId,
        draftOptions: undefined,
      };
      await ctx.writeContext(context);
      // Bugfix: Bot 首发不经过 UI 本地 deriveTaskTitle/optimistic cache。
      // 如果 created 广播继续携带 createTask 的空标题，侧栏会一直显示 New task，直到整表刷新。
      await ctx.broadcastTaskListChange(context, task.taskId, "created", {
        task: broadcastTask,
      });
      if (deletedTaskId) {
        botsLogger.info(
          undefined,
          `replaced deleted Bot task bot=${auth.bot.id} oldTask=${deletedTaskId} newTask=${task.taskId} workspace=${getWorkspaceKey(context.workspacePath, context.workspaceIdentity)}`,
        );
        // 切换已经持久化；通知失败不能让 callback 释放去重记录并重跑原消息。
        await ctx
          .sendOutbound(
            auth.bot,
            createOutbound(message.actor, ctx.msg(auth.locale, "deletedTaskReplaced")),
          )
          .catch((error: unknown) => {
            botsLogger.warn(
              undefined,
              `deleted task replacement notice failed bot=${auth.bot.id} task=${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      if (context.group)
        return ctx.submitGroupMessage(
          auth.bot,
          message,
          context,
          preparedMessage,
          auth.locale,
          history,
          topicBatch,
          isCurrent,
        );
      ctx.runningTasks.add(task.taskId);
      await ctx.watchTaskStream(auth.bot, message.actor, context, auth.user);
      await ctx.broadcastTaskListChange(context, task.taskId, "prompt_sent", {
        task: broadcastTask,
        prompt: {
          content: preparedMessage.content,
          attachments:
            preparedMessage.zcodeAttachments.length > 0
              ? preparedMessage.zcodeAttachments
              : undefined,
          messageId: `bot-${traceId}`,
          sentAt: Date.now(),
        },
      });
      ctx.sendPromptInBackground(
        auth.bot,
        message.actor,
        context,
        task.taskId,
        traceId,
        preparedMessage.content,
        preparedMessage.zcodeAttachments,
        resolveAutomationBotDeliveryTarget(message.actor),
        submissionDraftOptions.modelSelection,
      );
      return [];
    }
    if (auth.context.group)
      return ctx.submitGroupMessage(
        auth.bot,
        message,
        auth.context,
        preparedMessage,
        auth.locale,
        history,
        topicBatch,
        isCurrent,
      );
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
    await zcodeTaskService.resumeTask({
      taskId: auth.context.activeTaskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
    });
    // Bot 只是同一 Session 的输入端。菜单可能过滤无效值，不能拿它反推原选择，
    // 更不能重新套用 Bot 创建默认值。解析只确定本次输入，不在此改写 Session。
    const originalSelection = await zcodeTaskService.getTaskModelSelection({
      taskId: auth.context.activeTaskId,
    });
    const selectionView = originalSelection
      ? await ctx.readModelSelectionView(auth.context, originalSelection)
      : null;
    const effectiveSelection = selectionView?.effectiveSelection;
    if (!effectiveSelection || selectionView?.selectionIssue) {
      throw new Error(ctx.msg(auth.locale, "sessionModelUnavailable"));
    }
    await ctx.broadcastTaskListChange(auth.context, auth.context.activeTaskId, "resumed");
    ctx.runningTasks.add(auth.context.activeTaskId);
    await ctx.watchTaskStream(auth.bot, message.actor, auth.context, auth.user);
    const traceId = generateTraceId(auth.context.activeTaskId);
    await ctx.broadcastTaskListChange(auth.context, auth.context.activeTaskId, "prompt_sent", {
      prompt: {
        content: preparedMessage.content,
        attachments:
          preparedMessage.zcodeAttachments.length > 0
            ? preparedMessage.zcodeAttachments
            : undefined,
        messageId: `bot-${traceId}`,
        sentAt: Date.now(),
      },
    });
    ctx.sendPromptInBackground(
      auth.bot,
      message.actor,
      auth.context,
      auth.context.activeTaskId,
      traceId,
      preparedMessage.content,
      preparedMessage.zcodeAttachments,
      resolveAutomationBotDeliveryTarget(message.actor),
      effectiveSelection,
    );
    return [];
  }

  return {
    createSelectionReply,
    handleSelectionCancel,
    handleMessage,
  };
}
