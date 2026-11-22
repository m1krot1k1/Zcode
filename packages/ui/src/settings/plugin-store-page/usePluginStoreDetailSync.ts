import { useEffect } from "react";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import type {
  PluginManagementService,
  PluginStoreDetailSyncState,
  PluginStoreManagementState,
  PluginStoreView,
} from "./types.js";

/**
 * 详情页数据补齐与失效处理：未安装候选按需 describe；
 * 条目消失（例如可恢复内置被移除）时回列表，避免停留在空详情。
 */
export function usePluginStoreDetailSync({
  view,
  detailPluginId,
  detailItem,
  itemById,
  pluginDiagnostics,
  describePlugin,
  pluginManagementService,
  setView,
  setDetailPluginId,
}: {
  view: PluginStoreView;
  detailPluginId: string | null;
  detailItem: StorePluginItem | null;
  itemById: Map<string, StorePluginItem>;
  pluginDiagnostics: PluginStoreManagementState["pluginDiagnostics"];
  describePlugin: PluginStoreManagementState["describePlugin"];
  pluginManagementService: PluginManagementService;
  setView: (view: PluginStoreView) => void;
  setDetailPluginId: (pluginId: string | null) => void;
}): PluginStoreDetailSyncState {
  // 插件自身 warning 诊断（如声明的技能路径扫描为空）：详情高级区展示，避免静默失败。
  const detailPluginInfo = detailItem?.info;
  const detailPluginWarnings = detailPluginInfo
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === detailPluginInfo.id && diagnostic.severity === "warning",
      )
    : [];

  // 详情页数据补齐：无运行时信息的条目（未安装候选）按需 describe，拿组件清单 + manifest 回退字段。
  useEffect(() => {
    if (view !== "detail" || !detailItem || detailItem.info) return;
    void describePlugin(
      detailItem.id,
      detailItem.name,
      detailItem.marketplace,
      pluginManagementService,
    );
  }, [describePlugin, detailItem, pluginManagementService, view]);

  // 详情条目消失（卸载可恢复内置后 restorable 记录被移除等）时回到列表，避免空详情。
  useEffect(() => {
    if (view === "detail" && detailPluginId && !itemById.has(detailPluginId)) {
      setView("store");
      setDetailPluginId(null);
    }
  }, [detailPluginId, itemById, view]);

  return { detailPluginWarnings };
}
