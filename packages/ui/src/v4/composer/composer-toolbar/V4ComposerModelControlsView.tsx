/**
 * Представление модельной части v4 composer-тулбара.
 *
 * Вынесено из V4ComposerToolbar.tsx без изменения разметки: те же ветки
 * (Highspeed → retry → unavailable → настройки провайдера → меню моделей),
 * те же test id, классы и i18n-ключи. Вся логика — в хуках контекста и модели.
 */
import { cn } from "@/components/lib/utils.js";
import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_MODEL_CONFIG,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ChatContextUsage } from "@/chat-input-toolbar/display.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { HighspeedModelIndicator } from "@/highspeed/HighspeedModelIndicator.js";
import { CodeIndexPopover } from "@/agent-workbench/CodeIndexPopover.js";
import { HighspeedCountdown } from "./HighspeedCountdown.js";
import { shouldShowModelProviderSettingsShortcut } from "./modelProviderSettingsShortcut.js";
import {
  MODEL_SELECTION_LOADING_STATE,
  type V4ComposerToolbarProps,
} from "./types.js";
import type { ComposerContextUsageState } from "./useComposerContextUsage.js";
import type { ComposerToolbarModelControlsState } from "./useComposerModelControls.js";

const V4_COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;

export function V4ComposerModelControlsView({
  props,
  contextUsage,
  modelControls,
}: {
  props: V4ComposerToolbarProps;
  contextUsage: ComposerContextUsageState;
  modelControls: ComposerToolbarModelControlsState;
}) {
  const {
    workspacePath,
    workspaceIdentity,
    draftConfig,
    usage,
    disabled,
    modelLocked = false,
    highspeedPresented = false,
    highspeedEntranceAnimated = false,
    highspeedSweepActive = false,
    highspeedExpiresAt,
    highspeedModel,
    modelSelectionState = MODEL_SELECTION_LOADING_STATE,
    modelSelectionReload,
    activeConfigPicker,
    onSendCompressionCommand,
  } = props;
  const {
    intl,
    locale,
    displayProvider,
    effectiveConfig,
    providerSourcesLoading,
    contextStartPlanBalance,
    codingPlanUsageRemaining,
  } = contextUsage;
  const {
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
    connectionSwitchPending,
    thoughtOption,
    handleThoughtValueChange,
    taskUsage,
    modelShortcutLabel,
    thoughtShortcutLabel,
    composerOptions,
    isModelOptionLocked,
    modelMenuVisible,
    providerSubmenuClassName,
  } = modelControls;

  return (
    <>
      {/*
        e2e 契约（TID_V4_MODEL_CONFIG）：Composer/usage 状态的 data-* 属性锚点。
        Bug 原因：跨模型切换会主动清除源模型的显式 thought；此时可见控件已按目标模型
        Option Spec 展示默认档位，但旧锚点仍暴露空的原始投影。data-thought 必须与用户
        实际看到的受控值一致，不能重新引入一份草稿状态。
      */}
      <span
        data-testid={TID_V4_MODEL_CONFIG}
        data-source={effectiveConfig || draftConfig?.mode ? "composer" : ""}
        data-provider={effectiveConfig?.provider ?? ""}
        data-model={effectiveConfig?.model ?? ""}
        data-thought={
          thoughtOption?.type === "select"
            ? String(thoughtOption.currentValue ?? "")
            : (effectiveConfig?.thought ?? "")
        }
        data-thought-levels={
          thoughtOption?.type === "select"
            ? (thoughtOption.options ?? [])
                .map((option) => option.value)
                .join(",")
            : ""
        }
        data-mode={draftConfig?.mode ?? ""}
        data-plan-enabled={draftConfig?.planEnabled ?? false}
        data-usage-used={usage?.contextWindow?.usedTokens ?? ""}
        data-usage-max={usage?.contextWindow?.maxTokens ?? ""}
        className="hidden"
      />
      {/* Highspeed 卡激活即锁定模型；不能等动效交接完成才隐藏，否则 usage 圈圈会短暂闪现。 */}
      {!modelLocked ? (
        <ChatContextUsage
          codingPlanUsageRemaining={codingPlanUsageRemaining}
          taskUsage={taskUsage}
          startPlanBalance={contextStartPlanBalance}
          selectedProvider={displayProvider}
          intl={intl}
          locale={locale}
          onSendCompressionCommand={onSendCompressionCommand}
          compressionDisabled={disabled || recoveryPending}
        />
      ) : null}
      <CodeIndexPopover
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
      />
      {/* 加速轮的模型由本次卡决定，选型菜单此时不可用，所以指示器优先于选型加载态。 */}
      {highspeedPresented && highspeedModel ? (
        <HighspeedModelIndicator
          model={highspeedModel}
          originalModel={modelTriggerDisplay.fullLabel}
          sweepActive={highspeedSweepActive}
          animateEntrance={highspeedEntranceAnimated}
        />
      ) : modelSelectionState.status === "error" &&
        modelSelectGroups.length === 0 &&
        modelSelectionReload ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm text-destructive"
          onClick={modelSelectionReload}
        >
          {intl.formatMessage({ id: "chat.toolbar.model.loadFailedRetry" })}
        </Button>
      ) : modelSelectionState.status === "unavailable" &&
        modelSelectGroups.length === 0 ? (
        <span className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id:
              modelSelectionState.reason === "remote-waiting"
                ? "chat.toolbar.model.remoteWaiting"
                : "chat.toolbar.model.targetMissing",
          })}
        </span>
      ) : shouldShowModelProviderSettingsShortcut({
          modelMenuVisible,
          providerSourcesLoading,
          selectableModelGroupCount: modelSelectGroups.length,
          connectionSwitchPending,
        }) ? (
        // 空配置是正常状态；直接复用 Provider 设置入口，不展开无名称、无模型的菜单。
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm"
          data-testid="chat-model-select-trigger"
          onClick={handleOpenModelProviderSettings}
        >
          {manageModelsLabel}
        </Button>
      ) : modelMenuVisible ? (
        <ModelConfigSelect
          key={workspaceIdentity?.trim() || workspacePath}
          modelGroups={modelSelectGroups}
          contentAlign="center"
          normalizedValue={normalizedModelValue}
          triggerLabel={modelTriggerDisplay.modelLabel}
          composerOptions={composerOptions}
          showManageModelsAction={showManageModelsAction}
          manageModelsLabel={manageModelsLabel}
          onManageModels={handleOpenModelProviderSettings}
          lockReasonMessage={intl.formatMessage({
            id: modelLocked
              ? "chat.highspeed.modelLocked"
              : "chat.toolbar.modelSwitch.lockedByRunningTask",
          })}
          isItemLocked={isModelOptionLocked}
          onValueChange={handleModelValueChange}
          disabled={
            disabled ||
            recoveryPending ||
            modelLocked ||
            (modelSelectionState.status !== "ready" &&
              !(
                modelSelectionState.status === "loading" &&
                modelSelectionState.catalog
              ))
          }
          tooltipTitle={modelTriggerDisplay.fullLabel}
          shortcutLabel={modelShortcutLabel}
          triggerRef={modelTriggerRef}
          open={!modelLocked && activeConfigPicker === "model"}
          onOpenChange={handleModelPickerOpenChange}
          openRequestKey={modelMenuOpenRequestKey}
          labelVisibilityClassName="hidden @sm/composer:inline-flex"
          indicatorClassName="block group-data-[composer-model-icon=true]/toolbar:hidden"
          triggerLabelClassName="block min-w-0 text-left group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
          triggerClassName="composer-model-trigger group-data-[composer-model-icon=true]/toolbar:px-1.5 group-data-[composer-model-icon=true]/toolbar:justify-center"
          triggerIconClassName="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
          focusSelectorOnClose={V4_COMPOSER_INPUT_SELECTOR}
          providerSubmenuClassName={providerSubmenuClassName}
        />
      ) : null}
      {highspeedPresented && highspeedExpiresAt !== undefined ? (
        <HighspeedCountdown expiresAt={highspeedExpiresAt} />
      ) : null}
      {thoughtOption && (modelLocked || highspeedPresented) ? (
        <ThoughtLevelCycleControl
          composerCollapsePriority={3}
          labelVisibilityClassName="inline-flex"
          indicatorClassName="block"
          triggerClassName={cn(highspeedPresented && "text-ui-caption")}
          option={thoughtOption}
          onValueChange={handleThoughtValueChange}
          disabled={disabled || recoveryPending}
          intl={intl}
          provider={displayProvider}
          shortcutLabel={thoughtShortcutLabel}
          triggerRef={thoughtTriggerRef}
          open={activeConfigPicker === "thought"}
          onOpenChange={handleThoughtPickerOpenChange}
          restoreFocusSelector={V4_COMPOSER_INPUT_SELECTOR}
        />
      ) : null}
    </>
  );
}
