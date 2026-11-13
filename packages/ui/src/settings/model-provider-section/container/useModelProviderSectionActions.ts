import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import { finishMarketingNavigation, marketingNavigation } from "@/lib/marketingNavigation.js";
import {
  BIGMODEL_PROVIDER_ID,
  DesktopCommandIds,
  isStartPlanModelProviderId,
  toLegacyBilingualLocale,
  type BuiltinModelProviderId,
  type ModelConnectivityResult,
  type OAuthProviderId,
  resolveModelProviderFamilySpecByProviderId,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import { logger } from "@/logger.js";
import type { CodingPlanStatus } from "../constants.js";
import type { CodingPlanLoginOptions } from "../codingPlanPricingCards.js";
import { confirmAndDeleteModelProvider } from "../modelProviderActions.js";
import { createCustomProviderNodeKey } from "../utils.js";
import {
  clearPendingProviderFamilyConnectionSelection,
  resolveCodingPlanProviderSyncAttemptKey,
  resolveConnectionSelectionForNavItem,
  resolveModelProviderSideSelectionKey,
  shouldRefreshCodingPlanEntitlementsAfterSave,
  shouldRetryUnchangedCodingPlanProviderSync,
} from "./helpers.js";
import type { ModelProviderSectionCodingPlan } from "./useModelProviderSectionCodingPlan.js";
import type { ModelProviderSectionEnvironment } from "./useModelProviderSectionEnvironment.js";
import type { ModelProviderSectionNavigation } from "./useModelProviderSectionNavigation.js";

export function useModelProviderSectionActions({
  environment,
  codingPlan,
  navigation,
}: {
  environment: ModelProviderSectionEnvironment;
  codingPlan: ModelProviderSectionCodingPlan;
  navigation: ModelProviderSectionNavigation;
}) {
  const {
    intl,
    locale,
    confirmDialog,
    platform,
    modelSelectionService,
    oauthService,
    modelProviders,
    loading,
    modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    deleteProvider,
    displayOrder,
    saveDisplayOrder,
    testModelConnectivity,
    selectedNodeKey,
    setSelectedNodeKey,
    setInvalidProviderTarget,
    setTemplatePickerOpen,
    setCreatingProvider,
    setPendingCreatedProviderId,
    setCodingPlanDisconnectProviderId,
    setCodingPlanStatusSyncProviderId,
    setPresetSubscriptionProviderId,
  } = environment;
  const {
    requestLoginEntry,
    sharedSettings,
    sharedSettingsLoading,
    updateSharedSettings,
    activeOAuthProvider,
    refreshProviderPanelAfterAuthChange,
    refreshCodingPlanEntitlements,
    refreshCodingPlanPurchaseTokenState,
    refreshCodingPlanProducts,
    codingPlanStatusSyncAttemptsRef,
    setPendingConnectionSelections,
    connectionSelections,
    syncCodingPlanProviderOnce,
  } = codingPlan;
  const { navigationItems, selectedNavItem } = navigation;

  const handleSave = useCallback(
    async (config: ProviderSettingsFormProvider) => {
      try {
        const previousProvider = modelProviders.find(
          (provider) => provider.providerId === config.providerId,
        );
        // 配置不可执行不是用户退出账号；保存不得顺带清空账号域，否则套餐再选也无法就绪。
        await saveProvider(config);
        if (shouldRefreshCodingPlanEntitlementsAfterSave(previousProvider, config)) {
          refreshCodingPlanEntitlements();
        }
      } catch (error) {
        logger.error("[ModelProviderSection] 保存模型供应商失败", error);
        throw error;
      }
    },
    [modelProviders, refreshCodingPlanEntitlements, saveProvider],
  );

  const handleDelete = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await confirmAndDeleteModelProvider({
        provider,
        confirmDialog,
        intl,
        deleteProvider,
      });
    },
    [confirmDialog, deleteProvider, intl],
  );

  const handleOpenApiKeyUrl = useCallback(
    (url: string) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }
      platform.openExternal(normalizedUrl);
    },
    [platform],
  );

  const handleCodingPlanLogin = useCallback(
    (
      presetId: BuiltinModelProviderId,
      providerId: OAuthProviderId,
      providerName: string,
      status: CodingPlanStatus,
      options?: CodingPlanLoginOptions,
    ) => {
      setPresetSubscriptionProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      logger.info("[ModelProviderSection] 请求通过统一登录入口登录并连接 Coding Plan", {
        presetId,
        providerId,
        providerName,
        status,
        forceOAuth: options?.forceOAuth === true,
      });
      if (activeOAuthProvider === providerId && options?.forceOAuth !== true) {
        void refreshProviderPanelAfterAuthChange({}).finally(() => {
          setPresetSubscriptionProviderId((current) => (current === presetId ? null : current));
          setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
        });
        return;
      }
      // ZAI/BigModel provider 不再有独立 connection，Connect 必须切换 App active provider。
      return requestLoginEntry(providerId);
    },
    [
      activeOAuthProvider,
      refreshProviderPanelAfterAuthChange,
      requestLoginEntry,
    ],
  );

  const handleCodingPlanDisconnect = useCallback(
    async (presetId: BuiltinModelProviderId, providerId: OAuthProviderId, providerName: string) => {
      if (providerId !== BIGMODEL_PROVIDER_ID && providerId !== ZAI_PROVIDER_ID) {
        return;
      }

      setCodingPlanDisconnectProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      try {
        logger.info("[ModelProviderSection] 请求解绑 Coding Plan provider", {
          presetId,
          providerId,
          providerName,
        });
        // ZAI/BigModel provider 已恢复为 App 登录镜像。
        // 这里的 Unlink 必须走 provider logout，退出当前 active provider 并触发另一组 provider 恢复 Connect。
        const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
          currentDomain: sharedSettings?.providerFamilyDomain,
        });
        await oauthService.logout(providerId);
        // Coding Plan 官网 webview 使用独立持久 partition，provider Unlink 也属于账号边界。
        if (typeof platform.executeDesktopCommand === "function") {
          await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
        }
        await updateSharedSettings({
          providerFamilyDomain: (nextProviderFamilyDomain ?? "") as never,
          providerFamilyDomainUpdatedAt: Date.now(),
          providerFamilyDomainMigrated: true,
        });
        await refreshCodingPlanPurchaseTokenState({ clearUserWhenLoggedOut: true });
        await refresh();
        // 解绑后 batch-preview 的订阅/鉴权态已经失效，套餐卡片内部缓存必须刷新，
        // 否则按钮会继续沿用解绑前的 purchased 或 authenticated 状态。
        refreshCodingPlanProducts();
        // unlink 前的 React 闭包里仍可能保留旧 Start/Coding provider key。
        // 解绑按钮只等待本地 logout 和 provider 列表刷新；权益 hook 会在新 provider 快照落地后清空旧状态。
      } catch (error) {
        logger.error("[ModelProviderSection] 解绑 Coding Plan provider 失败", {
          presetId,
          providerId,
          providerName,
          error,
        });
      } finally {
        setCodingPlanDisconnectProviderId((current) => (current === presetId ? null : current));
        setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
      }
    },
    [
      oauthService,
      platform,
      updateSharedSettings,
      sharedSettings?.providerFamilyDomain,
      modelSelectionService,
      refresh,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
    ],
  );

  const persistProviderFamilyModeForNavItem = useCallback(
    async (item: (typeof navigationItems)[number]) => {
      if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
        return;
      }
      const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
      if (!familySpec) {
        return;
      }
      const selection = resolveConnectionSelectionForNavItem(item);
      if (!selection) return;
      const selectionUnchanged =
        JSON.stringify(connectionSelections[familySpec.id]) === JSON.stringify(selection);
      // 同套餐仍可能缺少持久账号域；用户重选必须补齐，不能用页面展示兜底值去重。
      const modeUnchanged = sharedSettings?.providerFamilyDomain === familySpec.id;
      const selectedKeyUnchanged = selectionUnchanged;
      const planSyncAttemptKey =
        item.type === "codingPlan" || item.type === "teamPlan"
          ? resolveCodingPlanProviderSyncAttemptKey({
              activeOAuthProvider,
              oauthProviderId: item.oauthProviderId,
              providerId: item.presetId,
            })
          : null;
      if (modeUnchanged && selectedKeyUnchanged) {
        const isPlanItem = item.type === "codingPlan" || item.type === "teamPlan";
        const planSyncAttemptStatus = planSyncAttemptKey
          ? codingPlanStatusSyncAttemptsRef.current.get(planSyncAttemptKey)
          : undefined;
        if (
          isPlanItem &&
          shouldRetryUnchangedCodingPlanProviderSync({
            attemptKey: planSyncAttemptKey,
            attemptStatus: planSyncAttemptStatus,
            modeUnchanged,
            selectedKeyUnchanged,
          })
        ) {
          try {
            await syncCodingPlanProviderOnce(item, {
              userTransition: true,
              refreshPlanSnapshots: false,
            });
          } catch (error) {
            logger.warn("[ModelProviderSection] 重试同步 Coding Plan provider 失败", {
              providerId: item.presetId,
              error,
            });
          }
        }
        return;
      }
      setPendingConnectionSelections((current) => ({
        ...current,
        [familySpec.id]: selection,
      }));
      if (planSyncAttemptKey) {
        // pending state 会先触发渲染；先占位，避免水合 effect 在设置落盘前重复发起同步。
        codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "inFlight");
      }
      try {
        await updateSharedSettings(
          {
            providerFamilyDomain: familySpec.id,
            providerFamilyDomainUpdatedAt: Date.now(),
            providerFamilyDomainMigrated: true,
            providerFamilyConnectionSelections: {
              ...sharedSettings?.providerFamilyConnectionSelections,
              [familySpec.id]: selection,
            },
          },
          {
            // 原因：页面快照可能落后其它窗口；不能把展示/待提交映射当作锁内预期。
            providerFamilyDomain: sharedSettings?.providerFamilyDomain,
            providerFamilyConnectionSelections: sharedSettings?.providerFamilyConnectionSelections,
            providerFamilyDomainUpdatedAt: sharedSettings?.providerFamilyDomainUpdatedAt ?? 0,
          },
        );
        if (item.type === "codingPlan" || item.type === "teamPlan") {
          // 用户动作拥有连接方式 transition：设置落盘后只刷新一次目标 Plan provider。
          await syncCodingPlanProviderOnce(item, {
            userTransition: true,
            refreshPlanSnapshots: false,
          });
        }
      } catch (error) {
        if (planSyncAttemptKey) {
          // 设置落盘或后续 provider 同步失败时必须允许同项重试。
          codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "failed");
        }
        logger.warn("[ModelProviderSection] 保存模型供应商连接方式失败", {
          familyId: familySpec.id,
          error,
        });
        setPendingConnectionSelections((current) =>
          clearPendingProviderFamilyConnectionSelection(current, familySpec.id, selection),
        );
      }
    },
    [
      activeOAuthProvider,
      connectionSelections,
      sharedSettings,
      syncCodingPlanProviderOnce,
      updateSharedSettings,
    ],
  );

  const handleSelectNavItem = useCallback(
    (item: (typeof navigationItems)[number]) => {
      setInvalidProviderTarget(false);
      setSelectedNodeKey(resolveModelProviderSideSelectionKey(item));
      setTemplatePickerOpen(false);
      void persistProviderFamilyModeForNavItem(item);
    },
    [persistProviderFamilyModeForNavItem],
  );

  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        const created = await createPersonalProvider({
          ...input,
          locale: toLegacyBilingualLocale(locale),
        });
        setPendingCreatedProviderId(created.providerId);
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        setPendingCreatedProviderId(null);
        throw error;
      } finally {
        setCreatingProvider(false);
      }
    },
    [
      createPersonalProvider,
      locale,
    ],
  );

  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  useEffect(() => {
    if (marketingRequest?.target.page !== "settings" || !marketingRequest.target.provider_id)
      return;
    if (
      loading ||
      modelProvidersRefreshing ||
      sharedSettingsLoading ||
      navigationItems.some((item) => item.type === "codingPlanLoading")
    )
      return;
    const providerId = marketingRequest.target.provider_id;
    const item = navigationItems.find((item) =>
      item.type === "custom"
        ? // 当前表单契约使用 providerId；旧 id 会让所有自定义提供商被误判为不存在。
          item.provider.providerId === providerId
        : "presetId" in item &&
          item.presetId === providerId &&
          (!isStartPlanModelProviderId(providerId) || item.type === "codingPlan"),
    );
    if (!item) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_provider_unavailable"));
      return;
    }
    const key = resolveModelProviderSideSelectionKey(item);
    if (selectedNodeKey !== key) {
      // 只定位侧栏节点；禁止复用带 mode 的选择路径，避免营销导航修改套餐连接。
      setSelectedNodeKey(key);
    } else if (selectedNavItem) {
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [
    marketingRequest,
    loading,
    modelProvidersRefreshing,
    sharedSettingsLoading,
    navigationItems,
    selectedNodeKey,
    selectedNavItem,
  ]);

  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = sortModelProvidersForDisplay(modelProviders, displayOrder).map(
        (provider) => provider.providerId,
      );
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) {
        return;
      }
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({
        providerIds: nextProviderIds,
      });
    },
    [displayOrder, modelProviders, saveDisplayOrder],
  );

  const handleTestModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      return testModelConnectivity(providerId, modelId);
    },
    [testModelConnectivity],
  );

  return {
    handleSave,
    handleDelete,
    handleOpenApiKeyUrl,
    handleCodingPlanLogin,
    handleCodingPlanDisconnect,
    persistProviderFamilyModeForNavItem,
    handleSelectNavItem,
    handleCreateProvider,
    handleReorderProviderIds,
    handleTestModel,
  };
}

export type ModelProviderSectionActions = ReturnType<typeof useModelProviderSectionActions>;
