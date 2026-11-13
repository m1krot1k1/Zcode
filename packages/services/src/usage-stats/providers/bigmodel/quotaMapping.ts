/**
 * BigModel / Start Plan 额度与权益快照映射。
 *
 * 只做纯映射：把订阅、套餐、额度桶和 Team Plan 上下文转换成
 * UsageEntitlementSnapshot 的字段，不发请求、不读凭据。
 */
import type {
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageQuotaLimit,
  ZCodeAccountAccess,
} from "@zcode/shared";
import type {
  ZaiStartPlanBalanceEnvelope,
  ZaiStartPlanPlan,
} from "../../../model-provider/zaiStartPlanBilling.js";
import { log } from "./constants.js";
import {
  formatUnixSecondsAsIso,
  parseNumber,
  parseUnixSeconds,
  readNonEmptyString,
} from "./parsing.js";
import type { ResolvedQuotaAuthorization, TeamPlanContext, ZaiStartPlanBalance } from "./types.js";

export function resolveTeamPlanContext(accountAccess: ZCodeAccountAccess): TeamPlanContext | null {
  return accountAccess.planKind === "team-coding-plan"
    ? {
        organizationId: accountAccess.organizationId,
        projectId: accountAccess.projectId,
        family: accountAccess.family,
      }
    : null;
}

export function buildUsageEntitlementContextFromRequest(
  request: Pick<UsageEntitlementRequest, "accountAccess">,
): UsageEntitlementSnapshot["context"] {
  if (
    !request.accountAccess ||
    !("planKind" in request.accountAccess) ||
    request.accountAccess.planKind !== "team-coding-plan"
  ) {
    return { scope: "personal" };
  }
  return {
    scope: "team",
    organizationId: request.accountAccess.organizationId,
    projectId: request.accountAccess.projectId,
  };
}

export function buildUsageEntitlementContext(
  resolved: ResolvedQuotaAuthorization,
  subscription: UsageEntitlementSnapshot["subscription"],
): UsageEntitlementSnapshot["context"] {
  if (!resolved.teamContext) {
    return {
      scope: "personal",
      productId: subscription?.details[0]?.productId || null,
      displayName: subscription?.details[0]?.productName || null,
    };
  }
  return {
    scope: "team",
    organizationId: resolved.teamContext.organizationId,
    projectId: resolved.teamContext.projectId,
    productId: subscription?.details[0]?.productId || null,
    displayName: subscription?.details[0]?.productName || null,
  };
}

export function buildSubscriptionSnapshot(summary: {
  productId: string;
  productName: string;
  billingCycle: string | null;
  renewTime: string | null;
  expireTime: string | null;
}): UsageEntitlementSnapshot["subscription"] {
  return {
    identityType: "unknown",
    identityMasked: null,
    details: [{ ...summary, purchaseTime: null, beginTime: null }],
  };
}

export function buildZaiStartPlanSubscription(
  plans: ZaiStartPlanPlan[] | undefined,
): UsageEntitlementSnapshot["subscription"] {
  const activePlans = (plans ?? []).filter(
    (plan) => readNonEmptyString(plan.status)?.toLowerCase() === "active",
  );
  return {
    identityType: "unknown",
    identityMasked: null,
    details: activePlans.map((plan) => ({
      productId: readNonEmptyString(plan.plan_id) ?? "",
      productName: readNonEmptyString(plan.name) ?? "编程套餐",
      purchaseTime: null,
      beginTime: formatUnixSecondsAsIso(plan.starts_at),
      billingCycle: pickZaiStartPlanBillingCycle(plan),
      // Start Plan 卡片不展示套餐级续期时间：额度桶刷新时间由每个 limit 的
      // nextResetTime（balance.expires_at）表达，套餐到期由 expireTime（ends_at）表达。
      renewTime: null,
      expireTime: formatUnixSecondsAsIso(plan.ends_at),
      entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
        const entitlementId = readNonEmptyString(entitlement.entitlement_id);
        if (!entitlementId) return [];
        return [
          {
            entitlementId,
            showName: readNonEmptyString(entitlement.show_name),
            effectiveTime: formatUnixSecondsAsIso(entitlement.effective_at),
          },
        ];
      }),
    })),
  };
}

