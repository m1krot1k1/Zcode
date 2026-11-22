import { Button } from "@/components/ui/button.js";
import { PluginStoreListView } from "@/settings/PluginStoreListView.js";
import { resolveItemDisplayName } from "@/settings/pluginStoreListing.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { PluginStorePageDetailView } from "@/settings/plugin-store-page/PluginStorePageDetailView.js";
import { PluginStorePageDialogs } from "@/settings/plugin-store-page/PluginStorePageDialogs.js";
import { PluginStorePageHeader } from "@/settings/plugin-store-page/PluginStorePageHeader.js";
import { PluginStorePageManageView } from "@/settings/plugin-store-page/PluginStorePageManageView.js";
import { usePluginStoreActions } from "@/settings/plugin-store-page/usePluginStoreActions.js";
import { usePluginStoreCatalog } from "@/settings/plugin-store-page/usePluginStoreCatalog.js";
import { usePluginStoreDetailSync } from "@/settings/plugin-store-page/usePluginStoreDetailSync.js";
import { usePluginStoreManagementState } from "@/settings/plugin-store-page/usePluginStoreManagementState.js";
import { usePluginStoreMarketingNavigation } from "@/settings/plugin-store-page/usePluginStoreMarketingNavigation.js";
import { usePluginStoreNavigation } from "@/settings/plugin-store-page/usePluginStoreNavigation.js";
import { usePluginStorePageServices } from "@/settings/plugin-store-page/usePluginStorePageServices.js";
import {
  reportPluginStoreSearchTelemetry,
  usePluginStoreViewTelemetry,
} from "@/settings/plugin-store-page/usePluginStoreTelemetry.js";
import { usePluginStoreViewController } from "@/settings/plugin-store-page/usePluginStoreViewController.js";
import { usePluginStoreWorkspaceSync } from "@/settings/plugin-store-page/usePluginStoreWorkspaceSync.js";
import type { PluginStorePageProps } from "@/settings/plugin-store-page/types.js";

/**
 * 插件商店容器：只负责装配数据/视图 hook 与四个子区域（列表、详情、管理、浮层）。
 * 具体交互分别下沉到 plugin-store-page/ 下的 hooks 与子组件，公共 API 保持为具名导出。
 */
