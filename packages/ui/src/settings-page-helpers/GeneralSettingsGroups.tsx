/**
 * 通用设置页的基础分组：语言、界面模式、终端、工作区边界/工具检索、运行上限、
 * 数据目录与引导入口。
 *
 * 从 `GeneralSectionContent` 内联的 SettingsGroupCard 原样拆出；卡片顺序、
 * 文案 key、test id、禁用条件与 DOM 结构保持不变。
 */
import type { AppToolSearchMode, LocalePreference } from "@zcode/shared";
import { appToolSearchModeSchema } from "@zcode/shared";
import {
  TID_SETTINGS_NATIVE_SEARCH_SWITCH,
  TID_SETTINGS_TOOL_SEARCH_OPTION,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { normalizeInterfaceMode, type InterfaceMode } from "@/lib/interfaceMode.js";
import { DataBaseDirControl } from "@/settings/DataBaseDirControl.js";
import { ProactiveSuggestionsSetting } from "@/settings/ProactiveSuggestionsSetting.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { RunLimitSettingRow } from "@/settings-page-helpers/RunLimitSettingRow.js";
import type { RunLimitSaveResult } from "@/settings-page-helpers/RunLimitSettingRow.js";
import type { TerminalSettingsController } from "@/settings-page-helpers/useTerminalSettings.js";

export function GeneralLocaleSettingsGroup({
  localePreference,
  setLocalePreference,
}: {
  localePreference: LocalePreference;
  setLocalePreference: (locale: LocalePreference) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.locale" })}
        description={intl.formatMessage({ id: "settings.localeDescription" })}
        control={
          <Select
            value={localePreference}
            onValueChange={(value) => setLocalePreference(value as LocalePreference)}
          >
            <SelectTrigger
              size="lg"
              className="w-[260px] min-w-0 justify-between"
              data-testid={TID_SETTINGS_LOCALE_SELECT_TRIGGER}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value="system"
                data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "system")}
              >
                {intl.formatMessage({ id: "settings.locale.system" })}
              </SelectItem>
              <SelectItem
                value="zh-CN"
                data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "zh-CN")}
              >
                {intl.formatMessage({ id: "settings.locale.zh-CN" })}
              </SelectItem>
              <SelectItem
                value="en-US"
                data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "en-US")}
              >
                {intl.formatMessage({ id: "settings.locale.en-US" })}
              </SelectItem>
              <SelectItem
                value="ru-RU"
                data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "ru-RU")}
              >
                {intl.formatMessage({ id: "settings.locale.ru-RU" })}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}

