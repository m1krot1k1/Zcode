import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { TID_AUTOMATION_FORM_TITLE } from "@zcode/shared/test-ids";
import { AUTOMATION_FORM_FIELD_CLASSNAME } from "@/settings/AutomationDesignPrimitives.js";
import { AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME } from "@/settings/AutomationInstructionsComposer.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import type { AutomationStatusKind } from "@/settings/automationFormat.js";
import { AutomationEditHeader } from "@/settings/automation-edit-view/AutomationEditHeader.js";
import { AutomationEditInstructionsField } from "@/settings/automation-edit-view/AutomationEditInstructionsField.js";
import { AutomationEditRunsHistory } from "@/settings/automation-edit-view/AutomationEditRunsHistory.js";
import { AutomationEditScheduleField } from "@/settings/automation-edit-view/AutomationEditScheduleField.js";
import type { AutomationEditViewProps } from "@/settings/automation-edit-view/automationEditTypes.js";
import { useAutomationEditViewState } from "@/settings/automation-edit-view/useAutomationEditViewState.js";

export type { AutomationEditSubmit } from "@/settings/automation-edit-view/automationEditTypes.js";
export { saveAndRunAutomation } from "@/settings/automation-edit-view/automationEditSaveAndRun.js";

const AUTOMATION_STATUS_DOT_CLASS: Record<AutomationStatusKind, string> = {
  active: "bg-success",
  paused: "bg-warning",
  failed: "bg-destructive",
  completed: "bg-foreground-subtlest",
};

export function AutomationEditView(props: AutomationEditViewProps) {
  const {
    builder,
    canSubmit,
    clearRequiredFieldValidation,
    customRepeatOpen,
    editStatus,
    editing,
    endAt,
    handleBackClick,
    handleFormSubmit,
    handleModeValueChange,
    handleModelValueChange,
    handlePromptValueChange,
    handleRemoveSchedule,
    handleSaveAndRun,
    handleSelectProject,
    handleTabChange,
    handleThoughtLevelValueChange,
    handleTitleValueChange,
    intl,
    isSelectedConversationWorkspace,
    markFieldTouched,
    modeOption,
    modelSelectGroups,
    modelSelectionRead,
    modelTriggerLabel,
    modelValue,
    onDelete,
    onDeleteRun,
    onManageModels,
    onOpenSession,
    onRunNow,
    onToggle,
    preserveSessionCreatedSchedule,
    prompt,
    runsEntry,
    runsPage,
    saveAndRunPending,
    saving,
    schedulePreview,
    scheduleRemoved,
    selectedWorkspaceDisplayLabel,
    setBuilder,
    setCustomRepeatOpen,
    setEndAt,
    setRunsPage,
    setScheduleRemoved,
    showCreateSettingsAction,
    showEditingSettingsActions,
    submissionContextReady,
    tab,
    thoughtLevelOption,
    thoughtTriggerRef,
    title,
    validationErrors,
    workspaceKey,
    workspaceOptions,
  } = useAutomationEditViewState(props);

  return (
    <div className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col gap-6")}>
      <AutomationEditHeader
        canSubmit={canSubmit}
        editing={editing}
        handleBackClick={handleBackClick}
        handleSaveAndRun={handleSaveAndRun}
        handleTabChange={handleTabChange}
        intl={intl}
        onDelete={onDelete}
        onRunNow={onRunNow}
        onToggle={onToggle}
        saveAndRunPending={saveAndRunPending}
        saving={saving}
        showCreateSettingsAction={showCreateSettingsAction}
        showEditingSettingsActions={showEditingSettingsActions}
        submissionContextReady={submissionContextReady}
        tab={tab}
      />

      {tab === "settings" ? (
        <form
          id="automation-edit-form"
          className="space-y-4"
          onSubmit={(event) => void handleFormSubmit(event)}
        >
          {editStatus ? (
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "automations.form.status.label" })}
              </div>
              <div className="flex min-h-8 flex-wrap items-center gap-2">
                {/* Bug 原因：状态圆点与胶囊沿用了偏大的 8px / 36px 尺寸，未遵循 6px glyph + 20px frame 的规格。 */}
                <span className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-card pl-2 pr-4 text-ui-base leading-5 text-foreground">
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        AUTOMATION_STATUS_DOT_CLASS[editStatus],
                      )}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({
                      id: `automations.lifecycle.${editStatus}`,
                    })}
                  </span>
                </span>
              </div>
            </div>
          ) : null}

          {/* Task title */}
          <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
            <label
              className="text-ui-base font-normal leading-5 text-foreground-subtle"
              htmlFor="automation-title"
            >
              {intl.formatMessage({ id: "automations.form.title.label" })}
            </label>
            {/* 修复原因：Task title 是标准 Input，不能局部移除全局描边语义。 */}
            <Input
              id="automation-title"
              size="lg"
              data-testid={TID_AUTOMATION_FORM_TITLE}
              value={title}
              onChange={(event) => handleTitleValueChange(event.target.value)}
              placeholder={intl.formatMessage({
                id: "automations.edit.titlePlaceholder",
              })}
              aria-invalid={validationErrors.has("title") && !title.trim()}
              maxLength={200}
              className={cn(
                "h-9 rounded-xl bg-input px-3 text-foreground",
                AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
              )}
            />
          </div>

          <AutomationEditScheduleField
            builder={builder}
            clearRequiredFieldValidation={clearRequiredFieldValidation}
            customRepeatOpen={customRepeatOpen}
            editing={editing}
            endAt={endAt}
            handleRemoveSchedule={handleRemoveSchedule}
            intl={intl}
            markFieldTouched={markFieldTouched}
            preserveSessionCreatedSchedule={preserveSessionCreatedSchedule}
            schedulePreview={schedulePreview}
            scheduleRemoved={scheduleRemoved}
            setBuilder={setBuilder}
            setCustomRepeatOpen={setCustomRepeatOpen}
            setEndAt={setEndAt}
            setScheduleRemoved={setScheduleRemoved}
            validationErrors={validationErrors}
          />

          <AutomationEditInstructionsField
            editing={editing}
            handleModelValueChange={handleModelValueChange}
            handlePromptValueChange={handlePromptValueChange}
            handleSelectProject={handleSelectProject}
            intl={intl}
            isSelectedConversationWorkspace={isSelectedConversationWorkspace}
            modeOption={modeOption}
            modelSelectGroups={modelSelectGroups}
            modelSelectionRead={modelSelectionRead}
            modelTriggerLabel={modelTriggerLabel}
            modelValue={modelValue}
            onManageModels={onManageModels}
            onModeValueChange={handleModeValueChange}
            onThoughtLevelValueChange={handleThoughtLevelValueChange}
            prompt={prompt}
            selectedWorkspaceDisplayLabel={selectedWorkspaceDisplayLabel}
            thoughtLevelOption={thoughtLevelOption}
            thoughtTriggerRef={thoughtTriggerRef}
            validationErrors={validationErrors}
            workspaceKey={workspaceKey}
            workspaceOptions={workspaceOptions}
          />
        </form>
      ) : (
        <AutomationEditRunsHistory
          intl={intl}
          onDeleteRun={onDeleteRun}
          onOpenSession={onOpenSession}
          runsEntry={runsEntry}
          runsPage={runsPage}
          setRunsPage={setRunsPage}
        />
      )}
    </div>
  );
}