export function PluginStorePage(props: PluginStorePageProps) {
  const {
    isDesktop = false,
    isMacDesktop = false,
    isWindowsDesktop = false,
    isWebRemoteControl = false,
    workspacePath,
    workspaceIdentity,
    onCreateTask,
    embedded = false,
    onBack,
  } = props;

  const services = usePluginStorePageServices(props);
  const management = usePluginStoreManagementState(services.store);
  const controller = usePluginStoreViewController({
    embedded,
    isWebRemoteControl,
    pluginManagementService: services.pluginManagementService,
  });
  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;

  usePluginStoreWorkspaceSync({
    workspacePath,
    workspaceIdentity,
    pluginManagementService: services.pluginManagementService,
    initialize: management.initialize,
    marketplaces: management.marketplaces,
    isWebRemoteControl,
    updateMarketplace: management.updateMarketplace,
  });

  const { items, itemById } = usePluginStoreCatalog(management);
  const detailItem = controller.detailPluginId
    ? (itemById.get(controller.detailPluginId) ?? null)
    : null;

  usePluginStoreViewTelemetry({
    platform: services.platform,
    rootRef: controller.rootRef,
    view: controller.view,
    detailPluginId: controller.detailPluginId,
    embedded,
    isWebRemoteControl,
  });
  usePluginStoreMarketingNavigation({
    embedded,
    workspacePath,
    workspaceIdentity,
    normalizedWorkspaceIdentity,
    loading: management.loading,
    loadedWorkspacePath: management.loadedWorkspacePath,
    loadedWorkspaceIdentity: management.loadedWorkspaceIdentity,
    error: management.error,
    itemById,
    view: controller.view,
    detailPluginId: controller.detailPluginId,
    setView: controller.setView,
    setDetailPluginId: controller.setDetailPluginId,
    setQuery: controller.setQuery,
  });
  const { detailPluginWarnings } = usePluginStoreDetailSync({
    view: controller.view,
    detailPluginId: controller.detailPluginId,
    detailItem,
    itemById,
    pluginDiagnostics: management.pluginDiagnostics,
    describePlugin: management.describePlugin,
    pluginManagementService: services.pluginManagementService,
    setView: controller.setView,
    setDetailPluginId: controller.setDetailPluginId,
  });
  const { openDetail, backToStore } = usePluginStoreNavigation({
    rootRef: controller.rootRef,
    storeScrollTopRef: controller.storeScrollTopRef,
    initialNavigationTargetRef: controller.initialNavigationTargetRef,
    workspacePath,
    normalizedWorkspaceIdentity,
    loading: management.loading,
    loadedWorkspacePath: management.loadedWorkspacePath,
    loadedWorkspaceIdentity: management.loadedWorkspaceIdentity,
    itemById,
    setView: controller.setView,
    setDetailPluginId: controller.setDetailPluginId,
    setQuery: controller.setQuery,
  });
  const {
    actions,
    handleRefresh,
    handleUsePrompt,
    handleAddMarketplace,
    handleUpdatePlugin,
    uninstall,
  } = usePluginStoreActions({
    store: services.store,
    operationService: controller.operationService,
    intl: services.intl,
    locale: services.locale,
    embedded,
    workspacePath,
    normalizedWorkspaceIdentity,
    skillsService: services.skillsService,
    onCreateTask,
    installedPlugins: management.installedPlugins,
    plugins: management.plugins,
    activeOperations: management.activeOperations,
    cancelRequestOperationIds: management.cancelRequestOperationIds,
    cancellingOperationIds: management.cancellingOperationIds,
    togglingPluginId: management.togglingPluginId,
    addMarketplace: management.addMarketplace,
    installPlugin: management.installPlugin,
    restoreBuiltin: management.restoreBuiltin,
    setEnabled: management.setEnabled,
    updateMarketplace: management.updateMarketplace,
    updatePlugin: management.updatePlugin,
    refreshStoreOrder: services.refreshStoreOrder,
    setRefreshing: controller.setRefreshing,
    setAddMarketplaceError: controller.setAddMarketplaceError,
    setSegment: controller.setSegment,
    pluginUi: services.pluginUi,
    openDetail,
  });

  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {services.intl.formatMessage({ id: "settings.plugins.noWorkspace" })}
      </div>
    );
  }

  return (
    <div
      ref={controller.rootRef}
      className="@container/plugin-store space-y-5"
      data-testid="plugin-store-root"
      data-view={controller.view}
    >
      {!embedded ? (
        <SettingsBreadcrumbReporter
          items={
            controller.view === "detail" && detailItem
              ? [{ label: resolveItemDisplayName(detailItem, services.locale) }]
              : []
          }
          onSectionSelect={backToStore}
        />
      ) : null}
      {controller.view === "detail" ? (
        <Button variant="ghost" data-testid="plugin-store-detail-back" onClick={backToStore}>
          {services.intl.formatMessage({ id: "settings.plugins.store.browseAll" })}
        </Button>
      ) : null}
      {controller.view === "store" ? (
        <PluginStorePageHeader
          intl={services.intl}
          refreshing={controller.refreshing}
          onRefresh={() => void handleRefresh()}
          onOpenSources={() => controller.setSourcesOpen(true)}
          onAddMarketplace={() => {
            controller.setAddMarketplaceError(null);
            controller.setAddSourceOpen(true);
          }}
          onManage={() => controller.setView("manage")}
          onBack={onBack}
          isWebRemoteControl={isWebRemoteControl}
          onCreateTask={onCreateTask}
        />
      ) : null}

      {management.error && !controller.addSourceOpen ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
          data-testid="plugin-store-error"
        >
          {management.error}
        </div>
      ) : null}

      {controller.view === "manage" ? (
        <PluginStorePageManageView
          intl={services.intl}
          embedded={embedded}
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          isWebRemoteControl={isWebRemoteControl}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          onCreateTask={onCreateTask}
          managementScope={services.managementScope}
          setManagementScope={services.setManagementScope}
          pluginUi={services.pluginUi}
          backToStore={backToStore}
          onAddMarketplace={() => controller.setAddSourceOpen(true)}
        />
      ) : controller.view === "detail" && detailItem ? (
        <PluginStorePageDetailView
          intl={services.intl}
          detailItem={detailItem}
          actions={actions}
          describeEntry={management.describeCache[detailItem.id]}
          onRetryDescribe={() => {
            void management.describePlugin(
              detailItem.id,
              detailItem.name,
              detailItem.marketplace,
              controller.operationService,
              true,
            );
          }}
          onUsePrompt={handleUsePrompt}
          detailPluginWarnings={detailPluginWarnings}
          activeOperations={management.activeOperations}
          onUpdatePlugin={(pluginId) => void handleUpdatePlugin(pluginId)}
        />
      ) : null}
      <div hidden={controller.view !== "store"}>
        <PluginStoreListView
          order={services.storeOrder}
          items={items}
          marketplaces={management.marketplaces}
          actions={actions}
          loading={
            management.loading ||
            management.activeOperations.some((operation) =>
              operation.id.startsWith("marketplace:update:"),
            )
          }
          query={controller.query}
          onQueryChange={controller.setQuery}
          onSearchSubmit={() => {
            if (!controller.query.trim()) return;
            reportPluginStoreSearchTelemetry(services.platform, { embedded, isWebRemoteControl });
          }}
          segment={controller.segment}
          onSegmentChange={controller.setSegment}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
        />
      </div>

      <PluginStorePageDialogs
        intl={services.intl}
        locale={services.locale}
        pluginUi={services.pluginUi}
        uninstall={uninstall}
        itemById={itemById}
        sourcesOpen={controller.sourcesOpen}
        setSourcesOpen={controller.setSourcesOpen}
        marketplaces={management.marketplaces}
        updateMarketplace={management.updateMarketplace}
        removeMarketplace={management.removeMarketplace}
        operationService={controller.operationService}
        activeOperations={management.activeOperations}
        addSourceOpen={controller.addSourceOpen}
        setAddSourceOpen={controller.setAddSourceOpen}
        handleAddMarketplace={handleAddMarketplace}
        addMarketplaceError={controller.addMarketplaceError}
      />
    </div>
  );
}
