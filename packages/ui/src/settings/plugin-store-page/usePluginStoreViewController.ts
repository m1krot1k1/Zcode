import { withPluginTelemetry } from "@zcode/services";
import { useEffect, useMemo, useRef, useState } from "react";
import { consumePluginStoreOpenTarget } from "@/lib/pluginStoreNavigation.js";
import type { PluginStoreTab } from "@/settings/PluginStoreListView.js";
import type {
  PluginManagementService,
  PluginStoreView,
  PluginStoreViewController,
} from "./types.js";

/**
 * 商店页本地视图状态：列表/详情/管理三种视图、搜索与刷新状态、对话框开关，
 * 以及按视图切换的 telemetry 包装服务。
 */
export function usePluginStoreViewController({
  embedded,
  isWebRemoteControl,
  pluginManagementService,
}: {
  embedded: boolean;
  isWebRemoteControl: boolean;
  pluginManagementService: PluginManagementService;
}): PluginStoreViewController {
  const [view, setView] = useState<PluginStoreView>("store");
  const operationService = useMemo(() => {
    const telemetry = {
      entry: embedded
        ? ("side_pane_market" as const)
        : view === "detail"
          ? ("store_detail" as const)
          : ("store_list" as const),
      client_kind: isWebRemoteControl ? ("mobile" as const) : ("desktop" as const),
    };
    return withPluginTelemetry(pluginManagementService, telemetry);
  }, [pluginManagementService, embedded, isWebRemoteControl, view]);

  const [detailPluginId, setDetailPluginId] = useState<string | null>(null);
  const [segment, setSegment] = useState<PluginStoreTab>("public");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [addMarketplaceError, setAddMarketplaceError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 返回列表页时恢复进入详情前的滚动位置（设置页 main 容器滚动）。
  const storeScrollTopRef = useRef(0);
  const [initialNavigationTarget] = useState(() =>
    embedded ? null : consumePluginStoreOpenTarget(),
  );
  const initialNavigationTargetRef = useRef(initialNavigationTarget);
  useEffect(() => {
    if (initialNavigationTarget?.intent === "add-marketplace") setAddSourceOpen(true);
  }, [initialNavigationTarget]);

  return {
    view,
    setView,
    operationService,
    detailPluginId,
    setDetailPluginId,
    segment,
    setSegment,
    query,
    setQuery,
    refreshing,
    setRefreshing,
    sourcesOpen,
    setSourcesOpen,
    addSourceOpen,
    setAddSourceOpen,
    addMarketplaceError,
    setAddMarketplaceError,
    rootRef,
    storeScrollTopRef,
    initialNavigationTargetRef,
  };
}
