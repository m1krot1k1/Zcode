import type { BotsServiceContext } from "./botsServicePorts.js";
import { formatBotModelSelectionValue } from "./botsServiceOptions.js";
import { createOutbound, helpMessageByCommand } from "./botsServiceSupport.js";
import { BOT_MENU_COMMAND_ORDER } from "./commandOrder.js";
import type { BotMessageId } from "./messages.js";
import {
  formatStatusTaskLine,
  formatTaskRunningDuration,
  readLatestTaskProgress,
  readTaskWorkedDurationMs,
  taskStatus,
} from "./statusFormatting.js";
import { getWorkspaceLabel } from "./workspaceHelpers.js";
import type {
  BotActor,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  Locale,
} from "@zcode/shared";

export function createBotsServiceStatus(ctx: BotsServiceContext) {
  async function handleStatus(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "status");
    if (!auth.ok) {
      return auth.reply;
    }
    // 群内 /status 与配置后的状态回复共用脱敏入口，避免单独分支泄露绝对路径。
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function createStatusReply(
    actor: BotActor,
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<BotOutboundMessage[]> {
    return [
      createOutbound(
        actor,
        context.group
          ? (await buildStatusText(context, locale))
              .split(context.workspacePath)
              .join(getWorkspaceLabel(context.workspacePath))
          : await buildStatusText(context, locale),
        undefined,
        {
          locale,
        },
      ),
    ];
  }

  function formatStatusLine(
    locale: Locale | undefined,
    labelId: BotMessageId,
    value: string,
  ): string {
    // Bugfix: /status 文案由服务层拼接，标签和值都要跟随 bot 当前 locale。
    return `${ctx.msg(locale, labelId)}: ${value}`;
  }

  function formatStatusStateValue(locale: Locale | undefined, state: string): string {
    if (locale === "en-US") {
      return state;
    }
    switch (state) {
      case "draft":
        return ctx.msg(locale, "statusDraft");
      case "remote disconnected":
        return ctx.msg(locale, "statusRemoteDisconnected");
      case "running":
        return ctx.msg(locale, "streamingStatusRunning");
      case "completed":
        return ctx.msg(locale, "streamingStatusCompleted");
      case "error":
      case "failed":
        return ctx.msg(locale, "streamingStatusFailed");
      case "cancelled":
        return ctx.msg(locale, "statusCancelled");
      case "stopped":
        return ctx.msg(locale, "statusStopped");
      default:
        return state;
    }
  }

  async function buildStatusText(
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<string> {
    const workspace = (await ctx.listWorkspaceRefs()).find(
      (item) => item.id === context.workspaceId,
    );
    if (!(await ctx.isRemoteWorkspaceConnected(context))) {
      const draftOptions = context.draftOptions;
      return [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        formatStatusLine(
          locale,
          "statusModel",
          await ctx.formatStatusModelLabel(
            formatBotModelSelectionValue(draftOptions?.modelSelection),
            context,
          ),
        ),
        "------",
        formatStatusLine(
          locale,
          "statusTask",
          context.activeTaskId ?? ctx.msg(locale, "statusDraft"),
        ),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, "remote disconnected"),
        ),
        ctx.msg(locale, "remoteDisconnectedStatus", {
          workspacePath: context.workspacePath,
        }),
      ].join("\n");
    }
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    const activeTask = context.activeTaskId
      ? tasks.find((task) => task.taskId === context.activeTaskId)
      : null;
    const activeTaskSnapshot = context.activeTaskId
      ? await zcodeTaskService
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      : null;
    // Bugfix: activeTaskId 来自 bot context，不应依赖 listTasks 必然返回同一条任务。
    // 某些筛选/索引时序下 listTasks 找不到 active task，之前会跳过 snapshot，导致 Progress 永远缺失。
    const statusTask = activeTask ?? activeTaskSnapshot?.meta ?? null;
    // Bugfix: 任务结束后 /status 只保留最终状态，避免把最后一次工具/思考进度误看成仍在执行。
    const latestProgress =
      context.activeTaskId && (!statusTask || taskStatus(statusTask) === "running")
        ? (ctx.liveStatusProgressByTaskId.get(context.activeTaskId)?.text ??
          readLatestTaskProgress(activeTaskSnapshot))
        : null;
    const workedDurationMs = statusTask
      ? readTaskWorkedDurationMs(activeTaskSnapshot, statusTask)
      : null;
    const activeTaskConfigOptions = context.activeTaskId
      ? await ctx.listActiveTaskConfigOptions(context, context.activeTaskId)
      : [];
    const isDraftStatus = context.mode === "draft" || !context.activeTaskId;
    const draftOptions =
      !statusTask && isDraftStatus ? await ctx.ensureDraftOptions(context) : null;
    // Bot Draft 属于 Select：未显式固定模型时只展示目标 Host 当前首选，不把默认值写回配置。
    const draftView = draftOptions
      ? await ctx.readModelSelectionView(context, draftOptions.modelSelection)
      : null;
    const draftEffectiveSelection = draftOptions?.modelSelection
      ? draftView?.effectiveSelection
      : draftView?.preferredSelection;
    const statusModel =
      ctx.readConfigSelectCurrentValue(activeTaskConfigOptions, "model") ??
      statusTask?.model ??
      formatBotModelSelectionValue(draftEffectiveSelection ?? undefined) ??
      "-";
    const statusModelLabel = await ctx.formatStatusModelLabel(statusModel, context);
    return (
      [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        // Bugfix: active task 显示真实 task 状态；草稿态显示 draftOptions。
        // /new 后草稿继承自当前 task，继续显示 "-" 会让用户误以为继承失败。
        formatStatusLine(locale, "statusModel", statusModelLabel),
        "------",
        statusTask
          ? formatStatusTaskLine(statusTask, ctx.msg(locale, "statusTask"))
          : formatStatusLine(locale, "statusTask", ctx.msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, statusTask ? taskStatus(statusTask) : "draft"),
        ),
        workedDurationMs !== null
          ? formatStatusLine(locale, "statusWorked", formatTaskRunningDuration(workedDurationMs))
          : null,
        latestProgress ? formatStatusLine(locale, "statusProgress", latestProgress) : null,
      ].filter(Boolean) as string[]
    ).join("\n");
  }

  async function handleHelp(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    return [
      createOutbound(
        message.actor,
        buildHelpText(
          auth.locale,
          auth.bot,
          auth.context.group
            ? message.actor.providerUserId === auth.context.group.ownerId
              ? "owner"
              : "member"
            : undefined,
        ),
      ),
    ];
  }

  function buildHelpText(
    locale: Locale | undefined,
    bot: Pick<BotConfig, "allowedCommands">,
    groupRole?: "owner" | "member",
  ): string {
    const lines = [ctx.msg(locale, "helpTitle")];
    if (groupRole) {
      lines.push(
        locale === "en-US"
          ? "Mention this bot to submit a request. /answer answers your active question."
          : "@当前机器人提交需求；/answer 回答自己发起请求中的问题。",
      );
      if (groupRole === "owner") {
        lines.push("/enable · /disable · /task · /stop · /approve · /deny · /reconnect");
        if (bot.allowedCommands.workspace !== false) lines.push("/history on|off");
      }
    }
    for (const command of BOT_MENU_COMMAND_ORDER) {
      if (
        groupRole &&
        (command === "bind" ||
          command === "reply" ||
          (groupRole === "member" && command !== "help" && command !== "status"))
      )
        continue;
      if (command === "help" || command === "bind") {
        lines.push(ctx.msg(locale, helpMessageByCommand[command]));
        continue;
      }
      if (bot.allowedCommands[command] === false) {
        continue;
      }
      lines.push(ctx.msg(locale, helpMessageByCommand[command]));
    }
    return lines.join("\n");
  }

  return {
    handleStatus,
    createStatusReply,
    formatStatusLine,
    formatStatusStateValue,
    buildStatusText,
    handleHelp,
    buildHelpText,
  };
}
