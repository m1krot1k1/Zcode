/**
 * Coding Plan 快照：把 monitor 载荷与 credit-usage detail/activity/health 组装成
 * CodingPlanUsageSnapshot。列表归一化委托给模型与工具子模块。
 */
import type {
  CodingPlanUsageGranularity,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  UsageEntitlementProviderInfo,
  UsageQuotaSnapshot,
} from "@zcode/shared";
import { buildCodingPlanActivityHeatmap } from "./heatmap.js";
import {
  normalizeCreditModelDataList,
  normalizeCreditModelSummaryList,
  normalizeModelDataList,
  normalizeModelSummaryList,
  sumCreditModelTokens,
} from "./modelUsage.js";
import { normalizeNumberSeries, toFiniteNumber } from "./series.js";
import {
  normalizeCreditToolDataList,
  normalizeCreditToolSummaryList,
  normalizeToolDataList,
  normalizeToolSummaryList,
} from "./toolUsage.js";
import type {
  BigModelCreditUsageActivityPayload,
  BigModelCreditUsageDetailPayload,
  BigModelUsageModelPerformancePayload,
  BigModelUsageModelUsagePayload,
  BigModelUsageToolUsagePayload,
} from "./types.js";

export function buildCodingPlanUsageSnapshotFromMonitor(params: {
  request: CodingPlanUsageRequest;
  provider: UsageEntitlementProviderInfo;
  quota: UsageQuotaSnapshot | null;
  granularity: CodingPlanUsageGranularity;
  xTime: string[];
  activityData?: BigModelCreditUsageActivityPayload;
  modelDetailData?: BigModelCreditUsageDetailPayload;
  toolDetailData?: BigModelCreditUsageDetailPayload;
  healthData?: BigModelUsageModelPerformancePayload;
  startDateKey: string;
  endDateKey: string;
  modelData?: BigModelUsageModelUsagePayload;
  toolData?: BigModelUsageToolUsagePayload;
}): CodingPlanUsageSnapshot {
  const modelUsage = params.modelDetailData?.modelUsage ?? null;
  const toolUsage = params.toolDetailData?.mcpUsage ?? null;
  const modelSummaryList = modelUsage
    ? normalizeCreditModelSummaryList(modelUsage)
    : normalizeModelSummaryList(params.modelData ?? {});
  const toolSummaryList = toolUsage
    ? normalizeCreditToolSummaryList(toolUsage)
    : normalizeToolSummaryList(params.toolData ?? {});
  const modelDataList = modelUsage
    ? normalizeCreditModelDataList(modelUsage, params.xTime, params.granularity)
    : normalizeModelDataList(params.modelData ?? {}, params.xTime, params.granularity);
  const toolDataList = toolUsage
    ? normalizeCreditToolDataList(toolUsage, params.xTime, params.granularity)
    : normalizeToolDataList(params.toolData ?? {}, params.xTime, params.granularity);
  const totalTokensUsage = modelUsage
    ? sumCreditModelTokens(modelUsage)
    : (params.modelData?.totalUsage?.totalTokensUsage ?? 0);
  const activity = buildCodingPlanActivitySnapshot(params.activityData);
  return {
    range: params.request.range,
    rangeStartDate: params.startDateKey,
    rangeEndDate: params.endDateKey,
    generatedAt: Date.now(),
    sourceProvider: params.provider,
    quota: params.quota,
    activity: {
      ...activity,
      summary: { ...activity.summary, favoriteModelName: modelSummaryList[0]?.modelName ?? null },
    },
    detail: buildCodingPlanUsageDetailSnapshot(params.modelDetailData, params.toolDetailData),
    modelUsage: {
      xTime: params.xTime,
      granularity: params.granularity,
      totalModelCallCount:
        modelUsage?.modelDataList?.length ?? params.modelData?.totalUsage?.totalModelCallCount ?? 0,
      totalTokensUsage,
      modelDataList,
      modelSummaryList,
    },
    toolUsage: {
      xTime: params.xTime,
      granularity: params.granularity,
      toolDataList,
      toolSummaryList,
    },
    health: buildCodingPlanHealthSnapshot(params.healthData),
  };
}

function buildCodingPlanActivitySnapshot(
  payload: BigModelCreditUsageActivityPayload | undefined,
): CodingPlanUsageSnapshot["activity"] {
  const heatmap = buildCodingPlanActivityHeatmap(payload?.series ?? []);
  return {
    summary: {
      totalTokens: toFiniteNumber(payload?.summary?.totalTokens) ?? 0,
      peakDailyTokens: toFiniteNumber(payload?.summary?.peakDailyTokens) ?? 0,
      peakDailyTokensDate: payload?.summary?.peakDailyTokensDate?.trim() || null,
      totalUsageDurationMs: toFiniteNumber(payload?.summary?.totalUsageDurationMs) ?? 0,
      currentStreakDays: toFiniteNumber(payload?.summary?.currentStreakDays) ?? 0,
      longestStreakDays: toFiniteNumber(payload?.summary?.longestStreakDays) ?? 0,
      favoriteModelName: null,
    },
    heatmap,
  };
}

function buildCodingPlanUsageDetailSnapshot(
  modelDetailData: BigModelCreditUsageDetailPayload | undefined,
  toolDetailData: BigModelCreditUsageDetailPayload | undefined,
): CodingPlanUsageSnapshot["detail"] {
  return {
    model: buildCodingPlanUsageDetailSummary(modelDetailData?.summary),
    tool: buildCodingPlanUsageDetailSummary(toolDetailData?.summary),
  };
}

function buildCodingPlanUsageDetailSummary(
  summary: BigModelCreditUsageDetailPayload["summary"] | undefined,
): CodingPlanUsageSnapshot["detail"]["model"] {
  return {
    cacheHitRate: toFiniteNumber(summary?.cacheHitRate?.value),
    cacheHitRateTrend: toFiniteNumber(summary?.cacheHitRate?.trend),
    totalCredits: toFiniteNumber(summary?.totalCredits?.value) ?? 0,
    totalCreditsTrend: toFiniteNumber(summary?.totalCredits?.trend),
    averageDailyCredits: toFiniteNumber(summary?.averageDailyCredits?.value) ?? 0,
    averageDailyCreditsTrend: toFiniteNumber(summary?.averageDailyCredits?.trend),
  };
}

function buildCodingPlanHealthSnapshot(
  payload: BigModelUsageModelPerformancePayload | undefined,
): CodingPlanUsageSnapshot["health"] {
  return {
    xTime: payload?.x_time ?? payload?.xTime ?? [],
    proMaxDecodeSpeed: normalizeNumberSeries(payload?.proMaxDecodeSpeed),
    liteDecodeSpeed: normalizeNumberSeries(payload?.liteDecodeSpeed),
  };
}
