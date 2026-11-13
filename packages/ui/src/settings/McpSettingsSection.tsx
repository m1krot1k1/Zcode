/**
 * MCP Settings Section
 *
 * Manages MCP server configuration in the settings page.
 * Supports the unified ZCode Agent MCP source backed by settings directories.
 *
 * The refresh rules, presentational sub-views and action handlers live in
 * `./mcp-settings-section/`; this module keeps the public API and the
 * hook/effect order of the section.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COMMUNITY_MCP_PRESETS,
  filterClineMcpMarketplaceEntries,
  filterCommunityMcpPresets,
  type ClineMcpMarketplaceCatalog,
  type RemoteTarget,
  type ZCodeMcpServer,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { McpServersImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { McpRegistryMarketplace } from "@/settings/McpRegistryMarketplace.js";
import { McpServerList } from "@/settings/McpServerList.js";
import { PluginInstallEmptyState, PluginLoadingState } from "@/settings/PluginInstallEmptyState.js";
import { RemoteSyncDialogs, shouldShowRemoteSyncActions } from "@/settings/RemoteSyncActions.js";
import { SettingsResourceGroupHeader } from "@/settings/SettingsResourceGroup.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import type { McpEditorMode } from "@/settings/mcpSettingsShared.js";
import {
  filterReviewedClinePresetDuplicates,
  filterUninstalledMcpPresets,
} from "@/settings/mcpRegistryCatalogView.js";
import {
  buildPluginMcpServerItems,
  filterLocalMcpServers,
  groupPluginMcpServersByPlugin,
} from "@/settings/pluginManagedResourceGroups.js";
import { selectPluginsForScope } from "@/settings/pluginCapabilityProjection.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import { createMcpSettingsActions } from "@/settings/mcp-settings-section/mcpSettingsSectionActions.js";
import { McpCommunityCatalog } from "@/settings/mcp-settings-section/McpCommunityCatalog.js";
import { McpSettingsEditorView } from "@/settings/mcp-settings-section/McpSettingsEditorView.js";
import { PluginMcpServerList } from "@/settings/mcp-settings-section/PluginMcpServerList.js";
import type { McpOAuthAuthorizationFollowupRefresh } from "@/settings/mcp-settings-section/mcpSettingsStatusList.js";
import { shouldShowPluginMcpServersInMcpSettings } from "@/settings/mcp-settings-section/mcpSettingsStatusList.js";
import { useMcpSettingsStatusRefresh } from "@/settings/mcp-settings-section/useMcpSettingsStatusRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useConfigWorkspaceServices as useWorkspaceServices } from "@/workspace-config-catalog/index.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import { Import, Plus, UploadCloud } from "lucide-react";

export {
  addCommunityMcpPresetToScope,
  type AddCommunityMcpPresetInput,
} from "@/settings/mcp-settings-section/mcpSettingsPresets.js";
export { McpCommunityCatalog } from "@/settings/mcp-settings-section/McpCommunityCatalog.js";
export {
  buildMcpOAuthAuthorizationStatusRefreshOptions,
  buildMcpOAuthAuthorizationStatusRefreshServers,
  buildMcpServerStatusListKey,
  buildPendingMcpOAuthAuthorizationRefreshKey,
  buildPluginMcpServerStatusListKey,
  createMcpOAuthAuthorizationStatusRefreshDeadline,
  createMcpStatusListRefreshQueue,
  isMcpOAuthAuthorizationStatusRefreshExpired,
  refreshMcpServerStatusList,
  resolveMcpStatusListRefreshSkipReason,
  shouldShowPluginMcpServersInMcpSettings,
  transitionMcpAutoStatusListRefreshKey,
  transitionMcpOAuthAuthorizationPendingRefresh,
} from "@/settings/mcp-settings-section/mcpSettingsStatusList.js";

interface McpSettingsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  isWebRemoteControl?: boolean;
  scopeFilter: "user" | "workspace";
  parentScopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
  onOpenPluginStore?: () => void;
  showMarketplaceBreadcrumb?: boolean;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

export function McpSettingsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  localWorkspacePath,
  isWebRemoteControl = false,
  scopeFilter,
  parentScopeKey,
  workspaceTabs,
  searchQuery,
  onVisibleCountChange,
  onEditorOpenChange,
  onFormScopeKeyChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  unscopedServices,
  cacheAuthorityKey,
}: McpSettingsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const services = useWorkspaceServices(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey) },
  );
  const platform = usePlatform();
  const baseServices = useBaseWorkspaceServices();

  const storedServers = useMcpStore((s) => s.servers);
  const storedStatusSnapshots = useMcpStore((s) => s.statusSnapshots);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const pluginStoreWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginStoreWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginStoreAuthorityKey = usePluginManagementStore((state) => state.authorityKey);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const currentProjectPath = useMcpStore((s) => s.currentProjectPath);
  const currentWorkspaceIdentity = useMcpStore((s) => s.currentWorkspaceIdentity);
  const currentAuthorityKey = useMcpStore((s) => s.currentAuthorityKey);
  const storeActiveWorkspacePath = useTabStore((s) => s.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((s) => s.activeWorkspaceIdentity ?? undefined);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity;
  const activeWorkspaceKey = `${cacheAuthorityKey?.trim() || "workspace"}\0${activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""}`;
  const currentMcpStoreWorkspaceKey = `${currentAuthorityKey?.trim() || "workspace"}\0${currentWorkspaceIdentity?.trim() || currentProjectPath}`;
  // 修复原因：active tab 会先于异步 MCP 目录加载切换；过渡帧不能把 A 的配置和
  // snapshot 投影到 B，更不能让后续 effect 把这些敏感配置发送给 B 的 Agent。
  const mcpStoreMatchesActiveWorkspace =
    Boolean(activeWorkspaceKey) && currentMcpStoreWorkspaceKey === activeWorkspaceKey;
  const servers = mcpStoreMatchesActiveWorkspace ? storedServers : [];
  const statusSnapshots = mcpStoreMatchesActiveWorkspace ? storedStatusSnapshots : {};
  const ensureLoadedForWorkspace = useMcpStore((s) => s.ensureLoadedForWorkspace);
  const loadMcpFromUserDirectory = useMcpStore((s) => s.loadMcpFromUserDirectory);
  const toggleServer = useMcpStore((s) => s.toggleServer);
  const addScopedMcpServer = useMcpStore((s) => s.addScopedMcpServer);
  const updateScopedMcpServer = useMcpStore((s) => s.updateScopedMcpServer);
  const deleteScopedMcpServer = useMcpStore((s) => s.deleteScopedMcpServer);
  const updateServerStatus = useMcpStore((s) => s.updateServerStatus);
  const connectMcpServer = useMcpStore((s) => s.connectMcpServer);
  const getEnabledMcpServersForZCode = useMcpStore((s) => s.getEnabledMcpServersForZCode);

  const [showForm, setShowForm] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState(parentScopeKey);
  const [editingServer, setEditingServer] = useState<ZCodeMcpServer | null>(null);
  const [presetDraft, setPresetDraft] = useState<ZCodeMcpServer | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  const [installingPresetIds, setInstallingPresetIds] = useState<Set<string>>(() => new Set());
  const [registryMcpResultCount, setRegistryMcpResultCount] = useState<number | null>(null);
  const installingPresetIdsRef = useRef(new Set<string>());
  const query = searchQuery;
  const [clineMarketplaceState, setClineMarketplaceState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [clineMarketplaceCatalog, setClineMarketplaceCatalog] =
    useState<ClineMcpMarketplaceCatalog | null>(null);
  const clineMarketplaceRequestIdRef = useRef(0);
  const loadClineMcpCatalog = useCallback(async () => {
    const requestId = ++clineMarketplaceRequestIdRef.current;
    setClineMarketplaceState("loading");
    setClineMarketplaceCatalog(null);
    try {
      const catalog = await services.mcpSyncService.loadMarketplaceCatalog();
      if (requestId !== clineMarketplaceRequestIdRef.current) return;
      setClineMarketplaceCatalog(catalog);
      setClineMarketplaceState("ready");
    } catch {
      if (requestId !== clineMarketplaceRequestIdRef.current) return;
      setClineMarketplaceCatalog(null);
      setClineMarketplaceState("error");
    }
  }, [services.mcpSyncService]);
  useEffect(() => {
    void loadClineMcpCatalog();
    return () => {
      clineMarketplaceRequestIdRef.current++;
    };
  }, [loadClineMcpCatalog]);
  const [editorMode, setEditorMode] = useState<McpEditorMode>("form");
  const [mcpConfigReadyWorkspaceKey, setMcpConfigReadyWorkspaceKey] = useState("");
  const [mcpOAuthAuthorizationFollowupRefresh, setMcpOAuthAuthorizationFollowupRefresh] =
    useState<McpOAuthAuthorizationFollowupRefresh | null>(null);
  const [mcpStatusOnlyUnsupported, setMcpStatusOnlyUnsupported] = useState(false);
  const mcpStatusOnlyUnsupportedRef = useRef(false);
  const isFormView = showForm || editingServer !== null;
  useEffect(() => {
    onEditorOpenChange?.(isFormView);
  }, [isFormView, onEditorOpenChange]);
  useEffect(
    () => () => {
      onEditorOpenChange?.(false);
    },
    [onEditorOpenChange],
  );
  const { refreshingStatusList, handleManualRefresh, requestMcpServerStatusList } =
    useMcpSettingsStatusRefresh({
      activeWorkspaceIdentity,
      activeWorkspaceKey,
      activeWorkspacePath: activeWorkspacePath ?? undefined,
      cacheAuthorityKey,
      currentMcpStoreWorkspaceKey,
      ensureLoadedForWorkspace,
      loadMcpFromUserDirectory,
      mcpConfigReadyWorkspaceKey,
      mcpOAuthAuthorizationFollowupRefresh,
      mcpStatusOnlyUnsupported,
      mcpStatusOnlyUnsupportedRef,
      mcpSyncService: services.mcpSyncService,
      pluginManagementService: services.pluginManagementService,
      plugins,
      scopeFilter,
      servers,
      setMcpConfigReadyWorkspaceKey,
      setMcpOAuthAuthorizationFollowupRefresh,
      setMcpStatusOnlyUnsupported,
      statusSnapshots,
    });

  const scopedServers = useMemo(
    () =>
      servers.filter(
        (server) =>
          server.scope === scopeFilter || (scopeFilter === "user" && server.scope === "common"),
      ),
    [scopeFilter, servers],
  );
  const filteredServers = useMemo(
    () => filterLocalMcpServers(scopedServers, query),
    [query, scopedServers],
  );
  const configuredMcpConfigs = useMemo(
    () => scopedServers.map((server) => server.config),
    [scopedServers],
  );
  const presetScopeProjectPath = parentScopeKey === "user" ? undefined : activeWorkspacePath;
  const addedPresetIds = useMemo(
    () =>
      new Set(
        servers
          .filter(
            (server) =>
              server.source === "zcodeagentmcp" && server.projectPath === presetScopeProjectPath,
          )
          .map((server) => server.name),
      ),
    [presetScopeProjectPath, servers],
  );
  const matchingCommunityMcpPresets = useMemo(
    () => filterCommunityMcpPresets(COMMUNITY_MCP_PRESETS, query),
    [query],
  );
  const filteredCommunityMcpPresets = useMemo(
    () => filterUninstalledMcpPresets(matchingCommunityMcpPresets, addedPresetIds),
    [addedPresetIds, matchingCommunityMcpPresets],
  );
  const filteredClineMarketplaceEntries = useMemo(
    () =>
      filterReviewedClinePresetDuplicates(
        filterClineMcpMarketplaceEntries(clineMarketplaceCatalog?.entries ?? [], query),
        matchingCommunityMcpPresets,
      ),
    [clineMarketplaceCatalog, matchingCommunityMcpPresets, query],
  );
  const connectedRemoteSyncTarget =
    shouldShowRemoteSyncActions({
      remoteSessionId,
      remoteTarget,
      clientMode: isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
      hasLocalSourceService: Boolean(baseServices.mcpSyncService),
    }) && activeWorkspacePath
      ? remoteTarget
      : null;
  const isRemoteSyncContext = Boolean(connectedRemoteSyncTarget);
  const pluginMcpServers = useMemo(() => {
    if (!shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext)) {
      // 插件 MCP 列表来自本机插件管理 store，不是当前远端目标。
      // 远端 MCP 设置页必须和 Skills 一样只展示远端工作区可读写的资源。
      return [];
    }
    // 插件 store 的 key 必须与 pluginManagementStoreLoading.buildWorkspaceKey 同格式
    // （authority\0identity|path），否则带 Source authority 的 activeWorkspaceKey 永远匹配不上。
    const pluginStoreWorkspaceKey = `${pluginStoreAuthorityKey?.trim() || "workspace"}\0${
      pluginStoreWorkspaceIdentity?.trim() || pluginStoreWorkspacePath || ""
    }`;
    const pluginStoreMatchesTarget =
      pluginStoreWorkspaceKey === activeWorkspaceKey && pluginConfigScope === scopeFilter;
    if (!pluginStoreMatchesTarget) {
      return [];
    }
    const scopedPlugins = selectPluginsForScope(plugins, installedPlugins, scopeFilter).filter(
      (plugin) => plugin.enabled,
    );
    return buildPluginMcpServerItems(scopedPlugins, query, statusSnapshots);
  }, [
    installedPlugins,
    activeWorkspaceKey,
    isRemoteSyncContext,
    pluginConfigScope,
    pluginStoreAuthorityKey,
    pluginStoreWorkspaceIdentity,
    pluginStoreWorkspacePath,
    plugins,
    query,
    scopeFilter,
    statusSnapshots,
  ]);
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const filteredMcpCount =
    filteredServers.length +
    pluginMcpServers.length +
    filteredCommunityMcpPresets.length +
    filteredClineMarketplaceEntries.length;
  const visibleMcpCount = filteredMcpCount + (registryMcpResultCount ?? 0);
  const pluginMcpGroups = useMemo(
    () => groupPluginMcpServersByPlugin(pluginMcpServers),
    [pluginMcpServers],
  );
  const mcpProjectionReady =
    !activeWorkspacePath ||
    (mcpStoreMatchesActiveWorkspace && mcpConfigReadyWorkspaceKey === activeWorkspaceKey);
  const hasEmptySearchResult =
    Boolean(query.trim()) && filteredMcpCount === 0 && registryMcpResultCount === 0;
  const installedServers = useMemo(
    () =>
      filteredServers
        .map((server, index) => ({ index, server }))
        .toSorted((left, right) => {
          // Bug 原因：Source authority 提交从旧基线重放时恢复了已废弃的「需要关注」分组，
          // 把诊断分组改版重新拆成两套列表。异常项只在 Installed 内稳定置顶，避免重复分组。
          const leftAttention = Boolean(
            left.server.authorization?.authorizationUrl ||
            left.server.status === "error" ||
            left.server.status === "requires_approval",
          );
          const rightAttention = Boolean(
            right.server.authorization?.authorizationUrl ||
            right.server.status === "error" ||
            right.server.status === "requires_approval",
          );
          return Number(rightAttention) - Number(leftAttention) || left.index - right.index;
        })
        .map(({ server }) => server),
    [filteredServers],
  );
  const hideInstalledGroup = Boolean(query.trim()) && installedServers.length === 0;
  useEffect(() => {
    onVisibleCountChange?.(visibleMcpCount);
  }, [visibleMcpCount, onVisibleCountChange]);
  const remoteMcpSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSkillSyncTarget(connectedRemoteSyncTarget, activeWorkspacePath ?? "")
    : "";

  const {
    handleToggle,
    handleSave,
    handleEdit,
    handleCreate,
    handleCreateFromPreset,
    handleConfigureRegistryEntry,
    handleInstallPreset,
    handleConnectProjectServer,
    handleOpenAuthorization,
    handleOpenPluginAuthorization,
  } = createMcpSettingsActions({
    activeWorkspaceIdentity,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    cacheAuthorityKey,
    confirmDialog,
    editingServer,
    formScopeKey,
    installingPresetIdsRef,
    intl,
    mcpSyncService: services.mcpSyncService,
    onFormScopeKeyChange,
    parentScopeKey,
    platform,
    requestMcpServerStatusList,
    setEditingServer,
    setEditorMode,
    setFormScopeKey,
    setInstallingPresetIds,
    setPresetDraft,
    setShowForm,
    store: {
      addScopedMcpServer,
      connectMcpServer,
      ensureLoadedForWorkspace,
      getEnabledMcpServersForZCode,
      listSavedServers: () => useMcpStore.getState().servers,
      toggleServer,
      updateScopedMcpServer,
      updateServerStatus,
    },
    workspaceTabs,
  });

  async function handleDelete(server: ZCodeMcpServer) {
    const confirmed = await confirmDialog({
      confirmVariant: "destructive",
      title: intl.formatMessage({ id: "settings.mcp.deleteConfirmTitle" }, { name: server.name }),
      description: intl.formatMessage({
        id: "settings.mcp.deleteConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({
        id: "settings.mcp.deleteConfirmAction",
      }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });

    if (!confirmed) {
      return;
    }

    await deleteScopedMcpServer(server.source, server.name, server.projectPath);
    setEditingServer(null);
    setShowForm(false);
    setEditorMode("form");
    onFormScopeKeyChange?.(null);
  }

  const closeFormView = () => {
    setShowForm(false);
    setEditingServer(null);
    setPresetDraft(null);
    setEditorMode("form");
    onFormScopeKeyChange?.(null);
  };

  if (isFormView) {
    return (
      <McpSettingsEditorView
        editingServer={editingServer}
        presetDraft={presetDraft}
        editorMode={editorMode}
        formScopeKey={formScopeKey}
        workspaceTabs={workspaceTabs}
        showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
        onOpenPluginStore={onOpenPluginStore}
        onClose={closeFormView}
        onEditorModeChange={setEditorMode}
        onScopeKeyChange={(nextScopeKey) => {
          setFormScopeKey(nextScopeKey);
          onFormScopeKeyChange?.(nextScopeKey);
        }}
        onSave={handleSave}
        onDelete={editingServer ? handleDelete : undefined}
      />
    );
  }

  return (
    <div className="space-y-4">
      {connectedRemoteSyncTarget ? (
        <div className="flex justify-end">
          <ControlHintTooltip title={intl.formatMessage({ id: "settings.mcp.remoteSync.open" })}>
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              aria-label={intl.formatMessage({
                id: "settings.mcp.remoteSync.open",
              })}
              onClick={() => setRemoteMcpSyncOpen(true)}
            >
              <UploadCloud className="size-3.5" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      ) : null}

      {connectedRemoteSyncTarget ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.mcp.remoteContext" },
            { target: remoteMcpSyncTargetLabel },
          )}
        </div>
      ) : null}

      {!mcpProjectionReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : null}
      {mcpProjectionReady ? (
        <McpRegistryMarketplace
          query={query}
          reviewedPresets={matchingCommunityMcpPresets}
          configuredServers={configuredMcpConfigs}
          onConfigure={handleConfigureRegistryEntry}
          onVisibleCountChange={setRegistryMcpResultCount}
        />
      ) : null}
      <div
        className={!mcpProjectionReady || hasEmptySearchResult ? "hidden" : "space-y-6"}
        data-mcp-list-layout="grouped"
      >
        <McpCommunityCatalog
          presets={filteredCommunityMcpPresets}
          discoveredEntries={filteredClineMarketplaceEntries}
          discoveryState={clineMarketplaceState}
          rejectedEntryCount={clineMarketplaceCatalog?.rejectedEntryCount ?? 0}
          onRefreshDiscovery={() => void loadClineMcpCatalog()}
          onSelect={handleCreateFromPreset}
          addedPresetIds={addedPresetIds}
          installingPresetIds={installingPresetIds}
          onInstall={(preset) => void handleInstallPreset(preset)}
          onOpenSource={(sourceUrl) => platform.openExternal(sourceUrl)}
        />
        <section
          className={hideInstalledGroup ? "hidden" : "space-y-4"}
          data-mcp-plugin-group="installed"
        >
          <div data-mcp-plugin-installed-actions="true">
            <SettingsResourceGroupHeader
              actions={
                <SettingsResourceHeaderActions
                  onRefresh={() => void handleManualRefresh()}
                  refreshing={refreshingStatusList}
                  onImport={() => setImportDialogOpen(true)}
                  onNew={handleCreate}
                  importActionId="settings.mcp.import.open"
                  newActionId="settings.mcp.create.open"
                />
              }
              count={installedServers.length}
              title={intl.formatMessage({
                id: "settings.plugin.mcp.installed",
              })}
            />
          </div>
          {installedServers.length > 0 ? (
            <McpServerList
              hideMetadata
              servers={installedServers}
              onCreate={handleCreate}
              onEdit={handleEdit}
              onToggle={handleToggle}
              onOpenAuthorization={handleOpenAuthorization}
              onConnectProjectServer={handleConnectProjectServer}
              emptyTitle={intl.formatMessage({ id: "settings.mcp.emptyTitle" })}
              emptyDescription={intl.formatMessage({
                id: "settings.mcp.emptyDescription",
              })}
            />
          ) : scopedServers.length === 0 && !query.trim() ? (
            <PluginInstallEmptyState
              title={intl.formatMessage({
                id: "settings.plugin.mcp.emptyInstalledTitle",
              })}
              description={intl.formatMessage({
                id: "settings.plugin.mcp.emptyInstalledDescription",
              })}
              actions={
                <>
                  <Button
                    type="button"
                    variant="default"
                    size="lg"
                    onClick={() => {
                      handleCreate();
                    }}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({
                      id: "settings.plugin.mcp.newServer",
                    })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={() => setImportDialogOpen(true)}
                  >
                    <Import data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.mcp.import.action" })}
                  </Button>
                </>
              }
            />
          ) : null}
        </section>
        {pluginMcpGroups.map((group) => (
          <section
            key={group.pluginId}
            className="space-y-4"
            data-mcp-plugin-group={group.pluginId}
          >
            <SettingsResourceGroupHeader
              count={group.items.length}
              title={resolvePluginDisplayName(
                {
                  name: group.pluginName,
                  listing: pluginListingById.get(group.pluginId),
                },
                locale,
              )}
            />
            <PluginMcpServerList
              items={group.items}
              pluginListingById={pluginListingById}
              onOpenAuthorization={handleOpenPluginAuthorization}
            />
          </section>
        ))}
      </div>
      <McpServersImportDialog
        // 对话框携带的是 mcpStore 的 currentProjectPath，只有它与当前 target
        // 一致时才和 services 的 host 同源；不一致的过渡帧不能让导入按 A 的 host 落盘 B 的路径。
        open={importDialogOpen && mcpStoreMatchesActiveWorkspace}
        workspacePath={currentProjectPath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={services.settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await loadMcpFromUserDirectory(
            services.mcpSyncService,
            activeWorkspaceIdentity,
            cacheAuthorityKey,
          );
        }}
      />
      <RemoteSyncDialogs
        canSyncSkills={false}
        canSyncMcp={Boolean(connectedRemoteSyncTarget && activeWorkspacePath)}
        skillOpen={false}
        mcpOpen={remoteMcpSyncOpen}
        onSkillOpenChange={() => {}}
        onMcpOpenChange={setRemoteMcpSyncOpen}
        localMcpSyncService={baseServices.mcpSyncService}
        remoteMcpSyncService={services.mcpSyncService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath=""
        mcpWorkspacePath={activeWorkspacePath ?? ""}
        mcpLocalWorkspacePath={localWorkspacePath}
        onSkillsSynced={() => {}}
        onMcpSynced={async () => {
          const loaded = await loadMcpFromUserDirectory(
            services.mcpSyncService,
            activeWorkspaceIdentity,
            cacheAuthorityKey,
          );
          if (loaded) {
            await requestMcpServerStatusList();
          }
        }}
      />
    </div>
  );
}