/**
 * tripwire：服务端契约保证 balances 只属于 active plans、每个桶都能按
 * plan_id 归属到套餐卡。出现无归属桶（含缺失 plan_id 的桶）说明契约被破坏——
 * 设置页多卡路径会静默丢弃这些桶，必须在 provider 层显式暴露，避免「额度去哪了」
 * 类问题无迹可查。正常数据下此日志零输出，用 warn 保证生产环境可见。
 */
export function warnOnUnattributedStartPlanBuckets(
  plans: ZaiStartPlanPlan[] | undefined,
  balances: ZaiStartPlanBalance[] | undefined,
): void {
  const activePlanIds = new Set(
    (plans ?? [])
      .filter((plan) => readNonEmptyString(plan.status)?.toLowerCase() === "active")
      .map((plan) => readNonEmptyString(plan.plan_id))
      .filter((planId): planId is string => Boolean(planId)),
  );
  const orphanBuckets = (balances ?? []).filter((balance) => {
    const planId = readNonEmptyString(balance.plan_id);
    return !planId || !activePlanIds.has(planId);
  });
  if (orphanBuckets.length === 0) {
    return;
  }
  log.warn(undefined, "billing/balance 返回无法归属到 active 套餐的额度桶", {
    orphanCount: orphanBuckets.length,
    orphanPlanIds: orphanBuckets.map((balance) => balance.plan_id ?? null),
    activePlanIds: [...activePlanIds],
  });
}

export function buildZaiStartPlanRemaining(
  balances: ZaiStartPlanBalance[] | undefined,
): UsageEntitlementSnapshot["remaining"] {
  const limits = normalizeZaiStartPlanBalanceLimits(balances);
  if (limits.length === 0) {
    return null;
  }

  const total = limits.reduce((sum, limit) => sum + (limit.number ?? 0), 0);
  const remaining = limits.reduce((sum, limit) => sum + (limit.remaining ?? 0), 0);
  return {
    count: remaining,
    isShow: true,
    percentage: total > 0 ? remaining / total : undefined,
    nextResetTime:
      limits
        .map((limit) => limit.nextResetTime)
        .filter((value): value is number => typeof value === "number")
        .sort((left, right) => left - right)[0] ?? null,
  };
}

export function buildZaiStartPlanQuota(
  balances: ZaiStartPlanBalance[] | undefined,
  plans?: ZaiStartPlanPlan[],
): UsageEntitlementSnapshot["quota"] {
  const limits = normalizeZaiStartPlanBalanceLimits(balances, plans);
  if (limits.length === 0) {
    return null;
  }

  return {
    level: "Start",
    limits,
  };
}

export function normalizeZaiStartPlanBalanceLimits(
  balances: ZaiStartPlanBalance[] | undefined,
  plans?: ZaiStartPlanPlan[],
): UsageQuotaLimit[] {
  if (!Array.isArray(balances)) {
    return [];
  }

  return balances
    .map((balance) => {
      const total = parseNumber(balance.total_units);
      const used = parseNumber(balance.used_units);
      // Start Plan 余额卡必须展示后端给出的 remaining_units。
      // available_units 会再扣除进行中请求的 reserved_units，不能作为“剩余”兜底。
      const remaining = parseNumber(balance.remaining_units);
      if (total === null && used === null && remaining === null) {
        return null;
      }
      // 额度桶的真实重置边界由 balance.expires_at 表达；服务端契约保证每个桶都带该字段。
      const nextResetSeconds = parseUnixSeconds(balance.expires_at);
      const capabilityLabels = normalizeZaiStartPlanCapabilities(balance.capabilities);
      const capabilityType = readNonEmptyString(capabilityLabels.join(", "));
      const displayName = readNonEmptyString(balance.show_name);
      const planId = readNonEmptyString(balance.plan_id);
      const userPlanId = readNonEmptyString(balance.user_plan_id);
      const plan = plans?.find((candidate) =>
        userPlanId && candidate.user_plan_id
          ? candidate.user_plan_id === userPlanId
          : candidate.plan_id === planId,
      );
      const period = plan?.entitlements?.find(
        (entry) => entry.entitlement_id === balance.entitlement_id,
      )?.period;
      const periodStart = parseUnixSeconds(balance.period_start);
      const periodEnd = parseUnixSeconds(balance.period_end);

      return {
        // 旧映射丢弃 bucket 和周期字段，Renderer 只能用变化的余额去重，导致反复提醒。
        bucketId: readNonEmptyString(balance.bucket_id) ?? undefined,
        userPlanId: userPlanId ?? undefined,
        periodStart: periodStart === null ? undefined : periodStart * 1000,
        periodEnd: periodEnd === null ? undefined : periodEnd * 1000,
        period: readNonEmptyString(period) ?? undefined,
        meter: readNonEmptyString(balance.meter) ?? undefined,
        unitType: readNonEmptyString(balance.unit_type) ?? undefined,
        type:
          readNonEmptyString(balance.entitlement_id) ??
          capabilityType ??
          readNonEmptyString(balance.meter) ??
          "model_usage",
        // planId 用于设置页按套餐卡片分组额度桶；服务端契约保证每个桶都携带 plan_id。
        ...(planId ? { planId } : {}),
        unit: total ?? undefined,
        number: total ?? undefined,
        usage: used ?? undefined,
        currentValue: used ?? undefined,
        remaining: remaining ?? undefined,
        percentage:
          total !== null && remaining !== null && total > 0 ? remaining / total : undefined,
        nextResetTime: nextResetSeconds === null ? undefined : nextResetSeconds * 1000,
        usageDetails: capabilityLabels.map((modelCode) => ({
          modelCode,
          // 两个 Start Plan 的 Today's balance 接口已经返回面向用户的 show_name。
          // 继续从 capabilities 推导会把 GLM-5-Turbo 显示成 GLM-5Turbo，并且丢失服务端名称语义。
          ...(displayName ? { displayName } : {}),
          usage: used ?? 0,
        })),
      };
    })
    .filter((limit): limit is NonNullable<typeof limit> => limit !== null);
}

