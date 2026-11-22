import { Loader2Icon, RefreshCw } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ImportSelectionList } from "./ImportSelectionList.js";
import {
  ImportModeSelect,
  ImportTargetScopeSelect,
  SourceScopeSelect,
} from "./ImportScopeControls.js";
import type { ExternalAgentImportCategoryState, ImportResourceCategory } from "./types.js";

/** onboarding 内嵌的选择面板：与弹窗共用同一份类别状态机。 */
export function ExternalAgentImportSelectionPanel({
  category,
  state,
  workspacePath,
}: {
  category: ImportResourceCategory;
  state: ExternalAgentImportCategoryState;
  workspacePath: string | null | undefined;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: `settings.${category}.import.summary` },
            { count: String(state.totalImportableCount) },
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SourceScopeSelect
            category={category}
            activeScope={state.activeScope}
            onActiveScopeChange={state.setActiveSourceScope}
          />
          <ControlHintTooltip title={intl.formatMessage({ id: "settingsSync.action.rescan" })}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "settingsSync.action.rescan" })}
              onClick={() => void state.loadDiscovery()}
              disabled={state.loading}
            >
              <RefreshCw className="size-3" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
        <div className="h-full overflow-auto p-3">
          {state.error ? (
            <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
              {state.error}
            </div>
          ) : null}
          {state.loading ? (
            <div className="flex h-full min-h-48 items-center justify-center gap-2 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
              <Loader2Icon className="size-4 animate-spin" />
              {intl.formatMessage({ id: `settings.${category}.import.scanning` })}
            </div>
          ) : state.discovery && state.discovery.agents.length > 0 ? (
            <ImportSelectionList
              category={category}
              discovery={state.discovery}
              workspacePath={workspacePath}
              activeScope={state.activeScope}
              selectedKeys={state.selectedKeys}
              expandedSourceKeys={state.expandedSourceKeys}
              onToggleSelection={state.toggleSelection}
              onSetResourceSelection={state.setResourceSelection}
              onToggleExpanded={state.toggleExpanded}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: `settings.${category}.import.empty` })}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: `settings.${category}.import.selectionCount` },
            {
              selected: String(state.selectedCount),
              total: String(state.totalImportableCount),
            },
          )}
        </div>
        <div className="flex items-center gap-3">
          {category !== "mcpServers" ? (
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
              </span>
              <ImportModeSelect
                category={category}
                importMode={state.importMode}
                onImportModeChange={state.setImportMode}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
            </span>
            <ImportTargetScopeSelect
              category={category}
              targetScope={state.importTargetScope}
              workspacePath={workspacePath}
              onTargetScopeChange={state.setImportTargetScope}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
