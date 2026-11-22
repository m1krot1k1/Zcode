import { AlertCircleIcon, ChevronDown } from "lucide-react";
import type { SettingsSyncImportMode, SettingsSyncSourceScope } from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { IMPORT_MODE_ORDER, formatSourceRootScope, SOURCE_ROOT_SCOPE_ORDER } from "./discovery.js";
import type { ImportResourceCategory } from "./types.js";

const SELECT_TRIGGER_CLASS =
  "w-fit shrink-0 justify-end border-border bg-surface text-right font-medium text-foreground hover:bg-surface-hover hover:text-foreground aria-expanded:bg-selected *:data-[slot=select-value]:justify-end";

export function ImportModeSelect({
  category,
  importMode,
  onImportModeChange,
}: {
  category: ImportResourceCategory;
  importMode: SettingsSyncImportMode;
  onImportModeChange: (importMode: SettingsSyncImportMode) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex items-center gap-1 text-ui-base text-foreground-subtle">
      <Select
        value={importMode}
        onValueChange={(nextMode) => {
          onImportModeChange(nextMode as SettingsSyncImportMode);
        }}
      >
        <SelectTrigger
          size="sm"
          variant="ghost"
          aria-label={intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
          className={SELECT_TRIGGER_CLASS}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {IMPORT_MODE_ORDER.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {intl.formatMessage({ id: `settings.${category}.import.mode.${mode}` })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ControlHintTooltip
        title={intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
        description={intl.formatMessage({
          id:
            importMode === "symlink"
              ? `settings.${category}.import.mode.symlink.description`
              : `settings.${category}.import.mode.copy.description`,
        })}
        side="top"
        align="start"
      >
        <span
          role="img"
          aria-label={intl.formatMessage({ id: `settings.${category}.import.modeHelp` })}
          className="inline-flex size-4 items-center justify-center rounded-full text-foreground-subtlest hover:bg-hover hover:text-foreground"
        >
          <AlertCircleIcon className="size-3" aria-hidden="true" />
        </span>
      </ControlHintTooltip>
    </div>
  );
}

export function ImportTargetDropdownButton({
  category,
  targetScope,
  disabled,
  workspacePath,
  onTargetScopeChange,
  onImport,
}: {
  category: ImportResourceCategory;
  targetScope: SettingsSyncSourceScope;
  disabled: boolean;
  workspacePath: string | null | undefined;
  onTargetScopeChange: (targetScope: SettingsSyncSourceScope) => void;
  onImport: (targetScope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  const hasWorkspaceTarget = Boolean(workspacePath);
  const canImportToTarget = targetScope === "global" || hasWorkspaceTarget;
  const activeTargetLabelId =
    targetScope === "project"
      ? `settings.${category}.import.target.project`
      : `settings.${category}.import.target.global`;
  return (
    <div className="flex items-center">
      <Button
        type="button"
        size="lg"
        disabled={disabled || !canImportToTarget}
        aria-label={intl.formatMessage({ id: activeTargetLabelId })}
        className="rounded-r-none border-r-0"
        onClick={() => onImport(targetScope)}
      >
        {intl.formatMessage({ id: activeTargetLabelId })}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="lg"
            className="rounded-l-none border-l-0 px-2"
            disabled={disabled}
            aria-label={intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => onTargetScopeChange("global")}>
            {intl.formatMessage({ id: `settings.${category}.import.target.global` })}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasWorkspaceTarget}
            onSelect={() => onTargetScopeChange("project")}
          >
            {intl.formatMessage({ id: `settings.${category}.import.target.project` })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ImportTargetScopeSelect({
  category,
  targetScope,
  workspacePath,
  onTargetScopeChange,
}: {
  category: ImportResourceCategory;
  targetScope: SettingsSyncSourceScope;
  workspacePath: string | null | undefined;
  onTargetScopeChange: (targetScope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  const hasWorkspaceTarget = Boolean(workspacePath);
  return (
    <Select
      value={targetScope}
      onValueChange={(nextScope) => {
        onTargetScopeChange(nextScope as SettingsSyncSourceScope);
      }}
    >
      <SelectTrigger
        size="sm"
        variant="ghost"
        aria-label={intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
        className={SELECT_TRIGGER_CLASS}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="global">
          {intl.formatMessage({ id: `settings.${category}.import.scope.global` })}
        </SelectItem>
        <SelectItem value="project" disabled={!hasWorkspaceTarget}>
          {intl.formatMessage({ id: `settings.${category}.import.scope.project` })}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

export function SourceScopeSelect({
  category,
  activeScope,
  onActiveScopeChange,
}: {
  category: ImportResourceCategory;
  activeScope: SettingsSyncSourceScope;
  onActiveScopeChange: (scope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Select
      value={activeScope}
      onValueChange={(nextScope) => {
        onActiveScopeChange(nextScope as SettingsSyncSourceScope);
      }}
    >
      <SelectTrigger
        size="sm"
        variant="ghost"
        aria-label={intl.formatMessage({ id: `settings.${category}.import.scopeLabel` })}
        className="w-fit shrink-0 justify-end text-right text-foreground-subtle hover:text-foreground *:data-[slot=select-value]:justify-end"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {SOURCE_ROOT_SCOPE_ORDER.map((scope) => (
          <SelectItem key={scope} value={scope}>
            {formatSourceRootScope(scope, intl, category)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
