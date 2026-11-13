/**
 * Plugin-provided MCP server rows rendered in MCP settings.
 */
import type { ZCodeAvailablePluginSummary } from "@zcode/shared";
import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_PLUGIN_MCP_SERVER_ROW,
  testId,
} from "@zcode/shared/test-ids";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "@/settings/McpFailurePresentation.js";
import { McpStatusDot } from "@/settings/McpServerList.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { SettingsResourceList } from "@/settings/SettingsResourceGroup.js";
import type { PluginMcpServerItem } from "@/settings/pluginManagedResourceGroups.js";

export function PluginMcpServerList({
  items,
  pluginListingById,
  onOpenAuthorization,
}: {
  items: PluginMcpServerItem[];
  pluginListingById: ReadonlyMap<string, ZCodeAvailablePluginSummary["listing"]>;
  onOpenAuthorization?: (item: PluginMcpServerItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const openAuthorizationLabel = intl.formatMessage({
    id: "settings.mcp.oauth.openAuthorization",
  });

  function resolveStatusDescription(item: PluginMcpServerItem): string {
    if (item.authorization?.authorizationUrl) {
      return intl.formatMessage({
        id: "settings.mcp.plugin.authorizationRequiredDescription",
      });
    }
    if (item.status === "error") {
      return intl.formatMessage({
        id: resolveMcpFailureMessageId(item.failureKind),
      });
    }
    if (item.active) {
      if (item.status === "connecting") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.connectingDescription",
        });
      }
      if (item.status === "connected") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.connectedDescription",
        });
      }
      if (item.status === "disconnected") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.disconnectedDescription",
        });
      }
      return item.hostProvided
        ? intl.formatMessage(
            { id: "settings.mcp.host.activeDescription" },
            { pluginName: item.pluginName },
          )
        : intl.formatMessage({ id: "settings.mcp.plugin.activeDescription" });
    }
    if (!item.pluginEnabled) {
      return intl.formatMessage({
        id: "settings.mcp.plugin.disabledDescription",
      });
    }
    return intl.formatMessage({
      id: "settings.mcp.plugin.unavailableDescription",
    });
  }

  return (
    <SettingsResourceList
      items={items}
      getKey={(item) => item.id}
      renderItem={(item) => {
        const statusDescription = resolveStatusDescription(item);
        return (
          <div
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
            data-mcp-status={item.status ?? ""}
            data-mcp-tool-count={item.toolCount}
            data-testid={testId(TID_PLUGIN_MCP_SERVER_ROW, item.runtimeServerName)}
          >
            <div className="relative size-9 shrink-0" data-mcp-status-dot-placement="icon-corner">
              <PluginStoreAvatar
                item={{
                  name: item.pluginName,
                  listing: pluginListingById.get(item.pluginId),
                }}
                className="size-9 bg-background"
              />
              <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background">
                <McpStatusDot
                  status={item.status}
                  attention={Boolean(item.authorization?.authorizationUrl)}
                  disabled={!item.pluginEnabled}
                  reason={statusDescription}
                />
              </span>
            </div>
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.status === "error" ? (
                <McpFailurePresentation error={item.error} failureKind={item.failureKind} />
              ) : (
                <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
                  {statusDescription}
                </div>
              )}
            </div>
            {item.authorization?.authorizationUrl ? (
              <div className="flex min-w-0 max-w-full shrink-0 items-center gap-2">
                <Button
                  variant="link"
                  size="sm"
                  className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
                  aria-label={openAuthorizationLabel}
                  data-testid={testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, item.runtimeServerName)}
                  title={openAuthorizationLabel}
                  onClick={() => onOpenAuthorization?.(item)}
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{openAuthorizationLabel}</span>
                </Button>
              </div>
            ) : null}
          </div>
        );
      }}
    />
  );
}
