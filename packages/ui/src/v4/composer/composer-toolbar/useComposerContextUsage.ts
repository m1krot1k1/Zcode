/**
 * Контекстная часть тулбара: настройки провайдера, entitlements и источники
 * usage для кольца/баланса рядом с отправкой.
 *
 * Вынесено из V4ComposerToolbar.tsx. Порядок вызовов, gating-условия и
 * memo-зависимости сохранены дословно: здесь живёт только чтение конфигурации
 * и сборка presentation-конфигов, без собственного состояния.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveModelProviderFamilySpecByProviderId,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import {
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  type SidebarUsageCodingPlanProviderId,
  type SidebarUsageCodingPlanSourceId,
  writeSidebarUsageCodingPlanProviderPreference,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import type { CodingPlanUsageSource } from "@/lib/codingPlanUsageSources.js";
import { setPendingSettingsUsageCodingPlanIntent } from "@/lib/settingsNavigation.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useToolbarConfigOptions } from "@/hooks/useZCodeConfig.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveDraftDisplayedConfig } from "@/v4/composer/draftWorkspaceDefaults.js";
import {
  resolveContextCodingPlanUsageSource,
  resolveV4ContextPlanConnection,
} from "./contextPlanSources.js";
import type { V4ComposerToolbarProps } from "./types.js";

export function useComposerContextUsage({
  workspacePath,
  workspaceIdentity,
  provider,
  draftConfig,
  activeConfigPicker,
}: V4ComposerToolbarProps) {
  const { intl, locale } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  // 配置面读取：workspace 缺省目录（taskId=null），不读旧会话态。
  const { error: configOptionsError } = useToolbarConfigOptions(
    workspacePath,
    null,
    workspaceIdentity,
  );
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready"
      ? providerSettingsRead.state.view
      : null;
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  // 配置面存活服务读（过渡归宿 = 配置面 v4 化）：连接方式选中键喂 BigModel Team Plan 门控豁免。
  const baseServices = useBaseWorkspaceServices();
  const { settings: sharedSettings } = useSettings({ services: baseServices });
  const {
    entitlements,
    enabledStartPlanProviderIds,
    refresh: refreshCodingPlanEntitlements,
  } = useCodingPlanEntitlements({
    providerSettingsView,
    connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
    // Context 只在用户 hover/open 时刷新，不在 composer 挂载时请求额度。
    suppressProviderFingerprintAutoRefresh: true,
  });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);

  // 空模型/档位曾被 Session 旧值补回，界面显示与实际不可提交状态矛盾。
  // 初始化已经由 Composer owner 完成；显示层只消费它，不能再次补值。
  const effectiveConfig = useMemo<SessionConfigState | null>(() => {
    return resolveDraftDisplayedConfig(draftConfig ?? {});
  }, [draftConfig]);

  const handleOpenStartPlanUpgrade = useCallback(
    (providerId: string) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext: createCodingPlanFunnelContext({
          providerId,
          upgradeSource: "session_token_usage",
          eventRegion: "app.session",
          eventText: intl.formatMessage({ id: "chat.quota.action.upgrade" }),
          entryPlanState: resolveCodingPlanEntryPlanState({
            providerId,
            displayStatus: "purchased",
            planLevel: "start",
          }),
        }),
      });
    },
    [intl, openCodingPlanUpgrade],
  );
  const handleOpenUsageDetails = useCallback(
    (sourceId?: SidebarUsageCodingPlanSourceId) => {
      if (sourceId) {
        writeSidebarUsageCodingPlanProviderPreference(sourceId);
      }
      // 剩余额度「更多」直达 Coding Plan 使用统计（按上面写入的来源偏好选中当前套餐），
      // 不落到应用用量；通用 Usage 入口仍走 setPendingSettingsUsageIntent。
      setPendingSettingsUsageCodingPlanIntent();
      openSettingsTab();
    },
    [openSettingsTab],
  );

  const contextPlanConnection = useMemo(
    () =>
      resolveV4ContextPlanConnection({
        connectionSelections:
          sharedSettings?.providerFamilyConnectionSelections,
        providerId: effectiveConfig?.provider,
      }),
    [
      effectiveConfig?.provider,
      sharedSettings?.providerFamilyConnectionSelections,
    ],
  );
  const contextAccountProviderAccess = useMemo(
    () =>
      contextPlanConnection.kind === "personalCoding" ||
      contextPlanConnection.kind === "teamCoding"
        ? resolveEntitledAccountProviderAccess(
            providerSettingsView,
            contextPlanConnection.providerId,
          )
        : null,
    [contextPlanConnection, providerSettingsView],
  );
  const contextStartPlanBalanceConfig = useMemo<
    ChatStartPlanBalanceConfig | undefined
  >(() => {
    if (contextPlanConnection.kind !== "start") {
      return undefined;
    }
    const entitlement = entitlements[contextPlanConnection.providerId];
    // Start Plan 只有具备独立 Account Access 时才挂载 hover 查询入口。
    const startPlanEntitlementEnabled = enabledStartPlanProviderIds.includes(
      contextPlanConnection.providerId,
    );
    return {
      loading: entitlement?.loading ?? providerSourcesLoading,
      // hover access 刷新入口不能只在 Coding Plan 配置上（onAccess）：
      // start plan 用户 hover context 面板从不主动刷新今日余额，只能等设置页/侧栏
      // 刷新后被动同步。接入与 Coding Plan 相同的静默 access 刷新；60s access 窗口
      // 与 in-flight 合并由刷新策略层自动生效，不会因反复 hover 放大 billing/balance 请求。
      ...(startPlanEntitlementEnabled
        ? {
            onAccess: () =>
              refreshCodingPlanEntitlements({ silent: true, reason: "access" }),
          }
        : {}),
      onUpgradeClick: () =>
        handleOpenStartPlanUpgrade(contextPlanConnection.providerId),
      snapshot:
        entitlement?.snapshot?.provider?.id === contextPlanConnection.providerId
          ? entitlement.snapshot
          : null,
    };
  }, [
    contextPlanConnection,
    enabledStartPlanProviderIds,
    entitlements,
    handleOpenStartPlanUpgrade,
    providerSourcesLoading,
    refreshCodingPlanEntitlements,
  ]);
  const contextStartPlanBalance = hasChatStartPlanBalance(
    contextStartPlanBalanceConfig,
  )
    ? contextStartPlanBalanceConfig
    : undefined;

  // 按当前连接 family 拉取团队产品，避免 zai 团队误用 bigmodel 产品目录。
  const connectionFamily =
    resolveModelProviderFamilySpecByProviderId(effectiveConfig?.provider ?? "")
      ?.id ??
    sharedSettings?.providerFamilyDomain ??
    "bigmodel";
  const user = useZCodeStoreWithDefault((state) => state.user, undefined);
  const connectionAuthenticated =
    user !== null &&
    Boolean(
      providerSettingsView?.providers.some(
        (p) =>
          p.effectiveConfig.access?.type === "zhipu-account" &&
          p.effectiveConfig.access.accountType === connectionFamily &&
          p.enabled &&
          p.accountState?.unavailableReason !== "not-authenticated" &&
          (p.effectiveConfig.access.mode === "team-coding-plan" ||
            p.accountState?.availability === "available"),
      ),
    );
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      !providerSourcesLoading &&
      (contextPlanConnection.kind === "teamCoding" ||
        activeConfigPicker === "model") &&
      connectionAuthenticated,
    authenticated: connectionAuthenticated,
    family: connectionFamily,
  });
  const subscribedTeamProducts = useMemo(
    () =>
      (connectionAuthenticated
        ? enterpriseProducts.snapshot?.productList.filter(
            (product) => product.subscribed === true,
          )
        : undefined) ?? [],
    [connectionAuthenticated, enterpriseProducts.snapshot?.productList],
  );
  const authSessionSeq = useZCodeStoreWithDefault(
    (state) => state.authSessionSeq,
    0,
  );
  const teamUsageScope = useMemo(
    () => ({}),
    [baseServices, connectionFamily, user?.id, authSessionSeq],
  );
  const contextTeamUsageSourceCacheRef = useRef<{
    scope: object;
    sources: CodingPlanUsageSource[];
  }>({ scope: teamUsageScope, sources: [] });
  // 原因：独立来源缓存可复活已清空的目录；鉴权边界要在本次渲染就隔离，不能等待 Provider 刷新。
  if (
    contextTeamUsageSourceCacheRef.current.scope !== teamUsageScope ||
    !connectionAuthenticated
  )
    contextTeamUsageSourceCacheRef.current = {
      scope: teamUsageScope,
      sources: [],
    };
  const contextCodingPlanUsageProviderId =
    contextPlanConnection.kind === "personalCoding" ||
    contextPlanConnection.kind === "teamCoding"
      ? contextPlanConnection.providerId
      : undefined;
  const contextCodingPlanUsageTeamSource = useMemo(
    () =>
      connectionAuthenticated && contextPlanConnection.kind === "teamCoding"
        ? resolveContextCodingPlanUsageSource({
            accountAccess: contextAccountProviderAccess?.access,
            cachedTeamSources: contextTeamUsageSourceCacheRef.current.sources,
            // 原硬取 bigmodelCodingPlan 的 entitlement snapshot，
            // zai team plan 查不到额度。改为按 connection.providerId 取对应 snapshot。
            entitlementSnapshot:
              entitlements[contextPlanConnection.providerId]?.snapshot ?? null,
            providerId: contextPlanConnection.providerId,
            teamSelection: contextPlanConnection.selection,
            subscribedTeamProducts,
          })
        : null,
    [
      connectionAuthenticated,
      teamUsageScope,
      contextAccountProviderAccess?.access,
      contextPlanConnection,
      entitlements,
      subscribedTeamProducts,
    ],
  );
  useEffect(() => {
    if (!contextCodingPlanUsageTeamSource) {
      return;
    }
    const cache = contextTeamUsageSourceCacheRef.current.sources;
    const nextCache = cache.filter(
      (source) => source.id !== contextCodingPlanUsageTeamSource.id,
    );
    nextCache.unshift(contextCodingPlanUsageTeamSource);
    // Team -> Personal(no_plan) -> Team 期间企业商品或个人 snapshot 可能短暂缺失。
    // 保留最近解析过的团队 source，避免输入框 context 余额跟随水合顺序闪断。
    contextTeamUsageSourceCacheRef.current = {
      scope: teamUsageScope,
      sources: nextCache.slice(0, 8),
    };
  }, [contextCodingPlanUsageTeamSource, teamUsageScope]);
  const contextCodingPlanUsageSelectedSourceId:
    | SidebarUsageCodingPlanSourceId
    | undefined =
    contextPlanConnection.kind === "teamCoding"
      ? contextCodingPlanUsageTeamSource?.id
      : contextCodingPlanUsageProviderId;
  const teamEntitlement = useUsageEntitlement({
    enabled:
      !providerSourcesLoading && Boolean(contextCodingPlanUsageTeamSource),
    includeSubscription: true,
    // 原硬编码 bigmodelCodingPlan，zai family team plan 选中时
    // contextCodingPlanUsageTeamSource.providerId 是 zaiCodingPlan，但这里仍传 bigmodelCodingPlan
    // → 服务端 pickQuotaProvider 按 providerId 精确匹配选不到 zai provider →
    // resolveAuthorization 返回 null → zai team plan 的输入框上下文用量区域不显示额度。
    // 改为跟随 team source 的 providerId（已在 resolveContextTeamUsageSourceFromEntitlementSnapshot
    // / resolveV4ContextPlanConnection 按 family 正确产出 zaiCodingPlan/bigmodelCodingPlan）。
    preferredProviderId:
      contextCodingPlanUsageTeamSource?.providerId ??
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: contextCodingPlanUsageTeamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: contextCodingPlanUsageTeamSource?.id,
    refreshOnMount: false,
  });
  const refreshTaskEntitlements = useCallback(
    async (options?: UsageEntitlementRefreshOptions) => {
      // Team Plan 的 context 面板使用 sourceId 隔离自己的 freshness key；任务边界刷新时
      // 与全局 entitlement 一起发布，底层 request key 会合并相同团队请求。
      await Promise.all([
        refreshCodingPlanEntitlements(options),
        teamEntitlement.refresh(options),
      ]);
    },
    [refreshCodingPlanEntitlements, teamEntitlement.refresh],
  );
  const contextCodingPlanUsageProviders = useMemo(() => {
    if (
      contextPlanConnection.kind !== "personalCoding" ||
      !contextCodingPlanUsageProviderId
    ) {
      return [];
    }
    const access = contextAccountProviderAccess;
    if (!access) return [];
    return [
      {
        providerId:
          contextCodingPlanUsageProviderId as SidebarUsageCodingPlanProviderId,
        accountAccess: access.access,
        label:
          access.label ||
          (contextCodingPlanUsageProviderId ===
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
            ? "Z.ai - Coding Plan"
            : "BigModel - Coding Plan"),
      },
    ];
  }, [
    contextAccountProviderAccess,
    contextCodingPlanUsageProviderId,
    contextPlanConnection.kind,
  ]);
  const codingPlanUsageEntitlements = useMemo<
    ChatCodingPlanUsageRemainingConfig["entitlements"]
  >(() => {
    if (contextCodingPlanUsageTeamSource) {
      return [
        {
          sourceId: contextCodingPlanUsageTeamSource.id,
          providerId: contextCodingPlanUsageTeamSource.providerId,
          accountAccess: contextCodingPlanUsageTeamSource.accountAccess,
          label: contextCodingPlanUsageTeamSource.label,
          snapshot: teamEntitlement.snapshot,
          loading: teamEntitlement.loading,
          error: teamEntitlement.error,
        },
      ];
    }

    if (
      contextPlanConnection.kind !== "personalCoding" ||
      !contextCodingPlanUsageProviderId ||
      contextCodingPlanUsageProviders.length === 0
    ) {
      return [];
    }
    const providerId = contextCodingPlanUsageProviderId;
    const entitlement = entitlements[providerId];
    return [
      {
        sourceId: providerId,
        providerId,
        accountAccess: contextCodingPlanUsageProviders[0]!.accountAccess,
        snapshot: entitlement?.snapshot ?? null,
        loading: entitlement?.loading ?? providerSourcesLoading,
        error: entitlement?.error ?? null,
      },
    ];
  }, [
    contextCodingPlanUsageProviderId,
    contextCodingPlanUsageProviders.length,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    entitlements,
    providerSourcesLoading,
    teamEntitlement.error,
    teamEntitlement.loading,
    teamEntitlement.snapshot,
  ]);
  const handleUsageClick = useCallback(
    () => handleOpenUsageDetails(contextCodingPlanUsageSelectedSourceId),
    [contextCodingPlanUsageSelectedSourceId, handleOpenUsageDetails],
  );
  const codingPlanUsageRemainingConfig = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (
      contextPlanConnection.kind !== "personalCoding" &&
      !contextCodingPlanUsageTeamSource
    ) {
      return undefined;
    }
    return {
      availableProviders: contextCodingPlanUsageProviders,
      entitlements: codingPlanUsageEntitlements,
      modelProvidersLoading: providerSourcesLoading,
      onEntitlementRefresh: () =>
        refreshTaskEntitlements({ force: true, silent: true }),
      onAccess: () =>
        refreshTaskEntitlements({ silent: true, reason: "access" }),
      onUsageClick: handleUsageClick,
      selectedProviderId: contextCodingPlanUsageSelectedSourceId,
    };
  }, [
    contextCodingPlanUsageProviders,
    contextCodingPlanUsageSelectedSourceId,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    codingPlanUsageEntitlements,
    handleUsageClick,
    providerSourcesLoading,
    refreshTaskEntitlements,
  ]);
  const codingPlanUsageRemaining =
    codingPlanUsageRemainingConfig &&
    hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingConfig)
      ? codingPlanUsageRemainingConfig
      : undefined;

  return {
    intl,
    locale,
    displayProvider,
    effectiveConfig,
    configOptionsError,
    providerSettingsView,
    providerSourcesLoading,
    sharedSettings,
    connectionFamily,
    subscribedTeamProducts,
    contextStartPlanBalance,
    codingPlanUsageRemaining,
  };
}

export type ComposerContextUsageState = ReturnType<
  typeof useComposerContextUsage
>;
