/**
 * Модельная часть тулбара: выбор модели/провайдера, план-группы, соединение,
 * уровень размышления и горячие клавиши.
 *
 * Вынесено из V4ComposerToolbar.tsx. Порядок хуков и memo-зависимости
 * сохранены; контекстные факты (effectiveConfig, family, entitlements-проекции)
 * приходят из useComposerContextUsage, чтобы не читать одни и те же сервисы
 * дважды в разных владельцах.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isApiKeyAccess } from "@zcode/provider";
import type { ZCodeConfigOption } from "@zcode/shared";
import {
  buildComposerPlanGroups,
  chooseConnectionModel,
  composerConnectionKey,
} from "@/lib/composerPlanGroups.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import {
  decodeCustomModelValue,
  encodeCustomModelValue,
} from "@/lib/zcodeCustomModelValue.js";
import {
  resolveModelSelectTriggerDisplay,
  shouldShowManageModelsAction,
} from "@/chat-input-toolbar/modelSelection.js";
import {
  getNextThoughtLevelValue,
  getThoughtLevelLabel,
} from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { ComposerModelOptions } from "@/chat-input-toolbar/ComposerModelMenu.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { useComposerConnectionSwitch } from "@/hooks/useComposerConnectionSwitch.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";
import { resolveV4ModelTriggerDisplay } from "@/v4/composer/modelTriggerDisplay.js";
import {
  resolveDraftModelThoughtOption,
  resolveDraftThoughtCurrentValue,
} from "@/v4/composer/draftWorkspaceDefaults.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import {
  MODEL_SELECTION_LOADING_STATE,
  type V4ComposerToolbarProps,
} from "./types.js";
import type { ComposerContextUsageState } from "./useComposerContextUsage.js";

/** 稳定空回调（热键 hook 单实例只处理本组件拥有的选项，其余动作占位）。 */
function noop(): void {}

