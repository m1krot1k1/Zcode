import { Loader2, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { McpRegistryInstallOption, McpRegistryMarketplaceEntry } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";

/**
 * Official MCP Registry search. Results are metadata + install options only;
 * "Configure & install" opens the existing MCP form so the user reviews the
 * exact npx/uvx/docker command or remote URL before anything is persisted.
 */
export function McpRegistryMarketplace({
  onConfigure,
}: {
  onConfigure: (entry: McpRegistryMarketplaceEntry, option: McpRegistryInstallOption) => void;
}) {
  const { intl } = useZCodeIntl();
  const { mcpSyncService } = useServices();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<McpRegistryMarketplaceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const search = async (rawQuery: string) => {
    const normalized = rawQuery.trim();
    setQuery(rawQuery);
    setHasSearched(true);
    setError(null);
    if (!normalized) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await mcpSyncService.searchMarketplace(normalized);
      setItems(result.entries);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[McpRegistryMarketplace] Official MCP Registry search failed", {
        error: message,
        query: normalized,
      });
      setItems([]);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void search(query);
  };

  return (
    <section className="space-y-3" data-testid="mcp-registry-marketplace">
      <div className="space-y-1">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.mcp.registry.title" })}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.registry.description" })}
        </p>
      </div>

      <form role="search" className="flex flex-wrap items-center gap-2" onSubmit={handleSubmit}>
        <SettingsSearchInput
          data-testid="mcp-registry-search"
          containerClassName="min-w-0 flex-[1_1_18rem]"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => {
            setQuery("");
            setItems([]);
            setHasSearched(false);
            setError(null);
          }}
          clearLabel={intl.formatMessage({ id: "settings.mcp.registry.clearSearch" })}
          placeholder={intl.formatMessage({ id: "settings.mcp.registry.searchPlaceholder" })}
        />
        <Button
          type="submit"
          variant="secondary"
          size="lg"
          className="h-9"
          disabled={loading || !query.trim()}
          data-testid="mcp-registry-submit"
        >
          <Search className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.mcp.registry.search" })}
        </Button>
      </form>

      {loading ? (
        <p
          role="status"
          className="flex items-center gap-2 py-2 text-ui-base text-foreground-subtle"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.mcp.registry.loading" })}
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          <span>{intl.formatMessage({ id: "settings.mcp.registry.error" })}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void search(query)}>
            {intl.formatMessage({ id: "settings.mcp.registry.retry" })}
          </Button>
        </div>
      ) : null}

      {!loading && !error && hasSearched && items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.registry.empty" })}
        </p>
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <ul className="space-y-2" data-testid="mcp-registry-results">
          {items.map((entry) => (
            <li
              key={entry.id}
              className="space-y-3 rounded-xl border border-card-border bg-card px-4 py-3"
              data-testid={`mcp-registry-entry-${entry.id}`}
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all text-ui-base font-medium text-foreground">
                    {entry.name}
                  </span>
                  {entry.version ? <Badge variant="outline">v{entry.version}</Badge> : null}
                </div>
                {entry.description ? (
                  <p className="text-ui-sm text-foreground-subtle">{entry.description}</p>
                ) : null}
                {entry.repositoryUrl ? (
                  <a
                    className="block break-all font-mono text-ui-xs text-foreground-subtle underline-offset-2 hover:underline"
                    href={entry.repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {entry.repositoryUrl}
                  </a>
                ) : null}
              </div>

              <div className="space-y-2">
                {entry.options.map((option, index) => (
                  <div
                    key={`${entry.id}-${option.kind}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {option.kind === "stdio"
                            ? intl.formatMessage({ id: "settings.mcp.registry.stdio" })
                            : intl.formatMessage({ id: "settings.mcp.registry.remote" })}
                        </Badge>
                        <code className="break-all font-mono text-ui-xs text-foreground">
                          {option.kind === "stdio"
                            ? [option.command, ...(option.args ?? [])].filter(Boolean).join(" ")
                            : option.url}
                        </code>
                      </div>
                      {option.requiresAuth ? (
                        <p className="text-ui-xs text-foreground-subtle">
                          {intl.formatMessage({ id: "settings.mcp.registry.requiresAuth" })}
                        </p>
                      ) : null}
                      {option.requiredEnv?.length ? (
                        <p className="break-all text-ui-xs text-foreground-subtle">
                          {intl.formatMessage({ id: "settings.mcp.registry.requiredEnv" })}:{" "}
                          {option.requiredEnv.map((item) => item.name).join(", ")}
                        </p>
                      ) : null}
                      {option.requiredHeaders?.length ? (
                        <p className="break-all text-ui-xs text-foreground-subtle">
                          {intl.formatMessage({ id: "settings.mcp.registry.requiredHeaders" })}:{" "}
                          {option.requiredHeaders.map((item) => item.name).join(", ")}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`mcp-registry-configure-${entry.id}-${index}`}
                      onClick={() => onConfigure(entry, option)}
                    >
                      {intl.formatMessage({ id: "settings.mcp.registry.configure" })}
                    </Button>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
