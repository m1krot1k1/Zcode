import type { PluginManagementStore, PluginStoreManagementState } from "./types.js";

/**
 * 插件管理 store 的 selector 投影。全部订阅集中在同一 hook 中，
 * 保持拆分前「一次渲染内按固定顺序订阅同一 scoped store」的语义。
 */
export function usePluginStoreManagementState(
  store: PluginManagementStore,
): PluginStoreManagementState {
  const plugins = store((state) => state.plugins);
  const pluginDiagnostics = store((state) => state.diagnostics);
  const marketplaces = store((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = store((state) => state.marketplaceAvailabilityKnown);
  const availablePlugins = store((state) => state.availablePlugins);
  const installedPlugins = store((state) => state.installedPlugins);
  const restorableBuiltins = store((state) => state.restorableBuiltins);
  const loading = store((state) => state.loading);
  const loadedWorkspacePath = store((state) => state.workspacePath);
  const loadedWorkspaceIdentity = store((state) => state.workspaceIdentity);
  const error = store((state) => state.error);
  const activeOperations = store((state) => state.activeOperations);
  const cancelRequestOperationIds = store((state) => state.cancelRequestOperationIds);
  const cancellingOperationIds = store((state) => state.cancellingOperationIds);
  const describeCache = store((state) => state.describeCache);
  const initialize = store((state) => state.initialize);
  const updateMarketplace = store((state) => state.updateMarketplace);
  const addMarketplace = store((state) => state.addMarketplace);
  const removeMarketplace = store((state) => state.removeMarketplace);
  const installPlugin = store((state) => state.installPlugin);
  const describePlugin = store((state) => state.describePlugin);
  const updatePlugin = store((state) => state.updatePlugin);
  const restoreBuiltin = store((state) => state.restoreBuiltin);
  const setEnabled = store((state) => state.setEnabled);
  const togglingPluginId = store((state) => state.togglingPluginId);

  return {
    plugins,
    pluginDiagnostics,
    marketplaces,
    marketplaceAvailabilityKnown,
    availablePlugins,
    installedPlugins,
    restorableBuiltins,
    loading,
    loadedWorkspacePath,
    loadedWorkspaceIdentity,
    error,
    activeOperations,
    cancelRequestOperationIds,
    cancellingOperationIds,
    describeCache,
    initialize,
    updateMarketplace,
    addMarketplace,
    removeMarketplace,
    installPlugin,
    describePlugin,
    updatePlugin,
    restoreBuiltin,
    setEnabled,
    togglingPluginId,
  };
}
