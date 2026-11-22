/**
 * 已安装插件的详情视图。
 *
 * 设置页重构时曾计划复用简化弹窗，但那是另一套内容模型：复用权威商店详情页
 * 并只注入已安装态高级配置，才能保留介绍、Hero、示例提示词与能力清单。
 */
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { PluginConfigControls } from "@/settings/PluginConfigControls.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";
import { PluginUninstallDialog } from "@/settings/plugins-section/PluginUninstallDialog.js";
import type { PluginListController } from "@/settings/plugins-section/usePluginListController.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";

export function PluginSectionDetail({
  controller,
  inMarketplace,
  showMarketplaceBreadcrumb,
  onOpenPluginStore,
  onCreateTask,
}: {
  controller: PluginListController;
  inMarketplace: boolean;
  showMarketplaceBreadcrumb: boolean;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
}) {
  const {
    intl,
    locale,
    selectedPlugin,
    selectedStoreItem,
    actions,
    closeDetail,
    pluginWarningsForSelected,
    pluginOptionsDrafts,
    setPluginOptionsDrafts,
    getPluginOptionValue,
    setPluginOptionDraft,
    savePluginOptions,
    activeOperations,
    configScope,
  } = controller;
  if (!selectedPlugin || !selectedStoreItem) return null;
  const pluginBreadcrumbLabel = resolvePluginDisplayName(selectedStoreItem, locale);
  const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });

  return (
    <section className="space-y-5">
      <Button variant="ghost" data-testid="plugin-settings-detail-back" onClick={closeDetail}>
        {intl.formatMessage({ id: "common.back" })}
      </Button>
      {!inMarketplace ? (
        <SettingsBreadcrumbReporter
          items={
            showMarketplaceBreadcrumb
              ? [
                  { label: pluginsBreadcrumbLabel, onSelect: closeDetail },
                  { label: pluginBreadcrumbLabel },
                ]
              : [{ label: pluginBreadcrumbLabel }]
          }
          onSectionSelect={showMarketplaceBreadcrumb ? onOpenPluginStore : closeDetail}
        />
      ) : null}
      <PluginStoreDetailView
        item={selectedStoreItem}
        actions={actions}
        onRetryDescribe={() => {}}
        onUsePrompt={(item, prompt) => {
          if (!onCreateTask) return;
          onCreateTask({
            initialPrompt: buildPluginStoreTryPrompt({
              item,
              locale,
              prompt,
            }),
            initialPromptMention: buildPluginStoreTryMention({
              item,
              locale,
            }),
          });
        }}
        advanced={
          selectedPlugin.packageStatus === "missing" ? undefined : (
            <PluginStoreAdvancedSection>
              {pluginWarningsForSelected.length > 0 ? (
                <div>
                  <div className="mb-2 text-ui-xs font-medium text-foreground">
                    {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                  </div>
                  <PluginWarningList warnings={pluginWarningsForSelected} />
                </div>
              ) : null}
              <PluginDetailRow
                label={intl.formatMessage({
                  id: "settings.plugins.detail.rootPath",
                })}
                value={selectedPlugin.rootPath}
              />
              {(selectedPlugin.hookDetails ?? []).length > 0 ? (
                <PluginHookDetails hooks={selectedPlugin.hookDetails ?? []} />
              ) : null}
              <PluginConfigControls
                getValue={getPluginOptionValue}
                isOptionClearPending={(pluginId, key) =>
                  pluginOptionsDrafts[pluginId]?.[key] === null
                }
                onClearOption={(pluginId, key, clear) =>
                  setPluginOptionsDrafts((current) => {
                    const nextPluginDrafts = { ...current[pluginId] };
                    if (clear) nextPluginDrafts[key] = null;
                    else delete nextPluginDrafts[key];
                    return {
                      ...current,
                      [pluginId]: nextPluginDrafts,
                    };
                  })
                }
                onSave={(savedPlugin) => void savePluginOptions(savedPlugin)}
                onSetDraft={setPluginOptionDraft}
                activeOperations={activeOperations}
                plugin={selectedPlugin}
                scope={configScope}
              />
            </PluginStoreAdvancedSection>
          )
        }
      />
      <PluginUninstallDialog controller={controller} />
    </section>
  );
}
