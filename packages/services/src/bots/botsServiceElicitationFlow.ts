import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  BOT_ELICITATION_CUSTOM_OPTION_ID,
  BOT_ELICITATION_SUBMIT_OPTION_ID,
  createOutbound,
  groupCardFor,
} from "./botsServiceSupport.js";
import type {
  BotActor,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  BotPendingElicitation,
  BotStructuredElicitationResponse,
  Locale,
  ZCodeStreamEvent,
} from "@zcode/shared";

export function createBotsServiceElicitationFlow(ctx: BotsServiceContext) {
  async function clearPendingElicitationForRequest(
    context: BotContextState,
    requestId: string,
  ): Promise<void> {
    if (context.pendingElicitation?.requestId !== requestId) {
      return;
    }
    ctx.clearPendingElicitationSelection(context.pendingElicitation);
    await ctx.writeContext(
      { ...context, pendingElicitation: undefined },
      false,
      context.activeTaskId,
    );
  }

  async function submitPendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<BotOutboundMessage[]> {
    if (!ctx.isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    if (pending.handledAt) {
      return [createOutbound(actor, ctx.msg(auth.locale, "elicitationHandled"))];
    }
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
    const submitted = await zcodeTaskService.respondElicitation({
      taskId: pending.taskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
      runId: pending.runId,
      requestId: pending.requestId,
      action,
      content,
    });
    // 修复原因：v4 resolveInteraction 才是业务确认点。若在 ACK 前写 handledAt，
    // 瞬时失败后的同一按钮重试会被误判为已处理，Agent 将永久停在等待用户输入。
    const handledAt = Date.now();
    await ctx.writeContext({
      ...auth.context,
      pendingElicitation: { ...pending, handledAt },
    });
    ctx.clearPendingElicitationSelection(pending);
    await ctx.writeContext({ ...auth.context, pendingElicitation: undefined });
    await ctx.broadcastTaskListChange(auth.context, pending.taskId, "elicitation_resolved", {
      requestId: pending.requestId,
    });
    if (!submitted) {
      return [createOutbound(actor, ctx.msg(auth.locale, "elicitationHandled"))];
    }
    if (action === "accept") {
      ctx.startTyping(auth.bot, actor, pending.taskId);
      // Bugfix: AskUserQuestion 只是在回复问题，不属于命令配置成功；这里保留原问答提交文案，避免误回 /status。
      return [ctx.createCompletedElicitationOutbound(actor, pending, auth.locale, action)];
    }
    // Bugfix: 取消/拒绝问答也应使用问答自己的结果文案，避免第三方 Bot 里出现无关的任务状态。
    return [ctx.createCompletedElicitationOutbound(actor, pending, auth.locale, action)];
  }

  async function advancePendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"],
  ): Promise<BotOutboundMessage[]> {
    if (pending.currentQuestionIndex >= pending.questions.length - 1) {
      return submitPendingElicitation(
        auth,
        actor,
        { ...pending, answers },
        "accept",
        ctx.buildBotElicitationContent(pending, answers),
      );
    }
    const nextPending: BotPendingElicitation = {
      ...pending,
      currentQuestionIndex: pending.currentQuestionIndex + 1,
      answers,
    };
    await ctx.writeContext({ ...auth.context, pendingElicitation: nextPending });
    // Bugfix: Bot 侧代选 AskUserQuestion 后，UI 只收到最终响应会停留在旧本地草稿。
    // 每次推进题号都同步当前题号和已选答案，让桌面/移动 Web 能保持同一选中态。
    await ctx.broadcastPendingElicitationProgress(auth.context, nextPending);
    return ctx.createElicitationReply(actor, nextPending, auth.locale);
  }

  async function handlePendingElicitationValue(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    value: string,
  ): Promise<BotOutboundMessage[]> {
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return [createOutbound(actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    if (!ctx.isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    const parsedValue = ctx.parseElicitationResponseValue(value);
    if (actor.provider !== "weixin") {
      const expectedToken = ctx.getPendingElicitationSelectionToken(pending);
      if (!parsedValue.token || parsedValue.token !== expectedToken) {
        // Bugfix: Telegram/飞书/Webhook 的旧按钮可能在新一轮 AskUserQuestion 后才送达。
        // 非微信通道必须带本轮短 token，避免把上一轮按钮编号误当成当前问题的答案。
        return [createOutbound(actor, ctx.msg(auth.locale, "elicitationExpired"))];
      }
    }
    if (parsedValue.value === ctx.getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const formValues = ctx.parseElicitationFormValues(parsedValue.value);
    if (formValues) {
      const answerKey = ctx.getElicitationAnswerKey(pending.currentQuestionIndex);
      const nextValues = ctx.mergeElicitationFormValues(
        question,
        ctx.readElicitationAnswerValues(pending, pending.currentQuestionIndex),
        formValues,
      );
      if (nextValues.length === 0) {
        return ctx.createElicitationReply(actor, pending, auth.locale);
      }
      // Bugfix: 飞书/Lark 平铺选项由按钮维护草稿，表单只负责提交和自定义输入。
      // 提交时需要合并当前 radio/checkbox 草稿和自定义输入，避免空表单把已选项覆盖掉。
      return advancePendingElicitation(auth, actor, pending, {
        ...pending.answers,
        [answerKey]: nextValues,
      });
    }
    const selectionOption = ctx.resolvePendingSelectionOption(
      actor,
      "elicitation.respond",
      parsedValue.value,
    );
    if (selectionOption?.id === ctx.getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const selectedValue = ctx.resolveElicitationQuestionValue(
      question,
      selectionOption?.id ?? parsedValue.value,
    );
    if (!selectedValue) {
      return ctx.createElicitationReply(actor, pending, auth.locale);
    }
    if (selectedValue === BOT_ELICITATION_SUBMIT_OPTION_ID) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    if (selectedValue === BOT_ELICITATION_CUSTOM_OPTION_ID) {
      const nextPending = ctx.toggleElicitationCustomAnswerExpanded(pending);
      await ctx.writeContext({ ...auth.context, pendingElicitation: nextPending });
      await ctx.broadcastPendingElicitationProgress(auth.context, nextPending);
      return ctx.createElicitationReply(actor, nextPending, auth.locale);
    }
    const answerKey = ctx.getElicitationAnswerKey(pending.currentQuestionIndex);
    if (question.multiSelect) {
      const currentValues = ctx.readElicitationAnswerValues(pending, pending.currentQuestionIndex);
      const nextValues = currentValues.includes(selectedValue)
        ? currentValues.filter((item) => item !== selectedValue)
        : [...currentValues, selectedValue];
      const nextPending = {
        ...pending,
        answers: { ...pending.answers, [answerKey]: nextValues },
      };
      await ctx.writeContext({ ...auth.context, pendingElicitation: nextPending });
      // Bugfix: 多选题在 Bot 里 toggle 后不会触发 ZCode Agent response，必须主动同步草稿给 UI。
      await ctx.broadcastPendingElicitationProgress(auth.context, nextPending);
      return ctx.createElicitationReply(actor, nextPending, auth.locale);
    }
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: [selectedValue],
    });
  }

  async function handlePendingElicitationText(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    text: string,
  ): Promise<BotOutboundMessage[] | null> {
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return null;
    }
    if (!ctx.isPendingElicitationOwnedByActor(pending, actor)) {
      return null;
    }
    const value = text.trim();
    if (!value) {
      return ctx.createElicitationReply(actor, pending, auth.locale);
    }
    if (value === ctx.getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const answerKey = ctx.getElicitationAnswerKey(pending.currentQuestionIndex);
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    if (
      !question.multiSelect &&
      /^[1-9]\d*$/u.test(value) &&
      Number.parseInt(value, 10) === question.options.length + 1
    ) {
      // 修复原因：自由文本必须保留为用户数据；只有菜单显示的额外序号才是跳过，
      // 避免吞掉名为 skip/next/跳过/__skip__ 的合法选项或自定义答案。
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const values = question?.multiSelect
      ? value
          .split(/[,\n，、]/u)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) =>
            ctx.resolveElicitationQuestionValue(question, item, {
              includeSubmit: false,
            }),
          )
      : [ctx.resolveElicitationQuestionValue(question, value, { includeSubmit: false })];
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: values,
    });
  }

  async function handleStructuredElicitationResponse(
    message: BotInboundMessage,
    response: BotStructuredElicitationResponse,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.requestId !== response.requestId) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    if (!ctx.isPendingElicitationOwnedByActor(pending, message.actor)) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    return submitPendingElicitation(
      auth,
      message.actor,
      pending,
      response.action,
      response.content,
    );
  }

  async function handleElicitationRequest(
    bot: BotConfig,
    user: BotConfig,
    actor: BotActor,
    context: BotContextState,
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    mentionedUserIds?: string[],
  ): Promise<void> {
    const locale = await ctx.readMessageLocale();
    ctx.stopTyping(event.taskId);
    const pendingElicitation: BotPendingElicitation = {
      taskId: event.taskId,
      requestId: event.requestId,
      runId: event.traceId,
      // Bugfix：subagent 发起的 elicitation 必须保留 origin；否则 Bot 广播和后续响应
      // 无法还原请求归属，rebase 后只剩顶层 stream event 带 origin。
      ...(event.origin ? { origin: event.origin } : {}),
      actorKey: ctx.getActorContextKey(actor),
      currentQuestionIndex: 0,
      // 修复原因：ExitPlanMode 的协议问题和选项使用稳定英文；如果直接复用，中文 Bot 卡片会中英混杂。
      // Bot 在出站边界按 App locale 本地化整组审批文案，普通 AskUserQuestion 保持模型原文。
      questions: ctx.normalizeBotElicitationQuestions(event, locale),
      answers: {},
      // 修复原因：Feishu/Lark 会在自定义回答、完成和重启恢复时重建原卡片；
      // 只把 schema 作为首次发送参数会让后续更新丢失 plan 并退回通用 Question 卡片。
      ...(ctx.readBotElicitationRenderContext(event)
        ? { renderContext: ctx.readBotElicitationRenderContext(event) }
        : {}),
    };
    // Bugfix: Bot 原先只消费 permission_request，没有把 ZCode Agent 的
    // AskUserQuestion/elicitation_request 转成第三方可回答消息，任务会一直卡在等待用户输入。
    if (context.pendingElicitation) {
      ctx.clearPendingElicitationSelection(context.pendingElicitation);
    }
    Object.assign(context, { pendingElicitation });
    await ctx.writeContext({ ...context, pendingElicitation }, false, context.activeTaskId);
    await ctx.broadcastPendingElicitationProgress(context, pendingElicitation);
    for (const reply of await ctx.createElicitationReply(actor, pendingElicitation, locale)) {
      // 原因：临时交互卡绕过普通出站分支，曾丢失群任务和授权版本；选择传输方式前统一附加。
      const scopedReply = context.group
        ? {
            ...reply,
            mentionedUserIds:
              pendingElicitation.renderContext?.kind === "plan_approval"
                ? ctx.adminAttention.mention(
                    actor,
                    bot.providerUserId,
                    `plan:${event.taskId}:${event.requestId}`,
                  )
                : mentionedUserIds,
            groupTaskId: context.activeTaskId!,
            groupCard: groupCardFor(actor, context),
          }
        : reply;
      if (ctx.shouldUseTransientInteractionCard(bot, user)) {
        await ctx.upsertTransientInteractionCard(bot, actor, event.taskId, scopedReply);
      } else {
        await ctx.sendOutbound(bot, scopedReply);
      }
    }
  }

  return {
    clearPendingElicitationForRequest,
    submitPendingElicitation,
    advancePendingElicitation,
    handlePendingElicitationValue,
    handlePendingElicitationText,
    handleStructuredElicitationResponse,
    handleElicitationRequest,
  };
}
