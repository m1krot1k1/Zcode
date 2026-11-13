// StatusCards 拆分：Coding Plan 状态卡的纯模型逻辑（标题、套餐档位判定）。
import type {
  UsageEntitlementSubscriptionDetail,
  UsageQuotaLimit,
} from "@zcode/shared";

export function hasStartPlanEntitlementQuota(
  entitlements: UsageEntitlementSubscriptionDetail["entitlements"],
  limits: readonly UsageQuotaLimit[],
): boolean {
  const entitlementIds = new Set(
    (entitlements ?? [])
      .map((entitlement) => entitlement.entitlementId.trim().toLowerCase())
      .filter(Boolean),
  );
  if (entitlementIds.size === 0) {
    return limits.length > 0;
  }
  return limits.some((limit) => entitlementIds.has(limit.type.trim().toLowerCase()));
}

export function resolveCodingPlanStatusCardTitle({
  isPurchased,
  isUnavailable: _isUnavailable = false,
  isStartPlanProvider,
  inactivePlanTitle,
  rawPlanLevel,
  displayPlanLevel,
  startPlanTitle,
  codingPlanTitle,
}: {
  isPurchased: boolean;
  isUnavailable?: boolean;
  isStartPlanProvider: boolean;
  inactivePlanTitle?: string | null;
  rawPlanLevel: string;
  displayPlanLevel: string;
  startPlanTitle: string;
  codingPlanTitle: string;
}): string {
  if (!isPurchased) {
    return inactivePlanTitle?.trim() || (isStartPlanProvider ? startPlanTitle : codingPlanTitle);
  }

  if (isStartPlanProvider) {
    // Start provider 偶尔会承载同品牌 paid Coding Plan 的权益快照。
    // 只有真实 Start 权益继续显示 Start Plan；否则必须露出后端权益名，避免付费用户看到免费套餐标题。
    return isStartPlanEntitlementName(rawPlanLevel)
      ? startPlanTitle
      : displayPlanLevel || startPlanTitle;
  }

  return displayPlanLevel || codingPlanTitle;
}

function isStartPlanEntitlementName(planLevel: string): boolean {
  const normalized = planLevel.trim().toLowerCase();
  return (
    normalized === "start" || normalized === "start plan" || normalized.endsWith(" start plan")
  );
}

export function isMaxCodingPlanLevel(planLevel: string): boolean {
  return /(^|[\s_-])MAX($|[\s_-])/i.test(planLevel);
}
