import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { resolvePluginUiSurfaceTitle } from "@/plugin-ui/index.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import { PluginStoreSourcesDialog } from "@/settings/PluginStoreSourcesDialog.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import type {
  MarketPluginUiController,
  PluginManagementService,
  PluginStoreIntl,
  PluginStoreManagementState,
  PluginUninstallController,
} from "./types.js";

/** 商店页四个浮层：多个 UI 面板选择、卸载确认、市场源管理、添加市场源。 */
export function PluginStorePageDialogs({
  intl,
  locale,
  pluginUi,
  uninstall,
  itemById,
  sourcesOpen,
  setSourcesOpen,
  marketplaces,
  updateMarketplace,
  removeMarketplace,
  operationService,
  activeOperations,
  addSourceOpen,
  setAddSourceOpen,
  handleAddMarketplace,
  addMarketplaceError,
}: {
  intl: PluginStoreIntl;
  locale: string;
  pluginUi: MarketPluginUiController;
  uninstall: PluginUninstallController;
  itemById: Map<string, StorePluginItem>;
  sourcesOpen: boolean;
  setSourcesOpen: (open: boolean) => void;
  marketplaces: PluginStoreManagementState["marketplaces"];
  updateMarketplace: PluginStoreManagementState["updateMarketplace"];
  removeMarketplace: PluginStoreManagementState["removeMarketplace"];
  operationService: PluginManagementService;
  activeOperations: PluginStoreManagementState["activeOperations"];
  addSourceOpen: boolean;
  setAddSourceOpen: (open: boolean) => void;
  handleAddMarketplace: (source: string) => Promise<boolean>;
  addMarketplaceError: string | null;
}) {
  return (
    <>
      <Dialog
        open={pluginUi.surfaces.length > 1}
        onOpenChange={(open) => {
          if (!open) pluginUi.closeSelection();
        }}
      >
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.plugins.store.ui.chooseSurface" })}
          </DialogTitle>
          {pluginUi.surfaces.map((surface) => (
            <Button
              key={surface.id}
              variant="outline"
              onClick={() => pluginUi.selectSurface(surface)}
            >
              {resolvePluginUiSurfaceTitle(surface.title, locale)}
            </Button>
          ))}
        </DialogContent>
      </Dialog>

      <PluginUninstallConfirmDialog
        open={uninstall.pendingPlugin !== null}
        pluginName={
          uninstall.pendingPlugin
            ? resolvePluginDisplayName(
                itemById.get(uninstall.pendingPlugin.id) ?? {
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
      <PluginStoreSourcesDialog
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        marketplaces={marketplaces}
        onUpdateMarketplace={(marketplace) => void updateMarketplace(marketplace, operationService)}
        onRemoveMarketplace={(marketplace) => void removeMarketplace(marketplace, operationService)}
        activeOperations={activeOperations}
      />
      <AddMarketplaceSourceDialog
        open={addSourceOpen}
        onOpenChange={setAddSourceOpen}
        onAddMarketplace={handleAddMarketplace}
        activeOperations={activeOperations}
        error={addMarketplaceError}
      />
    </>
  );
}
