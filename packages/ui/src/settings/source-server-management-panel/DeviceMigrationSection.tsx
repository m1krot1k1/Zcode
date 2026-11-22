import type {
  SourceServerManagementSnapshot,
  SourceServerMigrationReport,
  SourceServerRecord,
} from "@zcode/shared";
import { ChevronDown, ChevronRight, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SourceServerMigrationReportPanel } from "@/settings/SourceServerMigrationReportPanel.js";
import { usePanelRuntime } from "./panelContext.js";

export function DeviceMigrationSection({
  server,
  migrationCount,
  migrationReport,
  deviceBusy,
}: {
  server: SourceServerRecord;
  migrationCount: Extract<
    SourceServerManagementSnapshot["migrationCounts"][number],
    { status: "available" }
  >;
  migrationReport: SourceServerMigrationReport | undefined;
  deviceBusy: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { confirmDialog, runMigrationOperation, toggleMigrationReport, management } =
    usePanelRuntime();

  return (
    <div className="border-t border-border">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full justify-start rounded-none px-4 py-2.5 text-ui-sm text-remote-foreground-muted"
        onClick={() => toggleMigrationReport(server.sourceServerId)}
      >
        {migrationReport ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        <FileWarning className="size-3.5 text-warning" />
        {intl.formatMessage({
          id: "settings.source.connectionHistoryNeedsAttention",
        })}
        <span className="font-medium text-warning">
          {intl.formatMessage(
            { id: "settings.source.pendingMigrationCount" },
            {
              count: migrationCount.failedPathCount + migrationCount.abandonedPathCount,
            },
          )}
        </span>
      </Button>
      {migrationReport ? (
        <SourceServerMigrationReportPanel
          report={migrationReport}
          disabled={deviceBusy}
          onAbandon={(workspacePath, migrationId) => {
            void confirmDialog({
              title: intl.formatMessage({
                id: "settings.source.abandonMigrationTitle",
              }),
              description: intl.formatMessage({
                id: "settings.source.abandonMigrationDescription",
              }),
              confirmLabel: intl.formatMessage({
                id: "settings.source.abandonMigration",
              }),
              confirmVariant: "destructive",
            }).then((confirmed) => {
              if (!confirmed) return;
              void runMigrationOperation(
                `abandon:${server.sourceServerId}:${migrationId}`,
                server.sourceServerId,
                () =>
                  management.abandonWorkspaceMigration(
                    server.sourceServerId,
                    workspacePath,
                    migrationId,
                  ),
              );
            });
          }}
          onRetry={(workspacePath, migrationId) =>
            void runMigrationOperation(
              `retry:${server.sourceServerId}:${migrationId}`,
              server.sourceServerId,
              () =>
                management.retryWorkspaceMigration(
                  server.sourceServerId,
                  workspacePath,
                  migrationId,
                ),
            )
          }
        />
      ) : null}
    </div>
  );
}