export function InterfaceModeSettingsGroup({
  interfaceMode,
  setInterfaceMode,
  hasServices,
}: {
  interfaceMode: InterfaceMode;
  setInterfaceMode: (mode: InterfaceMode) => void;
  hasServices: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.interfaceMode" })}
        description={intl.formatMessage({
          id: "settings.interfaceMode.description",
        })}
        control={
          <Select
            value={interfaceMode}
            onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
          >
            <SelectTrigger
              size="lg"
              className="w-full min-w-0 sm:w-64"
              aria-label={intl.formatMessage({
                id: "settings.interfaceMode",
              })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="coding">
                {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
              </SelectItem>
              <SelectItem value="office">
                {intl.formatMessage({ id: "settings.interfaceMode.office" })}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {hasServices ? <ProactiveSuggestionsSetting /> : null}
    </SettingsGroupCard>
  );
}

export function TerminalSettingsGroup({
  terminalInheritSystemProfile,
  onTerminalInheritSystemProfileChange,
  terminal,
}: {
  terminalInheritSystemProfile: boolean;
  onTerminalInheritSystemProfileChange: (enabled: boolean) => Promise<void>;
  terminal: TerminalSettingsController;
}) {
  const { intl } = useZCodeIntl();
  const {
    localTerminalFontFamily,
    setLocalTerminalFontFamily,
    isTerminalFontFamilyDirty,
    handleTerminalFontFamilySave,
  } = terminal;
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.terminalProfile" })}
        description={intl.formatMessage({
          id: "settings.terminalProfileDescription",
        })}
        control={
          <Switch
            checked={terminalInheritSystemProfile}
            onCheckedChange={(checked) => {
              void onTerminalInheritSystemProfileChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.terminalFontFamily" })}
        description={intl.formatMessage({
          id: "settings.terminalFontFamilyDescription",
        })}
        control={
          <Button
            type="button"
            size="lg"
            disabled={!isTerminalFontFamilyDirty}
            onClick={() => void handleTerminalFontFamilySave()}
          >
            {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
          </Button>
        }
        detail={
          <Input
            size="lg"
            value={localTerminalFontFamily}
            placeholder={intl.formatMessage({
              id: "settings.terminalFontFamilyPlaceholder",
            })}
            onChange={(event) => {
              setLocalTerminalFontFamily(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isTerminalFontFamilyDirty) {
                void handleTerminalFontFamilySave();
              }
            }}
            className="max-w-[520px] font-mono"
          />
        }
      />
    </SettingsGroupCard>
  );
}

export function TerminalAndToolsSettingsGroup({
  showIntegratedTerminalShell,
  terminal,
  workspaceBoundary,
  onWorkspaceBoundaryChange,
  toolSearchMode,
  onToolSearchModeChange,
  nativeSearchEnhancementsEnabled,
  onNativeSearchEnhancementsEnabledChange,
}: {
  showIntegratedTerminalShell: boolean;
  terminal: TerminalSettingsController;
  workspaceBoundary: "strict" | "ask" | "allow";
  onWorkspaceBoundaryChange: (mode: "strict" | "ask" | "allow") => void;
  toolSearchMode: AppToolSearchMode;
  onToolSearchModeChange: (mode: AppToolSearchMode) => Promise<void>;
  nativeSearchEnhancementsEnabled: boolean;
  onNativeSearchEnhancementsEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const {
    integratedTerminalShellValue,
    visibleIntegratedTerminalShellOptions,
    handleIntegratedTerminalShellChange,
  } = terminal;
  return (
    <SettingsGroupCard>
      {showIntegratedTerminalShell ? (
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.integratedTerminalShell",
          })}
          description={intl.formatMessage({
            id: "settings.integratedTerminalShellDescription",
          })}
          control={
            <Select
              value={integratedTerminalShellValue}
              onValueChange={(value) => {
                void handleIntegratedTerminalShellChange(value);
              }}
            >
              <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {intl.formatMessage({
                    id: "settings.integratedTerminalShell.auto",
                  })}
                </SelectItem>
                {visibleIntegratedTerminalShellOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      ) : null}
      <SettingsRow
        label={intl.formatMessage({ id: "settings.workspaceBoundary" })}
        description={intl.formatMessage({
          id: "settings.workspaceBoundaryDescription",
        })}
        control={
          <Select
            value={workspaceBoundary}
            onValueChange={(value) => {
              if (value === "strict" || value === "ask" || value === "allow") {
                onWorkspaceBoundaryChange(value);
              }
            }}
          >
            <SelectTrigger size="lg" className="w-[220px] min-w-0 justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["strict", "ask", "allow"] as const).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {intl.formatMessage({ id: `settings.workspaceBoundary.${mode}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.toolSearch" })}
        description={intl.formatMessage({
          id: "settings.toolSearchDescription",
        })}
        detail={
          <p className="text-ui-sm leading-5 text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.toolSearchExperimentalNotice",
            })}
          </p>
        }
        control={
          <Select
            value={toolSearchMode}
            onValueChange={(value) => {
              void onToolSearchModeChange(appToolSearchModeSchema.parse(value));
            }}
          >
            <SelectTrigger
              size="lg"
              className="w-[260px] min-w-0 justify-between"
              data-testid={TID_SETTINGS_TOOL_SEARCH_SELECT}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {appToolSearchModeSchema.options.map((mode) => (
                <SelectItem
                  key={mode}
                  value={mode}
                  data-testid={testId(TID_SETTINGS_TOOL_SEARCH_OPTION, mode)}
                >
                  {intl.formatMessage({ id: `settings.toolSearch.${mode}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={intl.formatMessage({
          id: "settings.nativeSearchEnhancements",
        })}
        description={intl.formatMessage({
          id: "settings.nativeSearchEnhancementsDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.nativeSearchEnhancements",
            })}
            checked={nativeSearchEnhancementsEnabled}
            data-testid={TID_SETTINGS_NATIVE_SEARCH_SWITCH}
            onCheckedChange={(checked) => {
              void onNativeSearchEnhancementsEnabledChange(checked);
            }}
          />
        }
      />
    </SettingsGroupCard>
  );
}

export function RunLimitsSettingsGroup({
  subagentMaxParallel,
  onSubagentMaxParallelChange,
  subagentTaskTimeoutMinutes,
  onSubagentTaskTimeoutMinutesChange,
}: {
  subagentMaxParallel?: number;
  onSubagentMaxParallelChange: (raw: string) => Promise<RunLimitSaveResult>;
  subagentTaskTimeoutMinutes?: number;
  onSubagentTaskTimeoutMinutesChange: (raw: string) => Promise<RunLimitSaveResult>;
}) {
  const { intl } = useZCodeIntl();
  return (
    // 并行度只是可选的更低上限；0/空值使用主机可用并行度。
    <SettingsGroupCard>
      <RunLimitSettingRow
        labelId="settings.subagentMaxParallel"
        descriptionId="settings.subagentMaxParallelDescription"
        invalidId="settings.subagentMaxParallelInvalid"
        placeholder={intl.formatMessage({ id: "settings.runLimitPlaceholder" })}
        testId="settings-subagent-max-parallel"
        value={subagentMaxParallel}
        onSave={onSubagentMaxParallelChange}
      />
      <RunLimitSettingRow
        labelId="settings.subagentTaskTimeoutMinutes"
        descriptionId="settings.subagentTaskTimeoutMinutesDescription"
        invalidId="settings.subagentTaskTimeoutMinutesInvalid"
        placeholder={intl.formatMessage({ id: "settings.runLimitPlaceholder" })}
        testId="settings-subagent-task-timeout"
        value={subagentTaskTimeoutMinutes}
        onSave={onSubagentTaskTimeoutMinutesChange}
      />
    </SettingsGroupCard>
  );
}

export function DataBaseDirSettingsGroup({
  dataBaseDir,
  defaultHomeDir,
  onDataBaseDirChange,
  onSelectDataBaseDir,
}: {
  dataBaseDir: string;
  defaultHomeDir: string;
  onDataBaseDirChange: (dir: string) => Promise<void>;
  onSelectDataBaseDir: () => Promise<string | null>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.dataBaseDir" })}
        description={intl.formatMessage({
          id: "settings.dataBaseDirDescription",
        })}
        control={
          <DataBaseDirControl
            dataBaseDir={dataBaseDir}
            defaultHomeDir={defaultHomeDir}
            onDataBaseDirChange={onDataBaseDirChange}
            onSelectDataBaseDir={onSelectDataBaseDir}
          />
        }
      />
    </SettingsGroupCard>
  );
}

export function OnboardingSettingsGroup({
  onOpenOnboardingDialog,
}: {
  onOpenOnboardingDialog: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.onboarding" })}
        description={intl.formatMessage({
          id: "settings.onboardingDescription",
        })}
        control={
          <Button type="button" size="lg" variant="outline" onClick={onOpenOnboardingDialog}>
            {intl.formatMessage({ id: "settings.onboardingOpen" })}
          </Button>
        }
      />
    </SettingsGroupCard>
  );
}
