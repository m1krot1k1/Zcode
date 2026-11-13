import { useState } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMarketPluginUi } from "@/plugin-ui/index.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import type { PluginStorePageProps, PluginStorePageServices } from "./types.js";

/**
 * 页面级服务装配：平台、Intl、排序、插件服务与市场 UI 控制器。
 * 保持原有的 useScopedPluginManagementStore + useMarketPluginUi 调用顺序，
 * 让 scoped store 与市场面板的作用域 key 与拆分前一致。
 */
export function usePluginStorePageServices({
  workspacePath,
  workspaceIdentity,
  sessionId,
  remoteSessionId,
}: PluginStorePageProps): PluginStorePageServices {
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const { order: storeOrder, refresh: refreshStoreOrder } = usePluginStoreOrder();
  const { pluginManagementService, skillsService } = useServices();
  const store = useScopedPluginManagementStore(pluginManagementService);
  const pluginUi = useMarketPluginUi({
    workspacePath,
    workspaceIdentity,
    sessionId,
    remoteSessionId,
  });
  const [managementScope, setManagementScope] = useState("user");

  return {
    platform,
    intl,
    locale,
    storeOrder,
    refreshStoreOrder,
    pluginManagementService,
    skillsService,
    store,
    pluginUi,
    managementScope,
    setManagementScope,
  };
}
