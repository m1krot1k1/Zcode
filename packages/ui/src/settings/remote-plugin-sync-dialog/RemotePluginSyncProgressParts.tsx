import { Cable, CheckCircle2, CircleStop, CircleX, Loader2 } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { summarizeLocalPluginOptionsForDisplay } from "@/settings/remote-plugin-sync-dialog/candidateRows.js";
import type {
  RemotePluginSyncProgressStatus,
  RemotePluginSyncProgressView,
  RemotePluginSyncRow,
  RemotePluginSyncRunResult,
} from "@/settings/remote-plugin-sync-dialog/types.js";

function RemotePluginSyncStatusBadge({ status }: { status: RemotePluginSyncProgressStatus }) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: `settings.plugins.remoteSync.${status}` });
  const icon =
    status === "synced" ? (
      <CheckCircle2 className="size-3" aria-hidden="true" />
    ) : status === "failed" ? (
      <CircleX className="size-3" aria-hidden="true" />
    ) : status === "stopped" ? (
      <CircleStop className="size-3" aria-hidden="true" />
    ) : null;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-ui-xs font-medium",
        status === "synced" && "border-success/30 bg-success/10 text-success dark:bg-success/14",
        status === "failed" && "border-destructive/30 bg-destructive/10 text-destructive",
        status === "stopped" && "border-warning/30 bg-warning/10 text-warning",
        status === "skipped" && "border-border bg-secondary text-foreground-subtle",
        (status === "queued" || status === "syncing") &&
          "border-border bg-secondary text-foreground-subtle",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

function RemotePluginSyncLogHoverCard({ logs }: { logs: readonly string[] }) {
  const { intl } = useZCodeIntl();
  const shownLogs = logs.length > 0 ? logs : ["Queued plugin sync"];

  return (
    <HoverCard closeDelay={160} openDelay={120}>
      <HoverCardTrigger asChild>
        <span
          aria-label={intl.formatMessage({ id: "settings.plugins.remoteSync.logTooltip" })}
          className="inline-flex size-6 cursor-help items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
          role="img"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        side="left"
        sideOffset={6}
        className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 bg-popover p-3 text-left"
      >
        <div className="text-ui-base font-medium text-popover-foreground">
          {intl.formatMessage({ id: "settings.plugins.remoteSync.logTooltip" })}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-2 font-mono text-ui-xs/relaxed text-popover-foreground">
          {shownLogs.join("\n")}
        </pre>
      </HoverCardContent>
    </HoverCard>
  );
}

export function RemotePluginSyncProgressList({
  progressById,
  rows,
  onStop,
}: {
  progressById: ReadonlyMap<string, RemotePluginSyncProgressView>;
  rows: readonly RemotePluginSyncRow[];
  onStop: (candidateId: string) => void;
}) {
  const { intl } = useZCodeIntl();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const progress = progressById.get(row.candidate.id) ?? {
          logs: ["Queued plugin sync"],
          status: "queued" as const,
        };
        const optionSummary = summarizeLocalPluginOptionsForDisplay(row.candidate.pluginOptions);
        const canStop = progress.status === "queued" || progress.status === "syncing";
        return (
          <div
            key={row.candidate.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base"
          >
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Cable className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="font-medium text-foreground">{row.candidate.name}</span>
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
              </div>
              {progress.result?.error ? (
                <div className="mt-1 break-words text-ui-base text-destructive">
                  {progress.result.error}
                </div>
              ) : row.candidate.path ? (
                <div className="mt-1 break-all font-mono text-ui-base text-foreground-subtlest">
                  {row.candidate.path}
                </div>
              ) : null}
              {optionSummary && !progress.result?.error ? (
                <div className="mt-1 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.remoteSync.optionsSummary" },
                    {
                      manual: String(optionSummary.manualCount),
                      syncable: String(optionSummary.syncableCount),
                    },
                  )}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-start gap-1">
              {progress.status === "syncing" ? (
                <RemotePluginSyncLogHoverCard logs={progress.logs} />
              ) : null}
              <RemotePluginSyncStatusBadge status={progress.status} />
              {canStop ? (
                <ControlHintTooltip
                  title={intl.formatMessage({ id: "settings.plugins.remoteSync.stop" })}
                  side="left"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({
                      id: "settings.plugins.remoteSync.stop",
                    })}
                    className="text-foreground-subtle hover:text-warning"
                    onClick={() => onStop(row.candidate.id)}
                  >
                    <CircleStop className="size-3.5" aria-hidden="true" />
                  </Button>
                </ControlHintTooltip>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RemotePluginSyncResultList({
  result,
}: {
  result: RemotePluginSyncRunResult | null;
}) {
  const { intl } = useZCodeIntl();
  const items = result?.results ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div
            key={`${item.pluginId}-${item.directoryName}-${item.status}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.error ? (
                <div className="mt-0.5 break-words text-ui-base text-destructive">{item.error}</div>
              ) : item.path ? (
                <div className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest">
                  {item.path}
                </div>
              ) : null}
            </div>
            <RemotePluginSyncStatusBadge status={item.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
