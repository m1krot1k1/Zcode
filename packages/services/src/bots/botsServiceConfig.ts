import type {
  BotAuthorizedCommand,
  BotModelOption,
  BotModelProviderOption,
  BotRemoteWorkspaceReconnectResult,
} from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import { getReplyGranularityOptions } from "./botsServiceOptions.js";
import {
  BOT_FORCED_MODE,
  DEFAULT_BOT_ZCODE_PROVIDER,
  botsLogger,
  createOutbound,
  isRecord,
} from "./botsServiceSupport.js";
import type {
  IModelSelectionService,
  ModelSelectionView,
} from "../model-provider/providerFacadeServices.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { BotUserConfigOptionsParams } from "./bots.js";
import { getDefaultBotReplyGranularity } from "./config.js";
import type { BotMessageId } from "./messages.js";
import { getNativeModelProviderId } from "./modelSelectionHelpers.js";
import {
  type BotContextState,
  type BotDraftOptions,
  type BotInboundMessage,
  type BotOutboundMessage,
  type BotProvider,
  type BotReplyGranularity,
  type Locale,
  type ModelSelection,
  type SelectionPrompt,
  type ZCodeConfigOption,
  type ZCodeProvider,
  type ZCodeTaskMeta,
  type ZCodeTaskMode,
  decodeCustomModelValue,
  encodeCustomModelValue,
  normalizeAgentProviderToZCodeAgent,
  normalizeBotReplyGranularity,
} from "@zcode/shared";
import { BotAdminRequiredError } from "#src/bots/groupAdminAttention.js";
import { resolveProviderModeIdFromConfigOptions } from "#src/session/sessionModeOptions.js";

