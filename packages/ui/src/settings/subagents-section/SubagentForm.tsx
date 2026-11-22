import { hasExplicitModelChanged } from "@/lib/startPlanRecommendation.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  type AgentColor,
  type AgentSummary,
  type SkillSummary,
  type SubAgentConfig,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectFooterAction, ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { SystemPromptEnhanceAction } from "@/prompt-enhancer-ui/SystemPromptEnhanceAction.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SubagentReasoningField } from "@/settings/SubagentReasoningField.js";
import {
  AGENT_COLORS,
  COLOR_DOT_CLASS,
  FormFieldLabel,
  ToolCheckbox,
} from "@/settings/subagents-section/SubagentPrimitives.js";
import {
  INHERIT_MODEL_VALUE,
  MODEL_ITEM_NEVER_LOCKED,
  TOOL_OPTIONS,
  createSubagentFormInitialState,
  createSubagentFormInitialStateKey,
  isSubagentModelAvailable,
  isSubagentThoughtLevelAvailable,
  mergeTools,
  resolveSubagentModelLabel,
  resolveSubagentThoughtOptionState,
  toPersistedModel,
  toSubagentModelSelection,
} from "@/settings/subagents-section/subagentModel.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

export function SubagentForm({
  initial,
  modelSelectionView,
  modelSelectionLoading,
  modelSelectGroups,
  availableSkills,
  skillsLoading,
  skillsLoadError,
  onReloadSkills,
  onManageModels,
  saving,
  onCancel,
  onDelete,
  onSave,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
  systemPromptWorkspacePath,
  workspaceIdentity,
}: {
  initial?: AgentSummary;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  modelSelectGroups: readonly ModelSelectGroup[];
  availableSkills: readonly SkillSummary[];
  skillsLoading: boolean;
  skillsLoadError: string | null;
  onReloadSkills: () => void;
  onManageModels?: () => void;
  saving: boolean;
  onCancel: () => void;
  onDelete?: (agent: AgentSummary) => void;
  onSave: (config: SubAgentConfig) => Promise<void>;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onScopeKeyChange: (scopeKey: string) => void;
  /** Workspace для действия «Улучшить системный промпт»; без него действие скрыто. */
  systemPromptWorkspacePath?: string | null;
  workspaceIdentity?: string;
}) {
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");
  const { intl } = useZCodeIntl();
  const initialFormStateKey = createSubagentFormInitialStateKey(initial);
  const initialFormState = useMemo(
    () => createSubagentFormInitialState(initial),
    [initial, initialFormStateKey],
  );
  const previousInitialFormStateKeyRef = useRef(initialFormStateKey);
  const [name, setName] = useState(initialFormState.name);
  const [description, setDescription] = useState(initialFormState.description);
  const [color, setColor] = useState<AgentColor>(initialFormState.color);
  const [model, setModel] = useState(initialFormState.model);
  const [thoughtLevel, setThoughtLevel] = useState(initialFormState.thoughtLevel);
  const [injectAgentsMd, setInjectAgentsMd] = useState(initialFormState.injectAgentsMd);
  const [inheritAllTools, setInheritAllTools] = useState(initialFormState.inheritAllTools);
  const [selectedTools, setSelectedTools] = useState<string[]>(initialFormState.selectedTools);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(initialFormState.skills);
  const [includeInSwarm, setIncludeInSwarm] = useState(initialFormState.includeInSwarm);
  const [systemPrompt, setSystemPrompt] = useState(initialFormState.systemPrompt);
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const inheritModelLabel = intl.formatMessage({
    id: "settings.subagents.model.inherit",
  });
  const handleModelChange = useCallback(
    (nextModel: string) => {
      if (nextModel === model) {
        return;
      }
      setModel(nextModel);
      const identity = toPersistedModel(nextModel);
      const selected =
        identity && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(identity))
          : undefined;
      setThoughtLevel(selected?.options?.reasoningLevel ?? "");
      setModelError(null);
    },
    [model, modelSelectionView],
  );
  const persistedModel = toPersistedModel(model);
  const modelAvailable = isSubagentModelAvailable(modelSelectGroups, model, modelSelectionLoading);
  // 候选已明确失效时仍展示原型号会误导用户；只改触发器文案，不清空草稿或补回候选。
  // 非 ready 阶段由可用性函数保留原意图，不能把读取失败当成模型被删除。
  const modelTriggerLabel = modelAvailable
    ? resolveSubagentModelLabel({
        inheritLabel: inheritModelLabel,
        modelGroups: modelSelectGroups,
        model,
      })
    : intl.formatMessage({ id: "settings.subagents.model.select" });
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:inherit",
        label: inheritModelLabel,
        onSelect: () => handleModelChange(INHERIT_MODEL_VALUE),
        selected: model === INHERIT_MODEL_VALUE,
      },
    ],
    [handleModelChange, inheritModelLabel, model],
  );
  const thoughtLevelState = resolveSubagentThoughtOptionState({
    model,
    modelAvailable,
    modelSelectionView,
    modelSelectionLoading,
    thoughtLevel,
  });
  const thoughtLevelInvalid = Boolean(
    persistedModel &&
    thoughtLevel &&
    modelAvailable &&
    !isSubagentThoughtLevelAvailable(thoughtLevelState, thoughtLevel),
  );
  const swarmRosterInvalid =
    includeInSwarm &&
    (inheritAllTools || selectedTools.length === 0 || selectedTools.includes("*"));
  const trimmedName = name.trim();
  const canSave = Boolean(
    trimmedName.length >= 3 &&
    trimmedName.length <= 50 &&
    /^[a-zA-Z0-9-]+$/u.test(trimmedName) &&
    description.trim() &&
    systemPrompt.trim() &&
    modelAvailable &&
    !thoughtLevelInvalid &&
    !swarmRosterInvalid,
  );
  const selectedColorIndex = Math.max(0, AGENT_COLORS.indexOf(color));

  useEffect(() => {
    if (previousInitialFormStateKeyRef.current === initialFormStateKey) {
      return;
    }
    previousInitialFormStateKeyRef.current = initialFormStateKey;
    const nextInitialState = createSubagentFormInitialState(initial);

    // 保存/刷新后表单组件可能复用旧实例；必须按最新 agent 快照回灌字段，
    // 否则已写入 Markdown 的 model 会继续停留在本地 inherit 状态。
    setName(nextInitialState.name);
    setDescription(nextInitialState.description);
    setColor(nextInitialState.color);
    setModel(nextInitialState.model);
    setThoughtLevel(nextInitialState.thoughtLevel);
    setInjectAgentsMd(nextInitialState.injectAgentsMd);
    setInheritAllTools(nextInitialState.inheritAllTools);
    setSelectedTools(nextInitialState.selectedTools);
    setSelectedSkills(nextInitialState.skills);
    setIncludeInSwarm(nextInitialState.includeInSwarm);
    setSystemPrompt(nextInitialState.systemPrompt);
    setNameError(null);
    setDescriptionError(null);
    setPromptError(null);
    setModelError(null);
  }, [initial, initialFormStateKey]);

  const validate = (): boolean => {
    const trimmedName = name.trim();
    let valid = true;
    if (trimmedName.length < 3 || trimmedName.length > 50) {
      setNameError(
        intl.formatMessage(
          { id: "settings.subagents.form.validation.nameLength" },
          { min: "3", max: "50" },
        ),
      );
      valid = false;
    } else if (!/^[a-zA-Z0-9-]+$/u.test(trimmedName)) {
      setNameError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.nameCharacters",
        }),
      );
      valid = false;
    } else {
      setNameError(null);
    }
    if (!description.trim()) {
      setDescriptionError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.descriptionRequired",
        }),
      );
      valid = false;
    } else {
      setDescriptionError(null);
    }
    if (!systemPrompt.trim()) {
      setPromptError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.promptRequired",
        }),
      );
      valid = false;
    } else {
      setPromptError(null);
    }
    // 不可用模型会展示为“选择模型”，保存时也必须阻止历史值被静默写回。
    if (!isSubagentModelAvailable(modelSelectGroups, model, modelSelectionLoading)) {
      setModelError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.modelUnavailable",
        }),
      );
      valid = false;
    } else {
      setModelError(null);
    }
    if (thoughtLevelInvalid) {
      valid = false;
    }
    return valid;
  };

  const toggleTool = (tool: string) => {
    setInheritAllTools(false);
    setSelectedTools((current) =>
      current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool],
    );
  };

  const handleToolsModeChange = (value: string) => {
    const nextInheritAllTools = value === "all";
    setInheritAllTools(nextInheritAllTools);
    if (!nextInheritAllTools && selectedTools.length === 0) {
      setSelectedTools([...TOOL_OPTIONS]);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    let selection = toSubagentModelSelection(persistedModel, thoughtLevel);
    if (hasExplicitModelChanged(initial?.modelSelection, selection)) {
      const chosen = await recommendStartPlan(selection);
      if (!chosen) return;
      selection = chosen;
    }
    await onSave({
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      color,
      injectAgentsMd,
      ...(selection ? { modelSelection: selection } : {}),
      tools: inheritAllTools
        ? undefined
        : mergeTools(selectedTools, initialFormState.preservedTools),
      disallowedTools: initial?.disallowedTools,
      skills: selectedSkills,
      includeInSwarm,
      permissionMode: initial?.permissionMode,
      ...(initial?.maxTurns ? { maxTurns: initial.maxTurns } : {}),
      ...(initial?.background !== undefined ? { background: initial.background } : {}),
      mcpServers: initial?.mcpServers,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex justify-end">
        <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span className="shrink-0 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.scope.label" })}
          </span>
          <PluginScopeMenu
            align="end"
            disabled={Boolean(initial)}
            selectedScopeKey={scopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={onScopeKeyChange}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,14rem)_auto_minmax(0,1fr)] md:items-start">
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.name.label" })}
          </FormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.subagents.form.name.placeholder",
            })}
          />
          {nameError ? <p className="text-ui-base text-destructive">{nameError}</p> : null}
        </div>
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.color.label" })}
          </FormFieldLabel>
          <div
            role="radiogroup"
            className="relative inline-grid w-56 grid-cols-8 rounded-lg border border-input-border bg-input p-1"
          >
            <span
              className="pointer-events-none absolute top-1 size-6 rounded-full border border-border-hover bg-surface shadow-xs transition-[left]"
              style={{
                left: `calc(0.25rem + ((100% - 0.5rem) / ${AGENT_COLORS.length}) * ${selectedColorIndex})`,
              }}
              aria-hidden="true"
            />
            {AGENT_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={color === option}
                aria-label={intl.formatMessage({
                  id: `settings.subagents.color.${option}`,
                })}
                className="relative z-10 flex size-6 items-center justify-center rounded-full outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setColor(option)}
              >
                <span className={cn("size-3.5 rounded-full", COLOR_DOT_CLASS[option])} />
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.model.label" })}
          </FormFieldLabel>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ModelConfigSelect
              modelGroups={modelSelectGroups}
              normalizedValue={model}
              triggerLabel={modelTriggerLabel}
              showManageModelsAction={Boolean(onManageModels)}
              lockReasonMessage=""
              isItemLocked={MODEL_ITEM_NEVER_LOCKED}
              onValueChange={handleModelChange}
              footerActions={footerActions}
              manageModelsLabel={intl.formatMessage({
                id: "chat.toolbar.model.manageModels",
              })}
              onManageModels={onManageModels}
              // 聊天工具栏的模型菜单默认向上弹；Subagents add/edit 表单位于设置页正文，
              // 菜单项应贴着按钮下方展开，避免覆盖上面的表单字段。
              contentSide="bottom"
              focusSelectorOnClose={null}
              labelVisibilityClassName="inline-flex min-w-0"
              triggerClassName="h-8 w-fit max-w-full min-w-0 justify-between rounded-lg border border-input-border bg-input bg-clip-border px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
              triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            />
            <SubagentReasoningField
              intl={intl}
              state={thoughtLevelState}
              disabled={saving}
              labelVisibilityClassName="inline-flex min-w-0"
              onValueCommit={setThoughtLevel}
            />
          </div>
          {modelError ? <p className="text-ui-base text-destructive">{modelError}</p> : null}
          {thoughtLevelInvalid ? (
            <p className="text-ui-base text-destructive">
              {intl.formatMessage({
                id: "settings.subagents.form.validation.thoughtLevelUnavailable",
              })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <FormFieldLabel>
          {intl.formatMessage({
            id: "settings.subagents.form.description.label",
          })}
        </FormFieldLabel>
        <Input
          type="text"
          size="lg"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.subagents.form.description.placeholder",
          })}
        />
        {descriptionError ? (
          <p className="text-ui-base text-destructive">{descriptionError}</p>
        ) : null}
      </div>

      <div className="space-y-2 pt-1">
        <FormFieldLabel>
          {intl.formatMessage({ id: "settings.subagents.form.tools.label" })}
        </FormFieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Select value={inheritAllTools ? "all" : "custom"} onValueChange={handleToolsModeChange}>
            <SelectTrigger size="lg" className="w-fit justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {intl.formatMessage({
                  id: "settings.subagents.form.tools.mode.all",
                })}
              </SelectItem>
              <SelectItem value="custom">
                {intl.formatMessage({
                  id: "settings.subagents.form.tools.mode.custom",
                })}
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="min-w-0 text-ui-base font-normal text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.subagents.form.tools.card.title",
            })}
          </span>
        </div>
        {inheritAllTools ? null : (
          <div className="rounded-lg border border-border bg-card p-1">
            <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {TOOL_OPTIONS.map((tool) => (
                <ToolCheckbox
                  key={tool}
                  checked={selectedTools.includes(tool)}
                  disabled={false}
                  label={tool}
                  onToggle={() => toggleTool(tool)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <FormFieldLabel>
          {intl.formatMessage({ id: "settings.subagents.form.skills.label" })}
        </FormFieldLabel>
        {skillsLoadError !== null ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
            <span>
              {skillsLoadError ||
                intl.formatMessage({ id: "settings.subagents.form.skills.loadFailed" })}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={onReloadSkills}>
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          </div>
        ) : null}
        {skillsLoading ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : null}
        {availableSkills.length === 0 && !skillsLoading && !skillsLoadError ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.subagents.form.skills.empty" })}
          </p>
        ) : null}
        {availableSkills.length > 0 ? (
          <div className="grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-2">
            {availableSkills.map((skill) => (
              <label key={skill.id} className="flex min-w-0 items-start gap-2">
                <input
                  type="checkbox"
                  checked={selectedSkills.includes(skill.name)}
                  disabled={saving || skillsLoading || !skill.enabled}
                  onChange={() =>
                    setSelectedSkills((current) =>
                      current.includes(skill.name)
                        ? current.filter((name) => name !== skill.name)
                        : [...current, skill.name],
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="block truncate text-ui-base text-foreground">{skill.name}</span>
                  <span className="block line-clamp-2 text-ui-sm text-foreground-subtle">
                    {skill.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : null}
        {selectedSkills.some(
          (name) => !availableSkills.some((skill) => skill.name === name && skill.enabled),
        ) ? (
          <p className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "settings.subagents.form.skills.unavailable" })}:{" "}
            {selectedSkills
              .filter(
                (name) => !availableSkills.some((skill) => skill.name === name && skill.enabled),
              )
              .join(", ")}
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.subagents.form.swarm.label" })}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.subagents.form.swarm.description" })}
          </p>
        </div>
        <Switch
          checked={includeInSwarm}
          onCheckedChange={setIncludeInSwarm}
          aria-label={intl.formatMessage({ id: "settings.subagents.form.swarm.label" })}
        />
      </div>
      {swarmRosterInvalid ? (
        <p className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "settings.subagents.form.swarm.toolsRequired" })}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <FormFieldLabel>
          {intl.formatMessage({
            id: "settings.subagents.form.systemPrompt.label",
          })}
        </FormFieldLabel>
        <SettingsFormTextarea
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={3}
          className="max-h-56 min-h-16 resize-y overflow-y-auto text-ui-base"
          placeholder={intl.formatMessage({
            id: "settings.subagents.form.systemPrompt.placeholder",
          })}
        />
        {/* Причина: действие «Улучшить системный промпт» было реализовано, но не подключено
            ни к одной поверхности, поэтому модель улучшения системных инструкций была
            недоступна из UI. Результат сразу подставляется в поле как черновик формы. */}
        {/* 原因：切换目标 agent 时本 Action 会复用实例，旧请求完成后会把结果写进新 agent
            的字段；用 key 随目标重建，卸载清理会取消仍在进行的请求。 */}
        {systemPromptWorkspacePath ? (
          <SystemPromptEnhanceAction
            key={initialFormStateKey}
            workspacePath={systemPromptWorkspacePath}
            {...(workspaceIdentity ? { workspaceIdentity } : {})}
            draftText={systemPrompt}
            onApply={setSystemPrompt}
          />
        ) : null}
        {promptError ? <p className="text-ui-base text-destructive">{promptError}</p> : null}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2.5">
        <p className="min-w-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({
            id: "settings.subagents.form.injectAgentsMd.label",
          })}
        </p>
        <Switch
          checked={injectAgentsMd}
          onCheckedChange={setInjectAgentsMd}
          aria-label={intl.formatMessage({
            id: "settings.subagents.form.injectAgentsMd.label",
          })}
        />
      </div>

      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button type="submit" variant="default" size="lg" disabled={!canSave || saving}>
          {saving
            ? intl.formatMessage({ id: "common.saving" })
            : intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </form>
  );
}
