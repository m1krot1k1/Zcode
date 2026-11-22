import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import type { ZCodeAutomation } from "@zcode/shared";
import { TID_AUTOMATION_FORM_SUBMIT, TID_AUTOMATION_RUN_NOW } from "@zcode/shared/test-ids";
import {
  AutomationContinueIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationRunNowIcon,
  AutomationSettingsHistoryTabs,
  AutomationTrashIcon,
  type AutomationSettingsHistoryTab,
} from "@/settings/AutomationDesignPrimitives.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface AutomationEditHeaderProps {
  canSubmit: boolean;
  editing: ZCodeAutomation | null;
  handleBackClick: () => void;
  handleSaveAndRun: () => Promise<void>;
  handleTabChange: (nextTab: AutomationSettingsHistoryTab) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onDelete?: (automation: ZCodeAutomation) => void;
  onRunNow?: (automation: ZCodeAutomation) => Promise<void> | void;
  onToggle?: (automation: ZCodeAutomation, enabled: boolean) => void;
  saveAndRunPending: boolean;
  saving: boolean;
  showCreateSettingsAction: boolean;
  showEditingSettingsActions: boolean;
  submissionContextReady: boolean;
  tab: AutomationSettingsHistoryTab;
}

export function AutomationEditHeader({
  canSubmit,
  editing,
  handleBackClick,
  handleSaveAndRun,
  handleTabChange,
  intl,
  onDelete,
  onRunNow,
  onToggle,
  saveAndRunPending,
  saving,
  showCreateSettingsAction,
  showEditingSettingsActions,
  submissionContextReady,
  tab,
}: AutomationEditHeaderProps) {
  return (
    <>
      <SettingsBreadcrumbReporter
        items={[
          {
            label: editing?.title ?? intl.formatMessage({ id: "automations.edit.newTask" }),
          },
        ]}
        onSectionSelect={() => void handleBackClick()}
      />

      <div className="space-y-1.5">
        <h1
          data-testid="automation-edit-title"
          className="text-ui-xl font-semibold text-foreground"
        >
          {intl.formatMessage({
            id: editing ? "automations.form.editTitle" : "automations.form.createTitle",
          })}
        </h1>
        <p data-testid="automation-edit-subtitle" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: editing ? "automations.edit.editSubtitle" : "automations.edit.createSubtitle",
          })}
        </p>
      </div>

      {/* tab + 右侧操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AutomationSettingsHistoryTabs
          value={tab}
          settingsLabel={intl.formatMessage({
            id: "automations.edit.tab.settings",
          })}
          historyLabel={intl.formatMessage({
            id: "automations.edit.tab.history",
          })}
          onValueChange={handleTabChange}
        />

        <div className="flex items-center gap-1.5">
          {editing ? (
            <>
              {showEditingSettingsActions ? (
                <button
                  type="submit"
                  form="automation-edit-form"
                  data-testid={TID_AUTOMATION_FORM_SUBMIT}
                  className="inline-flex h-8 items-center rounded-lg border-0 bg-white px-3 text-ui-base font-medium text-black shadow-none outline-none transition-colors hover:bg-white/90 focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-40"
                  disabled={!submissionContextReady || saving}
                >
                  {intl.formatMessage({
                    id: saving ? "automations.form.saving" : "automations.form.save",
                  })}
                </button>
              ) : null}
              {showEditingSettingsActions && onRunNow ? (
                <button
                  type="button"
                  data-testid={TID_AUTOMATION_RUN_NOW}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border-0 bg-white/[0.06] px-3 text-ui-base font-medium text-foreground shadow-none outline-none transition-colors hover:bg-white/10 focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-foreground-subtlest disabled:opacity-40"
                  disabled={!submissionContextReady || saving || saveAndRunPending}
                  onClick={() => void handleSaveAndRun()}
                >
                  <AutomationRunNowIcon className="size-4" aria-hidden="true" />
                  {intl.formatMessage({ id: "automations.runNow" })}
                </button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={intl.formatMessage({
                      id: "automations.moreActions",
                    })}
                    className="flex size-8 items-center justify-center rounded-lg border-0 bg-white/[0.06] text-foreground-subtle shadow-none outline-none transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground focus-visible:ring-0"
                  >
                    <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px]">
                  {/* 终态任务(completed/failed)不展示 pause/resume：Resume 对终态无意义，改存即复活。 */}
                  {onToggle &&
                  editing.lifecycleStatus !== "completed" &&
                  editing.lifecycleStatus !== "failed" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      onSelect={() => onToggle(editing, !editing.enabled)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        {editing.enabled ? (
                          <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                        ) : (
                          <AutomationContinueIcon className="size-4" aria-hidden="true" />
                        )}
                      </span>
                      {intl.formatMessage({
                        id: editing.enabled ? "automations.pause" : "automations.resume",
                      })}
                    </DropdownMenuItem>
                  ) : null}
                  {onDelete ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                        onSelect={() => onDelete(editing)}
                      >
                        <AutomationTrashIcon />
                        {intl.formatMessage({ id: "automations.delete" })}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : showCreateSettingsAction ? (
            <Button
              type="submit"
              form="automation-edit-form"
              variant="default"
              size="lg"
              data-testid={TID_AUTOMATION_FORM_SUBMIT}
              disabled={!canSubmit || saving}
            >
              {intl.formatMessage({
                id: saving ? "automations.form.saving" : "automations.edit.createButton",
              })}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}
