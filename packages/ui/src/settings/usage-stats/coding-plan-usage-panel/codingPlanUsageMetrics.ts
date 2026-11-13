import type {
  CodingPlanModelData,
  CodingPlanToolData,
  CodingPlanUsageSnapshot,
} from "@zcode/shared";
import type { CodingPlanUsageSource } from "@/lib/codingPlanUsageSources.js";

const HIDDEN_CODING_PLAN_PROVIDER_NAMES = new Set(["BigModel - Coding Plan"]);

export function resolveCodingPlanUsageProviderName({
  fallbackProviderName,
  snapshot,
  source,
}: {
  fallbackProviderName?: string;
  snapshot: CodingPlanUsageSnapshot | null;
  source: CodingPlanUsageSource | null;
}): string | undefined {
  // 修复原因：Team Plan 复用 BigModel Coding Plan provider，monitor 接口只知道通用 provider 名。
  // 使用统计必须按当前 Team 连接的展示 key 取团队项目名，不能继续识别已删除的 team-plan key。
  if (source?.id.startsWith("team:")) {
    return (
      source.label || snapshot?.sourceProvider.name || fallbackProviderName
    );
  }
  const providerName =
    snapshot?.sourceProvider.name ?? source?.label ?? fallbackProviderName;
  return providerName && !HIDDEN_CODING_PLAN_PROVIDER_NAMES.has(providerName)
    ? providerName
    : undefined;
}

export function hasCodingPlanCreditUsageData({
  summary,
  modelDataList,
  toolDataList,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
  modelDataList: CodingPlanModelData[];
  toolDataList: CodingPlanToolData[];
}): boolean {
  if (
    hasPositiveFiniteNumber(summary.totalCredits) ||
    hasPositiveFiniteNumber(summary.averageDailyCredits)
  ) {
    return true;
  }

  return (
    modelDataList.some(
      (item) =>
        hasPositiveFiniteNumber(item.totalCredits) ||
        hasPositiveFiniteSeries(item.creditsUsage) ||
        hasPositiveFiniteSeries(item.cachedInputCreditsUsage) ||
        hasPositiveFiniteSeries(item.uncachedInputCreditsUsage) ||
        hasPositiveFiniteSeries(item.outputCreditsUsage),
    ) ||
    toolDataList.some(
      (item) =>
        hasPositiveFiniteNumber(item.totalCredits) ||
        hasPositiveFiniteSeries(item.creditsUsage),
    )
  );
}

export function shouldShowCodingPlanUsageDetailSummary({
  summary,
  modelDataList,
  toolDataList,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
  modelDataList: CodingPlanModelData[];
  toolDataList: CodingPlanToolData[];
}): boolean {
  if (
    hasPositiveFiniteNumber(summary.totalCredits) ||
    hasPositiveFiniteNumber(summary.averageDailyCredits)
  ) {
    return true;
  }

  // 旧版 Coding Plan usage-detail 只有 token 用量时也可能返回 cache 命中率，
  // 但 BigModel 官网不展示积分摘要卡；只有真实 credits 数据才展示这组三卡。
  return hasCodingPlanCreditUsageData({ summary, modelDataList, toolDataList });
}

function hasPositiveFiniteNumber(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasPositiveFiniteSeries(values: number[] | undefined): boolean {
  return values?.some(hasPositiveFiniteNumber) === true;
}
