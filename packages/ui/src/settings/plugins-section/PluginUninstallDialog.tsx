/**
 * 插件卸载确认弹窗。
 *
 * 详情视图与列表视图原来各自内联了同一份弹窗参数解析，统一到这里，
 * 保证两处使用同一份 pending 状态与名称回退逻辑。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import type { PluginListController } from "@/settings/plugins-section/usePluginListController.js";

export function PluginUninstallDialog({ controller }: { controller: PluginListController }) {
  const { locale } = useZCodeIntl();
  const { uninstall, storeItemById } = controller;
  return (
    <PluginUninstallConfirmDialog
      open={uninstall.pendingPlugin !== null}
      pluginName={
        uninstall.pendingPlugin
          ? resolvePluginDisplayName(
              storeItemById.get(uninstall.pendingPlugin.id) ?? {
                name: uninstall.pendingPlugin.name,
              },
              locale,
            )
          : ""
      }
      pending={uninstall.uninstalling}
      onCancel={uninstall.cancelUninstall}
      onConfirm={() => void uninstall.confirmUninstall()}
    />
  );
}
