import {
  type BuiltinModelProviderId,
  type ProviderFamilyConnectionSelectionSettings,
  type ModelConnectivityResult,
  type OAuthProviderId,
  resolveModelProviderFamilySpecByProviderId,
} from "@zcode/shared";
import {
  getProviderFormApiKeyManagementUrl,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { useEffect, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { type CodingPlanStatus, type ModelProviderNavItem } from "./constants.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";
import { ModelProviderLoadingCard, PresetProviderPlaceholderCard } from "./StatusCards.js";
import { type CodingPlanLoginOptions } from "./codingPlanPricingCards.js";
import {
  ProviderFamilyDetailShell,
  ProviderFamilyHeader,
  ProviderFamilyPlanModeSwitch,
} from "./ProviderFamilyModeHeader.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import type { SavePersonalModelDraftInput } from "@zcode/provider";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import type { ProviderSettingsView } from "./detail/contract.js";
import { ModelProviderPlanDetail } from "./detail/planProviderDetail.js";
import {
  hasTeamPlanContext,
  isPlanNavItem,
  resolveTeamPlanInspectionAccess,
  resolveTeamScopedPlanNavItem,
} from "./detail/teamPlanResolution.js";

// 以下解析器由旧版 Detail.tsx 导出，外部测试与调用方继续从本文件引入。
export { resolveTeamPlanInspectionAccess, resolveTeamScopedPlanNavItem };
export {
  resolveEnterprisePurchaseChoiceBannerPrice,
  resolvePurchaseChoiceBannerPrice,
  resolvePurchaseChoiceBannerProductsProviderId,
  resolvePurchaseChoiceSelectionIntent,
} from "./detail/purchaseChoiceBanners.js";

export function ModelProviderSectionDetail({
  selectedNavItem,
  navigationItems = selectedNavItem ? [selectedNavItem] : [],
  connectionSettingsFailed = false,
  connectionSelections,
  startPlanSubscriptionCount = 0,
  presetLoading,
  codingPlanPurchaseTokenAuthenticatedByProviderId,
  codingPlanAuthError,
  presetSubscriptionProviderId,
  codingPlanStatusSyncProviderId,
  codingPlanDisconnectProviderId,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onReorderProviderModels,
  onTestModel,
  onCodingPlanLogin,
  onRetryCodingPlan,
  onCodingPlanDisconnect,
  onOpenApiKeyUrl,
  onOpenBigModelRegistration,
  onCodingPlanPurchaseComplete,
  onSelectNavItem,
  providerSettingsView: providerSettingsViewOverride,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems?: ModelProviderNavItem[];
  connectionSettingsFailed?: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  startPlanSubscriptionCount?: number;
  presetLoading: boolean;
  codingPlanPurchaseTokenAuthenticatedByProviderId: Partial<
    Record<BuiltinModelProviderId, boolean>
  >;
  codingPlanAuthError?: string | null;
  presetSubscriptionProviderId: BuiltinModelProviderId | null;
  codingPlanStatusSyncProviderId: BuiltinModelProviderId | null;
  codingPlanDisconnectProviderId: BuiltinModelProviderId | null;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
  onReorderProviderModels?: (providerId: string, modelIds: string[]) => Promise<void>;
  onTestModel: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onRetryCodingPlan?: () => void | Promise<void>;
  onCodingPlanLogin: (
    presetId: BuiltinModelProviderId,
    providerId: OAuthProviderId,
    providerName: string,
    status: CodingPlanStatus,
    options?: CodingPlanLoginOptions,
  ) => number | void;
  onCodingPlanDisconnect: (
    presetId: BuiltinModelProviderId,
    providerId: OAuthProviderId,
    providerName: string,
  ) => void;
  onOpenApiKeyUrl: (url: string) => void;
  onOpenBigModelRegistration: () => void;
  onCodingPlanPurchaseComplete: () => void | Promise<void>;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
  providerSettingsView?: ProviderSettingsView | null;
}) {
  const { intl } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const loadingLabel = intl.formatMessage({ id: "common.loading" });
  const [upgradePlansVisibleProviderId, setUpgradePlansVisibleProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const selectedItemKey = selectedNavItem?.key ?? null;
  const rootProviderSettingsRead = useProviderSettingsView();
  const rootProviderSettingsView =
    rootProviderSettingsRead.state.status === "ready" ? rootProviderSettingsRead.state.view : null;
  const providerSettingsView = providerSettingsViewOverride ?? rootProviderSettingsView;
  // 账号分支曾漏传删除回调，出现只删 UI 不写盘。所有详情共用同一套模型操作装配。
  const modelEditingProps = {
    onAddPersonalModel,
    onSavePersonalModelDraft,
    onSetPersonalModelEnabled,
    onDeletePersonalModel,
    settingsRevision: providerSettingsView?.revision,
  };
  const selectedPlanAccess = useMemo(() => {
    if (!isPlanNavItem(selectedNavItem)) return undefined;
    if (selectedNavItem.type === "teamPlan")
      return resolveTeamPlanInspectionAccess(selectedNavItem);
    const access = resolveAccountProviderInspectionAccess(
      providerSettingsView,
      selectedNavItem.presetId,
    );
    if (
      !access ||
      (access.access.mode !== "start-plan" && access.access.mode !== "individual-coding-plan")
    )
      return undefined;
    return {
      type: "zhipu-account" as const,
      family: access.access.accountType,
      planKind: access.access.mode,
    };
  }, [providerSettingsView, selectedNavItem]);
  const selectedTeamPlanContext = useMemo(
    () =>
      hasTeamPlanContext(selectedNavItem)
        ? {
            organizationId: selectedNavItem.organizationId.trim(),
            projectId: selectedNavItem.projectId.trim(),
          }
        : null,
    [selectedNavItem],
  );
  const selectedTeamPlanEntitlement = useUsageEntitlement({
    enabled: Boolean(selectedTeamPlanContext),
    includeSubscription: true,
    preferredProviderId:
      selectedNavItem?.type === "teamPlan" ? selectedNavItem.presetId : undefined,
    accountAccess: selectedPlanAccess,
    // 已购 Team Plan 时，个人 Coding Plan provider 可能因个人权益不可用被标记 disabled。
    // Team 额度查询仍复用 Coding Plan quota 链路，并追加组织 / 项目上下文，不能在服务选择阶段被过滤。
    allowDisabledPreferredProvider: selectedNavItem?.type === "teamPlan",
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: selectedNavItem?.key ?? undefined,
    refreshOnMount: false,
  });
  useEffect(() => {
    if (!selectedTeamPlanContext) {
      return;
    }
    void selectedTeamPlanEntitlement.refresh({
      silent: true,
      reason: "access",
    });
  }, [selectedTeamPlanContext, selectedTeamPlanEntitlement.refresh]);
  const effectiveSelectedPlanNavItem = isPlanNavItem(selectedNavItem)
    ? resolveTeamScopedPlanNavItem(selectedNavItem, selectedTeamPlanEntitlement)
    : null;
  const planModeSwitch = (
    <ProviderFamilyPlanModeSwitch
      selectedNavItem={selectedNavItem}
      navigationItems={navigationItems}
      connectionSettingsFailed={connectionSettingsFailed}
      connectionSelections={connectionSelections}
      startPlanSubscriptionCount={startPlanSubscriptionCount}
      onSelectNavItem={onSelectNavItem}
    />
  );

  useEffect(() => {
    setUpgradePlansVisibleProviderId(null);
  }, [selectedItemKey]);

  if (!selectedNavItem) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  if (selectedNavItem.type === "preset") {
    if (!selectedNavItem.provider) {
      // 首屏慢网时预置供应商配置尚未返回，之前这里会直接展示“尚未同步，请先完成 OAuth 登录”，
      // 用户会把“还在下载”误判成“当前账号未登录”。首刷期间改为明确显示 loading，等请求结束后再决定是否展示未同步占位。
      if (presetLoading) {
        return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
      }

      return <PresetProviderPlaceholderCard displayName={selectedNavItem.displayName} />;
    }

    const presetProvider = selectedNavItem.provider;

    const familySpec = resolveModelProviderFamilySpecByProviderId(selectedNavItem.presetId);
    const presetFamilyHeader = (
      <ProviderFamilyHeader
        selectedNavItem={selectedNavItem}
        trailingAction={familySpec ? planModeSwitch : undefined}
      />
    );
    return (
      <ProviderFamilyDetailShell header={presetFamilyHeader}>
        <InlineEditableProviderCard
          provider={presetProvider}
          onSave={onSave}
          {...modelEditingProps}
          onReorderModelIds={
            onReorderProviderModels
              ? (modelIds) => onReorderProviderModels(presetProvider.providerId, modelIds)
              : undefined
          }
          onTestModel={onTestModel}
          readOnlyEndpoints
          // 预置供应商名称承载固定 API Key 入口语义，
          // 允许重命名会让侧边栏和模型选择器展示含义不一致，因此只允许自定义供应商改名。
          nameEditable={false}
          headerVisible={!familySpec}
          headerActionsVisible={familySpec ? false : undefined}
        />
      </ProviderFamilyDetailShell>
    );
  }

  if (effectiveSelectedPlanNavItem) {
    return (
      <ModelProviderPlanDetail
        effectiveSelectedPlanNavItem={effectiveSelectedPlanNavItem}
        providerSettingsView={providerSettingsView}
        navigationItems={navigationItems}
        planModeSwitch={planModeSwitch}
        modelEditingProps={modelEditingProps}
        loadingLabel={loadingLabel}
        selectedPlanAccess={selectedPlanAccess}
        teamPlanEntitlementRefresh={selectedTeamPlanEntitlement.refresh}
        upgradePlansVisibleProviderId={upgradePlansVisibleProviderId}
        setUpgradePlansVisibleProviderId={setUpgradePlansVisibleProviderId}
        codingPlanPurchaseTokenAuthenticatedByProviderId={
          codingPlanPurchaseTokenAuthenticatedByProviderId
        }
        codingPlanAuthError={codingPlanAuthError}
        presetSubscriptionProviderId={presetSubscriptionProviderId}
        codingPlanStatusSyncProviderId={codingPlanStatusSyncProviderId}
        codingPlanDisconnectProviderId={codingPlanDisconnectProviderId}
        onSave={onSave}
        onReorderProviderModels={onReorderProviderModels}
        onTestModel={onTestModel}
        onRetryCodingPlan={onRetryCodingPlan}
        onCodingPlanLogin={onCodingPlanLogin}
        onCodingPlanDisconnect={onCodingPlanDisconnect}
        onOpenApiKeyUrl={onOpenApiKeyUrl}
        onOpenBigModelRegistration={onOpenBigModelRegistration}
        onCodingPlanPurchaseComplete={onCodingPlanPurchaseComplete}
        openCodingPlanUpgrade={openCodingPlanUpgrade}
      />
    );
  }

  if (selectedNavItem.type === "codingPlanLoading") {
    // Z.AI plan 判定占位只属于左侧导航，不应进入详情表单渲染路径。
    return null;
  }

  if (selectedNavItem.type === "agentIntegration") {
    // 原因：CLI 集成只由外层单独的 ACP 面板负责，不能落入 API Provider 表单分支。
    return null;
  }

  if (!("provider" in selectedNavItem) || !selectedNavItem.provider) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  const customProvider = selectedNavItem.provider;
  const customApiKeyUrl = customProvider.templateId
    ? getProviderFormApiKeyManagementUrl(customProvider)
    : undefined;
  return (
    // 仅展示预设模板声明的入口，不根据地址猜测自定义 Provider 的 Key 控制台。
    <InlineEditableProviderCard
      provider={customProvider}
      onSave={onSave}
      {...modelEditingProps}
      onDelete={() => onDelete(customProvider)}
      onReorderModelIds={
        onReorderProviderModels
          ? (modelIds) => onReorderProviderModels(customProvider.providerId, modelIds)
          : undefined
      }
      onTestModel={onTestModel}
      presetApiKeyUrl={customApiKeyUrl}
      readOnlyEndpoints={false}
      nameEditable
      onOpenPresetApiKey={
        customApiKeyUrl
          ? () => {
              onOpenApiKeyUrl(customApiKeyUrl);
            }
          : undefined
      }
    />
  );
}
