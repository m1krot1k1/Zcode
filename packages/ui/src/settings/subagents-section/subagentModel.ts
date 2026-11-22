import type { AgentColor, AgentSummary, ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { resolveModelDisplayName } from "@/lib/modelSelectionGroups.js";
import type { SubagentReasoningFieldState } from "@/settings/SubagentReasoningField.js";

export const MODEL_ITEM_NEVER_LOCKED = () => false;
export const INHERIT_MODEL_VALUE = "inherit";
export const TOOL_OPTIONS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;
export const TOOL_OPTION_SET = new Set<string>(TOOL_OPTIONS);
export const RISKY_TOOLS = new Set<string>(["Bash", "Edit", "Write"]);

interface SubagentFormInitialState {
  name: string;
  description: string;
  color: AgentColor;
  model: string;
  thoughtLevel?: string;
  injectAgentsMd: boolean;
  inheritAllTools: boolean;
  selectedTools: string[];
  preservedTools: string[];
  skills: string[];
  includeInSwarm: boolean;
  systemPrompt: string;
}

function getKnownTools(values: readonly string[] | undefined): string[] {
  return values?.filter((tool) => TOOL_OPTION_SET.has(tool)) ?? [];
}

function getPreservedTools(values: readonly string[] | undefined): string[] {
  return values?.filter((tool) => !TOOL_OPTION_SET.has(tool)) ?? [];
}

export function mergeTools(
  selectedTools: readonly string[],
  preservedTools: readonly string[],
): string[] | undefined {
  const result = [...selectedTools, ...preservedTools].filter(
    (tool, index, tools) => tool.length > 0 && tools.indexOf(tool) === index,
  );
  return result.length > 0 ? result : undefined;
}

export function allowsAllTools(tools: readonly string[] | undefined): boolean {
  // 通配符 * 表示全部工具，不能按数组长度显示成 1 个工具。
  return !tools || tools.length === 0 || tools.some((tool) => tool.trim() === "*");
}

export function toPersistedModel(model: string): string | undefined {
  const trimmedModel = model.trim();
  return trimmedModel && trimmedModel !== INHERIT_MODEL_VALUE ? trimmedModel : undefined;
}

export function toSubagentModelValue(selection: ModelSelection | undefined): string {
  return selection
    ? encodeCustomModelValue(selection.providerId, selection.modelId)
    : INHERIT_MODEL_VALUE;
}

export function toSubagentModelSelection(
  model: string | undefined,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const persistedModel = model ? toPersistedModel(model) : undefined;
  if (!persistedModel) return undefined;
  const selection = parseModelPickerValue(persistedModel);
  const reasoningLevel = thoughtLevel?.trim();
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

type SubagentThoughtOptionState = SubagentReasoningFieldState;

export function resolveSubagentThoughtOptionState(params: {
  model: string;
  modelAvailable: boolean;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  thoughtLevel?: string;
}): SubagentThoughtOptionState {
  const persistedModel = toPersistedModel(params.model);
  if (!persistedModel || !params.modelAvailable) {
    return { kind: "not-applicable" };
  }
  const modelSelection = parseModelPickerValue(persistedModel);
  const explicitThoughtLevel = params.thoughtLevel?.trim();

  // Settings 只管理 Local Environment，模型能力与候选统一来自 Local Host View。
  // Workspace presentation 的 configOptions 不是第二份模型目录，也不参与 reasoning 判断。
  const metadataOption = params.modelSelectionView
    ? resolveModelThoughtOption({
        modelSelectionView: params.modelSelectionView,
        providerId: modelSelection.providerId,
        modelId: modelSelection.modelId,
        currentValue: explicitThoughtLevel,
      })
    : null;
  if (metadataOption) {
    return {
      kind: "supported",
      option: metadataOption,
    };
  }
  if (params.modelSelectionLoading) {
    return { kind: "unknown", status: "loading" };
  }
  return { kind: "unsupported" };
}

export function isSubagentThoughtLevelAvailable(
  state: SubagentThoughtOptionState,
  thoughtLevel: string | undefined,
): boolean {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return true;
  }
  if (state.kind === "unknown" || state.kind === "not-applicable") {
    return true;
  }
  if (state.kind === "unsupported") {
    return false;
  }
  return Boolean(
    state.option.type === "select" &&
    state.option.options?.some((entry) => entry.value === normalizedThoughtLevel),
  );
}

export function resolvedSubagentThoughtLevel(
  state: SubagentThoughtOptionState,
): string | undefined {
  return state.kind === "supported" && typeof state.option.currentValue === "string"
    ? state.option.currentValue
    : undefined;
}

export function isSubagentModelAvailable(
  modelGroups: readonly ModelSelectGroup[],
  model: string | undefined,
  modelSelectionLoading = false,
): boolean {
  const trimmedModel = model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return true;
  }
  if (modelSelectionLoading) {
    return true;
  }
  return modelGroups.some((group) => group.items.some((item) => item.value === trimmedModel));
}

export function createSubagentFormInitialState(
  initial?: Pick<
    AgentSummary,
    | "name"
    | "description"
    | "color"
    | "modelSelection"
    | "tools"
    | "skills"
    | "includeInSwarm"
    | "systemPrompt"
    | "injectAgentsMd"
  >,
): SubagentFormInitialState {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    color: initial?.color ?? "yellow",
    model: toSubagentModelValue(initial?.modelSelection),
    thoughtLevel: initial?.modelSelection?.options?.reasoningLevel,
    injectAgentsMd: initial?.injectAgentsMd ?? true,
    inheritAllTools: initial?.tools === undefined || initial.tools.length === 0,
    selectedTools: getKnownTools(initial?.tools),
    preservedTools: getPreservedTools(initial?.tools),
    skills: initial?.skills ?? [],
    includeInSwarm: initial?.includeInSwarm ?? false,
    systemPrompt: initial?.systemPrompt ?? "",
  };
}

export function createSubagentFormInitialStateKey(initial?: AgentSummary): string {
  return JSON.stringify({
    id: initial?.id ?? null,
    ...createSubagentFormInitialState(initial),
  });
}

export function resolveSubagentModelLabel(params: {
  inheritLabel: string;
  modelGroups: readonly ModelSelectGroup[];
  model: string | undefined;
}): string {
  const trimmedModel = params.model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return params.inheritLabel;
  }
  // Registry 只包含当前可选模型，但历史 Subagent 配置仍需展示原模型身份，
  // 方便用户理解并修复失效配置。候选列表与保存校验继续以 Registry 为准。
  return resolveModelDisplayName(params.modelGroups, trimmedModel) ?? trimmedModel;
}
