import { useEffect } from "react";
import { useStore } from "zustand";
import { finishMarketingNavigation, marketingNavigation } from "@/lib/marketingNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import type { PluginStoreManagementState, PluginStoreView } from "./types.js";

/**
 * 营销页面跳转的收尾：只有目标标签页可见且商店数据已加载到当前工作区时才路由，
 * 无法完成时把 marketing 请求标记为失败，避免导航悬挂。
 */
export function usePluginStoreMarketingNavigation({
  embedded,
  workspacePath,
  workspaceIdentity,
  normalizedWorkspaceIdentity,
  loading,
  loadedWorkspacePath,
  loadedWorkspaceIdentity,
  error,
  itemById,
  view,
  detailPluginId,
  setView,
  setDetailPluginId,
  setQuery,
}: {
  embedded: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  normalizedWorkspaceIdentity: string | null;
  loading: PluginStoreManagementState["loading"];
  loadedWorkspacePath: PluginStoreManagementState["loadedWorkspacePath"];
  loadedWorkspaceIdentity: PluginStoreManagementState["loadedWorkspaceIdentity"];
  error: PluginStoreManagementState["error"];
  itemById: Map<string, StorePluginItem>;
  view: PluginStoreView;
  detailPluginId: string | null;
  setView: (view: PluginStoreView) => void;
  setDetailPluginId: (pluginId: string | null) => void;
  setQuery: (query: string) => void;
}): void {
  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  const isMarketingDestinationVisible = useOptionalTabStore((state) => {
    const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
    return Boolean(
      tab &&
      isWorkspaceTab(tab) &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
        (workspaceIdentity?.trim() || workspacePath),
    );
  });

  useEffect(() => {
    if (embedded || marketingRequest?.target.page !== "plugin_marketplace") return;
    if (!isMarketingDestinationVisible) return;
    const pluginId = marketingRequest.target.plugin_id;
    if (!workspacePath) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_navigation_unavailable"));
      return;
    }
    if (
      loading ||
      loadedWorkspacePath !== workspacePath ||
      loadedWorkspaceIdentity !== normalizedWorkspaceIdentity
    )
      return;
    if (error || (pluginId && !itemById.has(pluginId))) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_plugin_unavailable"));
    } else if (pluginId ? view === "detail" && detailPluginId === pluginId : view === "store") {
      finishMarketingNavigation(marketingRequest.id);
    } else {
      setDetailPluginId(pluginId ?? null);
      setView(pluginId ? "detail" : "store");
      setQuery("");
    }
  }, [
    embedded,
    marketingRequest,
    isMarketingDestinationVisible,
    workspacePath,
    loading,
    loadedWorkspacePath,
    loadedWorkspaceIdentity,
    normalizedWorkspaceIdentity,
    error,
    itemById,
    view,
    detailPluginId,
  ]);
}
