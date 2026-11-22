import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  formatBotModelSelectionValue,
  parseBotModelOptionValue,
  resolveOptionByValue,
} from "./botsServiceOptions.js";
import { createOutbound } from "./botsServiceSupport.js";
import { completeNewModelSelection } from "@zcode/provider";
import {
  type BotCommand,
  type BotInboundMessage,
  type BotOutboundMessage,
  decodeCustomModelValue,
  generateTraceId,
  normalizeAgentProviderToZCodeAgent,
} from "@zcode/shared";

export function createBotsServiceCommandsModel(ctx: BotsServiceContext) {
  async function handleModelListCommand(
    message: BotInboundMessage,
    _command: Extract<BotCommand, { type: "model.list" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "model");
    if (!auth.ok) return auth.reply;
    const blockReason = await ctx.getContextTaskBlockReason(auth.context);
    if (blockReason) {
      // Bugfix: task 运行中不展示模型选择，避免产生运行中不可用的 pending selection。
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions = await ctx.resolveDraftOptionsForDisplay(auth.context);
      const providers = await ctx.listModelProviderOptionsForActiveTask(
        {
          model: formatBotModelSelectionValue(draftOptions.modelSelection),
          workspacePath: auth.context.workspacePath,
          workspaceIdentity: auth.context.workspaceIdentity,
        },
        draftOptions.provider,
      );
      if (providers.length === 0) {
        return [createOutbound(message.actor, ctx.msg(auth.locale, "modelProviderMissing"))];
      }
      const currentProviderId = await ctx.readCurrentModelProviderId(
        {
          model: formatBotModelSelectionValue(draftOptions.modelSelection),
          workspacePath: auth.context.workspacePath,
          workspaceIdentity: auth.context.workspaceIdentity,
        },
        [],
        draftOptions.provider,
      );
      return ctx.createSelectionReply(
        message.actor,
        {
          id: `model-${Date.now()}`,
          title: ctx.msg(auth.locale, "modelProviderSelectTitle", {
            model: await ctx.formatStatusModelLabel(
              formatBotModelSelectionValue(draftOptions.modelSelection),
              auth.context,
            ),
          }),
          currentId: currentProviderId,
          action: "model.provider.set",
          options: providers,
        },
        auth.locale,
      );
    }
    const active = await ctx.requireActiveTask(message, auth);
    if (!active.ok) return active.reply;
    const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
    if (!activeProvider) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modelProviderMissing"))];
    }
    const providers = await ctx.listModelProviderOptionsForActiveTask(active.task, activeProvider);
    if (providers.length === 0) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modelProviderMissing"))];
    }
    const currentValue = ctx.readCurrentActiveTaskModel(active.task, active.configOptions);
    const currentProviderId = await ctx.readCurrentModelProviderId(
      active.task,
      active.configOptions,
      activeProvider,
    );
    return ctx.createSelectionReply(
      message.actor,
      {
        id: `model-${Date.now()}`,
        title: ctx.msg(auth.locale, "modelProviderSelectTitle", {
          model: await ctx.formatStatusModelLabel(currentValue, active.task),
        }),
        currentId: currentProviderId,
        action: "model.provider.set",
        options: providers,
      },
      auth.locale,
    );
  }

  async function handleModelProviderSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "model.provider.set" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "model");
    if (!auth.ok) return auth.reply;
    const blockReason = await ctx.getContextTaskBlockReason(auth.context);
    if (blockReason) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions = await ctx.resolveDraftOptionsForDisplay(auth.context);
      const draftTask = {
        model: formatBotModelSelectionValue(draftOptions.modelSelection),
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
      };
      const providers = await ctx.listModelProviderOptionsForActiveTask(
        draftTask,
        draftOptions.provider,
      );
      const provider =
        ctx.resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
        resolveOptionByValue(providers, command.value);
      const providerId = provider?.id;
      if (!providerId) {
        return [createOutbound(message.actor, ctx.msg(auth.locale, "modelProviderMissing"))];
      }
      const providerModels = ctx.readModelProviderSelectionModels(provider);
      const options =
        providerModels.length > 0
          ? providerModels
          : await ctx.listModelOptionsForProviderFromActiveTask(
              draftTask,
              draftOptions.provider,
              providerId,
            );
      if (options.length === 0) {
        return [createOutbound(message.actor, ctx.msg(auth.locale, "modelMissing"))];
      }
      return ctx.createSelectionReply(
        message.actor,
        {
          id: `model-${Date.now()}`,
          title: ctx.msg(auth.locale, "modelModelSelectTitle", {
            model: formatBotModelSelectionValue(draftOptions.modelSelection) ?? "-",
          }),
          currentId: options.some(
            (option) => option.id === formatBotModelSelectionValue(draftOptions.modelSelection),
          )
            ? formatBotModelSelectionValue(draftOptions.modelSelection)
            : undefined,
          action: "model.set",
          options,
        },
        auth.locale,
      );
    }
    const active = await ctx.requireActiveTask(message, auth);
    if (!active.ok) return active.reply;
    const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
    if (!activeProvider) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modelProviderMissing"))];
    }
    const providers = await ctx.listModelProviderOptionsForActiveTask(active.task, activeProvider);
    const provider =
      ctx.resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
      resolveOptionByValue(providers, command.value);
    const providerId = provider?.id;
    if (!providerId) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modelProviderMissing"))];
    }
    const providerModels = ctx.readModelProviderSelectionModels(provider);
    const options =
      providerModels.length > 0
        ? providerModels
        : await ctx.listModelOptionsForProviderFromActiveTask(
            active.task,
            activeProvider,
            providerId,
          );
    if (options.length === 0) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modelMissing"))];
    }
    const currentValue = ctx.readCurrentActiveTaskModel(active.task, active.configOptions);
    return ctx.createSelectionReply(
      message.actor,
      {
        id: `model-${Date.now()}`,
        title: ctx.msg(auth.locale, "modelModelSelectTitle", {
          model: currentValue ?? "-",
        }),
        currentId: options.some((option) => option.id === currentValue) ? currentValue : undefined,
        action: "model.set",
        options,
      },
      auth.locale,
    );
  }

  async function handleModelSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "model.set" }>,
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "model");
    if (!auth.ok) return auth.reply;
    const blockReason = await ctx.getContextTaskBlockReason(auth.context);
    if (blockReason) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, blockReason))];
    }
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions = await ctx.ensureDraftOptions(auth.context);
      const model =
        ctx.resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
        resolveOptionByValue(
          await ctx.listAllModelOptionsForActiveTask(
            {
              model: formatBotModelSelectionValue(draftOptions.modelSelection),
              workspacePath: auth.context.workspacePath,
              workspaceIdentity: auth.context.workspaceIdentity,
            },
            draftOptions.provider,
          ),
          command.value,
        );
      if (!model) {
        return [createOutbound(message.actor, ctx.msg(auth.locale, "modelMissing"))];
      }
      const identity = parseBotModelOptionValue(model.id);
      const view = await ctx.readModelSelectionView(auth.context);
      const selection = view && identity ? completeNewModelSelection(view, identity) : undefined;
      // Bot 的主动选模也须取目标最高档；旧菜单失效/读取失败不能清掉已保存选择。
      if (!selection) return [createOutbound(message.actor, ctx.msg(auth.locale, "modelMissing"))];
      const nextContext = await ctx.writeDraftOptions(auth.context, {
        ...draftOptions,
        // 模型身份切换必须构造全新的 Selection，不能把旧模型的显式 options 带过去。
        modelSelection: selection,
      });
      return ctx.createStatusReply(message.actor, nextContext, auth.locale);
    }
    const active = await ctx.requireActiveTask(message, auth);
    if (!active.ok) return active.reply;
    const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
    if (!activeProvider) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modelProviderMissing"))];
    }
    const model =
      ctx.resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
      resolveOptionByValue(
        await ctx.listAllModelOptionsForActiveTask(active.task, activeProvider),
        command.value,
      );
    if (!model) return [createOutbound(message.actor, ctx.msg(auth.locale, "modelMissing"))];
    const nextModel = model.id;
    const customModel = decodeCustomModelValue(nextModel);
    const targetModel = customModel
      ? ctx.resolveCustomModelRuntimeModelId(activeProvider, customModel)
      : nextModel;
    if (!targetModel) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modelMissing"))];
    }
    const targetIdentity = customModel?.modelName
      ? {
          // Bugfix: bot /model 选择 custom provider 时，targetModel 会被降成纯模型名。
          // legacy task facade 必须额外拿到原始 provider 身份，否则同名模型会退回 glm/native。
          providerId: customModel.providerId,
          modelId: customModel.modelName,
        }
      : { providerId: activeProvider, modelId: targetModel };
    const view = await ctx.readModelSelectionView(active.task);
    const targetModelSelection = view ? completeNewModelSelection(view, targetIdentity) : undefined;
    if (!targetModelSelection)
      return [createOutbound(message.actor, ctx.msg(auth.locale, "modelMissing"))];
    const traceId = generateTraceId(active.taskId);
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(active.task);
    const configOptions = await zcodeTaskService.setModel({
      taskId: active.taskId,
      traceId,
      modelSelection: targetModelSelection,
    });
    await ctx.broadcastTaskConfigSync({
      context: auth.context,
      taskId: active.taskId,
      task: await ctx.readContextActiveTaskMeta(auth.context),
      provider: activeProvider,
      configOptions,
    });
    return ctx.createStatusReply(message.actor, auth.context, auth.locale);
  }

  return {
    handleModelListCommand,
    handleModelProviderSetCommand,
    handleModelSetCommand,
  };
}
