import { useCallback, useEffect, useState } from "react";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useCodingPlanUsageStats } from "@/hooks/useUsageStats.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import type { CodingPlanUsageSource } from "@/lib/codingPlanUsageSources.js";
import type { CodingPlanUsageTrendRange } from "./types.js";

/**
 * Состояние Coding Plan usage-панели: источники, entitlements и статистика.
 *
 * Порядок хуков сохранён как в исходном компоненте: intl → range → три
 * entitlement-запроса (zai individual, bigmodel individual, team) → usage stats
 * → refresh-колбэки → синхронизация entitlement при открытии.
 */
export function useCodingPlanUsagePanelState({
  loadingSources,
  selectedSource,
}: {
  loadingSources: boolean;
  selectedSource?: CodingPlanUsageSource | null;
}) {
  const { intl } = useZCodeIntl();
  const [range, setRange] = useState<CodingPlanUsageTrendRange>("7d");
  const effectiveSource = selectedSource ?? null;
  const effectiveProviderId = effectiveSource?.providerId;
  const effectiveSourceIsTeamPlan = Boolean(
    effectiveSource &&
    "planKind" in effectiveSource.accountAccess &&
    effectiveSource.accountAccess.planKind === "team-coding-plan",
  );
  const individualProviderFingerprint = effectiveSourceIsTeamPlan
    ? ""
    : effectiveSource?.accountAccess
      ? JSON.stringify([
          effectiveSource.providerId,
          effectiveSource.accountAccess,
        ])
      : "";
  const zaiEntitlement = useUsageEntitlement({
    // 原只按 zai providerId 启用，没区分个人/团队，team source 会被
    // 当成个人 zaiEntitlement 查询（缺 org/project）。加上 !effectiveSourceIsTeamPlan
    // 后，zai team source 改走 teamEntitlement 分支。
    enabled:
      !loadingSources &&
      effectiveProviderId ===
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan &&
      Boolean(individualProviderFingerprint) &&
      !effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: individualProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const bigmodelEntitlement = useUsageEntitlement({
    enabled:
      !loadingSources &&
      effectiveProviderId ===
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan &&
      Boolean(individualProviderFingerprint) &&
      !effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId:
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: individualProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const teamEntitlement = useUsageEntitlement({
    // 原硬绑 bigmodelCodingPlan providerId，zai team source 永远进不来。
    // 改为按 effectiveSourceIsTeamPlan 路由，providerId 按 effectiveSource 动态取，
    // zai team → zaiCodingPlan，bigmodel team → bigmodelCodingPlan。
    enabled: !loadingSources && effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId:
      effectiveProviderId ??
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: effectiveSource?.id,
    refreshOnMount: false,
  });
  // 原 zai providerId 一律走 zaiEntitlement（个人），把 team plan 漏掉。
  // 改为先判 team plan，命中走 teamEntitlement；否则按 providerId 走个人分支。
  const effectiveEntitlement = effectiveSourceIsTeamPlan
    ? teamEntitlement
    : effectiveProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
      ? zaiEntitlement
      : bigmodelEntitlement;
  const effectiveEntitlementSnapshot = effectiveEntitlement.snapshot;
  const effectiveEntitlementRefresh = effectiveEntitlement.refresh;
  const handleResetEntitlementRefresh = useCallback(async () => {
    await effectiveEntitlementRefresh?.({ force: true, silent: true });
  }, [effectiveEntitlementRefresh]);
  const {
    snapshot,
    loading,
    error,
    refresh: refreshCodingPlanUsage,
  } = useCodingPlanUsageStats(range, {
    enabled: !loadingSources && Boolean(effectiveProviderId),
    preferredProviderId: effectiveProviderId,
    accountAccess: effectiveSource?.accountAccess,
    customStartDate: null,
    customEndDate: null,
  });
  const handleUsageStatsRefresh = useCallback(async () => {
    await Promise.all([
      refreshCodingPlanUsage({ force: true }),
      effectiveEntitlementRefresh?.({ force: true, silent: true }),
    ]);
  }, [effectiveEntitlementRefresh, refreshCodingPlanUsage]);
  useEffect(() => {
    if (!effectiveProviderId || !effectiveEntitlementRefresh) {
      return;
    }

    // Usage 页的 Quota Remaining 优先展示 entitlement quota。
    // 打开 Coding Plan Usage 页面时，如果只依赖共享 TTL，可能继续显示 sidebar/input 留下的旧快照。
    void effectiveEntitlementRefresh({ silent: true, reason: "access" });
  }, [effectiveEntitlementRefresh, effectiveProviderId]);

  return {
    intl,
    range,
    setRange,
    effectiveSource,
    effectiveProviderId,
    effectiveEntitlementSnapshot,
    snapshot,
    loading,
    error,
    handleResetEntitlementRefresh,
    handleUsageStatsRefresh,
  };
}
