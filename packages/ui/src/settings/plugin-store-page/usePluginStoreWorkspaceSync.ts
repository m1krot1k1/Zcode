import { withPluginTelemetry } from "@zcode/services";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { useEffect } from "react";
import { claimMarketplaceAutoRefresh } from "@/settings/officialMarketplaceAutoRefresh.js";
import type { PluginManagementService, PluginStoreManagementState } from "./types.js";

/**
 * 工作区加载与官方目录自动刷新。两者都以插件管理 store 为唯一数据源，
 * 这里只触发加载/刷新，不缓存第二份安装状态。
 */
export function usePluginStoreWorkspaceSync({
  workspacePath,
  workspaceIdentity,
  pluginManagementService,
  initialize,
  marketplaces,
  isWebRemoteControl,
  updateMarketplace,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  pluginManagementService: PluginManagementService;
  initialize: PluginStoreManagementState["initialize"];
  marketplaces: PluginStoreManagementState["marketplaces"];
  isWebRemoteControl: boolean;
  updateMarketplace: PluginStoreManagementState["updateMarketplace"];
}): void {
  useEffect(() => {
    if (!workspacePath) {
      return;
    }
    // 安装仍属于 Host User inventory；卡片启停展示当前项目的实际生效配置。
    void initialize({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, workspaceIdentity, workspacePath]);

  // 目录自动刷新（Catalog Auto-Refresh）：只针对 ZCode 官方市场。每次进入商店页都刷新 CDN 目录，
  // 否则新上架插件要等用户手动点刷新才可见；以 10 分钟窗口节流，并在发起时占位防抖（失败/在飞不重复），
  // 判据见 officialMarketplaceAutoRefresh。状态放模块级而非组件 ref，因为每次进入都是重新挂载。
  useEffect(() => {
    const official = marketplaces.find((item) => item.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID);
    if (
      official &&
      claimMarketplaceAutoRefresh(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, official.lastUpdated)
    ) {
      void updateMarketplace(
        ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
        withPluginTelemetry(pluginManagementService, {
          trigger: "automatic",
          client_kind: isWebRemoteControl ? "mobile" : "desktop",
        }),
      );
    }
  }, [marketplaces, isWebRemoteControl, pluginManagementService, updateMarketplace]);
}
