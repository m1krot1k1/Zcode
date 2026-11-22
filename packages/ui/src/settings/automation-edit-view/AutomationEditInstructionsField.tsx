import type { ComponentProps } from "react";
import { FolderOpen, MessageCircle } from "lucide-react";
import { ZCODE_AGENT_PROVIDER, type ZCodeAutomation } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { TID_AUTOMATION_FORM_PROMPT } from "@zcode/shared/test-ids";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { AUTOMATION_FORM_FIELD_CLASSNAME } from "@/settings/AutomationDesignPrimitives.js";
import {
  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
  AutomationInstructionsComposer,
  AutomationInstructionsTextarea,
  AutomationInstructionsToolbar,
} from "@/settings/AutomationInstructionsComposer.js";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import {
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import type { AutomationEditRequiredField } from "@/settings/automationEditValidation.js";
import type {
  buildAutomationModelSelectGroups,
  buildAutomationModeOption,
} from "@/settings/automationAgentConfigOptions.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

interface AutomationEditInstructionsFieldProps {
  editing: ZCodeAutomation | null;
  handleModelValueChange: (value: string) => void;
  handlePromptValueChange: (value: string) => void;
  handleSelectProject: (key: string) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  isSelectedConversationWorkspace: boolean;
  modeOption: ReturnType<typeof buildAutomationModeOption>;
  modelSelectGroups: ReturnType<typeof buildAutomationModelSelectGroups>;
  modelSelectionRead: ReturnType<typeof useModelSelectionServiceView>;
  modelTriggerLabel: string;
  modelValue: string;
  onManageModels?: () => void;
  onModeValueChange: (value: string) => void;
  onThoughtLevelValueChange: (value: string) => void;
  prompt: string;
  selectedWorkspaceDisplayLabel: string;
  thoughtLevelOption: ComponentProps<typeof ThoughtLevelCycleControl>["option"] | null;
  thoughtTriggerRef: ComponentProps<typeof ThoughtLevelCycleControl>["triggerRef"];
  validationErrors: ReadonlySet<AutomationEditRequiredField>;
  workspaceKey: string | null;
  workspaceOptions: AutomationWorkspaceOption[];
}

export function AutomationEditInstructionsField({
  editing,
  handleModelValueChange,
  handlePromptValueChange,
  handleSelectProject,
  intl,
  isSelectedConversationWorkspace,
  modeOption,
  modelSelectGroups,
  modelSelectionRead,
  modelTriggerLabel,
  modelValue,
  onManageModels,
  onModeValueChange,
  onThoughtLevelValueChange,
  prompt,
  selectedWorkspaceDisplayLabel,
  thoughtLevelOption,
  thoughtTriggerRef,
  validationErrors,
  workspaceKey,
  workspaceOptions,
}: AutomationEditInstructionsFieldProps) {
  return (
    <>
      {/* Instructions + 底部项目/模型选择器 */}
      <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
        <label
          className="text-ui-base font-normal leading-5 text-foreground-subtle"
          htmlFor="automation-prompt"
        >
          {intl.formatMessage({ id: "automations.form.prompt.label" })}
        </label>
        <AutomationInstructionsComposer invalid={validationErrors.has("prompt") && !prompt.trim()}>
          <AutomationInstructionsTextarea
            id="automation-prompt"
            data-testid={TID_AUTOMATION_FORM_PROMPT}
            value={prompt}
            onChange={(event) => handlePromptValueChange(event.target.value)}
            placeholder={intl.formatMessage({
              id: "automations.edit.promptPlaceholder",
            })}
            aria-invalid={validationErrors.has("prompt") && !prompt.trim()}
          />
          <AutomationInstructionsToolbar>
            <div className="flex min-w-0 flex-wrap items-center gap-0 text-foreground-subtle">
              {/* 项目选择器:新建复用输入框空态的项目菜单;编辑锁定为 automation 所属项目 */}
              {editing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled
                  className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal"
                >
                  {isSelectedConversationWorkspace ? (
                    <MessageCircle className="size-3.5" aria-hidden="true" />
                  ) : (
                    <FolderOpen className="size-3.5" aria-hidden="true" />
                  )}
                  <span className="max-w-40 truncate">{selectedWorkspaceDisplayLabel}</span>
                </Button>
              ) : workspaceOptions.length > 0 ? (
                <Select value={workspaceKey ?? ""} onValueChange={handleSelectProject}>
                  <SelectTrigger
                    data-testid="automation-project-select"
                    variant="ghost"
                    className={AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME}
                  >
                    <FolderOpen className="size-4" aria-hidden="true" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaceOptions.map((option) => (
                      <SelectItem
                        key={resolveAutomationWorkspaceSelectionKey(option)}
                        value={resolveAutomationWorkspaceSelectionKey(option)}
                        data-project-id={option.projectId}
                        data-project-name={option.label}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled
                  className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal text-foreground-subtlest"
                >
                  <FolderOpen className="size-3.5" aria-hidden="true" />
                  {intl.formatMessage({
                    id: "automations.form.project.localRequired",
                  })}
                </Button>
              )}

              {/* Bugfix：自动化曾复制首页权限菜单，导致图标、字号和选中态逐渐分叉。
                        直接复用首页 ConfigSelect，只覆盖紧凑 trigger 布局。 */}
              <ConfigSelect
                option={modeOption}
                onValueChange={onModeValueChange}
                tooltipTitle={intl.formatMessage({
                  id: "chat.toolbar.mode.label",
                })}
                triggerVariant="ghost"
                triggerSize="default"
                triggerClassName={cn(
                  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                  "w-fit max-w-56 min-w-0 shrink justify-start gap-1 px-2",
                )}
                labelVisibilityClassName="inline-flex min-w-0 truncate text-left"
                provider={ZCODE_AGENT_PROVIDER}
                restoreFocusSelector={null}
              />
            </div>

            {/* 模型 / 推理强度在右侧成组，和左侧 workspace / 权限形成清晰分区。 */}
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-0 text-foreground-subtle">
              <ModelConfigSelect
                modelGroups={modelSelectGroups}
                normalizedValue={modelValue}
                triggerLabel={modelTriggerLabel}
                showManageModelsAction={Boolean(onManageModels)}
                lockReasonMessage=""
                isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                onValueChange={handleModelValueChange}
                tooltipTitle={intl.formatMessage({
                  id: "chat.toolbar.model.label",
                })}
                manageModelsLabel={intl.formatMessage({
                  id: "chat.toolbar.model.manageModels",
                })}
                onManageModels={onManageModels}
                contentSide="top"
                focusSelectorOnClose={null}
                labelVisibilityClassName="hidden @sm/composer:inline-flex"
                indicatorClassName="hidden @sm/composer:block"
                triggerClassName={cn(
                  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                  "w-fit max-w-72 min-w-0 shrink @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0",
                )}
                triggerIconClassName="inline-flex @sm/composer:hidden"
                disabled={modelSelectionRead.state.status !== "ready"}
              />
              {modelSelectionRead.state.status === "error" ? (
                <Button type="button" variant="ghost" size="xs" onClick={modelSelectionRead.reload}>
                  {intl.formatMessage({ id: "common.retry" })}
                </Button>
              ) : null}
              {thoughtLevelOption ? (
                <ThoughtLevelCycleControl
                  intl={intl}
                  option={thoughtLevelOption}
                  provider={ZCODE_AGENT_PROVIDER}
                  triggerRef={thoughtTriggerRef}
                  indicatorClassName="hidden @xl/composer:block"
                  triggerClassName={cn(
                    AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                    "@max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:p-0",
                  )}
                  restoreFocusSelector={null}
                  labelVisibilityClassName="hidden @xl/composer:inline-flex"
                  onValueChange={onThoughtLevelValueChange}
                />
              ) : null}
            </div>
          </AutomationInstructionsToolbar>
        </AutomationInstructionsComposer>
      </div>
    </>
  );
}
