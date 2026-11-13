/**
 * Plugin 管理列表的视图模型：store 订阅、跨 Scope 服务解析、派生投影与动作。
 *
 * 从原 PluginsSection 内联的 PluginList 组件提取，hook 调用顺序与订阅粒度保持不变；
 * 视图层只负责渲染，避免单文件再次突破 max-lines。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  Locale,
  RemoteTarget,
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginScope,
  ZCodePluginUserConfigOption,
} from "@zcode/shared";
import type { IServiceAccessor } from "./contract.ts";
import { toast } from "@/components/ui/toast.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { WorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import {
  filterPluginsByQuery,
  partitionPluginsForSettings,
  selectBuiltInPlugins,
  selectPluginsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import {
  buildPluginConfigPatch,
  type PluginOptionDraftValue,
} from "@/settings/pluginConfigPatch.js";
import { resolveManagedPluginDisplay, buildStoreItems } from "@/settings/pluginStoreListing.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import {
  isComputerUseRemoteOrLinux,
  matchesComputerUseSearch,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";
import {
  shouldShowRemoteSyncActions,
  useRemoteSyncDialogIntent,
} from "@/settings/RemoteSyncActions.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import {
  workspaceKey,
  type PluginListProps,
} from "@/settings/plugins-section/pluginsSectionTypes.js";

export interface PluginListController {
  intl: IntlInstance;
  locale: Locale;
  configScope: ZCodePluginScope;
  targetServiceResolution: WorkspaceServicesResolution;
  baseServices: IServiceAccessor;
  loading: boolean;
  togglingPluginId: string | null;
  activeOperations: PluginStoreActions["activeOperations"];
  storeItemById: Map<string, StorePluginItem>;
  visiblePlugins: ZCodePluginInfo[];
  visibleInstalledPlugins: ZCodePluginInfo[];
  visibleBuiltInPlugins: ZCodePluginInfo[];
  installedPluginCount: number;
  showUnavailableComputerUse: boolean;
  hideInstalledGroup: boolean;
  hasEmptySearchResult: boolean;
  computerUseDescriptionId: string;
  connectedRemoteSyncTarget: RemoteTarget | null | undefined;
  remotePluginSyncTargetLabel: string;
  remotePluginSyncOpen: boolean;
  setRemotePluginSyncOpen: (open: boolean) => void;
  selectedPlugin: ZCodePluginInfo | null;
  selectedStoreItem: StorePluginItem | undefined;
  pluginWarningsForSelected: ZCodePluginDiagnostic[];
  pluginOptionsDrafts: Record<string, Record<string, PluginOptionDraftValue>>;
  setPluginOptionsDrafts: Dispatch<
    SetStateAction<Record<string, Record<string, PluginOptionDraftValue>>>
  >;
  setPluginOptionDraft: (pluginId: string, key: string, value: string | number | boolean) => void;
  getPluginOptionValue: (
    plugin: ZCodePluginInfo,
    key: string,
    option: ZCodePluginUserConfigOption,
  ) => string | number | boolean;
  savePluginOptions: (plugin: ZCodePluginInfo) => Promise<void>;
  actions: PluginStoreActions;
  uninstall: ReturnType<typeof usePluginUninstall>;
  closeDetail: () => void;
  refreshAfterPluginChange: () => Promise<void>;
}

export function usePluginListController({
  target,
  configScope,
  searchQuery,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  onDetailOpenChange,
  onOpenPluginStore,
  onOpenUi,
  onVisibleCountChange,
  unscopedServices,
  cacheAuthorityKey,
}: PluginListProps): PluginListController {
  const { intl, locale } = useZCodeIntl();
  const targetServiceResolution = useWorkspaceServicesResolution(
    target?.workspacePath,
    target?.remoteSessionId,
    target?.workspaceIdentity,
    target?.remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey) },
  );
  const baseServices = useBaseWorkspaceServices();
  // Scope 可选择非激活 workspace，若继续从当前 ServiceProvider 取服务，
  // 会把 B 的路径发往 A 的 host。插件读写必须和 Scope target 共用同一服务解析结果。
  const { pluginManagementService } = targetServiceResolution.services;
  const usePluginManagementStore = useScopedPluginManagementStore(pluginManagementService);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const currentWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const currentWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const setEnabled = usePluginManagementStore((state) => state.setEnabled);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const configurePlugin = usePluginManagementStore((state) => state.configurePlugin);
  const currentAuthorityKey = usePluginManagementStore((state) => state.authorityKey);
  const currentConfigScope = usePluginManagementStore((state) => state.configScope);
  const resetPluginConfig = usePluginManagementStore((state) => state.resetPluginConfig);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const activeOperations = usePluginManagementStore((state) => state.activeOperations);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [pluginOptionsDrafts, setPluginOptionsDrafts] = useState<
    Record<string, Record<string, PluginOptionDraftValue>>
  >({});
  // 设置页重构后只保留了 Plugin 管理列表，漏掉了旧版插件页的远端同步入口。
  // 同步目标必须沿用当前 Scope 的 target services，不能回退到激活 workspace 的 host。
  const connectedRemoteSyncTarget =
    targetServiceResolution.rpcReady &&
    shouldShowRemoteSyncActions({
      remoteSessionId: target?.remoteSessionId,
      remoteTarget: target?.remoteTarget,
      clientMode: isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
      hasLocalSourceService: Boolean(baseServices.pluginSyncService),
    }) &&
    target?.workspacePath
      ? target.remoteTarget
      : null;
  // 设置页重构时只迁移了插件远程同步操作，遗漏了当前远端工作区提示，
  // 用户无法确认插件列表实际对应的是哪个远程目标。
  const remotePluginSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSkillSyncTarget(connectedRemoteSyncTarget, target?.workspacePath ?? "")
    : "";
  const targetKey = target ? workspaceKey(target) : "";
  const pluginSyncTargetKey = target
    ? `${targetKey}\u0000${target.remoteSessionId?.trim() ?? ""}`
    : "";
  const { open: remotePluginSyncOpen, setOpen: setRemotePluginSyncOpen } =
    useRemoteSyncDialogIntent({
      rpcReady: targetServiceResolution.rpcReady,
      targetKey: pluginSyncTargetKey,
    });
  const storeKey = currentWorkspaceIdentity?.trim() || currentWorkspacePath || "";
  const storeMatchesTarget =
    storeKey === targetKey &&
    currentAuthorityKey === (cacheAuthorityKey?.trim() || null) &&
    currentConfigScope === configScope;
  const storeItemById = useMemo(
    () =>
      new Map(
        buildStoreItems({
          marketplaces,
          marketplaceAvailabilityKnown,
          availablePlugins,
          installedPlugins,
          plugins,
          restorableBuiltins,
        }).map((item) => [item.id, item]),
      ),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  const visiblePlugins = useMemo(() => {
    if (!storeMatchesTarget) return [];
    return filterPluginsByQuery(
      selectPluginsForScope(plugins, installedPlugins, configScope),
      searchQuery,
      storeItemById,
      locale,
    );
  }, [
    configScope,
    installedPlugins,
    locale,
    plugins,
    searchQuery,
    storeItemById,
    storeMatchesTarget,
  ]);
  const scopedPlugins = useMemo(
    () => (storeMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, configScope) : []),
    [configScope, installedPlugins, plugins, storeMatchesTarget],
  );
  const builtInPluginIds = useMemo(
    () => new Set(selectBuiltInPlugins(plugins, installedPlugins).map((plugin) => plugin.id)),
    [installedPlugins, plugins],
  );
  const visiblePluginGroups = useMemo(
    () => partitionPluginsForSettings(visiblePlugins, builtInPluginIds),
    [builtInPluginIds, visiblePlugins],
  );
  const scopedPluginGroups = useMemo(
    () => partitionPluginsForSettings(scopedPlugins, builtInPluginIds),
    [builtInPluginIds, scopedPlugins],
  );
  const visibleBuiltInPlugins = visiblePluginGroups.builtIn;
  const visibleInstalledPlugins = visiblePluginGroups.installed;
  const installedPluginCount = scopedPluginGroups.installed.length;
  const computerUseAvailability = resolveComputerUseAvailability({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    remoteSessionId: target?.remoteSessionId,
    remoteTarget: target?.remoteTarget,
    workspaceIdentity: target?.workspaceIdentity,
  });
  const showUnavailableComputerUse = Boolean(
    configScope === "user" &&
    target &&
    !loading &&
    isComputerUseRemoteOrLinux(computerUseAvailability) &&
    matchesComputerUseSearch(searchQuery),
  );
  const hasEmptySearchResult = Boolean(
    target &&
    !loading &&
    searchQuery.trim() &&
    visibleInstalledPlugins.length === 0 &&
    visibleBuiltInPlugins.length === 0 &&
    !showUnavailableComputerUse,
  );
  const hideInstalledGroup = Boolean(searchQuery.trim() && visibleInstalledPlugins.length === 0);
  useEffect(() => {
    onVisibleCountChange?.(visibleInstalledPlugins.length + visibleBuiltInPlugins.length);
  }, [onVisibleCountChange, visibleBuiltInPlugins.length, visibleInstalledPlugins.length]);
  const refreshAfterPluginChange = useCallback(async () => {
    if (!target || !targetServiceResolution.rpcReady) return;
    await initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [
    initialize,
    cacheAuthorityKey,
    configScope,
    pluginManagementService,
    target,
    targetServiceResolution.rpcReady,
  ]);
  const handleSetEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      const succeeded = await setEnabled(pluginId, enabled, pluginManagementService, configScope);
      if (!succeeded) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      const messageId =
        configScope === "workspace"
          ? enabled
            ? "settings.plugins.toggle.workspaceEnabled"
            : "settings.plugins.toggle.workspaceDisabled"
          : enabled
            ? "settings.plugins.toggle.enabled"
            : "settings.plugins.toggle.disabled";
      toast(intl.formatMessage({ id: messageId }, { plugin: pluginLabel }));
    },
    [configScope, intl, locale, pluginManagementService, plugins, setEnabled, storeItemById],
  );
  const handleResetPluginConfig = useCallback(
    async (pluginId: string) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      const restored = await resetPluginConfig(pluginId, pluginManagementService, "workspace");
      if (!restored) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      toast(intl.formatMessage({ id: "settings.plugins.scope.restored" }, { plugin: pluginLabel }));
    },
    [intl, locale, pluginManagementService, plugins, resetPluginConfig, storeItemById],
  );
  const uninstall = usePluginUninstall({
    store: usePluginManagementStore,
    pluginService: pluginManagementService,
    installedPlugins,
    plugins,
    activeOperations,
    onAfterUninstall: refreshAfterPluginChange,
  });
  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, pluginManagementService);
      if (usePluginManagementStore.getState().error) return;
      await refreshAfterPluginChange();
    },
    [pluginManagementService, refreshAfterPluginChange, updatePlugin],
  );
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? null;
  // 插件自身 warning 诊断（如声明的技能路径扫描为空）：详情高级区展示，避免静默失败。
  const pluginWarningsForSelected = selectedPlugin
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === selectedPlugin.id && diagnostic.severity === "warning",
      )
    : [];
  const selectedStoreItem = selectedPluginId ? storeItemById.get(selectedPluginId) : undefined;
  const closeDetail = useCallback(() => {
    setSelectedPluginId(null);
    onDetailOpenChange?.(false);
  }, [onDetailOpenChange]);
  useEffect(() => {
    closeDetail();
  }, [closeDetail, targetKey]);
  useEffect(() => {
    if (selectedPluginId && !selectedPlugin) closeDetail();
  }, [closeDetail, selectedPlugin, selectedPluginId]);
  const setPluginOptionDraft = (
    pluginId: string,
    key: string,
    value: string | number | boolean,
  ) => {
    setPluginOptionsDrafts((current) => ({
      ...current,
      [pluginId]: { ...current[pluginId], [key]: value },
    }));
  };
  const getPluginOptionValue = (
    plugin: ZCodePluginInfo,
    key: string,
    option: ZCodePluginUserConfigOption,
  ): string | number | boolean => {
    const draft = pluginOptionsDrafts[plugin.id]?.[key];
    if (draft === null) return "";
    return (
      draft ??
      plugin.configuredOptions?.[key] ??
      option.default ??
      (option.type === "boolean" ? false : "")
    );
  };
  const savePluginOptions = async (plugin: ZCodePluginInfo) => {
    const { options, clearOptionKeys } = buildPluginConfigPatch(
      plugin,
      pluginOptionsDrafts[plugin.id] ?? {},
    );
    // 没有显式修改时不写入空的 Workspace 配置，避免无操作保存制造配置足迹。
    if (Object.keys(options).length === 0 && clearOptionKeys.length === 0) return;
    const configured = await configurePlugin(
      plugin.id,
      options,
      pluginManagementService,
      configScope,
      clearOptionKeys,
    );
    // 保存失败时保留用户输入和敏感字段清除意图，避免 RPC 错误后 UI 看起来像已提交。
    if (!configured) return;
    setPluginOptionsDrafts((current) => {
      const next = { ...current };
      delete next[plugin.id];
      return next;
    });
  };
  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: (pluginId) => {
        setSelectedPluginId(pluginId);
        onDetailOpenChange?.(true);
      },
      onOpenUi: onOpenUi
        ? (item) =>
            onOpenUi(
              item,
              target,
              item.info?.enabled
                ? undefined
                : () => setEnabled(item.id, true, pluginManagementService, configScope),
            )
        : undefined,
      onInstall: () => onOpenPluginStore(),
      onUninstall: uninstall.requestUninstall,
      onSetEnabled: (pluginId, enabled) => void handleSetEnabled(pluginId, enabled),
      onResetConfig:
        configScope === "workspace"
          ? (pluginId) => void handleResetPluginConfig(pluginId)
          : undefined,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      activeOperations,
      togglingPluginId,
    }),
    [
      configScope,
      handleResetPluginConfig,
      handleSetEnabled,
      handleUpdatePlugin,
      onDetailOpenChange,
      onOpenPluginStore,
      activeOperations,
      togglingPluginId,
      uninstall.requestUninstall,
      onOpenUi,
      target,
      setEnabled,
      pluginManagementService,
    ],
  );
  useEffect(() => {
    if (!target || !targetServiceResolution.rpcReady) return;
    void initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [
    initialize,
    cacheAuthorityKey,
    configScope,
    pluginManagementService,
    target,
    targetServiceResolution.rpcReady,
  ]);

  return {
    intl,
    locale,
    configScope,
    targetServiceResolution,
    baseServices,
    loading,
    togglingPluginId,
    activeOperations,
    storeItemById,
    visiblePlugins,
    visibleInstalledPlugins,
    visibleBuiltInPlugins,
    installedPluginCount,
    showUnavailableComputerUse,
    hideInstalledGroup,
    hasEmptySearchResult,
    computerUseDescriptionId:
      computerUseAvailability.kind === "local-linux"
        ? "settings.computerUse.unsupported.linuxDescription"
        : "settings.computerUse.unsupported.remoteDescription",
    connectedRemoteSyncTarget,
    remotePluginSyncTargetLabel,
    remotePluginSyncOpen,
    setRemotePluginSyncOpen,
    selectedPlugin,
    selectedStoreItem,
    pluginWarningsForSelected,
    pluginOptionsDrafts,
    setPluginOptionsDrafts,
    setPluginOptionDraft,
    getPluginOptionValue,
    savePluginOptions,
    actions,
    uninstall,
    closeDetail,
    refreshAfterPluginChange,
  };
}
