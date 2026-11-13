/**
 * 数值序列归一化与时间轴对齐。
 *
 * monitor 与 credit-usage 两个接口的 x 轴命名、粒度与空值形态不同，
 * 统一在这里收敛为 number[]，并按目标时间轴对齐。
 */
import type { CodingPlanUsageGranularity } from "@zcode/shared";
import type { BigModelUsageNumberSeries } from "./types.js";

export function toFiniteNumber(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function normalizeNumberSeries(
  values: Array<number | string | null | undefined> | undefined,
): number[] {
  return (values ?? []).map((value) => toFiniteNumber(value) ?? 0);
}

export function sumNumbers(values: BigModelUsageNumberSeries | undefined): number {
  return (values ?? []).reduce<number>((sum, value) => sum + (toFiniteNumber(value) ?? 0), 0);
}

export function sumSeries(
  seriesList: Array<BigModelUsageNumberSeries | undefined>,
): number[] | undefined {
  const maxLength = Math.max(0, ...seriesList.map((series) => series?.length ?? 0));
  if (maxLength === 0) return undefined;
  return Array.from({ length: maxLength }, (_, index) =>
    seriesList.reduce((sum, series) => sum + (toFiniteNumber(series?.[index]) ?? 0), 0),
  );
}

export function pickFirstNonEmptySeries(
  seriesList: Array<BigModelUsageNumberSeries | undefined>,
): number[] | undefined {
  const series = seriesList.find(
    (item) => Array.isArray(item) && item.some((value) => (toFiniteNumber(value) ?? 0) > 0),
  );
  return series ? normalizeNumberSeries(series) : undefined;
}

export function alignUsageSeries(
  sourceXTime: string[],
  targetXTime: string[],
  values: BigModelUsageNumberSeries | undefined,
  granularity: CodingPlanUsageGranularity,
): number[] {
  const sourceValues = normalizeNumberSeries(values);
  if (sourceXTime.length === 0 && sourceValues.length === targetXTime.length) {
    return sourceValues;
  }

  const valuesByTime = new Map<string, number>();
  sourceXTime.forEach((time, index) => {
    valuesByTime.set(normalizeCodingPlanAxisValue(time, granularity), sourceValues[index] ?? 0);
  });

  return targetXTime.map((time, index) => {
    const normalizedTime = normalizeCodingPlanAxisValue(time, granularity);
    return (
      valuesByTime.get(normalizedTime) ??
      (sourceXTime.length === 0 ? (sourceValues[index] ?? 0) : 0)
    );
  });
}

function normalizeCodingPlanAxisValue(
  value: string,
  granularity: CodingPlanUsageGranularity,
): string {
  if (granularity === "hour") {
    const timeMatch = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
    if (timeMatch) {
      return `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3] ?? "00"}`;
    }
  }

  const dateMatch = /(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (dateMatch) {
    return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
  }
  return value;
}
