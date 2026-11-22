import { Loader2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import {
  RemotePluginSyncBulkSelectionCheckbox,
  RemotePluginSyncSelectionList,
  RemotePluginSyncTargetRow,
  RemotePluginSyncTitle,
} from "@/settings/remote-plugin-sync-dialog/RemotePluginSyncDialogParts.js";
import {
  RemotePluginSyncProgressList,
  RemotePluginSyncResultList,
} from "@/settings/remote-plugin-sync-dialog/RemotePluginSyncProgressParts.js";
import type { RemotePluginSyncDialogProps } from "@/settings/remote-plugin-sync-dialog/types.js";
import { useRemotePluginSyncDialog } from "@/settings/remote-plugin-sync-dialog/useRemotePluginSyncDialog.js";

export function RemotePluginSyncDialog(props: RemotePluginSyncDialogProps) {
  const {
    error,
    handleOpenChange,
    importResult,
    intl,
    rows,
    selectedCount,
    selectedIds,
    setSelectedIds,
    setShowExistingRemotePlugins,
    showExistingRemotePlugins,
    step,
    stopPluginSync,
    syncProgressById,
    syncRows,
    syncSelected,
    targetLabel,
    togglePlugin,
    visibleMissingIds,
    visibleRows,
  } = useRemotePluginSyncDialog(props);

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={step !== "preflighting" && step !== "syncing"}
        className="h-[min(720px,calc(100dvh-2rem))] max-h-[min(720px,calc(100dvh-2rem))] max-w-2xl flex flex-col overflow-hidden"
      >
        <DialogHeader>
          <RemotePluginSyncTitle />
          <RemotePluginSyncTargetRow
            targetLabel={targetLabel}
            showExistingRemotePlugins={showExistingRemotePlugins}
            showExistingFilter={step === "selection" && rows.length > 0}
            onShowExistingRemotePluginsChange={setShowExistingRemotePlugins}
          />
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-surface px-3 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          {step === "loading" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.remoteSync.loading" })}
            </div>
          ) : null}
          {step === "preflighting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.remoteSync.preflighting" })}
            </div>
          ) : null}
          {step === "selection" ? (
            <RemotePluginSyncSelectionList
              rows={visibleRows}
              selectedIds={selectedIds}
              emptyMessageId={
                rows.length > 0 ? "settings.plugins.remoteSync.filteredEmpty" : undefined
              }
              onToggle={togglePlugin}
            />
          ) : null}
          {step === "syncing" ? (
            <RemotePluginSyncProgressList
              progressById={syncProgressById}
              rows={syncRows}
              onStop={stopPluginSync}
            />
          ) : null}
          {step === "complete" ? <RemotePluginSyncResultList result={importResult} /> : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.remoteSync.selectionCount" },
              { selected: String(selectedCount), total: String(visibleMissingIds.length) },
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {step === "selection" ? (
              <RemotePluginSyncBulkSelectionCheckbox
                selectedCount={selectedCount}
                totalSelectable={visibleMissingIds.length}
                onSelectAll={() => setSelectedIds(new Set(visibleMissingIds))}
                onClearAll={() => setSelectedIds(new Set())}
              />
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={step !== "selection" || selectedCount === 0}
              onClick={syncSelected}
            >
              <UploadCloud className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.remoteSync.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
