import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import type {
  CodingPlanUsageDetailMetric,
  CodingPlanUsageDetailSubject,
  CodingPlanUsageSnapshot,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import {
  buildCodingPlanModelLineChartSeries,
  buildCodingPlanToolLineChartSeries,
  buildCodingPlanUsageDetailLineChartSeries,
} from "@/settings/usage-stats/codingPlanUsageChartSeries.js";
import { formatCompactNumber } from "@/settings/usage-stats/usageStatsUiParts.js";
import {
  CODING_PLAN_DETAIL_SERIES_COLORS,
  CodingPlanUsageBarChart,
  MAX_SELECTED_CODING_PLAN_DETAIL_SERIES,
} from "./codingPlanUsageCharts.js";
import {
  formatCodingPlanDetailValue,
  formatCodingPlanRate,
  formatCodingPlanTrend,
} from "./codingPlanUsageFormatting.js";
import {
  hasCodingPlanCreditUsageData,
  shouldShowCodingPlanUsageDetailSummary,
} from "./codingPlanUsageMetrics.js";
import { SegmentedTabs } from "./SegmentedTabs.js";

export function CodingPlanUsageDetailSection({
  snapshot,
}: {
  snapshot: CodingPlanUsageSnapshot;
}) {
  const { intl, locale } = useZCodeIntl();
  const [metric, setMetric] = useState<CodingPlanUsageDetailMetric>("credits");
  const [subject, setSubject] = useState<CodingPlanUsageDetailSubject>("model");
  const [selectedSeriesNames, setSelectedSeriesNames] = useState<string[]>([]);
  const activeSummary =
    subject === "model" ? snapshot.detail.model : snapshot.detail.tool;
  const hasCreditUsageData = hasCodingPlanCreditUsageData({
    summary: activeSummary,
    modelDataList: snapshot.modelUsage.modelDataList,
    toolDataList: snapshot.toolUsage.toolDataList,
  });
  const showDetailSummary = shouldShowCodingPlanUsageDetailSummary({
    summary: activeSummary,
    modelDataList: subject === "model" ? snapshot.modelUsage.modelDataList : [],
    toolDataList: subject === "tool" ? snapshot.toolUsage.toolDataList : [],
  });
  const activeChartMeta =
    subject === "model"
      ? {
          granularity: snapshot.modelUsage.granularity,
          xTime: snapshot.modelUsage.xTime,
        }
      : {
          granularity: snapshot.toolUsage.granularity,
          xTime: snapshot.toolUsage.xTime,
        };
  const allSeries = useMemo(() => {
    const series = hasCreditUsageData
      ? buildCodingPlanUsageDetailLineChartSeries({
          metric,
          subject,
          modelDataList: snapshot.modelUsage.modelDataList,
          toolDataList: snapshot.toolUsage.toolDataList,
        })
      : subject === "model"
        ? buildCodingPlanModelLineChartSeries(snapshot.modelUsage.modelDataList)
        : buildCodingPlanToolLineChartSeries(snapshot.toolUsage.toolDataList);
    return series.map((item, index) => ({
      ...item,
      color:
        CODING_PLAN_DETAIL_SERIES_COLORS[
          index % CODING_PLAN_DETAIL_SERIES_COLORS.length
        ] ?? CODING_PLAN_DETAIL_SERIES_COLORS[0],
    }));
  }, [
    hasCreditUsageData,
    metric,
    snapshot.modelUsage.modelDataList,
    snapshot.toolUsage.toolDataList,
    subject,
  ]);
  const selectedSeriesNameSet = useMemo(
    () => new Set(selectedSeriesNames),
    [selectedSeriesNames],
  );
  const visibleSeries = useMemo(
    () => allSeries.filter((item) => selectedSeriesNameSet.has(item.name)),
    [allSeries, selectedSeriesNameSet],
  );
  const totalValue = visibleSeries.reduce(
    (sum, item) =>
      sum + item.values.reduce((itemSum, value) => itemSum + value, 0),
    0,
  );
  const valueKind = hasCreditUsageData
    ? metric === "credits"
      ? "credit"
      : subject === "model"
        ? "token"
        : "count"
    : subject === "model"
      ? "token"
      : "count";
  const valueMetric = hasCreditUsageData ? metric : "usage";
  const detailUnit =
    valueKind === "token"
      ? intl.formatMessage({ id: "settings.usage.tokenUnit" })
      : valueKind === "credit"
        ? intl.formatMessage({ id: "settings.usage.creditUnit" })
        : null;

  useEffect(() => {
    setSelectedSeriesNames(
      allSeries
        .slice(0, MAX_SELECTED_CODING_PLAN_DETAIL_SERIES)
        .map((item) => item.name),
    );
  }, [allSeries, hasCreditUsageData, metric, subject, snapshot.generatedAt]);

  const toggleSeries = useCallback((name: string) => {
    setSelectedSeriesNames((current) => {
      if (current.includes(name)) {
        if (current.length <= 1) {
          return current;
        }
        return current.filter((item) => item !== name);
      }
      if (current.length >= MAX_SELECTED_CODING_PLAN_DETAIL_SERIES) {
        return [...current.slice(1), name];
      }
      return [...current, name];
    });
  }, []);

  return (
    <section className="space-y-4">
      {showDetailSummary ? (
        <CodingPlanUsageDetailSummary summary={activeSummary} />
      ) : null}
      <div className="rounded-xl bg-surface/70 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {hasCreditUsageData ? (
            <>
              <SegmentedTabs
                value={metric}
                options={["credits", "usage"]}
                labelIdPrefix="settings.usage.codingPlanMetric"
                onChange={(value) =>
                  setMetric(value as CodingPlanUsageDetailMetric)
                }
              />
              <div aria-hidden="true" className="h-4 w-px bg-border" />
            </>
          ) : null}
          <SegmentedTabs
            value={subject}
            options={["model", "tool"]}
            labelIdPrefix="settings.usage.codingPlanSubject"
            onChange={(value) =>
              setSubject(value as CodingPlanUsageDetailSubject)
            }
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-ui-sm">
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-ui-sm"
            onClick={() =>
              setSelectedSeriesNames(
                allSeries
                  .slice(0, MAX_SELECTED_CODING_PLAN_DETAIL_SERIES)
                  .map((item) => item.name),
              )
            }
          >
            <span className="truncate text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.usage.codingPlanLegendTotal",
              })}
              :
            </span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium">
                {formatCodingPlanDetailValue(
                  locale,
                  totalValue,
                  valueMetric,
                  subject,
                )}
              </span>
              {detailUnit ? (
                <span className="text-foreground-subtle">{detailUnit}</span>
              ) : null}
            </span>
          </button>
          {allSeries.slice(0, 8).map((item) => {
            const hidden = !selectedSeriesNameSet.has(item.name);
            const itemTotal = item.values.reduce(
              (sum, value) => sum + value,
              0,
            );
            const seriesColor = item.color;
            return (
              <button
                key={item.name}
                type="button"
                aria-pressed={!hidden}
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-ui-sm"
                onClick={() => toggleSeries(item.name)}
              >
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                    hidden
                      ? "bg-input border-border text-transparent"
                      : "text-primary-foreground"
                  }`}
                  style={{
                    backgroundColor: hidden ? undefined : seriesColor,
                    borderColor: hidden ? undefined : seriesColor,
                  }}
                >
                  <Check className="size-3" aria-hidden="true" />
                </span>
                <span className="truncate text-foreground-subtle">
                  {item.name}:
                </span>
                <span className="flex items-baseline gap-1 text-foreground">
                  <span className="font-mono font-medium">
                    {formatCodingPlanDetailValue(
                      locale,
                      itemTotal,
                      valueMetric,
                      subject,
                    )}
                  </span>
                  {detailUnit ? (
                    <span className="text-foreground-subtle">{detailUnit}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <UsageChartLoadBoundary
            scope="settings.usage.coding-plan-detail-chart"
            resetKeys={[
              snapshot.sourceProvider.id,
              snapshot.range,
              snapshot.rangeStartDate,
              snapshot.rangeEndDate,
              snapshot.generatedAt,
              metric,
              subject,
            ]}
            loadingDescription={intl.formatMessage({
              id: "settings.usage.codingPlanLoadingDescription",
            })}
          >
            <CodingPlanUsageBarChart
              xTime={activeChartMeta.xTime}
              granularity={activeChartMeta.granularity}
              emptyDescription={intl.formatMessage({
                id: "settings.usage.emptyDescription",
              })}
              series={visibleSeries}
              valueKind={valueKind}
            />
          </UsageChartLoadBoundary>
        </div>
      </div>
    </section>
  );
}

function CodingPlanUsageDetailSummary({
  summary,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
}) {
  const { intl, locale } = useZCodeIntl();
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.cacheHitRate" }),
      trend: summary.cacheHitRateTrend,
      value: formatCodingPlanRate(locale, summary.cacheHitRate),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.creditsTotal" }),
      trend: summary.totalCreditsTrend,
      value: formatCompactNumber(locale, summary.totalCredits),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.averageDailyCredits" }),
      trend: summary.averageDailyCreditsTrend,
      value: formatCompactNumber(locale, summary.averageDailyCredits),
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl bg-surface/70 p-4">
          <div className="truncate text-ui-lg font-medium text-foreground">
            {item.value}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">
            <span className="min-w-0 truncate">{item.label}</span>
            {item.trend === null ? null : (
              <span
                className={`shrink-0 text-ui-base ${
                  item.trend < 0 ? "text-destructive" : "text-success"
                }`}
              >
                {formatCodingPlanTrend(locale, item.trend)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