export function createBotsServiceConfig(ctx: BotsServiceContext) {
  function requiresRemoteWorkspaceRuntime(requestedCommand: BotAuthorizedCommand): boolean {
    return (
      requestedCommand !== "help" &&
      requestedCommand !== "status" &&
      requestedCommand !== "workspace" &&
      requestedCommand !== "reconnect" &&
      requestedCommand !== "reply"
    );
  }

  async function isRemoteWorkspaceConnected(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<boolean> {
    if (!context.workspaceIdentity) {
      return true;
    }
    if (!ctx.deps.remoteWorkspaceService) {
      // Bugfix: 远端 workspace 没有注入重连服务时，不能默认当作已连接。
      // 否则 Bot 会继续使用缓存模型创建 task，最终在远端 API 层才暴露“模型不存在”等误导性错误。
      return false;
    }
    return ctx.deps.remoteWorkspaceService
      .isConnected({
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        ...(context.hostId ? { hostId: context.hostId } : {}),
      })
      .catch(() => false);
  }

  async function reconnectRemoteWorkspaceForBot(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<BotRemoteWorkspaceReconnectResult> {
    if (!context.workspaceIdentity) {
      return { ok: true };
    }
    if (!ctx.deps.remoteWorkspaceService) {
      return {
        ok: false,
        message: "remote reconnect service unavailable",
      };
    }
    return ctx.deps.remoteWorkspaceService.ensureConnected({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
  }

  async function resolveZCodeTaskServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<IZCodeTaskService> {
    if (!context.workspaceIdentity) {
      return ctx.deps.zcodeTaskService;
    }
    const remoteZCodeTaskService = await ctx.deps.remoteWorkspaceService?.getZCodeTaskService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
    if (remoteZCodeTaskService) {
      return remoteZCodeTaskService;
    }
    // Bugfix: 远端 workspace 的 bot 请求不能缺 runtime 时静默走本地 zcodeTaskService。
    // 否则 /root 这类远端路径会在 macOS/Windows 本地 host 创建任务，模型和文件系统都错位。
    throw new BotAdminRequiredError(
      "remote",
      `当前远端项目 ${context.workspacePath} runtime 不可用，请发送 **/重连** 后重试。`,
    );
  }

  async function resolveModelSelectionServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<Pick<IModelSelectionService, "getView">> {
    if (!context.workspaceIdentity) return ctx.deps.modelSelectionService;
    const service = await ctx.deps.remoteWorkspaceService?.getModelSelectionService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
    if (service) return service;
    throw new BotAdminRequiredError(
      "remote",
      `当前远端项目 ${context.workspacePath} runtime 不可用，请发送 **/重连** 后重试。`,
    );
  }

  async function blockDisconnectedRemoteWorkspace(params: {
    message: BotInboundMessage;
    context: BotContextState;
    locale: Locale | undefined;
    requestedCommand: BotAuthorizedCommand;
  }): Promise<BotOutboundMessage[] | null> {
    if (
      !params.context.workspaceIdentity ||
      !requiresRemoteWorkspaceRuntime(params.requestedCommand)
    ) {
      return null;
    }
    if (await isRemoteWorkspaceConnected(params.context)) {
      ctx.adminAttention.clear(params.message.actor, params.context.group?.ownerId, "remote");
      return null;
    }
    // Bugfix: 普通消息、配置修改和权限响应不应该隐式改变远端连接状态。
    // 远端恢复只允许显式 /reconnect 触发，避免同一条消息有时执行、有时只是在后台打开连接。
    return [
      ctx.administratorReply(
        params.message.actor,
        { providerUserId: params.context.group?.ownerId },
        "remote",
        createOutbound(
          params.message.actor,
          ctx.msg(params.locale, "remoteDisconnected", {
            workspacePath: params.context.workspacePath,
          }),
        ),
      ),
    ];
  }

  function currentOptionSuffix(locale: Locale | undefined): string {
    return locale === "en-US" ? "current" : "当前";
  }

  function formatReplyGranularityLabel(
    id: BotReplyGranularity | undefined,
    locale: Locale | undefined,
    provider?: BotProvider,
  ): string {
    const currentId = provider
      ? normalizeBotReplyGranularity(provider, id)
      : (id ?? getDefaultBotReplyGranularity());
    return (
      getReplyGranularityOptions(locale, provider).find((option) => option.id === currentId)
        ?.label ?? currentId
    );
  }

  function markCurrentSelection(
    selection: SelectionPrompt,
    locale: Locale | undefined,
  ): SelectionPrompt {
    const cancelLabel = ctx.msg(locale, "selectionCancelOption");
    if (!selection.currentId) {
      return { ...selection, cancelLabel };
    }
    const suffix = currentOptionSuffix(locale);
    return {
      ...selection,
      cancelLabel,
      options: selection.options.map((option) =>
        option.id === selection.currentId
          ? { ...option, label: `${option.label} · ${suffix}` }
          : option,
      ),
    };
  }

  async function listUserConfigOptions(
    _params: BotUserConfigOptionsParams,
  ): Promise<ZCodeConfigOption[]> {
    return [];
  }

  async function ensureBotStorageMigrated(): Promise<void> {
    // 单向导入已收口到 Repo；这里只等待初始化，不再读取旧模型字段或重写当前状态。
    if (!ctx.botStorageMigrationPromise) {
      ctx.botStorageMigrationPromise = Promise.all([ctx.repo.readConfig(), ctx.repo.readState()])
        .then(() => undefined)
        .catch((error: unknown) => {
          ctx.botStorageMigrationPromise = null;
          throw error;
        });
    }
    await ctx.botStorageMigrationPromise;
  }

  async function listActiveTaskConfigOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
  ): Promise<ZCodeConfigOption[]> {
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    return zcodeTaskService.getTaskConfigOptions({ taskId });
  }

  function findSelectConfigOption(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): (ZCodeConfigOption & { type: "select" }) | undefined {
    const category = configId === "thoughtLevel" ? "thought_level" : configId;
    return options.find(
      (item): item is ZCodeConfigOption & { type: "select" } =>
        item.type === "select" && (item.category === category || item.id === category),
    );
  }

  function listConfigSelectOptions(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): BotModelOption[] {
    const option = findSelectConfigOption(options, configId);
    return (option?.options ?? []).map((item) => {
      const baseOption = {
        id: item.value,
        label: item.name,
        description: item.description,
      };
      return {
        ...baseOption,
        // 保持 Bot 与工具栏的模式展示一致。
        label: formatConfigOptionLabel(baseOption, {
          configId,
          locale: context.locale,
          provider: context.provider,
        }),
      };
    });
  }

  function getConfigCommandMissingMessageId(configId: "mode" | "thoughtLevel"): BotMessageId {
    return configId === "mode" ? "modeMissing" : "thoughtLevelMissing";
  }

  function getModeDisplayLabel(
    locale: Locale | undefined,
    provider: ZCodeProvider | undefined,
    option: Pick<BotModelOption, "id" | "label">,
  ): string {
    if (!provider) {
      return option.label;
    }
    const isEnglish = locale === "en-US";
    const labels: Partial<Record<ZCodeProvider, Record<string, string>>> = {
      glm: {
        default: isEnglish ? "Default" : "默认",
        yolo: "Yolo",
        plan: isEnglish ? "Plan" : "计划",
      },
    };
    return labels[provider]?.[option.id] ?? option.label;
  }

  function formatConfigOptionLabel(
    option: BotModelOption,
    context: {
      configId: "model" | "mode" | "thoughtLevel";
      locale?: Locale;
      provider?: ZCodeProvider;
    },
  ): string {
    if (context.configId !== "mode") {
      return option.label;
    }
    return getModeDisplayLabel(context.locale, context.provider, option);
  }

  function createModelSelectionProviderOption(
    provider: ModelSelectionView["providers"][number],
  ): BotModelProviderOption {
    return {
      id: provider.providerId,
      label: provider.providerName?.trim() || provider.providerId,
      models: provider.models.map((model) => ({
        id: encodeCustomModelValue(provider.providerId, model.modelId),
        label: model.modelId,
      })),
    };
  }

  async function readModelSelectionView(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    selection?: ModelSelection,
  ): Promise<ModelSelectionView | null> {
    const service = await resolveModelSelectionServiceForContext(context).catch(() => null);
    if (!service) return null;
    return service.getView
      .call(service, selection ? { selection } : undefined)
      .catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `read model selection view for bot model display failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
  }

  async function listModelSelectionProviderOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<BotModelProviderOption[]> {
    const view = await readModelSelectionView(context);
    // 旧缓存没有 workspaceIdentity 隔离，远端断连时会显示其他 Host 的候选。
    // 当前菜单只消费目标 View；失败留空，下一次正常读取即可恢复，不借本地补选。
    if (!view) return [];
    return view.providers
      .map(createModelSelectionProviderOption)
      .filter((provider) => provider.models.length > 0);
  }

  async function listModelProviderOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    _activeProvider: ZCodeProvider,
  ): Promise<BotModelProviderOption[]> {
    return listModelSelectionProviderOptions(task);
  }

  async function listModelOptionsForProviderFromActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
    providerId: string,
  ): Promise<BotModelOption[]> {
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find(
        (provider) => provider.id === providerId,
      )?.models ?? []
    );
  }

  function readModelProviderSelectionModels(provider: unknown): BotModelOption[] {
    const models = isRecord(provider) ? provider.models : undefined;
    if (!Array.isArray(models)) {
      return [];
    }
    return models.filter(
      (model): model is BotModelOption =>
        isRecord(model) && typeof model.id === "string" && typeof model.label === "string",
    );
  }

  async function listAllModelOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<BotModelOption[]> {
    return (await listModelProviderOptionsForActiveTask(task, activeProvider)).flatMap(
      (provider) => provider.models,
    );
  }

  function readCurrentActiveTaskModel(
    task: Pick<ZCodeTaskMeta, "model">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "model") ?? task.model;
  }

  async function formatStatusModelLabel(
    model: string | undefined,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<string> {
    if (!model) {
      return "-";
    }
    const customModel = decodeCustomModelValue(model);
    if (customModel?.providerId) {
      const modelSelectionOptions = await listModelSelectionProviderOptions(context);
      const providerLabel = modelSelectionOptions.find(
        (item) => item.id === customModel.providerId,
      )?.label;
      if (providerLabel && customModel.modelName) {
        return `${providerLabel}/${customModel.modelName}`;
      }
      return providerLabel ?? model;
    }
    const separatorIndex = model.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
      return model;
    }
    const providerId = model.slice(0, separatorIndex);
    const modelName = model.slice(separatorIndex + 1);
    const modelSelectionOptions = await listModelSelectionProviderOptions(context);
    const providerLabel = modelSelectionOptions.find((item) => item.id === providerId)?.label;
    // Bugfix: /status 只应该暴露用户能识别的模型供应商名称。
    // 旧 bot-state 或 task config 可能保存成 providerId/modelId，providerId 对用户没有意义。
    return providerLabel ? `${providerLabel}/${modelName}` : model;
  }

  async function readCurrentModelProviderId(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    options: readonly ZCodeConfigOption[],
    activeProvider: ZCodeProvider,
  ): Promise<string | undefined> {
    const currentValue = readCurrentActiveTaskModel(task, options);
    if (!currentValue) {
      return undefined;
    }
    const customModel = decodeCustomModelValue(currentValue);
    if (customModel?.providerId) {
      return customModel.providerId;
    }
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find((provider) =>
        provider.models.some((model) => model.id === currentValue),
      )?.id ?? getNativeModelProviderId(activeProvider)
    );
  }

  function resolveCustomModelRuntimeModelId(
    _activeProvider: ZCodeProvider,
    customModel: { providerId: string; modelName?: string },
  ): string | undefined {
    if (!customModel.modelName) {
      return undefined;
    }
    return customModel.modelName;
  }

  function readConfigSelectCurrentValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): string | undefined {
    const currentValue = findSelectConfigOption(options, configId)?.currentValue;
    return typeof currentValue === "string" ? currentValue : undefined;
  }

  function resolveSupportedDraftMode(
    options: readonly ZCodeConfigOption[],
    mode: string | undefined,
    provider: ZCodeProvider,
  ): string | undefined {
    if (!mode) {
      return undefined;
    }
    return resolveProviderModeIdFromConfigOptions({
      configOptions: options,
      modeId: mode,
      provider,
    })
      ? mode
      : undefined;
  }

  function readConfigSelectCurrentLabel(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    const currentValue = readConfigSelectCurrentValue(options, configId);
    if (!currentValue) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find(
        (option) => option.id === currentValue,
      )?.label ?? currentValue
    );
  }

  function readConfigSelectLabelForValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    value: string | undefined,
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    if (!value) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find((option) => option.id === value)
        ?.label ?? value
    );
  }

  function readCurrentActiveTaskMode(
    task: Pick<ZCodeTaskMeta, "mode">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "mode") ?? task.mode;
  }

  async function listProviderConfigOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<ZCodeConfigOption[]> {
    return listUserConfigOptions({
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      provider: activeProvider,
    });
  }

  function normalizeBotDraftOptions(draftOptions: BotDraftOptions): BotDraftOptions {
    // Bugfix: bot-state 里可能还残留旧三方 CLI 草稿 provider。
    // 如果直接复用，/new 后首条消息会重新创建第三方 runtime，绕过 ZCode Agent 单一事实源。
    return {
      ...draftOptions,
      provider: normalizeAgentProviderToZCodeAgent(draftOptions.provider),
    };
  }

  async function buildInitializedDraftOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    provider?: ZCodeProvider,
  ): Promise<BotDraftOptions> {
    const requestedProvider = normalizeAgentProviderToZCodeAgent(
      provider ?? DEFAULT_BOT_ZCODE_PROVIDER,
    );
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: 远端断连时初始化草稿也不能偷偷申请远端 ZCode Agent runtime。
      // 只有 /reconnect 能恢复连接；草稿先保留最小默认值，重连成功后再刷新。
      return { provider: requestedProvider };
    }
    const resolvedProvider = requestedProvider;
    return {
      provider: resolvedProvider,
      mode: "group" in context && context.group ? "default" : BOT_FORCED_MODE,
    };
  }

  async function buildActiveTaskDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    const activeTask = await ctx.readContextActiveTaskMeta(context);
    if (!context.activeTaskId || !activeTask?.provider) {
      return context.draftOptions
        ? normalizeBotDraftOptions(context.draftOptions)
        : buildInitializedDraftOptions(context);
    }
    const configOptions = await listActiveTaskConfigOptions(context, context.activeTaskId).catch(
      () => [],
    );
    const resolvedProvider = normalizeAgentProviderToZCodeAgent(activeTask.provider);
    // Bot 硬锁 yolo：继承当前 task 时也强制 yolo，不沿用原 task 的 mode。
    const forcedMode = resolveSupportedDraftMode(
      configOptions,
      "group" in context && context.group ? "default" : BOT_FORCED_MODE,
      resolvedProvider,
    );
    // 继承的是领域选择，不是菜单显示值；显示值中的 $max 曾被误存为 modelId。
    // 由同一工作区的任务服务读取真实选择，保留 Provider、模型和显式思考等级。
    const taskService = await resolveZCodeTaskServiceForContext(context);
    const modelSelection = await taskService.getTaskModelSelection({
      taskId: context.activeTaskId,
    });
    return {
      provider: resolvedProvider,
      ...(modelSelection ? { modelSelection } : {}),
      ...(forcedMode ? { mode: forcedMode } : {}),
    };
  }

  async function ensureDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    if (context.draftOptions) {
      const normalizedDraftOptions = normalizeBotDraftOptions(context.draftOptions);
      if (normalizedDraftOptions.provider !== context.draftOptions.provider) {
        await ctx.writeContext({ ...context, draftOptions: normalizedDraftOptions });
      }
      return normalizedDraftOptions;
    }
    const draftOptions = await buildInitializedDraftOptions(context);
    await ctx.writeContext({ ...context, draftOptions });
    return draftOptions;
  }

  async function writeDraftOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
  ): Promise<BotContextState> {
    const normalizedDraftOptions = normalizeBotDraftOptions(draftOptions);
    const nextContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions: normalizedDraftOptions,
    };
    await ctx.writeContext(nextContext);
    return nextContext;
  }

  async function resolveDraftOptionsForDisplay(context: BotContextState): Promise<BotDraftOptions> {
    const original = await ensureDraftOptions(context);
    const view = await readModelSelectionView(context, original.modelSelection);
    // 菜单也必须展示派发将使用的身份。这里只返回副本；查看菜单不能写回原草稿。
    return {
      ...original,
      modelSelection:
        (original.modelSelection ? view?.effectiveSelection : view?.preferredSelection) ??
        undefined,
    };
  }

  async function listDraftConfigOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
    resolvedView?: ModelSelectionView | null,
  ): Promise<ZCodeConfigOption[]> {
    const view =
      resolvedView === undefined
        ? await readModelSelectionView(context, draftOptions.modelSelection)
        : resolvedView;
    const selection = draftOptions.modelSelection
      ? view?.effectiveSelection
      : view?.preferredSelection;
    if (!selection) return [];
    const model = view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
    const spec = model?.config.optionSpecs.reasoningLevel;
    if (!spec) return [];
    return [
      {
        id: "thought_level",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: selection.options?.reasoningLevel ?? "",
        options: spec.values.map((value) => ({ value, name: value })),
      },
    ];
  }

  async function applyDraftConfigOptions(
    context: BotContextState,
    taskId: string,
    traceId: string,
  ): Promise<void> {
    const draftOptions = context.draftOptions;
    if (!draftOptions) {
      return;
    }
    // Bugfix: workspace configOptions 描述的是切换前的工作区模型，不能用来校验新 task 的配置。
    // 例如 GLM 的 enabled 会被误下发给刚切换到的其他 provider 模型，导致首条微信消息回调失败。
    const configOptions = await listActiveTaskConfigOptions(context, taskId);
    const modeOption = configOptions.find(
      (option) => option.category === "mode" && option.type === "select",
    );
    // Bot 硬锁 yolo：无论草稿/继承的 mode 是什么，建 task 时一律下发 yolo。
    // 这是 mode 真正进入 agent session 的唯一咽喉，保证任何 bot task 都免交互权限。
    const forcedDraftMode = resolveSupportedDraftMode(
      configOptions,
      context.group ? (draftOptions.mode ?? "default") : BOT_FORCED_MODE,
      draftOptions.provider,
    );
    if ((modeOption?.id && forcedDraftMode) || context.group) {
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
      await zcodeTaskService.setMode({
        taskId,
        mode: (forcedDraftMode ?? "default") as ZCodeTaskMode,
      });
    } else if (modeOption?.id) {
      // provider 不支持 yolo（非 ZCode Agent）：保持其自身默认模式，避免首条消息回调失败。
      botsLogger.debug(
        traceId,
        `skip forced yolo mode unsupported provider=${draftOptions.provider}`,
      );
    }
  }

  return {
    requiresRemoteWorkspaceRuntime,
    isRemoteWorkspaceConnected,
    reconnectRemoteWorkspaceForBot,
    resolveZCodeTaskServiceForContext,
    resolveModelSelectionServiceForContext,
    blockDisconnectedRemoteWorkspace,
    currentOptionSuffix,
    formatReplyGranularityLabel,
    markCurrentSelection,
    listUserConfigOptions,
    ensureBotStorageMigrated,
    listActiveTaskConfigOptions,
    findSelectConfigOption,
    listConfigSelectOptions,
    getConfigCommandMissingMessageId,
    getModeDisplayLabel,
    formatConfigOptionLabel,
    createModelSelectionProviderOption,
    readModelSelectionView,
    listModelSelectionProviderOptions,
    listModelProviderOptionsForActiveTask,
    listModelOptionsForProviderFromActiveTask,
    readModelProviderSelectionModels,
    listAllModelOptionsForActiveTask,
    readCurrentActiveTaskModel,
    formatStatusModelLabel,
    readCurrentModelProviderId,
    resolveCustomModelRuntimeModelId,
    readConfigSelectCurrentValue,
    resolveSupportedDraftMode,
    readConfigSelectCurrentLabel,
    readConfigSelectLabelForValue,
    readCurrentActiveTaskMode,
    listProviderConfigOptionsForActiveTask,
    normalizeBotDraftOptions,
    buildInitializedDraftOptions,
    buildActiveTaskDraftOptions,
    ensureDraftOptions,
    writeDraftOptions,
    resolveDraftOptionsForDisplay,
    listDraftConfigOptions,
    applyDraftConfigOptions,
  };
}
