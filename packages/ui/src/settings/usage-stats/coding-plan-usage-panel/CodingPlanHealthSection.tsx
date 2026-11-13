import { useMemo } from "react";
import type { CodingPlanUsageSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import { CodingPlanUsageLineChart } from "./codingPlanUsageCharts.js";

export function CodingPlanHealthSection({
  snapshot,
}: {
  snapshot: CodingPlanUsageSnapshot;
}) {
  const { intl } = useZCodeIntl();
  const healthSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: "settings.usage.healthProMaxDecode" }),
        values: snapshot.health.proMaxDecodeSpeed,
      },
      {
        name: intl.formatMessage({ id: "settings.usage.healthLiteDecode" }),
        values: snapshot.health.liteDecodeSpeed,
      },
    ],
    [snapshot.health.liteDecodeSpeed, snapshot.health.proMaxDecodeSpeed, intl],
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.healthTitle" })}
        </h3>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.healthRange.7d" })}
        </span>
      </div>
      <div className="rounded-xl bg-surface/70 p-3">
        <UsageChartLoadBoundary
          scope="settings.usage.coding-plan-health-chart"
          resetKeys={[snapshot.sourceProvider.id, snapshot.generatedAt]}
          loadingDescription={intl.formatMessage({
            id: "settings.usage.codingPlanLoadingDescription",
          })}
        >
          <CodingPlanUsageLineChart
            xTime={snapshot.health.xTime}
            granularity="day"
            emptyDescription={intl.formatMessage({
              id: "settings.usage.emptyDescription",
            })}
            series={healthSeries}
            valueKind="speed"
          />
        </UsageChartLoadBoundary>
      </div>
    </section>
  );
}
