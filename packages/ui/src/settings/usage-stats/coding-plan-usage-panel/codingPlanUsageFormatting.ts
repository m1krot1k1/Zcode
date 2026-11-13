import type {
  CodingPlanUsageDetailMetric,
  CodingPlanUsageDetailSubject,
} from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import {
  formatCompactNumber,
  formatCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

/** Usage stats 独有的完整重置时刻格式；其它紧凑入口继续按各自规则展示。 */
export function formatUsageStatsQuotaResetTime(
  locale: string,
  value: number | null | undefined,
): string | undefined {
  return formatQuotaResetTime({ locale, value, format: "dateTime" });
}

export function formatCodingPlanRate(
  locale: string,
  value: number | null,
): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  const normalizedValue = value > 1 ? value / 100 : value;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
    style: "percent",
  }).format(normalizedValue);
}

export function formatCodingPlanRefreshTime(
  locale: string,
  intl: IntlInstance,
  value: number,
): string {
  const time = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
  return intl.formatMessage({ id: "settings.usage.lastRefreshTime" }, { time });
}

export function formatCodingPlanTrend(locale: string, value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(Math.abs(value))}`;
}

export function formatCodingPlanDetailValue(
  locale: string,
  value: number,
  metric: CodingPlanUsageDetailMetric,
  subject: CodingPlanUsageDetailSubject,
): string {
  if (metric === "credits") {
    return formatCompactNumber(locale, value);
  }
  if (subject === "model") {
    return formatCompactTokenUsage(locale, value);
  }
  return formatCompactNumber(locale, value);
}
