/**
 * Curated + discovered MCP catalog cards rendered inside MCP settings.
 */
import type { ClineMcpMarketplaceEntry, CommunityMcpPreset } from "@zcode/shared";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function McpCommunityCatalog({
  presets,
  discoveredEntries,
  discoveryState,
  rejectedEntryCount,
  onRefreshDiscovery,
  onSelect,
  addedPresetIds,
  installingPresetIds,
  onInstall,
  onOpenSource,
}: {
  presets: readonly CommunityMcpPreset[];
  discoveredEntries: readonly ClineMcpMarketplaceEntry[];
  discoveryState: "loading" | "ready" | "error";
  rejectedEntryCount: number;
  onRefreshDiscovery: () => void;
  onSelect: (preset: CommunityMcpPreset) => void;
  addedPresetIds: ReadonlySet<string>;
  installingPresetIds: ReadonlySet<string>;
  onInstall: (preset: CommunityMcpPreset) => void;
  onOpenSource: (sourceUrl: string) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <section className="space-y-2" aria-labelledby="community-mcp-presets-title">
      <div className="space-y-1">
        <h3 id="community-mcp-presets-title" className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.mcp.communityPresets.title" })}
        </h3>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.communityPresets.description" })}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {presets.map((preset) => (
          <article
            key={preset.id}
            className="flex min-w-0 flex-col justify-between gap-2 rounded-lg border border-border bg-card p-3"
            data-mcp-catalog-entry={preset.id}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <h4 className="truncate text-ui-base font-medium text-foreground">{preset.name}</h4>
                <p className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({
                    id:
                      preset.authRequirement === "none"
                        ? "settings.mcp.communityPresets.authNone"
                        : preset.authRequirement === "api-key-optional"
                          ? "settings.mcp.communityPresets.authOptionalApiKey"
                          : `settings.mcp.communityPresets.auth.${preset.authRequirement}`,
                  })}
                </p>
                {preset.usageLabel ? (
                  <p className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({
                      id: `settings.mcp.communityPresets.usage.${preset.usageLabel}`,
                    })}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={addedPresetIds.has(preset.id) || installingPresetIds.has(preset.id)}
                  aria-label={intl.formatMessage(
                    {
                      id: addedPresetIds.has(preset.id)
                        ? "settings.mcp.communityPresets.addedNamed"
                        : installingPresetIds.has(preset.id)
                          ? "settings.mcp.communityPresets.addingNamed"
                          : "settings.mcp.communityPresets.addNamed",
                    },
                    { name: preset.name },
                  )}
                  onClick={() => onInstall(preset)}
                >
                  {intl.formatMessage({
                    id: addedPresetIds.has(preset.id)
                      ? "settings.mcp.communityPresets.added"
                      : installingPresetIds.has(preset.id)
                        ? "settings.mcp.communityPresets.adding"
                        : "settings.mcp.communityPresets.add",
                  })}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => onSelect(preset)}>
                  {intl.formatMessage({ id: "settings.mcp.communityPresets.configure" })}
                </Button>
              </div>
            </div>
            <button
              className="inline-flex w-fit items-center gap-1 text-ui-sm text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline"
              type="button"
              onClick={() => onOpenSource(preset.sourceUrl)}
              aria-label={intl.formatMessage(
                { id: "settings.mcp.communityPresets.source" },
                { name: preset.name },
              )}
            >
              {intl.formatMessage({ id: "settings.mcp.communityPresets.sourceLabel" })}
              <ExternalLink className="size-3" aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
      <section
        className="space-y-2 border-t border-border pt-4"
        aria-labelledby="cline-mcp-discovery-title"
        data-mcp-marketplace-discovery="cline"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h4 id="cline-mcp-discovery-title" className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.mcp.marketplace.discovery.title" })}
            </h4>
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.mcp.marketplace.discovery.unverified" })}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={discoveryState === "loading"}
            onClick={onRefreshDiscovery}
          >
            {intl.formatMessage({
              id:
                discoveryState === "loading"
                  ? "settings.mcp.marketplace.discovery.loadingAction"
                  : "settings.mcp.marketplace.discovery.refresh",
            })}
          </Button>
        </div>
        {discoveryState === "loading" ? (
          <p className="text-ui-sm text-foreground-subtle" role="status">
            {intl.formatMessage({ id: "settings.mcp.marketplace.discovery.loading" })}
          </p>
        ) : null}
        {discoveryState === "error" ? (
          <p className="text-ui-sm text-foreground-subtle" role="alert">
            {intl.formatMessage({ id: "settings.mcp.marketplace.discovery.error" })}
          </p>
        ) : null}
        {discoveryState === "ready" ? (
          <>
            {rejectedEntryCount > 0 ? (
              <p className="text-ui-sm text-foreground-subtle" role="status">
                {intl.formatMessage(
                  { id: "settings.mcp.marketplace.discovery.filtered" },
                  { count: rejectedEntryCount },
                )}
              </p>
            ) : null}
            {discoveredEntries.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.mcp.marketplace.discovery.empty" })}
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {discoveredEntries.map((entry) => (
                  <article
                    key={entry.id}
                    className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3"
                    data-mcp-marketplace-entry={entry.id}
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h5 className="truncate text-ui-base font-medium text-foreground">
                          {entry.name}
                        </h5>
                        <span className="rounded border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                          {intl.formatMessage({
                            id: "settings.mcp.marketplace.discovery.externalBadge",
                          })}
                        </span>
                      </div>
                      {entry.author ? (
                        <p className="text-ui-sm text-foreground-subtle">
                          {intl.formatMessage(
                            { id: "settings.mcp.marketplace.discovery.author" },
                            { author: entry.author },
                          )}
                        </p>
                      ) : null}
                      {entry.tagline || entry.description ? (
                        <p className="text-ui-sm text-foreground-subtle">
                          {entry.tagline ?? entry.description}
                        </p>
                      ) : null}
                      {entry.tags.length > 0 ? (
                        <p className="text-ui-xs text-foreground-subtle">
                          {entry.tags.join(" · ")}
                        </p>
                      ) : null}
                    </div>
                    {entry.sourceUrl || entry.homepageUrl ? (
                      <button
                        className="inline-flex w-fit items-center gap-1 text-ui-sm text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline"
                        type="button"
                        onClick={() => onOpenSource(entry.sourceUrl ?? entry.homepageUrl ?? "")}
                        aria-label={intl.formatMessage(
                          { id: "settings.mcp.marketplace.discovery.openSource" },
                          { name: entry.name },
                        )}
                      >
                        {intl.formatMessage({
                          id: "settings.mcp.marketplace.discovery.sourceLabel",
                        })}
                        <ExternalLink className="size-3" aria-hidden="true" />
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </>
        ) : null}
      </section>
    </section>
  );
}
