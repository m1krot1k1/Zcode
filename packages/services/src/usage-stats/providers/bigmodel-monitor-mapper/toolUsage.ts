/**
 * 工具维度归一化：monitor 的 tool-usage 与 credit-usage 的 mcpUsage 两套载荷。
 */
import type {
  CodingPlanToolData,
  CodingPlanToolSummary,
  CodingPlanUsageGranularity,
} from "@zcode/shared";
import { alignUsageSeries, pickFirstNonEmptySeries, sumNumbers, toFiniteNumber } from "./series.js";
import type {
  BigModelCreditUsageDetailPayload,
  BigModelCreditUsageMcpDataPayload,
  BigModelUsageToolDataPayload,
  BigModelUsageToolSummaryPayload,
  BigModelUsageToolUsagePayload,
} from "./types.js";

export function normalizeToolDataList(
  payload: BigModelUsageToolUsagePayload,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
): CodingPlanToolData[] {
  return (payload.toolDataList ?? [])
    .filter((item): item is BigModelUsageToolDataPayload =>
      Boolean(item?.toolCode?.trim() || item?.toolName?.trim()),
    )
    .map((item, index) => ({
      toolCode: item.toolCode?.trim() || item.toolName?.trim() || "unknown",
      toolName: item.toolName?.trim() || item.toolCode?.trim() || "Unknown",
      sortOrder: item.sortOrder ?? index,
      usageCount: alignUsageSeries(payload.x_time ?? [], xTime, item.usageCount, granularity),
      totalUsageCount: item.totalUsageCount ?? 0,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

export function normalizeCreditToolDataList(
  payload: NonNullable<BigModelCreditUsageDetailPayload["mcpUsage"]>,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
): CodingPlanToolData[] {
  return (payload.mcpDataList ?? [])
    .filter((item): item is BigModelCreditUsageMcpDataPayload =>
      Boolean(
        item?.mcpCode?.trim() ||
        item?.mcpName?.trim() ||
        item?.toolCode?.trim() ||
        item?.toolName?.trim(),
      ),
    )
    .map((item, index) => {
      const usageSeries = pickFirstNonEmptySeries([item.mcpCallCount, item.usageCount]) ?? [];
      const creditSeries = item.creditsUsage ?? [];
      const toolCode =
        item.mcpCode?.trim() || item.toolCode?.trim() || item.mcpName?.trim() || "unknown";
      const toolName =
        item.mcpName?.trim() || item.toolName?.trim() || item.mcpCode?.trim() || toolCode;
      return {
        toolCode,
        toolName,
        sortOrder: item.sortOrder ?? index,
        usageCount: alignUsageSeries(payload.xTime ?? [], xTime, usageSeries, granularity),
        creditsUsage: alignUsageSeries(payload.xTime ?? [], xTime, creditSeries, granularity),
        totalUsageCount: toFiniteNumber(item.totalUsageCount) ?? sumNumbers(usageSeries),
        totalCredits: toFiniteNumber(item.totalCredits) ?? sumNumbers(creditSeries),
      };
    })
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

export function normalizeToolSummaryList(
  payload: BigModelUsageToolUsagePayload,
): CodingPlanToolSummary[] {
  return (payload.toolSummaryList ?? payload.totalUsage?.toolSummaryList ?? [])
    .filter((item): item is BigModelUsageToolSummaryPayload =>
      Boolean(item?.toolCode?.trim() || item?.toolName?.trim()),
    )
    .map((item, index) => ({
      toolCode: item.toolCode?.trim() || item.toolName?.trim() || "unknown",
      toolName: item.toolName?.trim() || item.toolCode?.trim() || "Unknown",
      totalUsageCount: item.totalUsageCount ?? 0,
      sortOrder: item.sortOrder ?? index,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

export function normalizeCreditToolSummaryList(
  payload: NonNullable<BigModelCreditUsageDetailPayload["mcpUsage"]>,
): CodingPlanToolSummary[] {
  return normalizeCreditToolDataList(
    payload,
    payload.xTime ?? [],
    (payload.xTime ?? []).some((value) => /\d{2}:\d{2}/u.test(value)) ? "hour" : "day",
  ).map((item) => ({
    toolCode: item.toolCode,
    toolName: item.toolName,
    totalUsageCount: item.totalUsageCount,
    totalCredits: item.totalCredits,
    sortOrder: item.sortOrder,
  }));
}
