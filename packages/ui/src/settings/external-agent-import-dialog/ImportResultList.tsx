import { AlertCircleIcon, CheckIcon, XIcon } from "lucide-react";
import type { SettingsSyncImportResult } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ImportItemResult, ImportResourceCategory } from "./types.js";

function ImportStat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-mono text-ui-base font-medium text-foreground">{value}</span>
      <span>{label}</span>
    </span>
  );
}

export function ImportStatsSummary({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: SettingsSyncImportResult | null;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-surface px-3 py-2 text-ui-xs text-foreground-subtle">
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.imported` })}
        value={result?.successCount ?? 0}
      />
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.skipped` })}
        value={result?.skippedCount ?? 0}
      />
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.failed` })}
        value={result?.failedCount ?? 0}
      />
    </div>
  );
}

function ImportStatusBadge({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: ImportItemResult;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({
    id:
      result.status === "imported"
        ? `settings.${category}.import.imported`
        : result.status === "skipped"
          ? `settings.${category}.import.skipped`
          : `settings.${category}.import.failed`,
  });
  const reasonLabel = result.skipReason
    ? intl.formatMessage({ id: `settings.${category}.import.skipReason.${result.skipReason}` })
    : null;
  const warningLabel =
    "warnings" in result
      ? result.warnings
          ?.map((warning) =>
            intl.formatMessage({ id: `settings.mcpServers.import.warning.${warning}` }),
          )
          .join(" ") || null
      : null;
  const accessibleLabel = [label, reasonLabel, warningLabel].filter(Boolean).join(": ");
  const Icon =
    result.status === "imported"
      ? CheckIcon
      : result.status === "skipped"
        ? AlertCircleIcon
        : XIcon;

  return (
    <span
      aria-label={accessibleLabel}
      role="img"
      className={cn(
        "flex size-3 shrink-0 items-center justify-center rounded-full",
        result.status === "imported" && "bg-success text-success-foreground",
        result.status === "skipped" && "bg-warning text-warning-foreground",
        result.status === "failed" && "bg-destructive text-destructive-foreground",
      )}
      title={accessibleLabel}
    >
      <Icon className="size-2" aria-hidden="true" />
    </span>
  );
}

export function ExternalAgentImportResultRow({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: ImportItemResult;
}) {
  const { intl } = useZCodeIntl();
  const warningLabel =
    "warnings" in result
      ? result.warnings
          ?.map((warning) =>
            intl.formatMessage({ id: `settings.mcpServers.import.warning.${warning}` }),
          )
          .join(" ") || null
      : null;

  return (
    <div className="flex min-w-0 items-center gap-2.5 px-3 py-2">
      <ImportStatusBadge category={category} result={result} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{result.name}</span>
          {"version" in result && result.version ? (
            <Badge
              variant="outline"
              className="h-5 border-border bg-surface px-1.5 font-mono text-ui-xs font-normal text-foreground-subtle"
            >
              {result.version.startsWith("v") ? result.version : `v${result.version}`}
            </Badge>
          ) : null}
        </div>
        {warningLabel ? (
          <span role="note" className="text-ui-xs text-warning-surface-foreground">
            {warningLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ImportResultList({
  category,
  results,
}: {
  category: ImportResourceCategory;
  results: ImportItemResult[];
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-2">
      <div className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: `settings.${category}.import.resultList` })}
      </div>
      <div className="overflow-hidden rounded-lg bg-card">
        {results.length === 0 ? (
          <div className="px-3 py-3 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: `settings.${category}.import.resultEmpty` })}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {results.map((itemResult) => (
              <ExternalAgentImportResultRow
                key={`${itemResult.status}:${itemResult.sourceScope}:${itemResult.path}`}
                category={category}
                result={itemResult}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
