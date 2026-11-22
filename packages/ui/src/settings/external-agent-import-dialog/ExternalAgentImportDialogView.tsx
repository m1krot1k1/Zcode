import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2Icon, RefreshCw } from "lucide-react";
import type { SettingsSyncImportResult, SettingsSyncSourceScope } from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Progress } from "@/components/ui/progress.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getImportResults, normalizeError } from "./discovery.js";
import {
  ImportModeSelect,
  ImportTargetDropdownButton,
  SourceScopeSelect,
} from "./ImportScopeControls.js";
import { ImportResultList, ImportStatsSummary } from "./ImportResultList.js";
import { ImportSelectionList } from "./ImportSelectionList.js";
import { buildExternalAgentImportSelections } from "./selectionKeys.js";
import type {
  CategorizedExternalAgentImportDialogProps,
  ExternalAgentImportDialogProps,
  ImportStep,
} from "./types.js";
import { useExternalAgentImportCategoryState } from "./useExternalAgentImportCategoryState.js";

export function ExternalAgentImportDialogView({
  category,
  open,
  workspacePath,
  workspaceIdentity,
  settingsSyncService,
  onOpenChange,
  onImported,
}: CategorizedExternalAgentImportDialogProps) {
  const { intl } = useZCodeIntl();
  const [step, setStep] = useState<ImportStep>("selection");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<SettingsSyncImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importState = useExternalAgentImportCategoryState({
    category,
    enabled: open,
    settingsSyncService,
    workspacePath,
    workspaceIdentity,
  });
  const {
    activeScope,
    discovery,
    error,
    expandedSourceKeys,
    importMode,
    importTargetScope,
    loading,
    selectedCount,
    selectedKeys,
    totalImportableCount,
  } = importState;

  const importProgress = step === "complete" ? 100 : importing ? 62 : 0;
  const importedResults = useMemo(() => getImportResults(result, category), [category, result]);
  const displayError = error ?? importError;

  useEffect(() => {
    if (!open) {
      return;
    }
    setResult(null);
    setImportError(null);
    setStep("selection");
  }, [open]);

  const startImport = useCallback(
    async (targetScope: SettingsSyncSourceScope) => {
      if (selectedKeys.length === 0) {
        return;
      }
      setImporting(true);
      setStep("importing");
      setImportError(null);
      try {
        logger.debug("[ExternalAgentImportDialog] import start", {
          category,
          targetScope,
          importMode,
          selectedCount: selectedKeys.length,
        });
        const importResult = await settingsSyncService.importSelected({
          workspacePath: workspacePath ?? undefined,
          workspaceIdentity,
          selections: buildExternalAgentImportSelections(selectedKeys, targetScope, importMode),
        });
        setResult(importResult);
        setStep("complete");
        await onImported();
      } catch (importError) {
        const message = normalizeError(importError);
        logger.error("[ExternalAgentImportDialog] import failed", { category, error: message });
        setImportError(message);
        setStep("selection");
      } finally {
        setImporting(false);
      }
    },
    [
      onImported,
      category,
      importMode,
      selectedKeys,
      settingsSyncService,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const closeLabel =
    step === "complete"
      ? intl.formatMessage({ id: `settings.${category}.import.finish` })
      : intl.formatMessage({ id: "settingsSync.action.skip" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(84vh,640px)] max-h-[calc(100vh-2rem)] max-w-2xl overflow-hidden rounded-2xl p-0">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-5">
            <DialogHeader className="shrink-0 sm:-mt-1">
              <div className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center sm:justify-between">
                <DialogTitle className="flex min-w-0 items-center text-ui-lg">
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({ id: `settings.${category}.import.title` })}
                  </span>
                </DialogTitle>
                {step === "selection" && !loading && discovery?.agents.length ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <SourceScopeSelect
                      category={category}
                      activeScope={activeScope}
                      onActiveScopeChange={importState.setActiveSourceScope}
                    />
                    <ControlHintTooltip
                      title={intl.formatMessage({ id: "settingsSync.action.rescan" })}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={intl.formatMessage({ id: "settingsSync.action.rescan" })}
                        onClick={() => void importState.loadDiscovery()}
                        disabled={loading}
                      >
                        <RefreshCw className="size-3" aria-hidden="true" />
                      </Button>
                    </ControlHintTooltip>
                  </div>
                ) : null}
              </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
              <div className="h-full overflow-auto p-3">
                {displayError ? (
                  <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
                    {displayError}
                  </div>
                ) : null}

                {loading ? (
                  <div className="flex h-full min-h-48 items-center justify-center gap-2 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
                    <Loader2Icon className="size-4 animate-spin" />
                    {intl.formatMessage({ id: `settings.${category}.import.scanning` })}
                  </div>
                ) : step === "importing" ? (
                  <div className="space-y-4 rounded-lg bg-surface px-4 py-5">
                    <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
                      <span>
                        {intl.formatMessage({ id: `settings.${category}.import.importing` })}
                      </span>
                      <span>{importProgress}%</span>
                    </div>
                    <Progress value={importProgress} className="h-2 rounded-full bg-background" />
                  </div>
                ) : step === "complete" ? (
                  <div className="space-y-4">
                    <ImportStatsSummary category={category} result={result} />
                    <ImportResultList category={category} results={importedResults} />
                  </div>
                ) : discovery && discovery.agents.length > 0 ? (
                  <ImportSelectionList
                    category={category}
                    discovery={discovery}
                    workspacePath={workspacePath}
                    activeScope={activeScope}
                    selectedKeys={selectedKeys}
                    expandedSourceKeys={expandedSourceKeys}
                    onToggleSelection={importState.toggleSelection}
                    onSetResourceSelection={importState.setResourceSelection}
                    onToggleExpanded={importState.toggleExpanded}
                  />
                ) : (
                  <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: `settings.${category}.import.empty` })}
                  </div>
                )}
              </div>
            </div>

            <div
              className={cn(
                "flex shrink-0 flex-wrap items-center gap-3",
                step === "complete" ? "justify-end" : "justify-between",
              )}
            >
              {step === "complete" ? null : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="text-ui-base text-foreground-subtle">
                    {intl.formatMessage(
                      { id: `settings.${category}.import.summary` },
                      { count: String(totalImportableCount) },
                    )}
                  </div>
                  {step === "selection" && category !== "mcpServers" ? (
                    <ImportModeSelect
                      category={category}
                      importMode={importMode}
                      onImportModeChange={importState.setImportMode}
                    />
                  ) : null}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {step === "complete" ? (
                  <Button type="button" size="lg" onClick={() => onOpenChange(false)}>
                    {closeLabel}
                  </Button>
                ) : null}
                {step === "selection" ? (
                  <ImportTargetDropdownButton
                    category={category}
                    targetScope={importTargetScope}
                    disabled={selectedCount === 0 || loading}
                    workspacePath={workspacePath}
                    onTargetScopeChange={importState.setImportTargetScope}
                    onImport={(targetScope) => void startImport(targetScope)}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SkillsImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialogView {...props} category="skills" />;
}

export function CommandsImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialogView {...props} category="commands" />;
}

export function McpServersImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialogView {...props} category="mcpServers" />;
}
