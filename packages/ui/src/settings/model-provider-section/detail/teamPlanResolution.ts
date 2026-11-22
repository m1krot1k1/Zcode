import { resolveModelProviderFamilySpecByProviderId } from "@zcode/shared";
import type { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import type { ModelProviderNavItem } from "../constants.js";

/** 套餐导航项：个人 Coding Plan 与 Team Plan 共用同一套详情渲染。 */
export type PlanNavItem = Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }>;

export function isPlanNavItem(
  item: ModelProviderNavItem | null,
): item is Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }> {
  return item?.type === "codingPlan" || item?.type === "teamPlan";
}

export function hasTeamPlanContext(item: ModelProviderNavItem | null): item is Extract<
  ModelProviderNavItem,
  { type: "teamPlan" }
> & {
  organizationId: string;
  projectId: string;
} {
  return (
    item?.type === "teamPlan" &&
    (item.organizationId?.trim().length ?? 0) > 0 &&
    (item.projectId?.trim().length ?? 0) > 0
  );
}

export function resolveTeamScopedPlanNavItem(
  item: Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }>,
  entitlement: ReturnType<typeof useUsageEntitlement>,
): Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }> {
  if (item.type !== "teamPlan" || !hasTeamPlanContext(item)) {
    return item;
  }
  if (
    item.availabilityReason === "credential-unavailable" &&
    entitlement.snapshot?.unavailableReason !== "no_plan"
  ) {
    // 已知 Project Key 不可用时，后续 quota loading/error 不能把真实原因改写成
    // “正在检查”或“团队套餐未分配”。Provider 配置仍由 Settings View 独立展示。
    return {
      ...item,
      status: "unavailable" as const,
      statusLabelId: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  const snapshot = entitlement.snapshot;
  if (!snapshot) {
    if (entitlement.loading) {
      return {
        ...item,
        // Team Plan 额度按组织 / 项目重新查询，切换团队时不能继续展示上一团队额度。
        status: "checking" as const,
        statusLabelId: undefined,
        availabilityReason: undefined,
        statusActive: false,
        quotaLimits: [],
      };
    }
    if (entitlement.error) {
      return {
        ...item,
        // 请求失败只证明权益状态未知，不能等价成服务端明确判定“团队套餐未分配”。
        status: "unavailable" as const,
        statusLabelId: undefined,
        availabilityReason: undefined,
        statusActive: false,
        quotaLimits: [],
      };
    }
    return item;
  }
  if (entitlement.loading && !snapshot.subscription) {
    return {
      ...item,
      status: "checking" as const,
      statusLabelId: undefined,
      availabilityReason: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  if (entitlement.error && !snapshot.subscription) {
    return {
      ...item,
      status: "unavailable" as const,
      statusLabelId: undefined,
      availabilityReason: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  const hasTeamSubscription = Boolean(snapshot.subscription?.details.length);
  const noPlan = snapshot.unavailableReason === "no_plan";
  const expired = noPlan && snapshot.teamPlanUnavailableReason === "expired";
  return {
    ...item,
    // 权益只来自团队订阅查询；quota 查询失败不能撤销订阅，也不能被解释成未分配。
    status: hasTeamSubscription ? ("purchased" as const) : ("unavailable" as const),
    planLevel: item.teamPlanName?.trim() || item.planLevel,
    currentProductId: item.currentProductId,
    subscriptionBillingCycle: null,
    subscriptionRenewTime: null,
    subscriptionExpireTime: null,
    subscriptionDetails: [],
    quotaLimits: snapshot.quota?.limits ?? [],
    statusLabelId:
      !hasTeamSubscription && noPlan
        ? expired
          ? "settings.modelProvider.codingPlan.status.teamExpired"
          : "settings.modelProvider.codingPlan.status.teamUnavailable"
        : undefined,
    statusMessage: noPlan ? undefined : item.statusMessage,
    availabilityReason:
      !hasTeamSubscription && noPlan ? (expired ? "expired" : "not-allocated") : undefined,
    statusActive: hasTeamSubscription,
  };
}

export function resolveTeamPlanInspectionAccess(
  item: Extract<ModelProviderNavItem, { type: "teamPlan" }>,
) {
  // 不可用套餐仍需查询失效原因；组织/项目身份来自团队导航，不能被执行可用性门禁清空。
  const family = resolveModelProviderFamilySpecByProviderId(item.presetId)?.id;
  const productId = item.currentProductId?.trim();
  const organizationId = item.organizationId?.trim();
  const projectId = item.projectId?.trim();
  if (!family || !productId || !organizationId || !projectId) return undefined;
  return {
    type: "zhipu-account" as const,
    family,
    planKind: "team-coding-plan" as const,
    productId,
    organizationId,
    projectId,
  };
}
