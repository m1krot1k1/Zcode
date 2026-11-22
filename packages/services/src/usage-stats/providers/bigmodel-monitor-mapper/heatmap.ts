/**
 * Coding Plan 活跃热力图：把远端 series 折叠成按周分组的格子。
 */
import type { AppUsageHeatmap, AppUsageHeatmapCell, AppUsageHeatmapWeek } from "@zcode/shared";
import { toFiniteNumber } from "./series.js";
import type { BigModelCreditUsageActivitySeriesPayload } from "./types.js";

export function buildCodingPlanActivityHeatmap(
  series: BigModelCreditUsageActivitySeriesPayload[],
): AppUsageHeatmap {
  const cells = series
    .map((item) => {
      const date = item.date?.trim() ?? "";
      const totalTokens = toFiniteNumber(item.totalTokens) ?? 0;
      const turnCount = toFiniteNumber(item.modelCallCount) ?? 0;
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        return null;
      }
      return {
        date,
        totalTokens,
        turnCount,
        toolCallCount: toFiniteNumber(item.mcpCalls) ?? 0,
      };
    })
    .filter((cell): cell is Omit<AppUsageHeatmapCell, "level"> => cell !== null)
    .sort((left, right) => left.date.localeCompare(right.date));
  const maxTokens = Math.max(0, ...cells.map((cell) => cell.totalTokens));
  const weeks = buildAppUsageHeatmapWeeks(cells, maxTokens);
  return {
    startDate: cells[0]?.date ?? null,
    endDate: cells.at(-1)?.date ?? null,
    maxTokens,
    weeks,
  };
}

function buildAppUsageHeatmapWeeks(
  cells: Array<Omit<AppUsageHeatmapCell, "level">>,
  maxTokens: number,
): AppUsageHeatmapWeek[] {
  const byDate = new Map(cells.map((cell) => [cell.date, cell] as const));
  const weekStarts = new Map<number, AppUsageHeatmapWeek>();
  for (const cell of cells) {
    const dayIndex = dateKeyToUtcDayIndex(cell.date);
    if (dayIndex === null) continue;
    const weekStart = dayIndex - new Date(dayIndex * DAY_MS).getUTCDay();
    let week = weekStarts.get(weekStart);
    if (!week) {
      week = {
        weekIndex: weekStarts.size,
        days: Array.from({ length: 7 }, (_, index) => {
          const date = utcDayIndexToDateKey(weekStart + index);
          const source = byDate.get(date);
          return source
            ? { ...source, level: levelForTokens(source.totalTokens, maxTokens) }
            : null;
        }),
      };
      weekStarts.set(weekStart, week);
    }
  }
  return [...weekStarts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, week], index) => ({ ...week, weekIndex: index }));
}

const DAY_MS = 86_400_000;

function dateKeyToUtcDayIndex(dateKey: string): number | null {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / DAY_MS);
}

function utcDayIndexToDateKey(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function levelForTokens(value: number, max: number): AppUsageHeatmapCell["level"] {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as AppUsageHeatmapCell["level"];
}
