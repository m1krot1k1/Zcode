import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  isIndividualCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  type BuiltinModelProviderId,
  type ModelConnectivityResult,
  type OAuthProviderId,
} from "@zcode/shared";
import { type ComponentProps, type ReactNode } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";
import type { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { type CodingPlanStatus, type ModelProviderNavItem } from "../constants.js";
import { InlineEditableProviderCard } from "../InlineEditableProviderCard.js";
import {
  CodingPlanStatusPanel,
  ModelProviderLoadingCard,
  PresetProviderPlaceholderCard,
} from "../StatusCards.js";
import type { CodingPlanLoginOptions } from "../codingPlanPricingCards.js";
import type { PurchaseAudience } from "../codingPlanEnterpriseTiers.js";
import { resolveCodingPlanStatusPanelViewState } from "../codingPlanStatusPanelViewState.js";
import { ProviderFamilyDetailShell, ProviderFamilyHeader } from "../ProviderFamilyModeHeader.js";
import type { ProviderSettingsView } from "./contract.js";
import { CodingPlanAccessBanner, resolveCodingPlanAccessBanner } from "./accessBanner.js";
import {
  CodingPlanPurchaseChoiceBanners,
  resolvePurchaseChoiceSelectionIntent,
} from "./purchaseChoiceBanners.js";
import type { PlanNavItem } from "./teamPlanResolution.js";

type PlanInspectionAccess = NonNullable<
  ComponentProps<typeof CodingPlanStatusPanel>["quotaResetAccountAccess"]
>;

type ModelEditingProps = Pick<
  ComponentProps<typeof InlineEditableProviderCard>,
  | "onAddPersonalModel"
  | "onSavePersonalModelDraft"
  | "onSetPersonalModelEnabled"
  | "onDeletePersonalModel"
  | "settingsRevision"
>;

/** 套餐详情需要的编排输入；Provider 卡片、状态卡与购买入口都从这里装配。 */
interface ModelProviderPlanDetailProps {
  effectiveSelectedPlanNavItem: PlanNavItem;
  providerSettingsView: ProviderSettingsView | null;
  navigationItems: ModelProviderNavItem[];
  planModeSwitch: ReactNode;
  modelEditingProps: ModelEditingProps;
  loadingLabel: string;
  selectedPlanAccess: PlanInspectionAccess | undefined;
  teamPlanEntitlementRefresh: ReturnType<typeof useUsageEntitlement>["refresh"];
  upgradePlansVisibleProviderId: BuiltinModelProviderId | null;
  setUpgradePlansVisibleProviderId: (providerId: BuiltinModelProviderId | null) => void;
  codingPlanPurchaseTokenAuthenticatedByProviderId: Partial<
    Record<BuiltinModelProviderId, boolean>
  >;
  codingPlanAuthError?: string | null;
  presetSubscriptionProviderId: BuiltinModelProviderId | null;
  codingPlanStatusSyncProviderId: BuiltinModelProviderId | null;
  codingPlanDisconnectProviderId: BuiltinModelProviderId | null;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
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
  openCodingPlanUpgrade: ReturnType<typeof useCodingPlanUpgradeDialog>["openCodingPlanUpgrade"];
}

function resolvePlanSettingsProvider({
  view,
  providerId,
  fallback,
}: {
  view: ProviderSettingsView | null | undefined;
  providerId: string;
  fallback: ProviderSettingsFormProvider | null;
}): ProviderSettingsFormProvider | null {
  if (view) {
    return (
      projectProviderSettingsViewToFormProviders(view).find(
        (provider) => provider.providerId === providerId,
      ) ?? null
    );
  }
  return fallback?.providerId === providerId ? fallback : null;
}

/** 套餐（Coding Plan / Team Plan）详情：状态卡 + 专属 Provider 卡片 + 购买入口。 */
export function ModelProviderPlanDetail({
  effectiveSelectedPlanNavItem,
  providerSettingsView,
  navigationItems,
  planModeSwitch,
  modelEditingProps,
  loadingLabel,
  selectedPlanAccess,
  teamPlanEntitlementRefresh,
  upgradePlansVisibleProviderId,
  setUpgradePlansVisibleProviderId,
  codingPlanPurchaseTokenAuthenticatedByProviderId,
  codingPlanAuthError,
  presetSubscriptionProviderId,
  codingPlanStatusSyncProviderId,
  codingPlanDisconnectProviderId,
  onSave,
  onReorderProviderModels,
  onTestModel,
  onRetryCodingPlan,
  onCodingPlanLogin,
  onCodingPlanDisconnect,
  onOpenApiKeyUrl,
  onOpenBigModelRegistration,
  onCodingPlanPurchaseComplete,
  openCodingPlanUpgrade,
}: ModelProviderPlanDetailProps) {
  const { intl } = useZCodeIntl();
  const selectedNavItem = effectiveSelectedPlanNavItem;
  const dedicatedProvider = resolvePlanSettingsProvider({
    view: providerSettingsView,
    providerId: selectedNavItem.presetId,
    fallback: selectedNavItem.provider,
  });
  // 购买/支付接口仍然依赖 OAuth 业务 token。
  // 这里与卡片登录态分开传递，避免 Provider API Key 点亮状态后误判购买 token 可用。
  const codingPlanPurchaseTokenAuthenticated =
    codingPlanPurchaseTokenAuthenticatedByProviderId[selectedNavItem.presetId] === true;
  const codingPlanLoginPending = presetSubscriptionProviderId === selectedNavItem.presetId;
  const codingPlanStatusSyncPending = codingPlanStatusSyncProviderId === selectedNavItem.presetId;
  const codingPlanDisconnectPending = codingPlanDisconnectProviderId === selectedNavItem.presetId;
  const hasResolvedEntitlementStatus =
    selectedNavItem.status === "purchased" || selectedNavItem.status === "notPurchased";
  const statusPanelViewState =
    codingPlanDisconnectPending || (codingPlanStatusSyncPending && !hasResolvedEntitlementStatus)
      ? {
          // 登录/登出后的 provider key 与权益刷新是异步链路。
          // 刷新落定前继续展示旧的未连接/已连接状态会让用户误以为操作失败。
          displayStatus: "checking" as const,
          actionStatus: "checking" as const,
          balanceStatus: "checking" as const,
          loginLoading: codingPlanStatusSyncPending,
        }
      : resolveCodingPlanStatusPanelViewState({
          status: selectedNavItem.status,
          loginPending: codingPlanLoginPending || codingPlanStatusSyncPending,
        });
  const visibleStatusLabelId =
    statusPanelViewState.displayStatus === "checking" ? undefined : selectedNavItem.statusLabelId;
  const isStartPlanProvider = isStartPlanModelProviderId(selectedNavItem.presetId);
  // 明确无权益时隐藏配置入口，但查询/取 Key 失败不能推断无权益，也不删除配置。
  const hasNoPlanEntitlement =
    !isStartPlanProvider &&
    (selectedNavItem.type === "teamPlan"
      ? selectedNavItem.availabilityReason === "not-allocated" ||
        selectedNavItem.availabilityReason === "expired"
      : selectedNavItem.status === "notPurchased");
  // Start 已由 Account 快照确认可用时，额度查询清空/刷新自己的缓存不能卸载编辑器。
  // 未取得套餐时不展示可执行模型；配置区不依赖额度请求的临时 loading 状态。
  const accountAvailable =
    providerSettingsView?.providers.find(
      (provider) => provider.providerId === selectedNavItem.presetId,
    )?.accountState?.availability === "available";
  const hidePlanModels =
    hasNoPlanEntitlement ||
    selectedNavItem.status === "disconnected" ||
    selectedNavItem.status === "notPurchased";
  const shouldShowDedicatedProviderDetail =
    dedicatedProvider !== null &&
    !hidePlanModels &&
    (!isStartPlanProvider || accountAvailable || selectedNavItem.status === "purchased");
  const reloginOnFailure =
    selectedNavItem.type === "codingPlan" &&
    isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
    selectedNavItem.provider?.accountState?.unavailableReason === "credential-failed";
  // 团队查询/取 Key 失败不是未登录：先刷新 Host 凭据，再刷新当前团队权益。
  const retryTeamPlan =
    selectedNavItem.type === "teamPlan" &&
    selectedNavItem.status === "unavailable" &&
    selectedNavItem.availabilityReason !== "not-allocated" &&
    selectedNavItem.availabilityReason !== "expired" &&
    onRetryCodingPlan
      ? async () => {
          await onRetryCodingPlan();
          await teamPlanEntitlementRefresh({ force: true, reason: "manual" });
        }
      : undefined;
  const accessBanner =
    isStartPlanProvider ||
    (selectedNavItem.type === "teamPlan" &&
      (selectedNavItem.availabilityReason === "not-allocated" ||
        selectedNavItem.availabilityReason === "expired"))
      ? null
      : resolveCodingPlanAccessBanner(statusPanelViewState.displayStatus, intl, reloginOnFailure);
  const upgradePlansVisible = upgradePlansVisibleProviderId === selectedNavItem.presetId;
  const handleUpgradePlansVisibleChange = (visible: boolean) => {
    setUpgradePlansVisibleProviderId(visible ? selectedNavItem.presetId : null);
  };
  const purchaseChoiceBannersVisible =
    statusPanelViewState.displayStatus === "notPurchased" &&
    (selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID ||
      (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID &&
        codingPlanPurchaseTokenAuthenticated));
  const anonymousPurchaseChoiceBannersVisible =
    (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
      selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
    statusPanelViewState.displayStatus === "disconnected";
  const handlePurchaseChoiceSelect = (
    audience: PurchaseAudience,
    options: { initialTeamPlanKey?: string; eventText?: string } = {},
  ) => {
    if (resolvePurchaseChoiceSelectionIntent(statusPanelViewState.displayStatus) === "login") {
      // 未登录时个人/团队套餐必须先建立对应 provider 的 OAuth 身份。
      // 直接打开购买面板会绕过账号态，导致后续价格/订单接口只能再报 oauth_required。
      onCodingPlanLogin(
        selectedNavItem.presetId,
        selectedNavItem.oauthProviderId,
        selectedNavItem.providerName,
        selectedNavItem.status,
      );
      return;
    }
    const nextFunnelContext = createCodingPlanFunnelContext({
      providerId: selectedNavItem.presetId,
      upgradeSource:
        audience === "team" ? "setting_team_plan_banner" : "setting_personal_plan_banner",
      eventRegion: "app.setting",
      eventText:
        options.eventText ??
        intl.formatMessage({
          id:
            audience === "team"
              ? "settings.modelProvider.codingPlan.purchaseBanner.teamTitle"
              : "settings.modelProvider.codingPlan.purchaseBanner.personalTitle",
        }),
      entryPlanState: resolveCodingPlanEntryPlanState({
        displayStatus: statusPanelViewState.displayStatus,
        providerId: selectedNavItem.presetId,
        planLevel: selectedNavItem.planLevel,
      }),
      purchaseAudience: audience,
    });
    openCodingPlanUpgrade({
      providerId: selectedNavItem.presetId,
      initialAudience: audience,
      initialTeamPlanKey: options.initialTeamPlanKey,
      funnelContext: nextFunnelContext,
    });
  };
  const codingPlanFamilyHeader = (
    <ProviderFamilyHeader selectedNavItem={selectedNavItem} trailingAction={planModeSwitch} />
  );
  // 团队导航在 pricing 返回历史 subscribed 时也可能标为 purchased。购买/升级入口
  // 只读取 Account owner 已确认的权益，不能把商品目录的展示状态当成当前权益。
  const hasActivePaidPlan = navigationItems.some(
    (item) =>
      (item.type === "teamPlan" ||
        (item.type === "codingPlan" && isIndividualCodingPlanModelProviderId(item.presetId))) &&
      item.oauthProviderId === selectedNavItem.oauthProviderId &&
      providerSettingsView?.providers.some(
        (provider) =>
          provider.providerId === item.presetId &&
          provider.accountState?.availability === "available" &&
          provider.accountState.entitled,
      ),
  );
  const planSupplementalContent =
    isStartPlanProvider && hasActivePaidPlan ? null : anonymousPurchaseChoiceBannersVisible ||
      purchaseChoiceBannersVisible ? (
      <CodingPlanPurchaseChoiceBanners
        providerId={selectedNavItem.presetId}
        soldOutVisible={codingPlanPurchaseTokenAuthenticated}
        accountDisconnected={statusPanelViewState.displayStatus === "disconnected"}
        onSelect={handlePurchaseChoiceSelect}
        teamVisible={selectedNavItem.oauthProviderId !== ZAI_PROVIDER_ID}
      />
    ) : accessBanner ? (
      <CodingPlanAccessBanner title={accessBanner.title} description={accessBanner.description} />
    ) : null;

  if (shouldShowDedicatedProviderDetail && dedicatedProvider) {
    const statusPanel = (
      <CodingPlanStatusPanel
        providerId={selectedNavItem.presetId}
        providerName={selectedNavItem.providerName}
        status={selectedNavItem.status}
        viewState={statusPanelViewState}
        planLevel={selectedNavItem.planLevel}
        subscriptionRenewTime={selectedNavItem.subscriptionRenewTime}
        subscriptionExpireTime={selectedNavItem.subscriptionExpireTime}
        subscriptionDetails={selectedNavItem.subscriptionDetails}
        quotaLimits={selectedNavItem.quotaLimits}
        mcpQuotaLimit={selectedNavItem.mcpQuotaLimit ?? null}
        authError={codingPlanAuthError}
        onOpenRegistration={onOpenBigModelRegistration}
        purchaseUrl={selectedNavItem.purchaseUrl}
        inactivePlanTitle={selectedNavItem.inactivePlanTitle}
        statusLabelId={visibleStatusLabelId}
        statusMessage={selectedNavItem.statusMessage}
        teamPlanAvailabilityReason={
          selectedNavItem.type === "teamPlan" ? selectedNavItem.availabilityReason : undefined
        }
        quotaResetSourceKey={
          selectedNavItem.type === "teamPlan" ? selectedNavItem.key : selectedNavItem.presetId
        }
        quotaResetAccountAccess={selectedPlanAccess}
        onQuotaResetEntitlementRefresh={
          selectedNavItem.type === "teamPlan"
            ? () =>
                teamPlanEntitlementRefresh({
                  force: true,
                  reason: "manual",
                })
            : onCodingPlanPurchaseComplete
        }
        onOpenPurchase={onOpenApiKeyUrl}
        onDisconnect={
          (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
            selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
          dedicatedProvider.providerId === selectedNavItem.presetId
            ? () => {
                onCodingPlanDisconnect(
                  selectedNavItem.presetId,
                  selectedNavItem.oauthProviderId,
                  selectedNavItem.providerName,
                );
              }
            : undefined
        }
        disconnectLoading={codingPlanDisconnectProviderId === selectedNavItem.presetId}
        // Plan Card 在未登录/登录失效时仍然是用户当前选中的入口。
        // 之前详情页没有打开状态卡内置登录动作，导致用户能进入 Coding tab 却只能看到“未连接”文案。
        loginActionVisible
        loginActionPlacement="trailing"
        reloginOnFailure={!upgradePlansVisible && reloginOnFailure}
        onRetry={
          retryTeamPlan ??
          (!upgradePlansVisible &&
          selectedNavItem.type === "codingPlan" &&
          !selectedNavItem.accountLoginRequired &&
          (selectedNavItem.status === "unavailable" ||
            selectedNavItem.statusLabelId ===
              "settings.modelProvider.codingPlan.status.unavailable" ||
            (isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
              selectedNavItem.provider?.accountState?.unavailableReason === "credential-failed"))
            ? onRetryCodingPlan
            : undefined)
        }
        onLogin={(options) => {
          return onCodingPlanLogin(
            selectedNavItem.presetId,
            selectedNavItem.oauthProviderId,
            selectedNavItem.providerName,
            // 查看套餐接口要求业务 OAuth 仍有效；已购买状态下的“重新链接”不能只静默刷新 key，
            // 否则 OAuth 过期时点击没有可见反馈。升级态的重连强制走重新登录路径。
            upgradePlansVisible ? "unavailable" : selectedNavItem.status,
            options,
          );
        }}
        onOpenUpgradePlans={(options) => {
          openCodingPlanUpgrade({
            providerId: selectedNavItem.presetId,
            initialAudience: options.initialAudience,
            funnelContext: options.funnelContext ?? undefined,
          });
        }}
        upgradePlansVisible={upgradePlansVisible}
        onUpgradePlansVisibleChange={handleUpgradePlansVisibleChange}
        purchaseInitialAudience={selectedNavItem.type === "teamPlan" ? "team" : "personal"}
        upgradeActionVisible={!isStartPlanProvider || !hasActivePaidPlan}
        startPlanPreviewVisible={false}
      />
    );

    return (
      <ProviderFamilyDetailShell header={codingPlanFamilyHeader}>
        <InlineEditableProviderCard
          provider={dedicatedProvider}
          onSave={onSave}
          {...modelEditingProps}
          onReorderModelIds={
            onReorderProviderModels
              ? (modelIds) => onReorderProviderModels(dedicatedProvider.providerId, modelIds)
              : undefined
          }
          onTestModel={onTestModel}
          nameEditable={false}
          statusSection={
            <div className="space-y-3">
              {statusPanel}
              {planSupplementalContent}
            </div>
          }
          headerActionsVisible={false}
        />
      </ProviderFamilyDetailShell>
    );
  }

  return (
    <ProviderFamilyDetailShell header={codingPlanFamilyHeader}>
      <div className="space-y-3">
        <CodingPlanStatusPanel
          providerId={selectedNavItem.presetId}
          providerName={selectedNavItem.providerName}
          status={selectedNavItem.status}
          viewState={statusPanelViewState}
          // 未登录状态下右侧只渲染 Plan Card，不再回退到 API Key 表单。
          // 因此登录入口必须留在 Plan Card 本身，否则用户进入 Coding tab 后没有下一步动作。
          loginActionVisible
          loginActionPlacement="trailing"
          purchaseUrl={selectedNavItem.purchaseUrl}
          planLevel={selectedNavItem.planLevel}
          inactivePlanTitle={selectedNavItem.inactivePlanTitle}
          statusLabelId={visibleStatusLabelId}
          statusMessage={selectedNavItem.statusMessage}
          teamPlanAvailabilityReason={
            selectedNavItem.type === "teamPlan" ? selectedNavItem.availabilityReason : undefined
          }
          quotaResetSourceKey={
            selectedNavItem.type === "teamPlan" ? selectedNavItem.key : selectedNavItem.presetId
          }
          quotaResetAccountAccess={selectedPlanAccess}
          onQuotaResetEntitlementRefresh={
            selectedNavItem.type === "teamPlan"
              ? () =>
                  teamPlanEntitlementRefresh({
                    force: true,
                    reason: "manual",
                  })
              : onCodingPlanPurchaseComplete
          }
          subscriptionRenewTime={selectedNavItem.subscriptionRenewTime}
          subscriptionExpireTime={selectedNavItem.subscriptionExpireTime}
          subscriptionDetails={selectedNavItem.subscriptionDetails}
          quotaLimits={selectedNavItem.quotaLimits}
          mcpQuotaLimit={selectedNavItem.mcpQuotaLimit ?? null}
          authError={codingPlanAuthError}
          onOpenRegistration={onOpenBigModelRegistration}
          onLogin={(options) => {
            return onCodingPlanLogin(
              selectedNavItem.presetId,
              selectedNavItem.oauthProviderId,
              selectedNavItem.providerName,
              selectedNavItem.status,
              options,
            );
          }}
          reloginOnFailure={!upgradePlansVisible && reloginOnFailure}
          onRetry={
            retryTeamPlan ??
            (!upgradePlansVisible &&
            selectedNavItem.type === "codingPlan" &&
            !selectedNavItem.accountLoginRequired &&
            (selectedNavItem.status === "unavailable" ||
              selectedNavItem.statusLabelId ===
                "settings.modelProvider.codingPlan.status.unavailable" ||
              (isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
                selectedNavItem.provider?.accountState?.unavailableReason === "credential-failed"))
              ? onRetryCodingPlan
              : undefined)
          }
          onOpenPurchase={onOpenApiKeyUrl}
          onDisconnect={
            (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
              selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
            selectedNavItem.provider?.providerId === selectedNavItem.presetId &&
            selectedNavItem.status !== "disconnected"
              ? () => {
                  onCodingPlanDisconnect(
                    selectedNavItem.presetId,
                    selectedNavItem.oauthProviderId,
                    selectedNavItem.providerName,
                  );
                }
              : undefined
          }
          disconnectLoading={codingPlanDisconnectProviderId === selectedNavItem.presetId}
          onOpenUpgradePlans={(options) => {
            openCodingPlanUpgrade({
              providerId: selectedNavItem.presetId,
              initialAudience: options.initialAudience,
              funnelContext: options.funnelContext ?? undefined,
            });
          }}
          upgradePlansVisible={upgradePlansVisible}
          onUpgradePlansVisibleChange={handleUpgradePlansVisibleChange}
          purchaseInitialAudience={selectedNavItem.type === "teamPlan" ? "team" : "personal"}
          upgradeActionVisible={!isStartPlanProvider || !hasActivePaidPlan}
          startPlanPreviewVisible={false}
        />
        {hidePlanModels ? null : providerSettingsView && !dedicatedProvider ? (
          <PresetProviderPlaceholderCard
            displayName={selectedNavItem.providerName}
            messageId="settings.modelProvider.accountProviderConfigMissing"
          />
        ) : !selectedNavItem.provider ||
          selectedNavItem.provider.providerId !== selectedNavItem.presetId ? (
          <ModelProviderLoadingCard loadingLabel={loadingLabel} />
        ) : null}
        {planSupplementalContent}
      </div>
    </ProviderFamilyDetailShell>
  );
}
