import type { CSSProperties } from "react";
import { type ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

export type ContextUsageBreakdownSource = ZCodeContextUsageBreakdownItem["source"];

export interface ContextUsageBreakdownSegment {
  chars: number;
  percent: number;
  source: ContextUsageBreakdownSource;
}

export interface ContextUsageProgressSegment {
  id: ContextUsageBreakdownSource;
  percent: number;
  style: CSSProperties;
}

export interface ContextUsageTaskUsage {
  used: number;
  size: number;
  cache?: { hitRate: number | null };
  breakdown?: ZCodeContextUsageBreakdownItem[];
}

const CONTEXT_PROGRESS_TONE_COLORS = [
  "var(--color-usage-chart-1)",
  "color-mix(in oklab, var(--color-usage-chart-1) 78%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 58%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 42%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 28%, var(--color-surface))",
] as const;
export const PERCENT_MAX = 100;
const CACHE_HIT_RATE_DISPLAY_THRESHOLD = 0.78;

export function formatContextUsageTokenCount(
  value: number,
  locale: string,
  options: { maximumFractionDigits?: number } = {},
): string {
  return formatCompactTokenNumber(locale, value, options);
}

export function formatContextUsageSummary({
  locale,
  percent,
  size,
  used,
}: {
  locale: string;
  percent: number;
  size: number;
  used: number;
}): string {
  const percentageFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  });
  return `${formatContextUsageTokenCount(used, locale)}/${formatContextUsageTokenCount(
    size,
    locale,
    {
      maximumFractionDigits: 0,
    },
  )} (${percentageFormatter.format(percent)})`;
}

export function formatContextCacheHitRateLabel(
  hitRate: number | null | undefined,
  locale: string,
  options: { showBelowThreshold?: boolean } = {},
): string | null {
  if (hitRate === null || hitRate === undefined || !Number.isFinite(hitRate)) {
    return null;
  }

  // 生产面板只露出明显缓存收益，避免低命中率分散对上下文容量的注意力；
  // 开发环境需要观察 provider 的真实低命中值，因此允许绕过 78% 展示阈值。
  if (!options.showBelowThreshold && hitRate < CACHE_HIT_RATE_DISPLAY_THRESHOLD) {
    return null;
  }

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(Math.max(0, hitRate));
}

export function getBreakdownToneStyle(index: number): CSSProperties {
  return {
    backgroundColor:
      CONTEXT_PROGRESS_TONE_COLORS[Math.min(index, CONTEXT_PROGRESS_TONE_COLORS.length - 1)] ??
      CONTEXT_PROGRESS_TONE_COLORS[0],
  };
}

export const BREAKDOWN_SOURCE_LABEL_ID: Record<ContextUsageBreakdownSource, string> = {
  messages: "chat.contextUsage.breakdown.messages",
  system_prompt: "chat.contextUsage.breakdown.systemPrompt",
  meta_user_context: "chat.contextUsage.breakdown.metaUserContext",
  skills: "chat.contextUsage.breakdown.skills",
  tool_prompt: "chat.contextUsage.breakdown.toolPrompt",
  system_tool_schemas: "chat.contextUsage.breakdown.systemTools",
  mcp_tool_schemas: "chat.contextUsage.breakdown.mcpTools",
};

const BREAKDOWN_SOURCE_ORDER: Record<ContextUsageBreakdownSource, number> = {
  messages: 0,
  system_prompt: 1,
  meta_user_context: 2,
  skills: 3,
  tool_prompt: 4,
  system_tool_schemas: 5,
  mcp_tool_schemas: 6,
};

export function buildContextUsageBreakdownSegments(
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | undefined,
): ContextUsageBreakdownSegment[] {
  const charsBySource = new Map<ContextUsageBreakdownSource, number>();
  for (const item of breakdown ?? []) {
    if (!Number.isFinite(item.chars) || item.chars <= 0) {
      continue;
    }
    charsBySource.set(item.source, (charsBySource.get(item.source) ?? 0) + item.chars);
  }

  const totalChars = [...charsBySource.values()].reduce((sum, chars) => sum + chars, 0);
  if (totalChars <= 0) {
    return [];
  }

  return [...charsBySource.entries()]
    .map(([source, chars]) => ({
      chars,
      percent: chars / totalChars,
      source,
    }))
    .sort(
      (left, right) =>
        right.chars - left.chars ||
        BREAKDOWN_SOURCE_ORDER[left.source] - BREAKDOWN_SOURCE_ORDER[right.source],
    );
}

export function buildContextUsageProgressSegments(
  segments: readonly ContextUsageBreakdownSegment[],
): ContextUsageProgressSegment[] {
  return segments.map((segment, index) => ({
    id: segment.source,
    percent: segment.percent,
    style: getBreakdownToneStyle(index),
  }));
}

export function getRenderableTaskUsage<T extends { used: number; size: number }>(
  taskUsage: T | null,
): T | null {
  if (!taskUsage) {
    return null;
  }

  // ZCode Protocol 迁移后会单独补齐真实 contextUsed/contextWindow。
  // used=0 或非法值不代表可展示的上下文占用，避免把初始化/异常兜底渲染成误导性的 0%。
  if (
    !Number.isFinite(taskUsage.used) ||
    !Number.isFinite(taskUsage.size) ||
    taskUsage.used <= 0 ||
    taskUsage.size <= 0
  ) {
    return null;
  }

  return taskUsage;
}
