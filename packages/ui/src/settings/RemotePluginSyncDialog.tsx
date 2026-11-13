// 公共入口：实现拆分到 remote-plugin-sync-dialog/ 下的候选构建、同步执行与子组件，
// 此处仅保留原有导出面，供设置面板与测试继续按原路径引用。
export {
  buildMarketplaceRemotePluginStatuses,
  buildMarketplaceRemotePluginSyncCandidates,
  buildRemotePluginSyncRows,
  buildRemotePluginSyncRowsForCandidates,
  filterRemotePluginSyncRows,
  resolveDefaultRemotePluginSyncSelection,
  shouldAllowRemotePluginSyncDialogOpenChange,
} from "@/settings/remote-plugin-sync-dialog/candidateRows.js";
export { RemotePluginSyncDialog } from "@/settings/remote-plugin-sync-dialog/RemotePluginSyncDialog.js";
export { syncSelectedRemotePlugins } from "@/settings/remote-plugin-sync-dialog/syncSelectedRemotePlugins.js";
