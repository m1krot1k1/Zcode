/**
 * 模型维度归一化：monitor 的 model-usage 与 credit-usage 的 modelUsage 两套载荷。
 */
import type {
  CodingPlanModelData,
  CodingPlanModelSummary,
  CodingPlanUsageGranularity,
} from "@zcode/shared";
import {
  alignUsageSeries,
  pickFirstNonEmptySeries,
  sumNumbers,
  sumSeries,
  toFiniteNumber,
} from "./series.js";
import type {
  BigModelCreditUsageDetailPayload,
  BigModelCreditUsageModelDataPayload,
  BigModelUsageModelDataPayload,
  BigModelUsageModelSummaryPayload,
  BigModelUsageModelUsagePayload,
} from "./types.js";

const CREDIT_USAGE_BREAKDOWN_BUCKET_CODES = new Set([
  "cached_input",
  "cachedInput",
  "cache_input",
  "cacheInput",
  "uncached_input",
  "uncachedInput",
  "output",
  "output_tokens",
  "outputTokens",
]);

export function normalizeModelDataList(
  payload: BigModelUsageModelUsagePayload,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
): CodingPlanModelData[] {
  return (payload.modelDataList ?? [])
    .filter((item): item is BigModelUsageModelDataPayload => Boolean(item?.modelName?.trim()))
    .map((item, index) => ({
      modelName: item.modelName!.trim(),
      sortOrder: item.sortOrder ?? index,
      tokensUsage: alignUsageSeries(payload.x_time ?? [], xTime, item.tokensUsage, granularity),
      totalTokens: item.totalTokens ?? 0,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

export function normalizeCreditModelDataList(
  payload: NonNullable<BigModelCreditUsageDetailPayload["modelUsage"]>,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
): CodingPlanModelData[] {
  return (payload.modelDataList ?? [])
    .filter((item): item is BigModelCreditUsageModelDataPayload =>
      Boolean(item?.modelName?.trim() || item?.modelCode?.trim()),
    )
    .filter((item) => !isCreditUsageBreakdownBucket(item))
    .map((item, index) => {
      const cachedInputTokensUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.cachedInputTokensUsage,
        granularity,
      );
      const uncachedInputTokensUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.uncachedInputTokensUsage,
        granularity,
      );
      const outputTokensUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.outputTokensUsage,
        granularity,
      );
      const cachedInputCreditsUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.cachedInputCreditsUsage,
        granularity,
      );
      const uncachedInputCreditsUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.uncachedInputCreditsUsage,
        granularity,
      );
      const outputCreditsUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.outputCreditsUsage,
        granularity,
      );
      const tokenSeries =
        pickFirstNonEmptySeries([
          item.totalTokensUsage,
          item.tokensUsage,
          sumSeries([
            item.cachedInputTokensUsage,
            item.uncachedInputTokensUsage,
            item.outputTokensUsage,
          ]),
        ]) ?? [];
      const creditSeries =
        pickFirstNonEmptySeries([
          item.totalCreditsUsage,
          sumSeries([
            item.cachedInputCreditsUsage,
            item.uncachedInputCreditsUsage,
            item.outputCreditsUsage,
          ]),
        ]) ?? [];
      const modelName = item.modelName?.trim() || item.modelCode?.trim() || "unknown";
      return {
        modelName,
        sortOrder: item.sortOrder ?? index,
        tokensUsage: alignUsageSeries(payload.xTime ?? [], xTime, tokenSeries, granularity),
        creditsUsage: alignUsageSeries(payload.xTime ?? [], xTime, creditSeries, granularity),
        cachedInputTokensUsage,
        uncachedInputTokensUsage,
        outputTokensUsage,
        cachedInputCreditsUsage,
        uncachedInputCreditsUsage,
        outputCreditsUsage,
        totalTokens: toFiniteNumber(item.totalTokens) ?? sumNumbers(tokenSeries),
        totalCredits: toFiniteNumber(item.totalCredits) ?? sumNumbers(creditSeries),
      };
    })
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

function isCreditUsageBreakdownBucket(item: BigModelCreditUsageModelDataPayload): boolean {
  const code = item.modelCode?.trim();
  if (code && CREDIT_USAGE_BREAKDOWN_BUCKET_CODES.has(code)) {
    return true;
  }
  const name = item.modelName?.trim().toLowerCase();
  // BigModel usage-detail 的 MODEL 数据有时返回“缓存/未缓存/输出”
  // 这种 token 拆分桶。它们是计费组成，不是模型维度，不能作为使用详情的模型图例。
  return name === "缓存" || name === "未缓存" || name === "输出";
}

export function sumCreditModelTokens(
  payload: NonNullable<BigModelCreditUsageDetailPayload["modelUsage"]>,
): number {
  // usage-detail 有时会同时返回真实模型行和“缓存/未缓存/输出”拆分桶，
  // 桶是全部模型 token 的计费组成而非模型维度，直接全量求和会把总用量算成约 2 倍。
  // 存在真实模型行时只统计模型行；仅返回拆分桶时才用桶求和兜底（保持原有语义）。
  const items = payload.modelDataList ?? [];
  const hasRealModelRow = items.some((item) => !isCreditUsageBreakdownBucket(item));
  const effectiveItems = hasRealModelRow
    ? items.filter((item) => !isCreditUsageBreakdownBucket(item))
    : items;
  return sumNumbers(
    effectiveItems.flatMap((item) => {
      const tokenSeries =
        pickFirstNonEmptySeries([
          item.totalTokensUsage,
          item.tokensUsage,
          sumSeries([
            item.cachedInputTokensUsage,
            item.uncachedInputTokensUsage,
            item.outputTokensUsage,
          ]),
        ]) ?? [];
      const totalTokens = toFiniteNumber(item.totalTokens);
      return totalTokens === null ? tokenSeries : [totalTokens];
    }),
  );
}

export function normalizeModelSummaryList(
  payload: BigModelUsageModelUsagePayload,
): CodingPlanModelSummary[] {
  return (payload.modelSummaryList ?? payload.totalUsage?.modelSummaryList ?? [])
    .filter((item): item is BigModelUsageModelSummaryPayload => Boolean(item?.modelName?.trim()))
    .map((item, index) => ({
      modelName: item.modelName!.trim(),
      totalTokens: item.totalTokens ?? 0,
      sortOrder: item.sortOrder ?? index,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

export function normalizeCreditModelSummaryList(
  payload: NonNullable<BigModelCreditUsageDetailPayload["modelUsage"]>,
): CodingPlanModelSummary[] {
  return normalizeCreditModelDataList(
    payload,
    payload.xTime ?? [],
    (payload.xTime ?? []).some((value) => /\d{2}:\d{2}/u.test(value)) ? "hour" : "day",
  ).map((item) => ({
    modelName: item.modelName,
    totalTokens: item.totalTokens,
    totalCredits: item.totalCredits,
    sortOrder: item.sortOrder,
  }));
}
