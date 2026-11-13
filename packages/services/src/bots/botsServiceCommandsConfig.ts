import type { BotsServiceContext } from "./botsServicePorts.js";
import { resolveOptionByValue } from "./botsServiceOptions.js";
import { createOutbound } from "./botsServiceSupport.js";
import {
  type BotCommand,
  type BotInboundMessage,
  type BotOutboundMessage,
  type SelectionPrompt,
  generateTraceId,
  normalizeAgentProviderToZCodeAgent,
} from "@zcode/shared";

export function createBotsServiceCommandsConfig(ctx: BotsServiceContext) {
  async function handleConfigListCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "mode.list" | "thoughtLevel.list" }>,
  ): Promise<BotOutboundMessage[]> {
    const commandName = command.type === "mode.list" ? "mode" : "thoughtLevel";
    const auth = await ctx.withAuthorizedContext(message, commandName);
    if (!auth.ok) return auth.reply;
    if (command.type === "mode.list" && !auth.context.group) {
      // Bot 硬锁 yolo：不提供模式选择。
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modeLocked"))];
    }
    const blockReason = await ctx.getContextTaskBlockReason(auth.context);
    if (blockReason) {
      // Bugfix: task 运行中不展示模式/思考级别选择，避免和正在执行的上下文配置混淆。
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions = await ctx.ensureDraftOptions(auth.context);
      const optionSource = await ctx.listDraftConfigOptions(auth.context, draftOptions);
      const rawCurrentValue =
        commandName === "mode"
          ? draftOptions.mode
          : ctx.findSelectConfigOption(optionSource, commandName)?.currentValue;
      const currentValue = typeof rawCurrentValue === "string" ? rawCurrentValue : undefined;
      const currentLabel = ctx.readConfigSelectLabelForValue(
        optionSource,
        commandName,
        currentValue,
        { locale: auth.locale, provider: draftOptions.provider },
      );
      const selectOption = ctx.findSelectConfigOption(optionSource, commandName);
      const options = ctx.listConfigSelectOptions(optionSource, commandName, {
        locale: auth.locale,
        provider: draftOptions.provider,
      });
      if (options.length === 0) {
        return [
          createOutbound(
            message.actor,
            ctx.msg(auth.locale, ctx.getConfigCommandMissingMessageId(commandName)),
          ),
        ];
      }
      return ctx.createSelectionReply(
        message.actor,
        {
          id: `${selectOption?.id ?? commandName}-${Date.now()}`,
          title:
            commandName === "mode"
              ? ctx.msg(auth.locale, "modeSelectTitle", {
                  mode: currentLabel ?? "-",
                })
              : ctx.msg(auth.locale, "thoughtLevelSelectTitle", {
                  level: currentLabel ?? "-",
                }),
          currentId: currentValue,
          action: `${commandName}.set` as SelectionPrompt["action"],
          options,
        },
        auth.locale,
      );
    }
    const active = await ctx.requireActiveTask(message, auth);
    if (!active.ok) return active.reply;
    const optionSource =
      commandName === "mode" && active.task.provider
        ? await ctx.listProviderConfigOptionsForActiveTask(
            active.task,
            normalizeAgentProviderToZCodeAgent(active.task.provider),
          )
        : active.configOptions;
    const currentValue =
      commandName === "mode"
        ? ctx.readCurrentActiveTaskMode(active.task, active.configOptions)
        : ctx.readConfigSelectCurrentValue(active.configOptions, commandName);
    const currentLabel =
      commandName === "mode"
        ? ctx.readConfigSelectLabelForValue(optionSource, commandName, currentValue, {
            locale: auth.locale,
            provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
          })
        : ctx.readConfigSelectCurrentLabel(active.configOptions, commandName, {
            locale: auth.locale,
            provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
          });
    const selectOption = ctx.findSelectConfigOption(optionSource, commandName);
    const options = ctx.listConfigSelectOptions(optionSource, commandName, {
      locale: auth.locale,
      provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
    });
    if (options.length === 0) {
      return [
        createOutbound(
          message.actor,
          ctx.msg(auth.locale, ctx.getConfigCommandMissingMessageId(commandName)),
        ),
      ];
    }
    return ctx.createSelectionReply(
      message.actor,
      {
        id: `${selectOption?.id ?? commandName}-${Date.now()}`,
        title:
          commandName === "mode"
            ? ctx.msg(auth.locale, "modeSelectTitle", {
                mode: currentLabel ?? "-",
              })
            : ctx.msg(auth.locale, "thoughtLevelSelectTitle", {
                level: currentLabel ?? "-",
              }),
        currentId: currentValue,
        action: `${commandName}.set` as SelectionPrompt["action"],
        options,
      },
      auth.locale,
    );
  }

  async function handleConfigSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "mode.set" | "thoughtLevel.set" }>,
  ): Promise<BotOutboundMessage[]> {
    const commandName = command.type === "mode.set" ? "mode" : "thoughtLevel";
    const auth = await ctx.withAuthorizedContext(message, commandName);
    if (!auth.ok) return auth.reply;
    if (command.type === "mode.set" && !auth.context.group) {
      // Bot 硬锁 yolo：拒绝任何模式切换请求。
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modeLocked"))];
    }
    const blockReason = await ctx.getContextTaskBlockReason(auth.context);
    if (blockReason) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const originalOptions = await ctx.ensureDraftOptions(auth.context);
      const view = await ctx.readModelSelectionView(auth.context, originalOptions.modelSelection);
      const optionSource = await ctx.listDraftConfigOptions(auth.context, originalOptions, view);
      // 同一个快照给出候选与当前模型；失效原意图不能因副本为空退回 preferred。
      const draftOptions = {
        ...originalOptions,
        modelSelection:
          (originalOptions.modelSelection ? view?.effectiveSelection : view?.preferredSelection) ??
          undefined,
      };
      const displayOptions = ctx.listConfigSelectOptions(optionSource, commandName, {
        locale: auth.locale,
        provider: draftOptions.provider,
      });
      const option =
        ctx.resolvePendingSelectionOption(
          message.actor,
          `${commandName}.set` as SelectionPrompt["action"],
          command.value,
        ) ?? resolveOptionByValue(displayOptions, command.value);
      if (option && !displayOptions.some((candidate) => candidate.id === option.id)) {
        return [
          createOutbound(
            message.actor,
            ctx.msg(auth.locale, ctx.getConfigCommandMissingMessageId(commandName)),
          ),
        ];
      }
      if (!option) {
        return [
          createOutbound(
            message.actor,
            ctx.msg(auth.locale, ctx.getConfigCommandMissingMessageId(commandName)),
          ),
        ];
      }
      const nextContext = await ctx.writeDraftOptions(auth.context, {
        ...draftOptions,
        ...(commandName === "mode"
          ? { mode: option.id }
          : draftOptions.modelSelection
            ? {
                modelSelection: {
                  ...draftOptions.modelSelection,
                  options: {
                    ...draftOptions.modelSelection.options,
                    reasoningLevel: option.id,
                  },
                },
              }
            : {}),
      });
      return ctx.createStatusReply(message.actor, nextContext, auth.locale);
    }
    const active = await ctx.requireActiveTask(message, auth);
    if (!active.ok) return active.reply;
    const optionSource =
      commandName === "mode" && active.task.provider
        ? await ctx.listProviderConfigOptionsForActiveTask(active.task, active.task.provider)
        : active.configOptions;
    const selectOption = ctx.findSelectConfigOption(optionSource, commandName);
    const displayOptions = ctx.listConfigSelectOptions(optionSource, commandName, {
      locale: auth.locale,
      provider: active.task.provider,
    });
    const option =
      ctx.resolvePendingSelectionOption(
        message.actor,
        `${commandName}.set` as SelectionPrompt["action"],
        command.value,
      ) ?? resolveOptionByValue(displayOptions, command.value);
    if (!option) {
      return [
        createOutbound(
          message.actor,
          ctx.msg(auth.locale, ctx.getConfigCommandMissingMessageId(commandName)),
        ),
      ];
    }
    if (!selectOption?.id) {
      return [
        createOutbound(
          message.actor,
          ctx.msg(auth.locale, ctx.getConfigCommandMissingMessageId(commandName)),
        ),
      ];
    }
    const traceId = generateTraceId(active.taskId);
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(auth.context);
    const configOptions = await zcodeTaskService.setConfigOption({
      taskId: active.taskId,
      traceId,
      configId: selectOption.id,
      value: option.id,
    });
    await ctx.broadcastTaskConfigSync({
      context: auth.context,
      taskId: active.taskId,
      task: await ctx.readContextActiveTaskMeta(auth.context),
      provider: active.task.provider,
      configOptions,
    });
    return ctx.createStatusReply(message.actor, auth.context, auth.locale);
  }

  return {
    handleConfigListCommand,
    handleConfigSetCommand,
  };
}
