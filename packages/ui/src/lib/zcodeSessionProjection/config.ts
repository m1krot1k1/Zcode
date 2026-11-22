import {
  getZCodeAgentAvailableModes as getSharedAgentAvailableModes,
  normalizeAvailableZCodeMode,
  decodeCustomModelValue,
  parseModelPickerValue as parseSharedModelSelection,
  formatModelPickerValue as formatSharedModelSelection,
  type ZCodeConfigOption,
  type ZCodeTaskMode,
  type ZCodeTaskModeInfo,
  type ZCodeMessageWithParts,
  type ModelSelection,
  type ZCodeSessionMode,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import {
  MODEL_CONFIG_ID,
  MODE_CONFIG_ID,
  THOUGHT_LEVEL_CONFIG_ID,
} from "./primitives.js";

export const ZCODE_AGENT_MODE_OPTIONS = getSharedAgentAvailableModes();

export function formatModelPickerValue(
  ref: ModelSelection | undefined,
): string {
  return formatSharedModelSelection(ref);
}

function resolveLatestMessageModelSelection(
  messages: readonly ZCodeMessageWithParts[],
): ModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.info.model;
    if (model) {
      return model;
    }
  }
  return undefined;
}

export function resolveTaskMetaModelSelectionFromSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ModelSelection | undefined {
  // 历史 resume 被错误 runtimeModel 覆盖时，settings.current 会变成 app 当前默认模型，
  // 但消息 info.model 仍记录真实使用的模型。task meta 会作为下次冷恢复 hint，
  // 因此优先用最近消息模型让已污染的历史记录自愈。
  return (
    resolveLatestMessageModelSelection(snapshot.messages) ??
    snapshot.settings.model.current
  );
}

export function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    // UI 自定义模型值是展示态 custom:provider:model，
    // ZCode Protocol 必须收到严格的 providerId/modelId 结构。
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}

export function zcodeSessionSettingsToConfigOptions(
  settings: ZCodeSessionSettingsState,
): ZCodeConfigOption[] {
  const configOptions: ZCodeConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: formatModelPickerValue(settings.model.current),
      options: settings.model.available.map((model) => {
        const modelThoughtLevels = model.reasoning?.levels.map(
          (level) => level.value,
        );
        const modelDefaultThoughtLevel =
          model.reasoning?.defaultLevel &&
          modelThoughtLevels?.includes(model.reasoning.defaultLevel)
            ? model.reasoning.defaultLevel
            : undefined;
        return {
          value: formatModelPickerValue(model.ref),
          name: model.label,
          description: model.description,
          modelProviderId: model.ref.providerId,
          modelProviderName: model.providerLabel ?? model.ref.providerId,
          ...(modelThoughtLevels ? { modelThoughtLevels } : {}),
          ...(modelDefaultThoughtLevel ? { modelDefaultThoughtLevel } : {}),
        };
      }),
    },
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableZCodeMode(settings.mode.current),
      options: getZCodeAgentModeSelectOptions(),
    },
  ];
  if (settings.thoughtLevel.enabled) {
    configOptions.push({
      id: THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue:
        resolveSettingsThoughtLevelCurrentValue(settings.thoughtLevel) ?? "",
      options: settings.thoughtLevel.available.map((level) => ({
        value: level.value,
        name: level.label,
        description: level.description,
      })),
    });
  }
  return configOptions;
}

export function zcodeWorkspacePresentationToConfigOptions(
  mode: ZCodeSessionMode,
): ZCodeConfigOption[] {
  return [
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableZCodeMode(mode),
      options: getZCodeAgentModeSelectOptions(),
    },
  ];
}

export function resolveSettingsThoughtLevelCurrentValue(
  thoughtLevel: ZCodeSessionSettingsState["thoughtLevel"],
): string | undefined {
  const thoughtLevelValues = new Set(
    thoughtLevel.available.map((level) => level.value),
  );
  const currentThoughtLevel =
    thoughtLevel.current && thoughtLevelValues.has(thoughtLevel.current)
      ? thoughtLevel.current
      : undefined;
  const defaultThoughtLevel =
    thoughtLevel.defaultLevel &&
    thoughtLevelValues.has(thoughtLevel.defaultLevel)
      ? thoughtLevel.defaultLevel
      : undefined;
  // ZCode Protocol 的 defaultLevel 是模型事实，current 为空时表示用户尚未显式修改。
  // 实时模型状态事件也要投影默认值，否则工具栏会拿到空 currentValue，出现没有档位被选中的 UI。
  return (
    currentThoughtLevel ??
    defaultThoughtLevel ??
    thoughtLevel.available[0]?.value
  );
}

export function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

export function getZCodeAgentModeSelectOptions(): NonNullable<
  ZCodeConfigOption["options"]
> {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

export function getZCodeAgentAvailableModes(): ZCodeTaskModeInfo[] {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({ ...mode }));
}
