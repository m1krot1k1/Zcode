import { useCallback, useEffect, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import type { BuiltinModelProviderId } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { createCustomProviderNodeKey } from "../utils.js";
import { resolveCodingPlanIntentProviderId, resolveProviderFamilySideNodeKey } from "./helpers.js";
import type { ModelProviderSectionProps } from "./types.js";

/**
 * 模型 Provider 设置只由 SettingsPage 注入 Local Host；这里不接收 workspaceIdentity，
 * 防止远程 workspace 误将 Provider Settings 的读写路由到远端 Environment。
 */
export function useModelProviderSectionEnvironment(props: ModelProviderSectionProps) {
  const {
    workspacePath = "",
    codeIndexWorkspacePath,
    codeIndexWorkspaceIdentity,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired = false,
    pendingModelProviderTarget,
    onConsumePendingModelProviderTarget,
  } = props;
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const { modelSelectionService, oauthService, credentialService, codeIntelligenceService } =
    useServices();
  const codeIndexWorkspaceRef = useMemo(() => {
    const path = codeIndexWorkspacePath?.trim();
    if (!path) return undefined;
    return {
      workspacePath: path,
      ...(codeIndexWorkspaceIdentity?.trim()
        ? { workspaceIdentity: codeIndexWorkspaceIdentity.trim() }
        : {}),
    };
  }, [codeIndexWorkspaceIdentity, codeIndexWorkspacePath]);
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing: modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const entitledAccountProviderIds = useMemo<ReadonlySet<string>>(() => {
    return new Set(
      (providerSettingsView?.providers ?? [])
        .filter(
          (provider) =>
            provider.effectiveConfig.access?.type === "zhipu-account" &&
            provider.effectiveConfig.access.entitled === true,
        )
        .map((provider) => provider.providerId),
    );
  }, [providerSettingsView]);
  const providerConnectionRefreshSignal = providerSettingsView?.revision;
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [invalidProviderTarget, setInvalidProviderTarget] = useState(() =>
    Boolean(
      initialModelProviderTarget && !resolveCodingPlanIntentProviderId(initialModelProviderTarget),
    ),
  );
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(() => {
    const providerId = resolveCodingPlanIntentProviderId(initialModelProviderTarget);
    return providerId ? resolveProviderFamilySideNodeKey(providerId) : null;
  });
  const [presetSubscriptionProviderId, setPresetSubscriptionProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const [codingPlanStatusSyncProviderId, setCodingPlanStatusSyncProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const [codingPlanDisconnectProviderId, setCodingPlanDisconnectProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  // 死代码清理：refreshToken 只被已下线的原生购买面板消费，这里仅保留 setter 供
  // 登录/解绑后的 refreshCodingPlanProducts 契约调用（保持共享 helper 签名不变）。
  const [, setCodingPlanProductsRefreshToken] = useState(0);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);

  useEffect(() => {
    if (
      !pendingCreatedProviderId ||
      !modelProviders.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      return;
    }
    // saveProvider 会先发布共享快照，再异步落盘；React 在高负载下可能先提交
    // selectedNodeKey、后提交 provider 列表。导航校正会把暂时不存在的 custom key 回退，
    // 新 provider 随后出现也不会再自动选中。只在列表事实可见后完成选中与草稿清理。
    setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
    setPendingCreatedProviderId(null);
  }, [modelProviders, pendingCreatedProviderId]);

  const applyModelProviderTarget = useCallback(
    (target: SettingsModelProviderTarget | undefined) => {
      if (!target) return false;
      const providerId = resolveCodingPlanIntentProviderId(target);
      if (!providerId) {
        // 未知 ID 不能只静默忽略：pending 指令不消费的话，外部输入错误会困住导航。
        // 仅显示错误，保留当前可操作页面和持久连接，后续合法导航/手动选择可恢复。
        logger.warn("[ModelProviderSection] 无法打开目标供应商", { providerId: target.providerId });
        setInvalidProviderTarget(true);
        setTemplatePickerOpen(false);
        return true;
      }

      setInvalidProviderTarget(false);
      setTemplatePickerOpen(false);
      setSelectedNodeKey(resolveProviderFamilySideNodeKey(providerId));
      return true;
    },
    [],
  );

  useEffect(() => {
    if (!pendingModelProviderTarget) {
      return;
    }
    if (applyModelProviderTarget(pendingModelProviderTarget)) {
      onConsumePendingModelProviderTarget?.();
    }
  }, [applyModelProviderTarget, onConsumePendingModelProviderTarget, pendingModelProviderTarget]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section !== "modelProvider") {
          return;
        }
        applyModelProviderTarget(
          detail?.modelProviderId
            ? {
                providerId: detail.modelProviderId,
              }
            : undefined,
        );
      }),
    [applyModelProviderTarget],
  );

  return {
    intl,
    locale,
    confirmDialog,
    platform,
    modelSelectionService,
    oauthService,
    credentialService,
    codeIntelligenceService,
    codeIndexWorkspaceRef,
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
    entitledAccountProviderIds,
    providerConnectionRefreshSignal,
    invalidProviderTarget,
    setInvalidProviderTarget,
    selectedNodeKey,
    setSelectedNodeKey,
    presetSubscriptionProviderId,
    setPresetSubscriptionProviderId,
    codingPlanStatusSyncProviderId,
    setCodingPlanStatusSyncProviderId,
    codingPlanDisconnectProviderId,
    setCodingPlanDisconnectProviderId,
    setCodingPlanProductsRefreshToken,
    pendingCreatedProviderId,
    setPendingCreatedProviderId,
    templatePickerOpen,
    setTemplatePickerOpen,
    creatingProvider,
    setCreatingProvider,
    applyModelProviderTarget,
  };
}

export type ModelProviderSectionEnvironment = ReturnType<typeof useModelProviderSectionEnvironment>;
