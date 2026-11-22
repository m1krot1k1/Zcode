import { useEffect, useRef, useState } from "react";
import { AlertCircleIcon, Cable } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { summarizeLocalPluginOptionsForDisplay } from "@/settings/remote-plugin-sync-dialog/candidateRows.js";
import type { RemotePluginSyncRow } from "@/settings/remote-plugin-sync-dialog/types.js";

export function RemotePluginSyncTitle() {
  const { intl } = useZCodeIntl();
  const [warningTooltipOpen, setWarningTooltipOpen] = useState(false);
  const warningTitle = intl.formatMessage({
    id: "settings.plugins.remoteSync.warningTitle",
  });

  return (
    <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.title" })}
      </span>
      <ControlHintTooltip
        open={warningTooltipOpen}
        title={warningTitle}
        description={intl.formatMessage({
          id: "settings.plugins.remoteSync.warningDescription",
        })}
        side="right"
        align="center"
      >
        <span
          aria-label={warningTitle}
          className="inline-flex size-5 items-center justify-center rounded-full text-warning transition-colors hover:bg-hover hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onMouseEnter={() => setWarningTooltipOpen(true)}
          onMouseLeave={() => setWarningTooltipOpen(false)}
          role="img"
        >
          <AlertCircleIcon className="size-3.5" aria-hidden="true" />
        </span>
      </ControlHintTooltip>
    </DialogTitle>
  );
}

function RemotePluginSyncExistingFilterCheckbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <label className="inline-flex h-6 cursor-pointer items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle hover:text-foreground">
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      />
      <span>{intl.formatMessage({ id: "settings.plugins.remoteSync.showExisting" })}</span>
    </label>
  );
}

export function RemotePluginSyncTargetRow({
  targetLabel,
  showExistingRemotePlugins,
  showExistingFilter,
  onShowExistingRemotePluginsChange,
}: {
  targetLabel: string;
  showExistingRemotePlugins: boolean;
  showExistingFilter: boolean;
  onShowExistingRemotePluginsChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words font-mono text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.target" }, { target: targetLabel })}
      </p>
      {showExistingFilter ? (
        <div className="shrink-0">
          <RemotePluginSyncExistingFilterCheckbox
            checked={showExistingRemotePlugins}
            onCheckedChange={onShowExistingRemotePluginsChange}
          />
        </div>
      ) : null}
    </div>
  );
}

export function RemotePluginSyncBulkSelectionCheckbox({
  selectedCount,
  totalSelectable,
  onSelectAll,
  onClearAll,
}: {
  selectedCount: number;
  totalSelectable: number;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const { intl } = useZCodeIntl();
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = totalSelectable === 0;
  const checked = totalSelectable > 0 && selectedCount >= totalSelectable;
  const indeterminate = totalSelectable > 0 && selectedCount > 0 && selectedCount < totalSelectable;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label
      className={`inline-flex h-6 items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle ${
        disabled ? "opacity-50" : "cursor-pointer hover:text-foreground"
      }`}
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="size-4"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : checked ? "true" : "false"}
        onChange={(event) => {
          if (event.currentTarget.checked) {
            onSelectAll();
          } else {
            onClearAll();
          }
        }}
      />
      <span>{intl.formatMessage({ id: "settings.plugins.remoteSync.selectAll" })}</span>
    </label>
  );
}

export function RemotePluginSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId = "settings.plugins.remoteSync.empty",
  onToggle,
}: {
  rows: readonly RemotePluginSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (pluginId: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: emptyMessageId })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const checkboxId = `remote-plugin-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const selected = !row.exists && selectedIds.has(row.candidate.id);
        const optionSummary = summarizeLocalPluginOptionsForDisplay(row.candidate.pluginOptions);
        return (
          <label
            key={row.candidate.id}
            htmlFor={checkboxId}
            className={`grid grid-cols-[auto_auto_minmax(0,1fr)] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base ${
              row.exists
                ? "cursor-default"
                : "cursor-pointer hover:border-border-hover hover:bg-surface-hover"
            }`}
          >
            <input
              id={checkboxId}
              type="checkbox"
              aria-labelledby={labelId}
              className="mt-1 size-4"
              checked={selected}
              disabled={row.exists}
              onChange={(event) => onToggle(row.candidate.id, event.currentTarget.checked)}
            />
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Cable className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span id={labelId} className="font-medium text-foreground">
                  {row.candidate.name}
                </span>
                {row.candidate.version ? (
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                    {row.candidate.version}
                  </span>
                ) : null}
                {row.candidate.componentTypes.map((type) => (
                  <span
                    key={type}
                    className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle"
                  >
                    {type}
                  </span>
                ))}
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {row.candidate.kind === "inline" ? "inline" : row.candidate.marketplace}
                </span>
                {row.exists ? (
                  <span className="text-ui-base text-foreground-subtlest">
                    {intl.formatMessage({ id: "settings.plugins.remoteSync.existing" })}
                  </span>
                ) : null}
              </span>
              {row.candidate.description ? (
                <span className="mt-1 block text-ui-base text-foreground-subtle">
                  {row.candidate.description}
                </span>
              ) : null}
              {row.candidate.path ? (
                <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                  {row.candidate.path}
                </span>
              ) : null}
              {optionSummary ? (
                <span className="mt-1 block text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.remoteSync.optionsSummary" },
                    {
                      manual: String(optionSummary.manualCount),
                      syncable: String(optionSummary.syncableCount),
                    },
                  )}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
