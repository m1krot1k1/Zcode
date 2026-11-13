import type { BotTaskSelectionEntry } from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  getReplyGranularityOptions,
  resolveOptionByValue,
  resolveReplyGranularityByValue,
} from "./botsServiceOptions.js";
import { botsLogger, createOutbound } from "./botsServiceSupport.js";
import { getBotStateKey } from "./groupSessions.js";
import { taskStatus } from "./statusFormatting.js";
import {
  type BotCommand,
  type BotConfig,
  type BotContextState,
  type BotInboundMessage,
  type BotOutboundMessage,
  type SelectionPrompt,
  normalizeBotReplyGranularity,
} from "@zcode/shared";

export function createBotsServiceCommandsTask(ctx: BotsServiceContext) {
  async function handleTaskList(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "task");
    if (!auth.ok) {
      return auth.reply;
    }
    if (message.actor.threadId)
      return ctx.createStatusReply(message.actor, auth.context, auth.locale);
    const blockReason = await getContextTaskBlockReason(auth.context);
    if (blockReason) {
      // Bugfix: 运行中展示 /task 列表会让用户继续点选其它 task，
      // 即使后续切换被拒绝，也会留下误导性的 pending selection。
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    const taskEntries = (await ctx.listContextTaskSelectionEntries(auth.context, auth.user)).slice(
      0,
      10,
    );
    const tasks = taskEntries.map((entry) => entry.task);
    const activeTask = auth.context.activeTaskId
      ? tasks.find((task) => task.taskId === auth.context.activeTaskId)
      : null;
    const selection: SelectionPrompt = {
      id: `task-${Date.now()}`,
      title: ctx.msg(auth.locale, "taskSelectTitle", {
        task: activeTask ? `${activeTask.title} (${activeTask.taskId})` : "draft",
      }),
      currentId: auth.context.activeTaskId ?? undefined,
      action: "task.set",
      options: taskEntries.map((entry) => ({
        id: entry.task.taskId,
        label: entry.task.title,
        description: taskStatus(entry.task),
      })),
    };
    if (taskEntries.length > 0) {
      // Bugfix: 远端 task 展示时必须把 workspaceIdentity 一起缓存。
      // 否则点击 /task 的序号后只剩 taskId，后续二次查询会退回 path-only 语义并提示 Task not found。
      ctx.pendingTaskSelectionsByContext.set(
        ctx.getActorContextKey(message.actor),
        new Map(taskEntries.map((entry) => [entry.task.taskId, entry])),
      );
    } else {
      ctx.pendingTaskSelectionsByContext.delete(ctx.getActorContextKey(message.actor));
    }
    return tasks.length > 0
      ? ctx.createSelectionReply(message.actor, selection, auth.locale)
      : [createOutbound(message.actor, ctx.msg(auth.locale, "noHistoryTasks"))];
  }

  async function resolveTaskSelectionEntry(
    message: BotInboundMessage,
    context: BotContextState,
    user: BotConfig,
    value: string,
  ): Promise<BotTaskSelectionEntry | null> {
    const entries = await ctx.listContextTaskSelectionEntries(context, user);
    // 旧菜单只解析 taskId，实际归属必须重读；snapshot 不得绕过项目与固定 cwd 边界。
    const pending = ctx.resolvePendingTaskSelectionEntry(message.actor, value);
    return (
      resolveOptionByValue(
        entries.map((entry) => ({ id: entry.task.taskId, label: entry.task.title, entry })),
        pending?.task.taskId ?? value,
      )?.entry ?? null
    );
  }

  async function getContextTaskBlockReason(
    context: BotContextState,
  ): Promise<
    "taskRunning" | "groupTaskQueued" | "groupTaskInteraction" | "groupTaskDisconnected" | null
  > {
    if (!context.activeTaskId) {
      return null;
    }
    if (context.group) {
      if (context.workspaceIdentity && !(await ctx.isRemoteWorkspaceConnected(context)))
        return "groupTaskDisconnected";
      const taskService = await ctx.resolveZCodeTaskServiceForContext(context);
      if (!taskService.getBotGroupTaskBlockReason)
        throw new Error("Runtime cannot verify group queue state");
      const reason = await taskService.getBotGroupTaskBlockReason({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
      botsLogger.debug(
        undefined,
        `group task switch check task=${context.activeTaskId} reason=${reason ?? "idle"}`,
      );
      if (reason)
        return reason === "queued"
          ? "groupTaskQueued"
          : reason === "interaction"
            ? "groupTaskInteraction"
            : "taskRunning";
      // 停止或在 Desktop 处理审批后，Bot 卡片缓存可能仍残留；不能让缓存否决 CLI 空闲状态。
      if (context.pendingElicitation || context.pendingPermissionOptions?.length) {
        if (context.pendingElicitation)
          ctx.clearPendingElicitationSelection(context.pendingElicitation);
        context.pendingElicitation = undefined;
        context.pendingPermissionOptions = undefined;
        await ctx.writeContext(context, false, context.activeTaskId);
        botsLogger.info(
          undefined,
          `cleared stale group interaction cache task=${context.activeTaskId}`,
        );
      }
      return null;
    }
    if (!ctx.runningTasks.has(context.activeTaskId)) {
      return null;
    }
    if (context.workspaceIdentity && !(await ctx.isRemoteWorkspaceConnected(context))) {
      // Bugfix: /workspace 这类本地命令只是在切换上下文，不能为了确认旧任务状态而创建远端 runtime。
      // 断连时把内存 running 状态视为不可确认，交给显式 /reconnect 后再恢复查询。
      return null;
    }
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(context);
    const activeTaskSnapshot = await zcodeTaskService
      .getTaskSnapshot({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => null);
    if (
      activeTaskSnapshot?.meta.status === "completed" ||
      activeTaskSnapshot?.meta.status === "error"
    ) {
      // Bugfix: Bots 进程内 runningTasks 可能因重启/流式终态事件丢失而和持久化状态不一致。
      // ZCode Agent 历史任务的 status 为空也可能只是旧数据，不代表 UI 仍在运行；只有本进程确实发起
      // 且尚未观察到终态的 task 才阻止 /task、/new 等上下文切换。
      ctx.runningTasks.delete(context.activeTaskId);
      ctx.stopTyping(context.activeTaskId);
      return null;
    }
    return "taskRunning";
  }

  async function handleTaskSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "task.set" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "task");
    if (!auth.ok) return auth.reply;
    if (message.actor.threadId)
      return ctx.createStatusReply(message.actor, auth.context, auth.locale);
    const taskEntry = await resolveTaskSelectionEntry(
      message,
      auth.context,
      auth.user,
      command.value,
    );
    if (!taskEntry) return [createOutbound(message.actor, ctx.msg(auth.locale, "taskMissing"))];
    const { task } = taskEntry;
    const blockReason =
      auth.context.activeTaskId !== task.taskId
        ? await getContextTaskBlockReason(auth.context)
        : null;
    if (blockReason) {
      // Bugfix: 运行中的旧 task 已经建立了第三方 stream 订阅。
      // 如果此时允许 /task 改写 activeTaskId，后续输入会落到新 task，
      // 但旧 task 输出仍会继续回到同一 bot 会话，用户会误以为消息串线。
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    const nextContext = {
      ...auth.context,
      mode: "task",
      activeTaskId: task.taskId,
    } satisfies BotContextState;
    await ctx.writeContext(nextContext);
    if (auth.context.activeTaskId !== nextContext.activeTaskId)
      ctx.stopGroupSynchronization(auth.context);
    await ctx.restoreGroupSynchronization(nextContext);
    ctx.pendingTaskSelectionsByContext.delete(ctx.getActorContextKey(message.actor));
    return ctx.createStatusReply(message.actor, nextContext, auth.locale);
  }

  async function handleReplyListCommand(
    message: BotInboundMessage,
    _command: Extract<BotCommand, { type: "reply.list" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "reply");
    if (!auth.ok) return auth.reply;
    return ctx.createSelectionReply(
      message.actor,
      {
        id: `reply-${Date.now()}`,
        title: ctx.msg(auth.locale, "replySelectTitle", {
          mode: ctx.formatReplyGranularityLabel(auth.bot.replyMode, auth.locale, auth.bot.provider),
        }),
        currentId: normalizeBotReplyGranularity(auth.bot.provider, auth.bot.replyMode),
        action: "reply.set",
        options: getReplyGranularityOptions(auth.locale, auth.bot.provider),
      },
      auth.locale,
    );
  }

  async function handleReplySetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "reply.set" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "reply");
    if (!auth.ok) return auth.reply;
    const replyGranularity = resolveReplyGranularityByValue(
      command.value,
      auth.locale,
      auth.bot.provider,
    );
    if (!replyGranularity)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "replyMissing"))];
    await ctx.service.saveBot({
      bot: {
        ...auth.bot,
        replyMode: replyGranularity.id,
      },
    });
    return ctx.createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function handleTopicLeaveCommand(
    message: BotInboundMessage,
    _command: Extract<BotCommand, { type: "topic.leave" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    if (!auth.context.group?.threadId)
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US" ? "Use /leave inside a topic." : "请在话题中使用 /leave。",
        ),
      ];
    await ctx.cancelTopicInputs(message.actor);
    await ctx.serializeStateWrite(async () => {
      const state = await ctx.repo.readState();
      const current = state.bots[getBotStateKey(auth.context)];
      if (current?.group) current.group.topicActive = false;
      await ctx.repo.writeState(state);
    });
    if (auth.context.activeTaskId) {
      const service = await ctx.resolveZCodeTaskServiceForContext(auth.context);
      const target = {
        taskId: auth.context.activeTaskId,
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
      };
      if (!service.readBotTopicExecution || !service.stopBotTopicExecution)
        throw new Error("Topic runtime control is unavailable");
      const executionId = await service.readBotTopicExecution(target);
      if (executionId) await ctx.stopTopicRun(auth.context, executionId.executionId);
    }
    return [
      createOutbound(
        message.actor,
        auth.locale === "en-US"
          ? "Left this topic. Mention me to resume the same task."
          : "已退出话题。再次 @我可继续原任务。",
      ),
    ];
  }

  async function handleStopCommand(
    message: BotInboundMessage,
    _command: Extract<BotCommand, { type: "stop" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "stop");
    if (!auth.ok) return auth.reply;
    if (auth.context.group?.threadId) await ctx.cancelTopicInputs(message.actor);
    if (!auth.context.activeTaskId) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "noActiveTask"))];
    }
    try {
      const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
      if (auth.context.group?.threadId) {
        if (!zcodeTaskService.readBotTopicExecution)
          throw new Error("Topic runtime control is unavailable");
        const executionId = await zcodeTaskService.readBotTopicExecution({
          taskId: auth.context.activeTaskId,
          workspacePath: auth.context.workspacePath,
          workspaceIdentity: auth.context.workspaceIdentity,
        });
        if (executionId) await ctx.stopTopicRun(auth.context, executionId.executionId);
      } else await zcodeTaskService.stopGeneration({ taskId: auth.context.activeTaskId });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return [
        createOutbound(message.actor, ctx.msg(auth.locale, "taskFailed", { message: messageText })),
      ];
    }
    ctx.runningTasks.delete(auth.context.activeTaskId);
    ctx.stopTyping(auth.context.activeTaskId);
    await ctx.broadcastTaskListChange(auth.context, auth.context.activeTaskId, "updated");
    // 群聊成功停止只更新状态，避免状态卡再次触发机器人互答。
    return auth.context.group
      ? []
      : ctx.createStatusReply(message.actor, auth.context, auth.locale);
  }

  return {
    handleTaskList,
    resolveTaskSelectionEntry,
    getContextTaskBlockReason,
    handleTaskSetCommand,
    handleReplyListCommand,
    handleReplySetCommand,
    handleTopicLeaveCommand,
    handleStopCommand,
  };
}
