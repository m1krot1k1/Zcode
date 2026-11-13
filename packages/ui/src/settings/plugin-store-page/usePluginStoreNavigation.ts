import { useCallback, useEffect, type RefObject } from "react";
import type { PluginStoreOpenTarget } from "@/lib/pluginStoreNavigation.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import type {
  PluginStoreManagementState,
  PluginStoreNavigationController,
  PluginStoreView,
} from "./types.js";

/**
 * 列表 ⇄ 详情导航：进入详情前记录列表滚动位置，返回时恢复；
 * 首次进入时消费外部导航目标（stable plugin id），加载完成后落到详情或搜索。
 */
export function usePluginStoreNavigation({
  rootRef,
  storeScrollTopRef,
  initialNavigationTargetRef,
  workspacePath,
  normalizedWorkspaceIdentity,
  loading,
  loadedWorkspacePath,
  loadedWorkspaceIdentity,
  itemById,
  setView,
  setDetailPluginId,
  setQuery,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  storeScrollTopRef: RefObject<number>;
  initialNavigationTargetRef: RefObject<PluginStoreOpenTarget | null>;
  workspacePath?: string | null;
  normalizedWorkspaceIdentity: string | null;
  loading: PluginStoreManagementState["loading"];
  loadedWorkspacePath: PluginStoreManagementState["loadedWorkspacePath"];
  loadedWorkspaceIdentity: PluginStoreManagementState["loadedWorkspaceIdentity"];
  itemById: Map<string, StorePluginItem>;
  setView: (view: PluginStoreView) => void;
  setDetailPluginId: (pluginId: string | null) => void;
  setQuery: (query: string) => void;
}): PluginStoreNavigationController {
  const scrollContainer = (): HTMLElement | null => rootRef.current?.closest("main") ?? null;

  const openDetail = useCallback((pluginId: string) => {
    storeScrollTopRef.current =
      (rootRef.current?.closest("main") as HTMLElement | null)?.scrollTop ?? 0;
    setDetailPluginId(pluginId);
    setView("detail");
    requestAnimationFrame(() => {
      const main = rootRef.current?.closest("main");
      if (main) main.scrollTop = 0;
    });
  }, []);

  useEffect(() => {
    const target = initialNavigationTargetRef.current;
    if (
      !target?.pluginId ||
      loading ||
      loadedWorkspacePath !== workspacePath ||
      loadedWorkspaceIdentity !== normalizedWorkspaceIdentity
    ) {
      return;
    }
    initialNavigationTargetRef.current = null;
    if (itemById.has(target.pluginId)) {
      openDetail(target.pluginId);
      return;
    }
    // 刷新后候选仍不存在时保留 stable ID 搜索，让用户看到明确的空结果而不是错误详情。
    setView("store");
    setQuery(target.pluginId);
  }, [
    itemById,
    loadedWorkspaceIdentity,
    loadedWorkspacePath,
    loading,
    normalizedWorkspaceIdentity,
    openDetail,
    workspacePath,
  ]);

  const backToStore = useCallback(() => {
    setView("store");
    setDetailPluginId(null);
    requestAnimationFrame(() => {
      const main = scrollContainer();
      if (main) main.scrollTop = storeScrollTopRef.current;
    });
  }, []);

  return { openDetail, backToStore };
}
