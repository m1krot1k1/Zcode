// StatusCards 拆分：Coding Plan / Start Plan 状态面板（状态、动作与套餐区块编排）。
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import {
  BIGMODEL_PROVIDER_ID,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  type UsageEntitlementSubscriptionDetail,
  type UsageQuotaLimit,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { InfoIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { logger } from "@/logger.js";
import {
  CodingPlanBillingDiscountBadge,
  useCodingPlanBillingDiscount,
} from "@/CodingPlanBillingDiscount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  type CodingPlanFunnelContext,
} from "@/lib/codingPlanFunnelTelemetry.js";
import type {
  CodingPlanProviderId,
  CodingPlanStatus,
  TeamPlanAvailabilityReason,
} from "../constants.js";
import type { CodingPlanStatusPanelViewState } from "../codingPlanStatusPanelViewState.js";
import { CodingPlanStatusMeta, StartPlanStatusMeta } from "../CodingPlanStatusMeta.js";
import { CodingPlanStatusActions, CodingPlanUpgradeAction } from "../CodingPlanStatusActions.js";
import type { CodingPlanLoginOptions } from "../codingPlanPricingCards.js";
import type { PurchaseAudience } from "../codingPlanEnterpriseTiers.js";
import { StartPlanCard } from "../StartPlanCard.js";
import { StartPlanQuotaStatusCard } from "../StartPlanQuotaStatusCard.js";
import { resolveStartPlanQuotaCardEntries } from "../StartPlanBalanceCard.js";
import { useStartPlanPreview } from "../useStartPlanPreview.js";
import {
  BigModelRegistrationHint,
  isBigModelUnregisteredAuthError,
} from "../BigModelRegistrationHint.js";
import { formatQuotaModelDisplayName } from "../quotaModelDisplayName.js";
import { PlanStatusCardSurface } from "./StatusCardSurfaces.js";
import { CodingPlanUsageSummaryCards } from "./CodingPlanUsageSummaryCards.js";
import { hasDisplayableCodingPlanUsageLimits } from "./codingPlanUsageMetrics.js";
import {
  hasStartPlanEntitlementQuota,
  isMaxCodingPlanLevel,
  resolveCodingPlanStatusCardTitle,
} from "./codingPlanStatusCardModel.js";

export function CodingPlanStatusPanel({
  providerId,
  providerName,
  status,
  viewState,
  loginLoading,
  disconnectLoading,
  purchaseUrl,
  planLevel,
  inactivePlanTitle,
  subscriptionRenewTime,
  subscriptionExpireTime,
  subscriptionDetails,
  quotaLimits = [],
  mcpQuotaLimit = null,
  authError,
  onOpenRegistration,
  onLogin,
  onRetry,
  reloginOnFailure = false,
  onOpenPurchase,
  onDisconnect,
  onOpenUpgradePlans,
  purchaseInitialAudience = "personal",
  loginActionPlacement = "inline",
  loginActionVisible = false,
  usageDetailsVisible = true,
  upgradeActionVisible = true,
  upgradePlansVisible: controlledUpgradePlansVisible,
  onUpgradePlansVisibleChange,
  startPlanPreviewVisible = true,
  statusLabelId,
  statusMessage,
  teamPlanAvailabilityReason,
  quotaResetSourceKey,
  quotaResetAccountAccess,
  onQuotaResetEntitlementRefresh,
}: {
  providerId: CodingPlanProviderId;
  providerName: string;
  status: CodingPlanStatus;
  viewState?: CodingPlanStatusPanelViewState;
  loginLoading?: boolean;
  disconnectLoading?: boolean;
  purchaseUrl?: string;
  planLevel?: string | null;
  inactivePlanTitle?: string | null;
  subscriptionRenewTime?: string | null;
  subscriptionExpireTime?: string | null;
  subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
  quotaLimits?: UsageQuotaLimit[];
  /** 官方 Server MCP 额度（服务端下发的总额度）。不在 quota.limits[] 里，由 nav item 单独透传。 */
  mcpQuotaLimit?: UsageQuotaLimit | null;
  authError?: string | null;
  onOpenRegistration?: () => void;
  onLogin?: (options?: CodingPlanLoginOptions) => number | void | Promise<void>;
  /** 凭据获取失败提供主动重新登录，不据此自动退出账号。 */
  reloginOnFailure?: boolean;
  /** Start 套餐获取失败沿用 Host 手动刷新，不强制重新登录。 */
  onRetry?: () => void;
  onOpenPurchase?: (url: string) => void;
  onDisconnect?: () => void;
  onOpenUpgradePlans?: (options: {
    initialAudience: PurchaseAudience;
    funnelContext: CodingPlanFunnelContext | null;
  }) => void;
  /** 原生面板移除后，Team 状态卡仍须把购买对象传给统一升级入口。 */
  purchaseInitialAudience?: PurchaseAudience;
  loginActionPlacement?: "inline" | "trailing";
  loginActionVisible?: boolean;
  usageDetailsVisible?: boolean;
  upgradeActionVisible?: boolean;
  upgradePlansVisible?: boolean;
  onUpgradePlansVisibleChange?: (visible: boolean) => void;
  startPlanPreviewVisible?: boolean;
  statusLabelId?: string;
  statusMessage?: string | null;
  teamPlanAvailabilityReason?: TeamPlanAvailabilityReason;
  /** Team Plan 必须传完整连接 key，避免与同 provider 的个人套餐共享重置状态。 */
  quotaResetSourceKey?: string;
  quotaResetAccountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  onQuotaResetEntitlementRefresh?: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const billingDiscount = useCodingPlanBillingDiscount();
  const [internalUpgradePlansVisible, setInternalUpgradePlansVisible] = useState(false);
  const [startPlanEntitlementRefreshing, setStartPlanEntitlementRefreshing] = useState(false);
  const upgradePlansVisible = controlledUpgradePlansVisible ?? internalUpgradePlansVisible;
  const setUpgradePlansVisible = onUpgradePlansVisibleChange ?? setInternalUpgradePlansVisible;
  const refreshStartPlanEntitlement = async () => {
    if (!onQuotaResetEntitlementRefresh || startPlanEntitlementRefreshing) {
      return;
    }
    setStartPlanEntitlementRefreshing(true);
    try {
      await onQuotaResetEntitlementRefresh();
    } catch (error) {
      // 额度桶可能在生效时间后仍短暂未就绪。刷新失败时必须保留按钮供重试，
      // 不能因为一次网络错误把“尚未同步”错误收敛成已完成。
      logger.warn("[ModelProviderSection] 刷新 Start Plan 权益失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
      });
    } finally {
      setStartPlanEntitlementRefreshing(false);
    }
  };
  const effectiveViewState = viewState ?? {
    displayStatus: status,
    actionStatus: status,
    balanceStatus: status,
    loginLoading: loginLoading === true,
  };
  const isDisconnected = effectiveViewState.displayStatus === "disconnected";
  const isChecking = effectiveViewState.displayStatus === "checking";
  const isUnavailable = effectiveViewState.displayStatus === "unavailable";
  const isUnsupported = effectiveViewState.displayStatus === "unsupported";
  const isPurchased = effectiveViewState.displayStatus === "purchased";
  const isNotPurchased = effectiveViewState.displayStatus === "notPurchased";
  const actionIsDisconnected = effectiveViewState.actionStatus === "disconnected";
  const isStartPlanProvider = isStartPlanModelProviderId(providerId);
  const providerIcon =
    resolveModelProviderFamilySpecByProviderId(providerId)?.oauthProviderId ?? null;
  const canDisconnectProvider =
    !isStartPlanProvider &&
    Boolean(onDisconnect) &&
    !isDisconnected &&
    !isChecking &&
    !isUnavailable &&
    !isUnsupported;
  const loginButtonId = isStartPlanProvider
    ? isUnavailable
      ? "chat.error.action.relogin"
      : "settings.modelProvider.startPlan.login"
    : "settings.modelProvider.codingPlan.connect";
  const defaultStatusBadgeId = isUnsupported
    ? "settings.modelProvider.codingPlan.status.unsupported"
    : isDisconnected
      ? "settings.modelProvider.codingPlan.status.disconnected"
      : isChecking
        ? "settings.modelProvider.codingPlan.status.checking"
        : isUnavailable
          ? "settings.modelProvider.codingPlan.status.unavailable"
          : isPurchased
            ? "settings.modelProvider.codingPlan.status.purchased"
            : "settings.modelProvider.codingPlan.status.notPurchased";
  // 检查态可能仍携带上一轮团队错误；状态行只呈现当前检查状态，避免双图标和旧错误闪现。
  const statusBadgeId = isChecking
    ? defaultStatusBadgeId
    : (statusLabelId ??
      (isStartPlanProvider && isDisconnected
        ? "settings.modelProvider.startPlan.status.loginRequired"
        : isStartPlanProvider && isNotPurchased
          ? "settings.modelProvider.startPlan.status.noPlan"
          : defaultStatusBadgeId));
  const statusBadgeMessage = isChecking ? undefined : statusMessage?.trim();
  // 展示文案不是状态权威。Team Plan 交互只读取显式业务原因，
  // 避免 Project Key 错误被翻译 key 误判成“团队套餐未分配”。
  const teamPlanUnavailableStatusVisible =
    teamPlanAvailabilityReason === "not-allocated" || teamPlanAvailabilityReason === "expired";
  const teamPlanWarningVisible = !isChecking && teamPlanAvailabilityReason !== undefined;
  const recoverableUnavailable =
    effectiveViewState.actionStatus === "unavailable" && !teamPlanUnavailableStatusVisible;
  const reloginVisible = recoverableUnavailable && reloginOnFailure && Boolean(onLogin);
  const retryVisible =
    (recoverableUnavailable ||
      statusLabelId === "settings.modelProvider.codingPlan.status.unavailable") &&
    !reloginVisible &&
    Boolean(onRetry);
  const trailingLoginVisible =
    !reloginVisible &&
    !retryVisible &&
    loginActionVisible &&
    loginActionPlacement === "trailing" &&
    (actionIsDisconnected || recoverableUnavailable) &&
    Boolean(onLogin);
  const rawPlanLevel = planLevel?.trim() ?? "";
  const normalizedPlanLevel = rawPlanLevel.toUpperCase();
  const isMaxPlanLevel = isMaxCodingPlanLevel(rawPlanLevel);
  const displayPlanLevel = /^GLM[\s_-]+CODING\b/i.test(rawPlanLevel)
    ? formatQuotaModelDisplayName(rawPlanLevel)
    : normalizedPlanLevel;
  const canUpgrade =
    // Max 已是最高档但仍需要续期入口，不能因为不可升级就隐藏按钮。
    upgradeActionVisible && isPurchased && !isChecking && !isUnsupported;
  const canManageCodingPlan =
    !isDisconnected &&
    !isChecking &&
    !isUnsupported &&
    isPurchased &&
    Boolean(purchaseUrl) &&
    Boolean(onOpenPurchase);
  const disconnectedStartPlanPricingVisible =
    isStartPlanProvider && (isDisconnected || isNotPurchased);
  const startPlanCardVisible =
    startPlanPreviewVisible && disconnectedStartPlanPricingVisible && !upgradePlansVisible;
  const startPlanPreview = useStartPlanPreview({
    enabled: startPlanCardVisible,
  });
  const shouldShowBigModelRegistrationHint =
    isChecking &&
    providerIcon === BIGMODEL_PROVIDER_ID &&
    isBigModelUnregisteredAuthError(authError);
  const createSettingPlanCardFunnelContext = (eventText: string) =>
    createCodingPlanFunnelContext({
      providerId,
      // 修复原因：Start Plan 的升级入口与普通 Coding Plan 套餐卡属于不同链接方式，
      // 埋点必须单独标识，避免把 Start Plan 用户误归类为普通套餐卡来源。
      upgradeSource: isStartPlanProvider ? "setting_start_plan_card" : "setting_plan_card",
      eventRegion: "app.setting",
      eventText,
      entryPlanState: resolveCodingPlanEntryPlanState({
        displayStatus: effectiveViewState.displayStatus,
        providerId,
        planLevel,
      }),
    });
  const openUpgradePlans = (
    initialAudience: PurchaseAudience,
    nextFunnelContext: CodingPlanFunnelContext | null,
  ) => {
    if (onOpenUpgradePlans) {
      // Coding Plan 购买流程不应继续挂载在 Model Settings 内部；
      // 状态卡只负责发起意图，由弹窗 hook 承载购买面板。
      onOpenUpgradePlans({
        initialAudience,
        funnelContext: nextFunnelContext,
      });
      return;
    }
    setUpgradePlansVisible(true);
  };
  const upgradeAction = canUpgrade ? (
    <CodingPlanUpgradeAction
      loginLoading={effectiveViewState.loginLoading}
      upgradePlansVisible={upgradePlansVisible}
      actionLabelId={
        isMaxPlanLevel
          ? "settings.modelProvider.codingPlan.renew"
          : "settings.modelProvider.codingPlan.upgrade"
      }
      billingDiscountActive={isStartPlanProvider && billingDiscount.active}
      billingDiscountConfig={billingDiscount.config}
      onUpgradePlansVisibleChange={(visible) => {
        if (visible) {
          openUpgradePlans(
            purchaseInitialAudience,
            createSettingPlanCardFunnelContext(
              intl.formatMessage({
                id: isMaxPlanLevel
                  ? "settings.modelProvider.codingPlan.renew"
                  : "settings.modelProvider.codingPlan.upgrade",
              }),
            ),
          );
          return;
        }
        setUpgradePlansVisible(visible);
      }}
    />
  ) : null;
  const buyAction =
    !isStartPlanProvider && !canUpgrade && isNotPurchased && !isChecking && !isUnsupported ? (
      <CodingPlanEntryButton
        type="button"
        size="lg"
        // 未购买状态也可能正在等待权益接口返回；此时必须和 Upgrade
        // 按钮一样禁用，避免旧的 notPurchased 快照被提前提交为购买入口。
        disabled={effectiveViewState.loginLoading}
        onClick={() => {
          openUpgradePlans(
            purchaseInitialAudience,
            createSettingPlanCardFunnelContext(
              intl.formatMessage({
                id: "settings.modelProvider.codingPlan.subscribe",
              }),
            ),
          );
        }}
      >
        {/* 单卡同步可能晚于全局套餐查询；仅禁用会丢失等待反馈，和 Upgrade 保持一致。 */}
        {effectiveViewState.loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
        {intl.formatMessage({
          id: "settings.modelProvider.codingPlan.subscribe",
        })}
      </CodingPlanEntryButton>
    ) : null;
  const inlineDisconnectVisible = canDisconnectProvider && !isPurchased;
  const planTitle = resolveCodingPlanStatusCardTitle({
    isPurchased,
    isUnavailable,
    isStartPlanProvider,
    inactivePlanTitle,
    rawPlanLevel,
    displayPlanLevel,
    startPlanTitle: intl.formatMessage({
      id: "settings.modelProvider.planCard.startPlan",
    }),
    codingPlanTitle: intl.formatMessage({
      id: "settings.modelProvider.planCard.codingPlan",
    }),
  });
  const titleBillingDiscountVisible = !isStartPlanProvider && billingDiscount.active;
  const notPurchasedStatusLabel = isNotPurchased ? (
    <span className="flex w-fit items-center gap-1.5 text-foreground-subtle">
      <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
      <span>{intl.formatMessage({ id: statusBadgeId })}</span>
    </span>
  ) : null;
  const startPlanEntries = resolveStartPlanQuotaCardEntries({
    plans: subscriptionDetails ?? [],
    limits: quotaLimits,
  });
  const statusMeta =
    isPurchased && isStartPlanProvider ? (
      // 产品语义:体验套餐用量卡片不展示「管理」「解绑」操作(免费套餐无管理页,
      // 登录态由 family 级连接方式管理),仅保留过期时间与右侧升级 Coding Plan 入口。
      <StartPlanStatusMeta
        expireTime={subscriptionExpireTime}
        entitlements={subscriptionDetails?.[0]?.entitlements}
        hasQuota={hasStartPlanEntitlementQuota(
          subscriptionDetails?.[0]?.entitlements,
          startPlanEntries[0]?.limits ?? quotaLimits,
        )}
        refreshing={startPlanEntitlementRefreshing}
        onRefresh={refreshStartPlanEntitlement}
      />
    ) : isPurchased ? (
      <CodingPlanStatusMeta
        renewTime={subscriptionRenewTime}
        expireTime={subscriptionExpireTime}
        manageLabel={
          canManageCodingPlan
            ? intl.formatMessage({
                id: "settings.modelProvider.codingPlan.manage",
              })
            : null
        }
        unlinkLabel={
          canDisconnectProvider
            ? intl.formatMessage({
                id: "settings.modelProvider.codingPlan.disconnect",
              })
            : null
        }
        unlinkLoading={disconnectLoading}
        onManage={
          canManageCodingPlan && purchaseUrl && onOpenPurchase
            ? () => onOpenPurchase(purchaseUrl)
            : undefined
        }
        onUnlink={canDisconnectProvider ? onDisconnect : undefined}
      />
    ) : shouldShowBigModelRegistrationHint ? (
      <BigModelRegistrationHint onOpenRegistration={onOpenRegistration} />
    ) : inlineDisconnectVisible ? (
      <CodingPlanStatusMeta
        statusLabel={notPurchasedStatusLabel ?? intl.formatMessage({ id: statusBadgeId })}
        unlinkLabel={intl.formatMessage({
          id: "settings.modelProvider.codingPlan.disconnect",
        })}
        unlinkLoading={disconnectLoading}
        onUnlink={onDisconnect}
      />
    ) : (
      <span
        className={
          teamPlanWarningVisible
            ? "flex w-fit items-center gap-1.5 text-ui-base text-warning"
            : "flex w-fit items-center gap-1.5 text-ui-base text-foreground-subtle"
        }
      >
        {isChecking ? <Loader2Icon className="size-3 animate-spin" /> : null}
        {isNotPurchased || teamPlanWarningVisible ? (
          <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : null}
        {statusBadgeMessage || intl.formatMessage({ id: statusBadgeId })}
      </span>
    );
  const usageCardsVisible =
    usageDetailsVisible &&
    isPurchased &&
    (isStartPlanProvider || hasDisplayableCodingPlanUsageLimits(quotaLimits));
  // 同 family 已登录时默认登录动作只刷新；凭据失败后的主动恢复必须强制进入 OAuth。
  const trailingAction = reloginVisible ? (
    <Button
      type="button"
      size="lg"
      onClick={() => onLogin?.({ forceOAuth: true })}
      disabled={effectiveViewState.loginLoading}
    >
      {intl.formatMessage({ id: "login.expired.action" })}
    </Button>
  ) : retryVisible ? (
    <Button type="button" size="lg" onClick={onRetry} disabled={effectiveViewState.loginLoading}>
      {intl.formatMessage({ id: "common.retry" })}
    </Button>
  ) : trailingLoginVisible ? (
    <Button
      type="button"
      size="lg"
      onClick={() => onLogin?.()}
      disabled={effectiveViewState.loginLoading}
    >
      {effectiveViewState.loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
    </Button>
  ) : upgradeAction ? (
    // 升级是 Plan Card 的主操作，和连接入口同属卡片级 action。
    // 放在标题旁会随标题换行抖动；放到右侧并使用同尺寸按钮，层级和位置都更稳定。
    upgradeAction
  ) : buyAction ? (
    buyAction
  ) : null;
  const statusContent = (
    <>
      {isPurchased && statusLabelId === "settings.modelProvider.codingPlan.status.unavailable" ? (
        <span className="text-ui-base text-warning">
          {intl.formatMessage({ id: statusLabelId })}
        </span>
      ) : null}
      {statusMeta}
      <CodingPlanStatusActions
        providerName={providerName}
        isDisconnected={actionIsDisconnected}
        isUnavailable={recoverableUnavailable}
        isPurchased={isPurchased}
        loginLoading={effectiveViewState.loginLoading}
        loginButtonId={loginButtonId}
        loginVisible={
          loginActionVisible && !trailingLoginVisible && !reloginVisible && !retryVisible
        }
        canDisconnectProvider={inlineDisconnectVisible ? false : canDisconnectProvider}
        disconnectLoading={disconnectLoading}
        onLogin={onLogin}
        onDisconnect={onDisconnect}
      />
    </>
  );
  const planCards =
    isStartPlanProvider && isPurchased && startPlanEntries.length > 0
      ? startPlanEntries.map(({ plan, limits: planLimits }, index) => (
          <PlanStatusCardSurface
            key={`${plan.productId}:${index}`}
            planTitle={plan.productName.trim() || planTitle}
            statusMeta={
              index === 0 ? (
                statusContent
              ) : (
                <StartPlanStatusMeta
                  expireTime={plan.expireTime}
                  entitlements={plan.entitlements}
                  hasQuota={hasStartPlanEntitlementQuota(plan.entitlements, planLimits)}
                  refreshing={startPlanEntitlementRefreshing}
                  onRefresh={refreshStartPlanEntitlement}
                />
              )
            }
            trailingAction={index === 0 ? trailingAction : undefined}
            usageContent={
              usageDetailsVisible &&
              (effectiveViewState.balanceStatus === "checking" || planLimits.length > 0) ? (
                <StartPlanQuotaStatusCard
                  isChecking={effectiveViewState.balanceStatus === "checking"}
                  limits={planLimits}
                  embedded
                />
              ) : undefined
            }
          />
        ))
      : [
          <PlanStatusCardSurface
            key="current-plan"
            planTitle={planTitle}
            titleAccessory={
              titleBillingDiscountVisible ? (
                <CodingPlanBillingDiscountBadge config={billingDiscount.config} size="compact" />
              ) : undefined
            }
            statusMeta={statusContent}
            trailingAction={trailingAction}
            usageContent={
              usageCardsVisible ? (
                isStartPlanProvider ? (
                  // 服务端契约保证 balances 只属于 active plans：purchased 快照必带套餐详情，
                  // 多卡路径必然可用。兜底分支（nav item 无套餐详情）不得把全量 quotaLimits
                  // 塞进单卡，否则无归属桶违背「无匹配 plan_id 的桶不得附着到任何卡片」的约定；
                  // 余额未落定时只保留查询占位。
                  effectiveViewState.balanceStatus === "checking" ? (
                    <StartPlanQuotaStatusCard
                      isChecking
                      limits={[]}
                      expireTime={subscriptionExpireTime}
                      embedded
                    />
                  ) : undefined
                ) : (
                  <CodingPlanUsageSummaryCards
                    limits={quotaLimits}
                    mcpQuotaLimit={mcpQuotaLimit}
                    sourceKey={quotaResetSourceKey ?? providerId}
                    preferredProviderId={providerId}
                    accountAccess={quotaResetAccountAccess}
                    onEntitlementRefresh={onQuotaResetEntitlementRefresh}
                  />
                )
              ) : undefined
            }
          />,
        ];

  return (
    <div className="space-y-3">
      {planCards}

      {startPlanCardVisible && !startPlanPreview.loading && startPlanPreview.preview ? (
        <StartPlanCard preview={startPlanPreview.preview} />
      ) : null}
    </div>
  );
}
