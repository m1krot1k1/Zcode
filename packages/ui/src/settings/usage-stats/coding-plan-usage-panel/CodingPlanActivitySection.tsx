import { Fragment } from "react";
import { InfoIcon } from "lucide-react";
import type { CodingPlanUsageSnapshot } from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatAppUsageDuration } from "@/settings/usage-stats/AppUsagePanel.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import {
  formatCompactNumber,
  formatFullDay,
  formatSummaryCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

export function CodingPlanActivitySection({
  snapshot,
}: {
  snapshot: CodingPlanUsageSnapshot;
}) {
  const { intl, locale } = useZCodeIntl();
  const summary = snapshot.activity.summary;
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTotalTokens" }),
      value: formatSummaryCompactTokenUsage(locale, summary.totalTokens),
    },
    {
      // 日期直接拼进标签会在窄卡片中被截断；固定标题保持可读，日期改由信息图标按需展示。
      label: intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" }),
      peakDailyTokensDate: summary.peakDailyTokensDate,
      value: formatSummaryCompactTokenUsage(locale, summary.peakDailyTokens),
    },
    {
      // 修复回归：CodingPlanActivitySummary 只有 totalUsageDurationMs（累计使用时长），
      // longestSessionMs 是 App Usage 侧的字段，不能使用“最长聊天时长”标签。
      label: intl.formatMessage({ id: "settings.usage.totalUsageDuration" }),
      value: formatAppUsageDuration(summary.totalUsageDurationMs, intl),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.currentStreak" }),
      value: `${formatCompactNumber(locale, summary.currentStreakDays)} ${intl.formatMessage(
        {
          id: "settings.usage.duration.day",
        },
      )}`,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestStreak" }),
      value: `${formatCompactNumber(locale, summary.longestStreakDays)} ${intl.formatMessage(
        {
          id: "settings.usage.duration.day",
        },
      )}`,
    },
  ];

  return (
    <section className="space-y-4">
      <h3 className="text-ui-lg font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.activityTitle" })}
      </h3>
      <div className="flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center">
        {items.map((item, index) => (
          <Fragment key={item.label}>
            {index > 0 ? (
              <div
                aria-hidden="true"
                className="hidden h-7 w-px bg-border sm:block"
              />
            ) : null}
            <div className="min-w-0 flex-1 px-4 py-3 text-center">
              <div className="truncate text-ui-lg font-medium text-foreground">
                {item.value}
              </div>
              <div className="mt-1 flex min-w-0 items-center justify-center gap-1 text-ui-base text-foreground-subtle">
                <span className="min-w-0 truncate">{item.label}</span>
                {item.peakDailyTokensDate ? (
                  <ControlHintTooltip
                    title={formatFullDay(locale, item.peakDailyTokensDate)}
                  >
                    <span
                      className="inline-flex size-4 items-center justify-center"
                      tabIndex={0}
                      aria-label={formatFullDay(
                        locale,
                        item.peakDailyTokensDate,
                      )}
                    >
                      <InfoIcon className="size-3.5" aria-hidden="true" />
                    </span>
                  </ControlHintTooltip>
                ) : null}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
      {snapshot.activity.heatmap.weeks.length ? (
        <UsageHeatmap
          locale={locale}
          intl={intl}
          weeks={snapshot.activity.heatmap.weeks}
          countMetric="tools"
        />
      ) : null}
    </section>
  );
}
