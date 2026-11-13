/** Модельные фабрики child runtime: наследование Active Model и off-peak override. */
import type { SubagentRunOptions } from "@zcode/contracts";
import type { Model, ModelSelection } from "../../deps.js";
import { getOffPeakModelBinding } from "../../off-peak/model-binding.js";
import type { AgentRuntimeDeps } from "../../types.js";

export function createInheritedSubagentModelFactory(
  inheritedSelection: ModelSelection,
  inheritedModel: Model,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): NonNullable<AgentRuntimeDeps["modelFactory"]> {
  return (target) => {
    if (
      target.selection.providerId === inheritedSelection.providerId &&
      target.selection.modelId === inheritedSelection.modelId &&
      target.selection.options?.reasoningLevel === inheritedSelection.options?.reasoningLevel
    ) {
      // Selection 保持显式意图的稀疏形态；不能拿它和 Active Model 的完整 effective
      // options 比较，否则默认值必然导致复用失败并让 child 重新解释可变 Registry。
      return inheritedModel;
    }
    return fallbackFactory(target);
  };
}

export function modelSelectionFromActiveModel(model: Model): ModelSelection {
  const reasoningLevel = model.options.reasoningLevel;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export function createSubagentOverrideModelFactory(
  override: NonNullable<SubagentRunOptions["modelOverride"]>,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): AgentRuntimeDeps["modelFactory"] {
  return (target) => {
    const model = fallbackFactory({
      ...target,
      selection: override.selection,
      requestDependencies: override.requestDependencies,
    });
    return getOffPeakModelBinding(override.requestDependencies)?.wrap(model) ?? model;
  };
}
