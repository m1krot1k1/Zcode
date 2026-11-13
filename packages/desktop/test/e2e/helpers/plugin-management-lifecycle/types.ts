export interface PluginLifecycleFixture {
  marketplaceRoot: string;
  pluginRoot: string;
  version: string;
}

export type PluginTestActionName =
  | "addPluginMarketplace"
  | "getPluginsOverview"
  | "installPlugin"
  | "listPlugins"
  | "getPluginReferenceCatalog"
  | "updatePluginMarketplace";

export interface SerializedActionResult<T> {
  ok: boolean;
  error?: string;
  value?: T;
}

export interface PluginControlAttributes {
  componentKind?: string;
  configKey?: string;
  groupKey?: string;
  marketplaceId?: string;
  pluginId?: string;
}
