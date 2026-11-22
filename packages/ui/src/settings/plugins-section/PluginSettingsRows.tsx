/**
 * Plugin 管理列表的行渲染：已安装/内置插件行与「Computer Use 不可用」占位行。
 *
 * 从原 PluginsSection 内联的 renderPluginRows / renderUnavailableComputerUse 提取，
 * 保持相同的 DOM 结构与 test id。
 */
import { Fragment } from "react";
import { Loader2, Monitor } from "lucide-react";
import type { ZCodePluginInfo, ZCodePluginScope } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import {
  PluginStoreItemMenu,
  PluginStoreOpenUiButton,
  PluginStoreUpdateBadge,
  PluginStoreUpdateButton,
} from "@/settings/PluginStoreCard.js";
import {
  resolveManagedPluginDisplay,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";

export function PluginSettingsRows({
  items,
  actions,
  configScope,
  togglingPluginId,
  storeItemById,
}: {
  items: ZCodePluginInfo[];
  actions: PluginStoreActions;
  configScope: ZCodePluginScope;
  togglingPluginId: string | null;
  storeItemById: Map<string, StorePluginItem>;
}) {
  const { intl, locale } = useZCodeIntl();
  return (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((plugin, index) => (
        <Fragment key={plugin.id}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <div
            className="group/plugin-row flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
            data-testid="plugin-settings-plugin-row"
            data-plugin-id={plugin.id}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              onClick={() => actions.onOpenDetail(plugin.id)}
            >
              <PluginStoreAvatar
                item={storeItemById.get(plugin.id) ?? { name: plugin.name }}
                className="size-9 bg-background"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                    {resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name}
                  </span>
                  <PluginStoreUpdateBadge item={storeItemById.get(plugin.id)} />
                </div>
                {resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale)
                  .description ? (
                  <div className="mt-0.5 line-clamp-1 text-ui-sm text-foreground-subtle">
                    {
                      resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale)
                        .description
                    }
                  </div>
                ) : null}
                <div className="mt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SettingsScopeBadge
                      scope={plugin.enabledSource ?? "default"}
                      label={
                        configScope === "user" && plugin.enabledSource === "user"
                          ? intl.formatMessage({
                              id: "settings.plugins.scope.userDefault",
                            })
                          : plugin.enabledSource === "user"
                            ? intl.formatMessage({
                                id: "settings.plugins.scope.inheritedUser",
                              })
                            : plugin.enabledSource === "workspace"
                              ? intl.formatMessage({
                                  id: "settings.plugins.scope.workspaceOverride",
                                })
                              : undefined
                      }
                    />
                  </div>
                </div>
              </div>
            </button>
            <PluginStoreUpdateButton item={storeItemById.get(plugin.id)} actions={actions} />
            {storeItemById.get(plugin.id) && plugin.packageStatus !== "missing" ? (
              <PluginStoreItemMenu item={storeItemById.get(plugin.id)!} actions={actions} />
            ) : null}
            {storeItemById.get(plugin.id) ? (
              <PluginStoreOpenUiButton item={storeItemById.get(plugin.id)!} actions={actions} />
            ) : null}
            <div className="flex shrink-0 items-center gap-2">
              {togglingPluginId === plugin.id ? (
                <Loader2
                  className="size-4 animate-spin text-foreground-subtle"
                  data-testid="plugin-settings-enabled-pending"
                  aria-label={intl.formatMessage(
                    { id: "settings.plugins.toggle.pending" },
                    {
                      plugin: resolveManagedPluginDisplay(
                        plugin,
                        storeItemById.get(plugin.id),
                        locale,
                      ).name,
                    },
                  )}
                />
              ) : null}
              <Switch
                data-testid="plugin-settings-enabled-switch"
                data-plugin-id={plugin.id}
                checked={plugin.enabled}
                disabled={togglingPluginId === plugin.id}
                aria-busy={togglingPluginId === plugin.id}
                aria-label={intl.formatMessage(
                  {
                    id: plugin.enabled
                      ? "settings.plugins.toggle.disable"
                      : "settings.plugins.toggle.enable",
                  },
                  {
                    plugin: resolveManagedPluginDisplay(
                      plugin,
                      storeItemById.get(plugin.id),
                      locale,
                    ).name,
                  },
                )}
                onCheckedChange={(enabled) => {
                  actions.onSetEnabled?.(plugin.id, enabled);
                }}
              />
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export function PluginUnavailableComputerUseRow({ descriptionId }: { descriptionId: string }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="overflow-hidden rounded-xl bg-surface">
      <div className="flex min-w-0 items-center gap-3 px-4 py-3 text-foreground-subtle">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle">
          <Monitor className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.title" })}
          </div>
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: descriptionId })}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-background px-2 py-1 text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.badge" })}
        </span>
      </div>
    </div>
  );
}