export function useComposerModelControls(
  {
    workspacePath,
    workspaceIdentity,
    modelSelectionView = null,
    modelSelectionState = MODEL_SELECTION_LOADING_STATE,
    modelSelectionRefresh,
    isWebRemoteControl = false,
    isMobileViewport = false,
    draftMode = false,
    usage,
    disabled,
    modelLocked = false,
    onConfigPickerOpenChange,
    onSelectModel,
    onSelectThought,
    onRecoverCustomModelSelection,
  }: V4ComposerToolbarProps,
  contextUsage: ComposerContextUsageState,
) {
  const {
    intl,
    displayProvider,
    effectiveConfig,
    configOptionsError,
    providerSettingsView,
    sharedSettings,
    connectionFamily,
    subscribedTeamProducts,
  } = contextUsage;
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const modelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // Ctrl+M 热键：递增 openRequestKey 请求 ModelConfigSelect 打开菜单（旧 handleOpenModelMenuShortcut 语义）。
  const [modelMenuOpenRequestKey, setModelMenuOpenRequestKey] = useState(0);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const handleOpenModelMenuShortcut = useCallback(() => {
    setModelMenuOpenRequestKey((current) => current + 1);
  }, []);
  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("model", open);
    },
    [onConfigPickerOpenChange],
  );
  const handleThoughtPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("thought", open);
    },
    [onConfigPickerOpenChange],
  );

  const modelOption = modelSelectionView?.providers.some(
    (provider) => provider.models.length > 0,
  )
    ? ({
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "",
        options: [],
      } satisfies ZCodeConfigOption)
    : undefined;

  // 高频交互排障只走 debug，避免生产日志量随每次选择增长。
  useEffect(() => {
    if (!draftMode) return;
    logger.debug("[v4-toolbar] draft effectiveConfig changed", {
      provider: effectiveConfig?.provider ?? null,
      model: effectiveConfig?.model ?? null,
      thought: effectiveConfig?.thought ?? null,
      modelSelectionRevision: modelSelectionView?.revision ?? null,
    });
  }, [draftMode, effectiveConfig, modelSelectionView?.revision]);

  const modelGroupLabels = useMemo(
    () => ({
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      apiKeyBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.apiKeyBadge",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
      codingPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlanBadge",
      }),
      startPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlan",
      }),
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      teamPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlanBadge",
      }),
      teamPlanFallbackLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlan",
      }),
    }),
    [intl],
  );
  const modelSelectGroups = useMemo<ModelSelectGroup[]>(
    () =>
      modelSelectionView
        ? buildRegistryModelSelectGroups(
            displayProvider,
            modelSelectionView,
            modelGroupLabels,
          )
        : [],
    [displayProvider, modelGroupLabels, modelSelectionView],
  );

  // 修复：恢复「管理模型」入口（老版 onManageModels = 打开设置页并定位模型供应商区）。
  const handleOpenModelProviderSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const showManageModelsAction = shouldShowManageModelsAction(
    handleOpenModelProviderSettings,
  );
  const manageModelsLabel = intl.formatMessage({
    id: "chat.toolbar.model.manageModels",
  });

  // 当前投影模型的编码值：provider 命中目录则按自定义模型编码，否则回落裸 model id。
  const rawModelValue = useMemo(() => {
    if (!effectiveConfig || !effectiveConfig.model) return "";
    const providerExists = modelSelectionView?.providers.some(
      (candidate) => candidate.providerId === effectiveConfig.provider,
    );
    if (providerExists) {
      return encodeCustomModelValue(
        effectiveConfig.provider,
        effectiveConfig.model,
      );
    }
    return effectiveConfig.model;
  }, [effectiveConfig, modelSelectionView]);

  // 触发器显示兜底——`<synthetic>`（SDK 恢复时合成的占位模型）或当前模型
  // 不在可选组（失效/下线/退登）→ 回落占位/默认「选择模型」，不直显协议内部占位符或失效
  // 模型 id。复用存活的 resolveModelSelectTriggerDisplay。
  const triggerDisplay = useMemo(
    () =>
      resolveModelSelectTriggerDisplay(
        rawModelValue,
        modelSelectGroups,
        showManageModelsAction,
        manageModelsLabel,
      ),
    [
      manageModelsLabel,
      modelSelectGroups,
      rawModelValue,
      showManageModelsAction,
    ],
  );
  const normalizedModelValue = triggerDisplay.value ?? "";

  const modelTriggerDisplay: { fullLabel: string; modelLabel: string } =
    useMemo(() => {
      // 非可选值（未选 / synthetic / 不可用）：占位文案或默认「选择模型」。
      const fallbackLabel =
        triggerDisplay.placeholder ??
        intl.formatMessage({ id: "chat.toolbar.model.label" });
      const providerName =
        modelSelectionView?.providers.find(
          (candidate) => candidate.providerId === effectiveConfig?.provider,
        )?.providerName ?? undefined;
      return resolveV4ModelTriggerDisplay({
        modelGroups: modelSelectGroups,
        normalizedValue: normalizedModelValue,
        fallbackLabel,
        providerId: effectiveConfig?.provider,
        providerName,
      });
    }, [
      effectiveConfig?.provider,
      intl,
      modelSelectionView,
      modelSelectGroups,
      normalizedModelValue,
      triggerDisplay.placeholder,
    ]);
  const handleModelValueChange = useCallback(
    (value: string, reasoningLevel?: string) => {
      if (modelLocked) return;
      const decoded = decodeCustomModelValue(value);
      // 草稿的点击时可见模型可能只存在于 catalog，或已经被最新 draft
      // intent 覆盖，不能让 SessionPane 再从迟到的 prewarm projection 反推。
      const sourceModel =
        effectiveConfig?.provider && effectiveConfig.model
          ? {
              provider: effectiveConfig.provider,
              model: effectiveConfig.model,
            }
          : null;
      // debug 日志（草稿态切模型排障）：点击值 + 解码分支。
      logger.debug("[v4-toolbar] model select onValueChange", {
        value,
        decodedProviderId: decoded?.providerId ?? null,
        decodedModelName: decoded?.modelName ?? null,
        draftMode,
      });
      const selectedRegistryProvider = decoded?.providerId
        ? modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )
        : undefined;
      const customRecoveryEligible = isApiKeyAccess(
        selectedRegistryProvider?.config.access,
      );
      if (
        configOptionsError &&
        decoded?.providerId &&
        customRecoveryEligible &&
        onRecoverCustomModelSelection
      ) {
        setRecoveryPending(true);
        void Promise.resolve(onRecoverCustomModelSelection(value, sourceModel))
          .catch((error) => {
            logger.warn("[v4-toolbar] custom provider recovery failed", {
              error: error instanceof Error ? error.message : String(error),
              providerId: decoded.providerId,
            });
          })
          .finally(() => {
            setRecoveryPending(false);
          });
        return;
      }
      if (decoded) {
        if (reasoningLevel !== undefined)
          onSelectModel(
            decoded.providerId,
            decoded.modelName ?? "",
            sourceModel,
            reasoningLevel,
          );
        else
          onSelectModel(
            decoded.providerId,
            decoded.modelName ?? "",
            sourceModel,
          );
        return;
      }
      const slashIndex = value.indexOf("/");
      if (slashIndex > 0) {
        onSelectModel(
          value.slice(0, slashIndex),
          value.slice(slashIndex + 1),
          sourceModel,
        );
        return;
      }
      // 裸 model id：provider 沿用当前（宿主从最新投影补齐）。
      onSelectModel("", value, sourceModel);
    },
    [
      configOptionsError,
      displayProvider,
      draftMode,
      effectiveConfig?.model,
      effectiveConfig?.provider,
      onRecoverCustomModelSelection,
      onSelectModel,
      modelLocked,
      modelSelectionView,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const planGroups = useMemo(
    () =>
      buildComposerPlanGroups(
        modelSelectGroups,
        subscribedTeamProducts,
        providerSettingsView,
        displayProvider,
        modelGroupLabels,
        sharedSettings?.providerFamilyConnectionSelections,
      ),
    [
      modelSelectGroups,
      subscribedTeamProducts,
      providerSettingsView,
      displayProvider,
      modelGroupLabels,
      sharedSettings?.providerFamilyConnectionSelections,
    ],
  );
  const connectionSwitch = useComposerConnectionSwitch({
    workspacePath,
    workspaceIdentity,
    agentProvider: displayProvider,
    normalizedValue: normalizedModelValue,
    onSelectModel: handleModelValueChange,
    waitForPresentation: true,
    refreshPresentation: modelSelectionRefresh,
    presentationStatus: modelSelectionState.status,
    presentationRevision: modelSelectionView?.revision,
    presentationErrorRevision:
      modelSelectionState.status === "ready"
        ? modelSelectionState.refreshError?.revision
        : undefined,
  });
  const selectedProviderId =
    decodeCustomModelValue(normalizedModelValue)?.providerId;
  const selectedPlanGroup = planGroups.find((group) => {
    const connection = group.connection;
    if (!connection || connection.providerId !== selectedProviderId)
      return false;
    const selection =
      sharedSettings?.providerFamilyConnectionSelections?.[connection.family];
    return (
      connection.selection?.kind !== "team-coding-plan" ||
      (selection &&
        composerConnectionKey(connection.family, selection) === connection.key)
    );
  });
  const selectedPlanKey = connectionSwitch.pending
    ? connectionSwitch.previousKey
    : (selectedPlanGroup?.key ??
      // 团队共用模型 value；当前过期行隐藏后，不能误选另一团队并阻止用户点击它。
      planGroups.find(
        (group) =>
          group.connection?.selection?.kind !== "team-coding-plan" &&
          group.items.some((item) => item.value === normalizedModelValue),
      )?.key);

  const draftModelThoughtOption = useMemo(
    () =>
      effectiveConfig
        ? resolveDraftModelThoughtOption(
            effectiveConfig.provider,
            effectiveConfig.model,
            modelSelectionView,
          )
        : null,
    [effectiveConfig, modelSelectionView],
  );

  // 候选档位只来自目标 Host 的 ModelSelectionView，已选档位只来自 Composer。
  const thoughtOption = useMemo<ZCodeConfigOption | null>(() => {
    if (!effectiveConfig) return null;
    if (!draftModelThoughtOption) return null;
    return {
      ...draftModelThoughtOption,
      currentValue: resolveDraftThoughtCurrentValue({
        thought: effectiveConfig.thought,
        thoughtLevels:
          draftModelThoughtOption.options?.map((option) => option.value) ?? [],
      }),
    };
  }, [draftModelThoughtOption, effectiveConfig]);

  const handleThoughtValueChange = useCallback(
    (value: string) => {
      if (!effectiveConfig) return;
      if (!value.trim()) {
        // 跨模型受控 Select 重建时可能抛出一次空 value；它不是用户选择，
        // 若继续上抛会把模型 intent 标成 superseded，导致 accepted 模型无法写入全局元组。
        logger.debug("[v4-toolbar] ignore synthetic empty thought change", {
          model: effectiveConfig.model,
          provider: effectiveConfig.provider,
        });
        return;
      }
      onSelectThought(value, {
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
      });
    },
    [effectiveConfig, onSelectThought],
  );

  // Ctrl+T 热键：按目录顺序循环下一次 Submission 的思考深度。
  const handleCycleThoughtLevel = useCallback(() => {
    if (!thoughtOption || thoughtOption.type !== "select") {
      return;
    }
    const nextValue = getNextThoughtLevelValue(thoughtOption);
    if (nextValue == null) {
      return;
    }
    if (!effectiveConfig) return;
    onSelectThought(nextValue, {
      provider: effectiveConfig.provider,
      model: effectiveConfig.model,
    });
  }, [effectiveConfig, onSelectThought, thoughtOption]);

  const taskUsage = useMemo(() => {
    const contextWindow = usage?.contextWindow;
    if (!contextWindow) return null;
    return {
      used: contextWindow.usedTokens,
      size: contextWindow.maxTokens,
      ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
      ...(contextWindow.breakdown
        ? { breakdown: contextWindow.breakdown }
        : {}),
    };
  }, [usage?.contextWindow]);
  // 工具条热键已转正为命令表命令：tooltip 快捷键文案读生效表，
  // 改绑后按钮提示即时跟随（不能用硬编码文案）。
  const modelShortcutLabel = useShortcutCommandLabel("openModelMenu");
  const thoughtShortcutLabel = useShortcutCommandLabel("cycleThoughtLevel");
  const selectConnection = connectionSwitch.select;
  // 原因：内联对象会在无关渲染时使 memo 选择器失效；按展示事实和回调缓存选项。
  const composerOptions = useMemo<ComposerModelOptions>(
    () => ({
      providerMenu: {
        groups: planGroups,
        selectedKey: selectedPlanKey,
        pending: connectionSwitch.pending,
        // 团队目录查询不是用户的连接切换操作，不能把登录错误挂到 API 菜单。
        error: connectionSwitch.error,
        onSelect: (group) => {
          // 原因：展示失败时设置可能已成功；已选连接仍须允许重试，不能被同 key 短路。
          if (group.key === selectedPlanKey && !connectionSwitch.error) return;
          if (group.connection) {
            void selectConnection(group.connection, selectedPlanKey);
          } else {
            const model = chooseConnectionModel(
              group.items,
              decodeCustomModelValue(normalizedModelValue)?.modelName,
            );
            const providerId = decodeCustomModelValue(
              model?.value ?? "",
            )?.providerId;
            // OpenCode CLI 是 Host 本地 provider，不是账号/API 连接；走连接同步会读取错误 owner 的目录并拒绝选择。
            if (providerId === "opencode" && model) {
              handleModelValueChange(model.value);
              return;
            }
            // 原因：普通 API 原先绕过连接切换 owner，缺少 loading 且会暴露旧目录。
            if (providerId)
              void selectConnection(
                {
                  key: group.key,
                  label: group.label,
                  providerId,
                  family: connectionFamily,
                  items: group.items,
                },
                selectedPlanKey,
              );
          }
        },
      },
      providerLabel: intl.formatMessage({
        id: "chat.toolbar.combined.provider",
      }),
      modelsLabel: intl.formatMessage({ id: "chat.toolbar.combined.models" }),
      effortLabel: intl.formatMessage({ id: "chat.toolbar.combined.effort" }),
      effortShortcutLabel: thoughtShortcutLabel,
      selectModelLabel: intl.formatMessage({
        id: "chat.toolbar.combined.selectModel",
      }),
      levels:
        thoughtOption?.options?.map((entry) => ({
          value: entry.value,
          label: getThoughtLevelLabel(
            intl,
            displayProvider,
            thoughtOption,
            entry,
          ),
        })) ?? [],
      value: String(thoughtOption?.currentValue ?? ""),
      onValueChange: handleThoughtValueChange,
    }),
    [
      planGroups,
      selectedPlanKey,
      connectionSwitch.pending,
      connectionSwitch.error,
      selectConnection,
      normalizedModelValue,
      connectionFamily,
      intl,
      thoughtShortcutLabel,
      thoughtOption,
      displayProvider,
      handleThoughtValueChange,
    ],
  );
  const isModelOptionLocked = useCallback(() => false, []);

  // 键盘热键（旧 useToolbarShortcutBindings）：Ctrl+M 打开模型菜单、Ctrl+T 循环思考深度。
  // 模式循环（Ctrl+Shift+M）由 V4ComposerModeSwitch 单独绑定（modeOption 在彼处）。
  // 模型留空是正常的待选择状态，包括已有会话；不能因为没有已选模型隐藏重选入口。
  // 有可选组时正常显示；无组但有「管理模型」入口时也显示，避免用户零模型入口。
  const modelMenuVisible =
    modelSelectGroups.length > 0 || showManageModelsAction;
  // Bug 根因：手机端固定宽度的二级菜单没有消费 Radix 测得的当前方向可用宽度，
  // 共享 min-w-32 还会阻止极窄空间继续收缩。保持二级交互，同时把窗口边缘作为硬上限。
  const providerSubmenuClassName =
    isWebRemoteControl && isMobileViewport
      ? "w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)"
      : undefined;
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(modelOption) || Boolean(thoughtOption),
    toolbarDisabled: disabled || recoveryPending || connectionSwitch.pending,
    modelMenuDisabled:
      disabled ||
      recoveryPending ||
      modelLocked ||
      connectionSwitch.pending ||
      !modelMenuVisible,
    modelOption,
    thoughtOption: thoughtOption ?? undefined,
    onOpenModelMenu: handleOpenModelMenuShortcut,
    onCycleThoughtLevel: handleCycleThoughtLevel,
    onCycleSessionMode: noop,
  });

  return {
    modelTriggerRef,
    thoughtTriggerRef,
    modelMenuOpenRequestKey,
    recoveryPending,
    handleModelPickerOpenChange,
    handleThoughtPickerOpenChange,
    modelSelectGroups,
    handleOpenModelProviderSettings,
    showManageModelsAction,
    manageModelsLabel,
    normalizedModelValue,
    modelTriggerDisplay,
    handleModelValueChange,
    connectionSwitchPending: connectionSwitch.pending,
    thoughtOption,
    handleThoughtValueChange,
    taskUsage,
    modelShortcutLabel,
    thoughtShortcutLabel,
    composerOptions,
    isModelOptionLocked,
    modelMenuVisible,
    providerSubmenuClassName,
  };
}

export type ComposerToolbarModelControlsState = ReturnType<
  typeof useComposerModelControls
>;
