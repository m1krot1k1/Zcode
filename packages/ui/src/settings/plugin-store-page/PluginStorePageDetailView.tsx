import type { ZCodePluginDiagnostic } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import { canUpdatePluginItem, type StorePluginItem } from "@/settings/pluginStoreListing.js";
import type { PluginDescribeEntry } from "@/store/pluginManagementStore.js";
import type { PluginStoreIntl, PluginStoreManagementState } from "./types.js";

/** 插件详情：概览 + 高级区（更新提示、warning 诊断、根路径与 hooks）。 */
export function PluginStorePageDetailView({
  intl,
  detailItem,
  actions,
  describeEntry,
  onRetryDescribe,
  onUsePrompt,
  detailPluginWarnings,
  activeOperations,
  onUpdatePlugin,
}: {
  intl: PluginStoreIntl;
  detailItem: StorePluginItem;
  actions: PluginStoreActions;
  describeEntry: PluginDescribeEntry | undefined;
  onRetryDescribe: () => void;
  onUsePrompt: (item: StorePluginItem, prompt: string) => void;
  detailPluginWarnings: ZCodePluginDiagnostic[];
  activeOperations: PluginStoreManagementState["activeOperations"];
  onUpdatePlugin: (pluginId: string) => void;
}) {
  const detailUpdatePending = canUpdatePluginItem(detailItem);

  return (
    <PluginStoreDetailView
      item={detailItem}
      actions={actions}
      describeEntry={describeEntry}
      onRetryDescribe={onRetryDescribe}
      onUsePrompt={onUsePrompt}
      advanced={
        detailItem.info ? (
          <div className="space-y-4">
            {detailUpdatePending ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2">
                <div className="min-w-0">
                  <p className="text-ui-base font-medium text-foreground">
                    {detailItem.installedMeta?.updateStatus === "update-available"
                      ? intl.formatMessage(
                          { id: "settings.plugins.detail.updateAvailable" },
                          { version: detailItem.installedMeta?.latestVersion ?? "" },
                        )
                      : intl.formatMessage({ id: "settings.plugins.detail.versionChanged" })}
                  </p>
                  <p className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({
                      id: "settings.plugins.detail.updateNewSessionsNote",
                    })}
                  </p>
                </div>
                <Button
                  type="button"
                  data-testid="plugin-store-detail-update"
                  variant="outline"
                  size="sm"
                  disabled={activeOperations.some(
                    (operation) => operation.id === `plugin:update:${detailItem.id}`,
                  )}
                  onClick={() => onUpdatePlugin(detailItem.id)}
                >
                  {intl.formatMessage({ id: "settings.plugins.detail.update" })}
                </Button>
              </div>
            ) : null}
            <PluginStoreAdvancedSection>
              {detailPluginWarnings.length > 0 ? (
                <div>
                  <div className="mb-2 text-ui-xs font-medium text-foreground">
                    {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                  </div>
                  <PluginWarningList warnings={detailPluginWarnings} />
                </div>
              ) : null}
              <PluginDetailRow
                label={intl.formatMessage({ id: "settings.plugins.detail.rootPath" })}
                value={detailItem.info.rootPath}
              />
              {(detailItem.info.hookDetails ?? []).length > 0 ? (
                <PluginHookDetails hooks={detailItem.info.hookDetails ?? []} />
              ) : null}
            </PluginStoreAdvancedSection>
          </div>
        ) : undefined
      }
    />
  );
}
