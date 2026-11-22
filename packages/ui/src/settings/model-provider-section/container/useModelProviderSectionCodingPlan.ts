import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveProviderFamilyDomainFromOAuthProvider,
  type BuiltinModelProviderId,
  type OAuthProviderId,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import { refreshProviderPanelAfterAuthChange as refreshModelProviderPanelAfterAuthChange } from "../modelProviderActions.js";
import { useCodingPlanEntitlements } from "../useCodingPlanEntitlements.js";
import {
  clearPendingProviderFamilyConnectionSelection,
  resolveCodingPlanProviderSyncAttemptKey,
} from "./helpers.js";
import type { ModelProviderSectionEnvironment } from "./useModelProviderSectionEnvironment.js";
import type { CodingPlanConnectionNavItem } from "./types.js";

export function useModelProviderSectionCodingPlan({
  environment,
}: {
  environment: ModelProviderSectionEnvironment;
}) {
  const {
    credentialService,
    refresh,
    providerSettingsView,
    providerConnectionRefreshSignal,
    codingPlanStatusSyncProviderId,
    setCodingPlanStatusSyncProviderId,
    setCodingPlanProductsRefreshToken,
  } = environment;
  const [
    codingPlanPurchaseTokenAuthenticatedByProviderId,
    setCodingPlanPurchaseTokenAuthenticatedByProviderId,
  ] = useState<Partial<Record<BuiltinModelProviderId, boolean>>>({});
  const [activeOAuthProvider, setActiveOAuthProvider] = useState<OAuthProviderId | null>(null);
  const [pendingConnectionSelections, setPendingConnectionSelections] =
    useState<ProviderFamilyConnectionSelectionSettings>({});
  const presetSubscriptionCompletionProviderIdRef = useRef<BuiltinModelProviderId | null>(null);
  const codingPlanStatusSyncAttemptsRef = useRef(
    new Map<string, "inFlight" | "succeeded" | "failed">(),
  );
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const setUser = useZCodeStore((state) => state.setUser);
  const oauthError = useZCodeStore((state) => state.oauthError);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const {
    settings: sharedSettings,
    loading: sharedSettingsLoading,
    error: sharedSettingsError,
    update: updateSharedSettings,
  } = useSettings();
  const authenticatedEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "bigmodel",
  });
  // zai 与 bigmodel Team Plan 对称化。原仅 bigmodel 调 hook，
  // zai 团队订阅永远拉不到、也无法展示对应团队。
  // zai 独立调 hook（zai family 走 zai provider），下游合并两 family 的订阅产品。
  const authenticatedZaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "zai",
  });
  const refreshAuthenticatedEnterpriseProducts = useCallback(async () => {
    await Promise.all([
      authenticatedEnterpriseProducts.refresh(),
      authenticatedZaiEnterpriseProducts.refresh(),
    ]);
  }, [authenticatedEnterpriseProducts, authenticatedZaiEnterpriseProducts]);
  const subscribedTeamProducts = useMemo(
    () => [
      ...(authenticatedEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(authenticatedZaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [
      authenticatedEnterpriseProducts.snapshot?.productList,
      authenticatedZaiEnterpriseProducts.snapshot?.productList,
    ],
  );
  const connectionSelections = sharedSettings?.providerFamilyConnectionSelections ?? {};
  const familyConnectionSettingsFailed = sharedSettingsError !== null && sharedSettings === null;
  const effectiveConnectionSelections = useMemo(
    () => ({
      ...connectionSelections,
      ...pendingConnectionSelections,
    }),
    [connectionSelections, pendingConnectionSelections],
  );
  // 原仅检查 bigmodel selectedKey 是否为 team plan，zai team key
  // 永远不会触发已购团队 fallback（断裂）。改为任一 family 有持久化 team key 即显示。
  const showPurchasedTeamPlanFallback = Boolean(
    effectiveConnectionSelections.bigmodel?.kind === "team-coding-plan" ||
    effectiveConnectionSelections.zai?.kind === "team-coding-plan",
  );
  const effectiveProviderFamilyDomain =
    sharedSettings?.providerFamilyDomain ??
    resolveProviderFamilyDomainFromOAuthProvider(activeOAuthProvider);
  const { entitlements: codingPlanEntitlements, refresh: refreshCodingPlanEntitlements } =
    useCodingPlanEntitlements({
      providerSettingsView,
      connectionSelections: effectiveConnectionSelections,
      suppressProviderFingerprintAutoRefresh: codingPlanStatusSyncProviderId !== null,
    });
  useEffect(() => {
    setPendingConnectionSelections((current) => {
      let next = current;
      for (const [familyId, selection] of Object.entries(current) as Array<
        [ProviderFamilyDomain, ProviderFamilyConnectionSelection]
      >) {
        if (JSON.stringify(connectionSelections[familyId]) !== JSON.stringify(selection)) {
          continue;
        }
        // API Key/Coding Plan tab 点击后 settings 落盘和 hook 刷新是异步的。
        // 等持久化快照真的追上再清 pending，避免旧 mode 把选中项短暂纠偏回去造成闪烁。
        next = clearPendingProviderFamilyConnectionSelection(next, familyId, selection);
      }
      return next;
    });
  }, [connectionSelections]);

  const refreshCodingPlanProducts = useCallback(() => {
    setCodingPlanProductsRefreshToken((current) => current + 1);
  }, []);

  const refreshCodingPlanPurchaseTokenState = useCallback(
    async (
      options: {
        clearUserWhenLoggedOut?: boolean;
        shouldApply?: () => boolean;
      } = {},
    ) => {
      const [activeProvider, zaiToken, bigmodelToken] = await Promise.all([
        credentialService.load("oauth:active_provider"),
        credentialService.load(`oauth:${ZAI_PROVIDER_ID}:access_token`),
        credentialService.load(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`),
      ]);
      if (options.shouldApply && !options.shouldApply()) {
        return null;
      }
      const normalizedActiveProvider =
        activeProvider === ZAI_PROVIDER_ID || activeProvider === BIGMODEL_PROVIDER_ID
          ? activeProvider
          : null;
      setActiveOAuthProvider(normalizedActiveProvider);
      setCodingPlanPurchaseTokenAuthenticatedByProviderId({
        [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
      });
      if (!normalizedActiveProvider && options.clearUserWhenLoggedOut) {
        // provider Unlink 已等价于 App logout。
        // 服务端 token 已清理后，设置页也要同步清掉 Zustand user，否则侧边栏会一直显示旧登录态直到重启。
        setUser(null);
        setOAuthError(null);
      }
      return normalizedActiveProvider;
    },
    [credentialService, setOAuthError, setUser],
  );

  const refreshProviderPanelAfterAuthChange = useCallback(
    async ({
      refreshPlanSnapshots = true,
      refreshReason = "auth",
    }: {
      refreshPlanSnapshots?: boolean;
      refreshReason?: "auth" | "purchase";
    }) => {
      await refreshModelProviderPanelAfterAuthChange({
        refreshModelProviders: refresh,
        refreshCodingPlanEntitlements: () =>
          refreshCodingPlanEntitlements({ force: true, reason: refreshReason }),
        refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
        refreshCodingPlanProducts,
        refreshPurchaseTokenState: refreshCodingPlanPurchaseTokenState,
        refreshPlanSnapshots,
      });
    },
    [
      refresh,
      refreshAuthenticatedEnterpriseProducts,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
      refreshModelProviderPanelAfterAuthChange,
    ],
  );

  const syncCodingPlanProviderOnce = useCallback(
    async (
      item: CodingPlanConnectionNavItem,
      options: { userTransition?: boolean; refreshPlanSnapshots?: boolean } = {},
    ) => {
      const attemptKey = resolveCodingPlanProviderSyncAttemptKey({
        activeOAuthProvider,
        oauthProviderId: item.oauthProviderId,
        providerId: item.presetId,
      });
      if (!attemptKey) {
        return;
      }
      if (
        options.userTransition !== true &&
        codingPlanStatusSyncAttemptsRef.current.has(attemptKey)
      ) {
        return;
      }
      codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "inFlight");
      setCodingPlanStatusSyncProviderId(item.presetId);
      try {
        await refreshProviderPanelAfterAuthChange({
          refreshPlanSnapshots: options.refreshPlanSnapshots,
        });
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "succeeded");
      } catch (error) {
        // 失败状态必须显式保留。自动水合看到 failed 后不循环重试，
        // 用户再次点击同一连接项时则可以按 failed 状态主动恢复。
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "failed");
        throw error;
      } finally {
        setCodingPlanStatusSyncProviderId((current) =>
          current === item.presetId ? null : current,
        );
      }
    },
    [activeOAuthProvider, refreshProviderPanelAfterAuthChange],
  );

  useEffect(() => {
    let disposed = false;

    void refreshCodingPlanPurchaseTokenState({
      shouldApply: () => !disposed,
    });

    return () => {
      disposed = true;
    };
  }, [providerConnectionRefreshSignal, refreshCodingPlanPurchaseTokenState]);

  return {
    authenticatedEnterpriseProducts,
    authenticatedZaiEnterpriseProducts,
    codingPlanPurchaseTokenAuthenticatedByProviderId,
    activeOAuthProvider,
    pendingConnectionSelections,
    setPendingConnectionSelections,
    presetSubscriptionCompletionProviderIdRef,
    codingPlanStatusSyncAttemptsRef,
    requestLoginEntry,
    setUser,
    oauthError,
    setOAuthError,
    sharedSettings,
    sharedSettingsLoading,
    sharedSettingsError,
    updateSharedSettings,
    refreshAuthenticatedEnterpriseProducts,
    subscribedTeamProducts,
    connectionSelections,
    familyConnectionSettingsFailed,
    effectiveConnectionSelections,
    showPurchasedTeamPlanFallback,
    effectiveProviderFamilyDomain,
    codingPlanEntitlements,
    refreshCodingPlanEntitlements,
    refreshCodingPlanProducts,
    refreshCodingPlanPurchaseTokenState,
    refreshProviderPanelAfterAuthChange,
    syncCodingPlanProviderOnce,
  };
}

export type ModelProviderSectionCodingPlan = ReturnType<typeof useModelProviderSectionCodingPlan>;
