import type { BotsServiceContext } from "./botsServicePorts.js";
import { botsLogger, createOutbound } from "./botsServiceSupport.js";
import type { BotCommand, BotInboundMessage, BotOutboundMessage } from "@zcode/shared";

export function createBotsServiceCommandsInteraction(ctx: BotsServiceContext) {
  async function handlePermissionRespondCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "permission.respond" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "approve");
    if (!auth.ok) return auth.reply;
    if (!auth.context.activeTaskId)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "noActiveTask"))];
    const optionIndex = Number.parseInt(command.value, 10) - 1;
    const option = Number.isFinite(optionIndex)
      ? auth.context.pendingPermissionOptions?.[optionIndex]
      : undefined;
    botsLogger.info(
      undefined,
      `permission callback task=${auth.context.activeTaskId} user=${message.actor.providerUserId} optionIndex=${optionIndex + 1} pending=${auth.context.pendingPermissionOptions?.length ?? 0} option=${option ? `${option.command}:${option.optionId}` : "missing"} handled=${option?.handledAt ? "yes" : "no"}`,
    );
    if (!option) return [createOutbound(message.actor, ctx.msg(auth.locale, "permissionExpired"))];
    if (option.handledAt)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "permissionHandled"))];
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
    const submitted = await zcodeTaskService.respondPermission({
      taskId: auth.context.activeTaskId,
      requestId: option.requestId,
      optionId: option.optionId,
      response: option.response,
    });
    // 修复原因：权限和问答必须以同一个 v4 ACK 为提交点。ACK 失败前不能持久化
    // handledAt，否则 Telegram/文本序号按钮无法重试，runtime 仍会继续等待权限。
    const handledAt = Date.now();
    const nextPermissionOptions = auth.context.pendingPermissionOptions?.map((item) =>
      item.requestId === option.requestId ? { ...item, handledAt } : item,
    );
    botsLogger.info(
      undefined,
      `permission callback respond task=${auth.context.activeTaskId} requestId=${option.requestId} optionId=${option.optionId} submitted=${submitted}`,
    );
    if (!submitted) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "permissionHandled"))];
    }
    await ctx.writeContext({
      ...auth.context,
      pendingPermissionOptions: nextPermissionOptions,
    });
    await ctx.broadcastTaskListChange(
      auth.context,
      auth.context.activeTaskId,
      "permission_resolved",
      {
        requestId: option.requestId,
      },
    );
    ctx.startTyping(auth.bot, message.actor, auth.context.activeTaskId);
    return [
      createOutbound(
        message.actor,
        ctx.msg(
          auth.locale,
          option.command === "deny" ? "permissionDenied" : "permissionSubmitted",
        ),
      ),
    ];
  }

  async function handleElicitationRespondCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "elicitation.respond" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    return ctx.handlePendingElicitationValue(auth, message.actor, command.value);
  }

  async function handleElicitationSubmitCommand(
    message: BotInboundMessage,
    _command: Extract<BotCommand, { type: "elicitation.submit" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const pending = auth.context.pendingElicitation;
    if (!pending) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    if (message.actor.provider !== "weixin") {
      // Bugfix: 非微信通道的“完成”应从带 token 的按钮进入 elicitation.respond。
      // 直接 /elicitation submit 没有轮次标识，可能误提交上一轮 AskUserQuestion。
      return [createOutbound(message.actor, ctx.msg(auth.locale, "elicitationExpired"))];
    }
    return ctx.submitPendingElicitation(
      auth,
      message.actor,
      pending,
      "accept",
      ctx.buildBotElicitationContent(pending),
    );
  }

  async function handleApproveCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "approve" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "approve");
    if (!auth.ok) return auth.reply;
    if (!auth.context.activeTaskId)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "noActiveTask"))];
    const pendingOption = auth.context.pendingPermissionOptions?.find(
      (option) => option.requestId === command.requestId && option.optionId === command.optionId,
    );
    if (!pendingOption) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "permissionHandled"))];
    }
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
    const submitted = await zcodeTaskService.respondPermission({
      taskId: auth.context.activeTaskId,
      requestId: command.requestId,
      optionId: command.optionId,
      response: pendingOption.response,
    });
    if (!submitted)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "permissionHandled"))];
    await ctx.broadcastTaskListChange(
      auth.context,
      auth.context.activeTaskId,
      "permission_resolved",
      {
        requestId: command.requestId,
      },
    );
    ctx.startTyping(auth.bot, message.actor, auth.context.activeTaskId);
    return [createOutbound(message.actor, ctx.msg(auth.locale, "permissionSubmitted"))];
  }

  async function handleDenyCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "deny" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "approve");
    if (!auth.ok) return auth.reply;
    if (!auth.context.activeTaskId)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "noActiveTask"))];
    const pendingOption = auth.context.pendingPermissionOptions?.find(
      (option) => option.requestId === command.requestId && option.command === "deny",
    );
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
    const submitted = await zcodeTaskService.respondPermission({
      taskId: auth.context.activeTaskId,
      requestId: command.requestId,
      optionId: "deny",
      response: pendingOption?.response ?? {
        decision: "deny",
        reason: "Denied by bot command",
      },
    });
    if (!submitted)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "permissionHandled"))];
    await ctx.broadcastTaskListChange(
      auth.context,
      auth.context.activeTaskId,
      "permission_resolved",
      {
        requestId: command.requestId,
      },
    );
    ctx.startTyping(auth.bot, message.actor, auth.context.activeTaskId);
    return [createOutbound(message.actor, ctx.msg(auth.locale, "permissionDenied"))];
  }

  async function handleUnknownCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "unknown" }>,
  ): Promise<BotOutboundMessage[]> {
    return [
      createOutbound(
        message.actor,
        ctx.msg(await ctx.readMessageLocale(), "unknownCommand", {
          command: command.name,
        }),
      ),
    ];
  }

  return {
    handlePermissionRespondCommand,
    handleElicitationRespondCommand,
    handleElicitationSubmitCommand,
    handleApproveCommand,
    handleDenyCommand,
    handleUnknownCommand,
  };
}
