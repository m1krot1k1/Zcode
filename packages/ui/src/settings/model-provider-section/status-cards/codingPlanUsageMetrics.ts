// StatusCards 拆分：Coding Plan 额度项的查找、剩余百分比与模型名格式化。
import type { UsageQuotaLimit } from "@zcode/shared";
import { isSameLimitCategory } from "@/lib/codingPlanQuotaPresentation.js";
import { formatQuotaModelDisplayName } from "../quotaModelDisplayName.js";

export function findUsageLimit(
  limits: UsageQuotaLimit[],
  type: UsageQuotaLimit["type"],
  unit: number,
  number?: number,
): UsageQuotaLimit | undefined {
  return limits.find(
    (limit) =>
      // zai team plan 返回 CREDIT_LIMIT，bigmodel 返回 TOKENS_LIMIT，
      // unit/number 语义一致。用 isSameLimitCategory 让两者等价命中。
      isSameLimitCategory(limit.type, type) &&
      limit.unit === unit &&
      (number == null || limit.number === number),
  );
}

export function hasDisplayableCodingPlanUsageLimits(limits: UsageQuotaLimit[]): boolean {
  return Boolean(
    findUsageLimit(limits, "TOKENS_LIMIT", 3, 5) ||
    findUsageLimit(limits, "TOKENS_LIMIT", 6) ||
    findUsageLimit(limits, "TIME_LIMIT", 5, 1) ||
    limits.some(isDisplayableUsageLimit),
  );
}

export function isDisplayableUsageLimit(limit: UsageQuotaLimit): boolean {
  return (
    typeof limit.percentage === "number" ||
    typeof limit.remaining === "number" ||
    typeof limit.currentValue === "number" ||
    typeof limit.usage === "number"
  );
}

export function resolveLimitRemainingPercentage(limit: UsageQuotaLimit | undefined): number | null {
  const usedPercentage = normalizeUsagePercentage(limit?.percentage);
  if (usedPercentage !== null) {
    // Coding Plan quota 接口的 percentage 是已用百分比，
    // Plan Card 属于“剩余额度”视图，需要和侧边栏剩余用量菜单一致反转展示。
    return Math.max(0, Math.min(100, 100 - usedPercentage));
  }
  const remaining = limit?.remaining;
  const total = limit?.number;
  if (
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    typeof total === "number" &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return Math.max(0, Math.min(100, (remaining / total) * 100));
  }
  return null;
}

function normalizeUsagePercentage(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

export function formatRemainingPercentage(locale: string, value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(Math.max(0, Math.min(100, value)))}%`;
}

export function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  return Array.from(new Set(modelNames)).join(" / ");
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode
    .replace(/^model:/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return normalized || modelCode;
}
