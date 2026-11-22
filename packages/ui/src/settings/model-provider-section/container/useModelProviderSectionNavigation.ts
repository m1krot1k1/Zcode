import { useEffect, useMemo } from "react";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { logger } from "@/logger.js";
import {
  PRESET_PROVIDER_SPECS,
  PRESET_SUBSCRIPTION_TIMEOUT_MS,
} from "../constants.js";
import { reportPresetSubscriptionSuccess } from "../oauthActions.js";
import { useCodingPlanAccessRefresh } from "../useCodingPlanEntitlements.js";
import { useModelProviderNavigation } from "../useModelProviderNavigation.js";
import { shouldShowPresetProviderForActiveOAuth } from "./helpers.js";
import type { ModelProviderSectionCodingPlan } from "./useModelProviderSectionCodingPlan.js";
import type { ModelProviderSectionEnvironment } from "./useModelProviderSectionEnvironment.js";

export function useModelProviderSectionNavigation({
  environment,
  codingPlan,
}: {
  environment: ModelProviderSectionEnvironment;
  codingPlan: ModelProviderSectionCodingPlan;
}) {
  const {
    platform,
    modelProviders,
    displayOrder,
    loading,
    selectedNodeKey,
    setSelectedNodeKey,
    presetSubscriptionProviderId,
    setPresetSubscriptionProviderId,
    codingPlanDisconnectProviderId,
    setCodingPlanStatusSyncProviderId,
    codeIntelligenceService,
    codeIndexWorkspaceRef,
    entitledAccountProviderIds,
    providerSettingsView,
    intl,
  } = environment;
  const {
    activeOAuthProvider,
    presetSubscriptionCompletionProviderIdRef,
    pendingConnectionSelections,
    sharedSettings,
    effectiveConnectionSelections,
    showPurchasedTeamPlanFallback,
    effectiveProviderFamilyDomain,
    codingPlanEntitlements,
    refreshCodingPlanEntitlements,
    refreshProviderPanelAfterAuthChange,
    syncCodingPlanProviderOnce,
    subscribedTeamProducts,
    familyConnectionSettingsFailed,
    sharedSettingsLoading,
  } = codingPlan;

  const presetProviders = useMemo(
    () =>
      PRESET_PROVIDER_SPECS.filter((preset) =>
        shouldShowPresetProviderForActiveOAuth(preset.id, effectiveProviderFamilyDomain),
      ).map((preset) => ({
        ...preset,
        provider: modelProviders.find((provider) => provider.providerId === preset.id) ?? null,
      })),
    [effectiveProviderFamilyDomain, modelProviders],
  );

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    const accountEntitled = Boolean(
      resolveEntitledAccountProviderAccess(providerSettingsView, presetSubscriptionProviderId),
    );
    if (accountEntitled) {
      if (presetSubscriptionCompletionProviderIdRef.current === presetSubscriptionProviderId) {
        return;
      }

      presetSubscriptionCompletionProviderIdRef.current = presetSubscriptionProviderId;
      void (async () => {
        void reportPresetSubscriptionSuccess({
          platform,
          presetId: presetSubscriptionProviderId,
        });
        try {
          // Bugfix: 连接/重新授权成功后账号连接状态会先于本轮权益接口结果就绪。
          // pending 必须等本轮权益刷新完成后再清，否则 Plan Card 会短暂显示旧套餐态或非 loading 状态。
          await refreshProviderPanelAfterAuthChange({});
        } finally {
          presetSubscriptionCompletionProviderIdRef.current = null;
          setCodingPlanStatusSyncProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
          setPresetSubscriptionProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
        }
      })();
    }
  }, [
    platform,
    presetSubscriptionProviderId,
    providerSettingsView,
    refreshProviderPanelAfterAuthChange,
  ]);

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setCodingPlanStatusSyncProviderId((current) =>
        current === presetSubscriptionProviderId ? null : current,
      );
      setPresetSubscriptionProviderId((current) => {
        if (current !== presetSubscriptionProviderId) {
          return current;
        }
        return null;
      });
    }, PRESET_SUBSCRIPTION_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [presetSubscriptionProviderId]);

  const { navigationGroups, navigationItems, selectedNavItem, navigationUnavailable } =
    useModelProviderNavigation({
      presetProviders,
      modelProviders,
      entitledAccountProviderIds,
      modelProvidersLoading: loading,
      displayOrder,
      codingPlanEntitlements,
      subscribedTeamProducts,
      providerFamilyDomain: effectiveProviderFamilyDomain,
      connectionSelections: effectiveConnectionSelections,
      pendingConnectionSelections,
      showPurchasedTeamPlanFallback,
      familyConnectionSettingsLoading: sharedSettingsLoading && sharedSettings === null,
      familyConnectionSettingsFailed,
      selectedNodeKey,
      setSelectedNodeKey,
      codeIntelligenceAvailable: Boolean(codeIntelligenceService && codeIndexWorkspaceRef),
      intl,
    });
  const selectedPlanAccessKey =
    selectedNavItem?.type === "codingPlan" || selectedNavItem?.type === "teamPlan"
      ? selectedNavItem.key
      : null;
  // 套餐卡每次被用户打开时按需校正；共享 freshness window 保证一分钟内切换返回
  // 不会放大 quota 请求。权益展示更新不等于用户重新打开套餐。
  useCodingPlanAccessRefresh({
    refresh: refreshCodingPlanEntitlements,
    selectedPlanKey: selectedPlanAccessKey,
  });

  useEffect(() => {
    if (selectedNavItem?.type !== "codingPlan" && selectedNavItem?.type !== "teamPlan") {
      return;
    }
    if (
      activeOAuthProvider !== selectedNavItem.oauthProviderId ||
      presetSubscriptionProviderId === selectedNavItem.presetId ||
      codingPlanDisconnectProviderId === selectedNavItem.presetId
    ) {
      return;
    }

    const accountEntitled = selectedNavItem.accountEntitled === true;
    if (accountEntitled) {
      return;
    }

    // 这是首次水合校正，不是由详情 status 驱动的状态机。
    // 同一 provider/OAuth 组合只执行一次，checking 与最终状态来回切换不能重启刷新。
    void syncCodingPlanProviderOnce(selectedNavItem).catch((error) => {
      logger.warn("[ModelProviderSection] 自动同步 Coding Plan provider 失败", {
        providerId: selectedNavItem.presetId,
        error,
      });
    });
  }, [
    activeOAuthProvider,
    codingPlanDisconnectProviderId,
    presetSubscriptionProviderId,
    selectedNavItem,
    syncCodingPlanProviderOnce,
  ]);

  return {
    presetProviders,
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable,
    selectedPlanAccessKey,
  };
}

export type ModelProviderSectionNavigation = ReturnType<typeof useModelProviderSectionNavigation>;