export function normalizeZaiStartPlanCapabilities(capabilities: string[] | undefined): string[] {
  if (!Array.isArray(capabilities)) {
    return [];
  }

  return capabilities
    .map((capability) =>
      capability.startsWith("model:") ? capability.slice("model:".length) : capability,
    )
    .filter((capability) => capability.trim().length > 0);
}

export function pickCurrentZaiStartPlan(
  plans: ZaiStartPlanPlan[] | undefined,
): ZaiStartPlanPlan | null {
  return (
    plans?.find((plan) => {
      const status = readNonEmptyString(plan.status)?.toLowerCase();
      const planId = readNonEmptyString(plan.plan_id)?.toLowerCase();
      const name = readNonEmptyString(plan.name)?.toLowerCase();
      return (
        status === "active" && (isZaiStartPlanIdentity(planId) || isZaiStartPlanIdentity(name))
      );
    }) ?? null
  );
}

export function readZaiStartPlanBalances(
  payload: ZaiStartPlanBalanceEnvelope,
): ZaiStartPlanBalance[] | undefined {
  return payload.data?.balances as ZaiStartPlanBalance[] | undefined;
}

export function summarizeStartPlans(plans: ZaiStartPlanPlan[] | undefined): Array<{
  name: string | null;
  plan_id: string | null;
  status: string | null;
}> {
  return (plans ?? []).map((plan) => ({
    name: plan.name ?? null,
    plan_id: plan.plan_id ?? null,
    status: plan.status ?? null,
  }));
}

export function summarizeStartPlanBalances(balances: ZaiStartPlanBalance[] | undefined): Array<{
  entitlement_id: string | null;
  show_name: string | null;
  total_units: number | string | null;
  used_units: number | string | null;
  remaining_units: number | string | null;
  available_units: number | string | null;
  reserved_units: number | string | null;
}> {
  return (balances ?? []).map((balance) => ({
    entitlement_id: balance.entitlement_id ?? null,
    show_name: balance.show_name ?? null,
    total_units: balance.total_units ?? null,
    used_units: balance.used_units ?? null,
    remaining_units: balance.remaining_units ?? null,
    available_units: balance.available_units ?? null,
    reserved_units: balance.reserved_units ?? null,
  }));
}

export function isZaiStartPlanIdentity(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.includes("start-plan") || value.includes("start plan");
}

export function pickZaiStartPlanBillingCycle(plan: ZaiStartPlanPlan): string | null {
  return (
    plan.entitlements
      ?.map((item) => readNonEmptyString(item.period))
      .find((period): period is string => Boolean(period)) ?? null
  );
}
