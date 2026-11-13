import { completeNewModelSelection } from "@zcode/provider";
import type { AgentSummary } from "@zcode/shared";
import { TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, testId } from "@zcode/shared/test-ids";
import type { ModelSelectionView } from "@zcode/services";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { SubagentReasoningField } from "@/settings/SubagentReasoningField.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import {
  INHERIT_MODEL_VALUE,
  MODEL_ITEM_NEVER_LOCKED,
  isSubagentModelAvailable,
  isSubagentThoughtLevelAvailable,
  resolveSubagentModelLabel,
  resolveSubagentThoughtOptionState,
  resolvedSubagentThoughtLevel,
  toSubagentModelSelection,
  toSubagentModelValue,
} from "@/settings/subagents-section/subagentModel.js";

/** 内置与插件 subagent 共用的行内 model / effort 覆盖控件，即改即存。 */
export function SubagentModelOverrideControl({
  agent,
  disabled,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  onModelOverrideChange,
}: {
  agent: AgentSummary;
  disabled: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  onModelOverrideChange: (
    agent: AgentSummary,
    config: { model?: string; thoughtLevel?: string },
  ) => Promise<void>;
}) {
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const [config, setConfig] = useState<{
    model?: string;
    thoughtLevel?: string;
  }>(() => ({
    model: agent.modelSelectionOverride
      ? toSubagentModelValue(agent.modelSelectionOverride)
      : undefined,
    thoughtLevel: agent.modelSelectionOverride?.options?.reasoningLevel,
  }));
  const defaultLabel = intl.formatMessage({
    id: "settings.subagents.model.defaultMain",
  });
  const selectModelLabel = intl.formatMessage({
    id: "settings.subagents.model.select",
  });
  const value = config.model ?? INHERIT_MODEL_VALUE;
  const modelAvailable = isSubagentModelAvailable(modelGroups, value, modelSelectionLoading);
  const thoughtLevelState = resolveSubagentThoughtOptionState({
    model: value,
    modelAvailable,
    modelSelectionView,
    modelSelectionLoading,
    thoughtLevel: config.thoughtLevel,
  });
  const thoughtLevelInvalid = Boolean(
    config.thoughtLevel &&
    modelAvailable &&
    !isSubagentThoughtLevelAvailable(thoughtLevelState, config.thoughtLevel),
  );
  // Coding Plan 连接切换后，Builtin 的旧模型可能不再属于当前候选；仅隐藏 reasoning
  // 会让用户误以为模型仍有效，因此触发器改用“选择模型”提示，候选列表仍只展示当前连接。
  const triggerLabel =
    value === INHERIT_MODEL_VALUE
      ? defaultLabel
      : !modelAvailable
        ? selectModelLabel
        : resolveSubagentModelLabel({
            inheritLabel: defaultLabel,
            modelGroups,
            model: value,
          });
  useEffect(() => {
    setConfig({
      model: agent.modelSelectionOverride
        ? toSubagentModelValue(agent.modelSelectionOverride)
        : undefined,
      thoughtLevel: agent.modelSelectionOverride?.options?.reasoningLevel,
    });
  }, [agent.modelSelectionOverride]);

  const persistConfig = useCallback(
    async (nextConfig: { model?: string; thoughtLevel?: string }) => {
      if (pending) {
        return;
      }
      const previousConfig = config;
      setConfig(nextConfig);
      setPending(true);
      try {
        let selectedConfig = nextConfig;
        if (nextConfig.model && nextConfig.model !== config.model) {
          const selection = toSubagentModelSelection(nextConfig.model, nextConfig.thoughtLevel);
          const chosen = selection ? await recommendStartPlan(selection) : null;
          if (!chosen) {
            setConfig(previousConfig);
            return;
          }
          selectedConfig = {
            model: toSubagentModelValue(chosen),
            thoughtLevel: chosen.options?.reasoningLevel,
          };
        }
        await onModelOverrideChange(agent, selectedConfig);
        setConfig(selectedConfig);
      } catch {
        setConfig(previousConfig);
      } finally {
        setPending(false);
      }
    },
    [agent, config, onModelOverrideChange, pending, recommendStartPlan],
  );
  const handleValueChange = useCallback(
    (nextValue: string) => {
      const nextModel = nextValue === INHERIT_MODEL_VALUE ? undefined : nextValue;
      if (nextModel === config.model) {
        return;
      }
      const nextModelAvailable = isSubagentModelAvailable(
        modelGroups,
        nextValue,
        modelSelectionLoading,
      );
      const nextThoughtState = resolveSubagentThoughtOptionState({
        model: nextValue,
        modelAvailable: nextModelAvailable,
        modelSelectionView,
        modelSelectionLoading,
        thoughtLevel:
          nextModel && modelSelectionView
            ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(nextModel))
                ?.options?.reasoningLevel
            : undefined,
      });
      // 控件会展示 Registry 的正常默认档位，持久化必须保存同一个值，
      // 不能让界面有值而执行 Selection 缺少 reasoningLevel。
      void persistConfig({
        model: nextModel,
        thoughtLevel: resolvedSubagentThoughtLevel(nextThoughtState),
      });
    },
    [config.model, modelGroups, modelSelectionLoading, modelSelectionView, persistConfig],
  );
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:built-in-default",
        label: defaultLabel,
        onSelect: () => handleValueChange(INHERIT_MODEL_VALUE),
        selected: value === INHERIT_MODEL_VALUE,
      },
    ],
    [defaultLabel, handleValueChange, value],
  );

  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-1">
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        <span
          data-testid={testId(TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, agent.name)}
          data-model-current-value={value}
          className="inline-flex min-w-0"
        >
          <ModelConfigSelect
            modelGroups={modelGroups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={handleValueChange}
            footerActions={footerActions}
            manageModelsLabel={intl.formatMessage({
              id: "chat.toolbar.model.manageModels",
            })}
            contentSide="top"
            contentAlign="end"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            disabled={disabled || pending}
          />
        </span>
        <SubagentReasoningField
          intl={intl}
          state={thoughtLevelState}
          disabled={disabled || pending}
          labelVisibilityClassName="hidden sm:inline-flex"
          onValueCommit={(thoughtLevel) => {
            if (thoughtLevel === config.thoughtLevel) {
              return;
            }
            void persistConfig({ model: config.model, thoughtLevel });
          }}
        />
      </div>
      {thoughtLevelInvalid ? (
        <span className="text-ui-sm text-destructive">
          {intl.formatMessage({
            id: "settings.subagents.form.validation.thoughtLevelUnavailable",
          })}
        </span>
      ) : null}
    </div>
  );
}
