import { useMemo } from "react";
import { buildStoreItems } from "@/settings/pluginStoreListing.js";
import type { PluginStoreCatalogState, PluginStoreManagementState } from "./types.js";

/**
 * 商店条目投影：市场 / 可安装 / 已安装 / 可恢复内置合并成同一份列表，
 * 详情与列表都从这份投影取数，避免各视图自行拼装。
 */
export function usePluginStoreCatalog({
  marketplaces,
  marketplaceAvailabilityKnown,
  availablePlugins,
  installedPlugins,
  plugins,
  restorableBuiltins,
}: Pick<
  PluginStoreManagementState,
  | "marketplaces"
  | "marketplaceAvailabilityKnown"
  | "availablePlugins"
  | "installedPlugins"
  | "plugins"
  | "restorableBuiltins"
>): PluginStoreCatalogState {
  const items = useMemo(
    () =>
      buildStoreItems({
        marketplaces,
        marketplaceAvailabilityKnown,
        availablePlugins,
        installedPlugins,
        plugins,
        restorableBuiltins,
      }),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  return { items, itemById };
}
