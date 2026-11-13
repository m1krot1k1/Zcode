import type { BotsServiceContext } from "./botsServicePorts.js";
import { isSelectionIndexValue, resolveOptionByValue } from "./botsServiceOptions.js";
import { botsLogger } from "./botsServiceSupport.js";
import { parseBotCommand } from "./commandParser.js";
import {
  type BotActor,
  type BotCommand,
  type BotConfig,
  type BotOutboundMessage,
  type SelectionPrompt,
  isFeishuBotProvider,
  normalizeBotReplyGranularity,
} from "@zcode/shared";

export function createBotsServiceSelection(ctx: BotsServiceContext) {
  function getActorContextKey(actor: BotActor): string {
    return [
      actor.botId,
      actor.provider,
      actor.chatId?.trim() || actor.providerUserId,
      ...(actor.threadId ? [actor.threadId] : []),
      ...(actor.chatType === "group" ? [actor.providerUserId] : []),
    ].join("::");
  }

  function clearPrivatePendingSelectionsForBot(botId: string): void {
    // 私聊新建不能清掉群成员的菜单；群 key 额外包含发送者这一段。
    const matchesBot = (contextKey: string): boolean =>
      contextKey === botId ||
      (contextKey.startsWith(`${botId}::`) &&
        contextKey.slice(botId.length + 2).split("::").length === 2);
    for (const contextKey of ctx.pendingSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        ctx.pendingSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of ctx.pendingTaskSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        ctx.pendingTaskSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of ctx.pendingWorkspaceSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        ctx.pendingWorkspaceSelectionsByContext.delete(contextKey);
      }
    }
  }

  function resolvePendingSelectionOption(
    actor: BotActor,
    action: SelectionPrompt["action"],
    value: string,
  ): SelectionPrompt["options"][number] | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = ctx.pendingSelectionsByContext.get(actorContextKey);
    if (selection?.action !== action) {
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (option) {
      ctx.pendingSelectionsByContext.delete(actorContextKey);
    }
    return option;
  }

  function clearPendingSelection(actor: BotActor): void {
    const actorContextKey = getActorContextKey(actor);
    ctx.pendingSelectionsByContext.delete(actorContextKey);
    ctx.pendingTaskSelectionsByContext.delete(actorContextKey);
    ctx.pendingWorkspaceSelectionsByContext.delete(actorContextKey);
  }

  function resolvePendingSelectionCommand(actor: BotActor, value: string): BotCommand | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = ctx.pendingSelectionsByContext.get(actorContextKey);
    if (!selection) {
      return null;
    }
    if (actor.provider !== "weixin") {
      // Bugfix: 只有微信没有结构化选项，只能靠“回复数字”承接 pending selection。
      // Telegram/飞书等 provider 有按钮回调，普通文本不应被隐式解析成菜单选择。
      clearPendingSelection(actor);
      return null;
    }
    if (!isSelectionIndexValue(value)) {
      // Bugfix: /task 等列表命令会留下 pending selection。
      // 旧逻辑允许普通文本按 label 命中选项，用户输入与 task 标题同名的消息时会被误切 task。
      // 隐式选择只接受纯数字；按 id/label 选择仍通过显式 /task <value> 等命令完成。
      clearPendingSelection(actor);
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (!option) {
      clearPendingSelection(actor);
      return null;
    }
    ctx.pendingSelectionsByContext.delete(actorContextKey);
    switch (selection.action) {
      case "queue.cancel":
        return parseBotCommand(option.id);
      case "workspace.set":
        return { type: "workspace.set", value: option.id };
      case "model.provider.set":
        return { type: "model.provider.set", value: option.id };
      case "model.set":
        return { type: "model.set", value: option.id };
      case "mode.set":
        return { type: "mode.set", value: option.id };
      case "thoughtLevel.set":
        return { type: "thoughtLevel.set", value: option.id };
      case "task.set":
        return { type: "task.set", value: option.id };
      case "reply.set":
        return { type: "reply.set", value: option.id };
      case "permission.respond":
        return { type: "permission.respond", value };
      case "elicitation.respond":
        return { type: "elicitation.respond", value: option.id };
    }
  }

  function shouldUseTransientInteractionCard(bot: BotConfig, user: BotConfig): boolean {
    const adapter = ctx.providers[bot.provider];
    return (
      isFeishuBotProvider(bot.provider) &&
      normalizeBotReplyGranularity(bot.provider, user.replyMode) === "streaming_card" &&
      Boolean(adapter?.createTransientInteractionCard) &&
      Boolean(adapter?.updateTransientInteractionCard)
    );
  }

  async function upsertTransientInteractionCard(
    bot: BotConfig,
    actor: BotActor,
    taskId: string,
    message: BotOutboundMessage,
  ): Promise<void> {
    const adapter = ctx.providers[bot.provider];
    const key = getActorContextKey(actor);
    const existing = ctx.transientInteractionCards.get(key);
    if (existing) {
      // 修复原因：交互推进时 POST 新卡再 DELETE 旧卡会显示撤回痕迹。
      // callback token 更新失败后的降级路径也只能 PATCH 原 message_id，保持单卡身份稳定。
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, message);
      return;
    }
    const handle = await adapter?.createTransientInteractionCard?.(bot, message);
    if (!handle) {
      return;
    }
    ctx.transientInteractionCards.set(key, { bot, taskId, handle });
  }

  async function finalizeTransientInteractionCard(
    actor: BotActor,
    fallback: BotOutboundMessage,
  ): Promise<boolean> {
    const key = getActorContextKey(actor);
    const existing = ctx.transientInteractionCards.get(key);
    if (!existing) {
      return false;
    }
    const adapter = ctx.providers[existing.bot.provider];
    try {
      // 修复原因：交互完成后撤回卡片会让问答和计划从聊天历史消失，用户无法回看
      // 决策上下文。终态只更新为无控件卡片并释放运行时句柄，后续交互会创建新卡。
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, fallback);
    } catch (error) {
      botsLogger.warn(
        undefined,
        `finalize interaction card failed bot=${existing.bot.id} task=${existing.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      ctx.transientInteractionCards.delete(key);
    }
    return true;
  }

  return {
    getActorContextKey,
    clearPrivatePendingSelectionsForBot,
    resolvePendingSelectionOption,
    clearPendingSelection,
    resolvePendingSelectionCommand,
    shouldUseTransientInteractionCard,
    upsertTransientInteractionCard,
    finalizeTransientInteractionCard,
  };
}
