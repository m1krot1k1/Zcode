import type { BotsServiceContext } from "./botsServicePorts.js";
import { formatWorkspaceOptionLabel } from "./botsServiceOptions.js";
import { createOutbound } from "./botsServiceSupport.js";
import {
  filterAllowedWorkspaces,
  isWorkspaceAllowed,
  resolveWorkspaceByValue,
} from "./workspaceHelpers.js";
import type { BotCommand, BotInboundMessage, BotOutboundMessage } from "@zcode/shared";

export function createBotsServiceCommandsWorkspace(ctx: BotsServiceContext) {
  async function handleNewCommand(
    message: BotInboundMessage,
    _command: Extract<BotCommand, { type: "new" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "new");
    if (!auth.ok) return auth.reply;
    if (message.actor.threadId)
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "Open another topic to start a new task."
            : "请另开一个话题开始新任务。",
        ),
      ];
    const blockReason = await ctx.getContextTaskBlockReason(auth.context);
    if (blockReason) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    const context = await ctx.writeDraftContext(
      auth.context,
      await ctx.buildActiveTaskDraftOptions(auth.context),
    );
    return ctx.createStatusReply(message.actor, context, auth.locale);
  }

  async function handleWorkspaceListCommand(
    message: BotInboundMessage,
    _command: Extract<BotCommand, { type: "workspace.list" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    const blockReason = await ctx.getContextTaskBlockReason(auth.context);
    if (blockReason) {
      // Bugfix: task 运行中不展示 workspace 选择，避免用户误以为可以切换上下文。
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    const synced = await ctx.normalizeBotWorkspaceConfig(
      auth.config,
      auth.bot,
      ctx.createCurrentWorkspaceRef(auth.context),
    );
    const visibleWorkspaces = filterAllowedWorkspaces(
      synced.workspaces,
      synced.user.allowedWorkspaces,
    );
    const options = visibleWorkspaces.map((workspace) => ({
      id: workspace.id,
      // Bugfix: Telegram/飞书等按钮通道只展示 label，不展示 description。
      // 远端标识必须合进 label，避免 /workspace 列表看不出哪些项目来自远端。
      label: formatWorkspaceOptionLabel(workspace, auth.locale),
    }));
    if (options.length === 0) {
      ctx.pendingWorkspaceSelectionsByContext.delete(ctx.getActorContextKey(message.actor));
      return [createOutbound(message.actor, ctx.msg(auth.locale, "workspaceMissing"))];
    }
    // Bugfix: 远端 workspace 选项必须在展示时保留 workspaceIdentity。
    // Telegram/飞书按钮会把点击变成 /workspace 序号，切换阶段若重新从 settings 解析，
    // current remote context 可能不在候选列表里，最终表现成 /workspace 不支持远端。
    ctx.pendingWorkspaceSelectionsByContext.set(
      ctx.getActorContextKey(message.actor),
      new Map(visibleWorkspaces.map((workspace) => [workspace.id, { workspace }])),
    );
    return ctx.createSelectionReply(
      message.actor,
      {
        id: `workspace-${Date.now()}`,
        title: ctx.msg(auth.locale, "workspaceSelectTitle", {
          workspace:
            visibleWorkspaces.find((workspace) => workspace.id === auth.context.workspaceId)
              ?.label ?? auth.context.workspacePath,
        }),
        currentId: auth.context.workspaceId,
        action: "workspace.set",
        options,
      },
      auth.locale,
    );
  }

  async function handleWorkspaceSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "workspace.set" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    const blockReason = await ctx.getContextTaskBlockReason(auth.context);
    if (blockReason) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    const synced = await ctx.normalizeBotWorkspaceConfig(
      auth.config,
      auth.bot,
      ctx.createCurrentWorkspaceRef(auth.context),
    );
    const workspace =
      ctx.resolvePendingWorkspaceSelectionEntry(message.actor, command.value)?.workspace ??
      resolveWorkspaceByValue(synced.workspaces, command.value, synced.user.allowedWorkspaces);
    if (!workspace)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "workspaceMissing"))];
    if (!isWorkspaceAllowed(workspace.id, synced.user.allowedWorkspaces))
      return [createOutbound(message.actor, ctx.msg(auth.locale, "workspaceOutOfScope"))];
    const context = { ...auth.context, ...(await ctx.bindProject(workspace)) };
    const draftContext = await ctx.writeDraftContext(
      context,
      await ctx.buildInitializedDraftOptions(context),
    );
    ctx.pendingWorkspaceSelectionsByContext.delete(ctx.getActorContextKey(message.actor));
    return ctx.createStatusReply(message.actor, draftContext, auth.locale);
  }

  return {
    handleNewCommand,
    handleWorkspaceListCommand,
    handleWorkspaceSetCommand,
  };
}
