import type { CreateTaskRequest } from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import type { MarketPluginUiController, PluginStoreIntl } from "./types.js";

/** 管理已安装视图：复用「插件管理」分区，商店内只保留返回与添加上下文。 */
export function PluginStorePageManageView({
  intl,
  embedded,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  managementScope,
  setManagementScope,
  pluginUi,
  backToStore,
  onAddMarketplace,
}: {
  intl: PluginStoreIntl;
  embedded: boolean;
  isDesktop: boolean;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  isWebRemoteControl: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  managementScope: string;
  setManagementScope: (scope: string) => void;
  pluginUi: MarketPluginUiController;
  backToStore: () => void;
  onAddMarketplace: () => void;
}) {
  return (
    <div data-testid="plugin-store-manage" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-ui-xl font-semibold">
          {intl.formatMessage({ id: "settings.plugins.store.manageInstalled" })}
        </h1>
        <Button variant="outline" data-testid="plugin-store-browse-all" onClick={backToStore}>
          {intl.formatMessage({ id: "settings.plugins.store.browseAll" })}
        </Button>
      </div>
      <PluginsSection
        mode="market"
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        isWebRemoteControl={isWebRemoteControl}
        initialScopeKey={managementScope}
        onScopeChange={setManagementScope}
        onCreateTask={onCreateTask}
        onOpenPluginStore={(_scope, intent) => {
          backToStore();
          if (intent === "add-marketplace") onAddMarketplace();
        }}
        onOpenUi={
          embedded
            ? (item, target, enable) => {
                if (
                  (target?.workspaceIdentity?.trim() || target?.workspacePath) !==
                  (workspaceIdentity?.trim() || workspacePath)
                ) {
                  toast(intl.formatMessage({ id: "settings.plugins.store.ui.needsSession" }));
                  return;
                }
                void pluginUi.open(item.id, enable);
              }
            : undefined
        }
      />
    </div>
  );
}
