import { Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  MCP_CURATED_SERVERS,
  type McpRegistryInstallOption,
  type McpRegistryMarketplaceEntry,
  type McpRegistryMarketplaceResult,
} from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import {
  buildMcpCatalogView,
  mergeMcpRegistryEntries,
  MCP_CATALOG_TABS,
  type McpCatalogSortMode,
  type McpCatalogTab,
} from "@/settings/mcpRegistryCatalogView.js";

/**
 * Official MCP Registry 目录。
 *
 * Registry 不提供 installs/publishedAt 之外的排名信号：`MCP_CURATED_SERVERS` 是编辑精选顺序，
 * 必须显示 `catalog.curatedNote`，不能展示任何安装量。安装动作仍然交给现有 MCP 表单，
 * 用户先确认 npx/uvx/docker 命令或远端 URL 再写入配置。
 */

const PRELOAD_BATCH_SIZE = 4;

/** 精选目录按会话缓存：Registry 只支持 search，没有 browse/count 接口。 */
let curatedPreload: Promise<McpRegistryMarketplaceEntry[]> | null = null;

/** 清掉会话级精选缓存，让重新加载重新请求 Registry。 */
function resetMcpRegistryCatalogPreloadForTests(): void {
  curatedPreload = null;
}

const SORT_MODES: readonly McpCatalogSortMode[] = ["recommended", "name"];

async function loadCuratedEntries(
  search: (query: string) => Promise<McpRegistryMarketplaceResult>,
): Promise<McpRegistryMarketplaceEntry[]> {
  const collected: McpRegistryMarketplaceEntry[] = [];
  for (let index = 0; index < MCP_CURATED_SERVERS.length; index += PRELOAD_BATCH_SIZE) {
    const batch = MCP_CURATED_SERVERS.slice(index, index + PRELOAD_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((name) => search(name)));
    for (const result of results) {
      if (result.status === "fulfilled") collected.push(...result.value.entries);
    }
  }
  // Popular 只展示真实命中的精选条目；未命中的名字不生成占位卡片。
  return mergeMcpRegistryEntries(
    [],
    collected.filter((entry) => entry.options.length > 0),
  );
}

export function McpRegistryMarketplace({
  onConfigure,
}: {
  onConfigure: (entry: McpRegistryMarketplaceEntry, option: McpRegistryInstallOption) => void;
}) {
  const { intl } = useZCodeIntl();
  const { mcpSyncService } = useServices();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<McpRegistryMarketplaceEntry[]>([]);
  const [tab, setTab] = useState<McpCatalogTab>("popular");
  const [sort, setSort] = useState<McpCatalogSortMode>("recommended");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const task =
      curatedPreload ??
      loadCuratedEntries((name) => mcpSyncService.searchMarketplace(name));
    curatedPreload = task;
    task
      .then((loaded) => {
        if (!active || loaded.length === 0) return;
        setEntries((current) => mergeMcpRegistryEntries(current, loaded));
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[McpRegistryMarketplace] curated registry preload failed", {
          error: message,
        });
        setError(message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mcpSyncService]);

  const reloadCurated = async () => {
    resetMcpRegistryCatalogPreloadForTests();
    setError(null);
    setLoading(true);
    try {
      const loaded = await loadCuratedEntries((name) => mcpSyncService.searchMarketplace(name));
      curatedPreload = Promise.resolve(loaded);
      setEntries((current) => mergeMcpRegistryEntries(current, loaded));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[McpRegistryMarketplace] curated registry reload failed", { error: message });
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const search = async (rawQuery: string) => {
    const normalized = rawQuery.trim();
    setQuery(rawQuery);
    setHasSearched(true);
    setError(null);
    if (!normalized) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await mcpSyncService.searchMarketplace(normalized);
      setEntries((current) => mergeMcpRegistryEntries(current, result.entries));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[McpRegistryMarketplace] Official MCP Registry search failed", {
        error: message,
        query: normalized,
      });
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void search(query);
  };

  const viewEntries = useMemo(
    () => buildMcpCatalogView({ entries, tab, sort, filter: query }),
    [entries, tab, sort, query],
  );

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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(value) => setTab(value as McpCatalogTab)}>
          <TabsList aria-label={intl.formatMessage({ id: "catalog.mcp.title" })}>
            {MCP_CATALOG_TABS.map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                data-testid={`mcp-registry-tab-${item}`}
                className="px-2"
              >
                {intl.formatMessage({ id: `catalog.tabs.${item}` })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "catalog.sort.label" })}
          </span>
          {SORT_MODES.map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={sort === mode ? "secondary" : "ghost"}
              aria-pressed={sort === mode}
              data-testid={`mcp-registry-sort-${mode}`}
              onClick={() => setSort(mode)}
            >
              {intl.formatMessage({ id: `catalog.sort.${mode}` })}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-foreground-subtle">
        <span className="font-medium text-foreground">
          {intl.formatMessage({ id: "catalog.source.mcpRegistry" })}
        </span>
        <span aria-hidden="true">·</span>
        <span>{intl.formatMessage({ id: "catalog.curatedNote" })}</span>
        <span aria-hidden="true">·</span>
        <span>{intl.formatMessage({ id: "catalog.officialRegistryNote" })}</span>
      </div>

      <form role="search" className="flex flex-wrap items-center gap-2" onSubmit={handleSubmit}>
        <SettingsSearchInput
          data-testid="mcp-registry-search"
          containerClassName="min-w-0 flex-[1_1_18rem]"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => {
            setQuery("");
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (hasSearched && query.trim()) void search(query);
              else void reloadCurated();
            }}
          >
            {intl.formatMessage({ id: "settings.mcp.registry.retry" })}
          </Button>
        </div>
      ) : null}

      {!loading && !error && viewEntries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.registry.empty" })}
        </p>
      ) : null}

      {!loading && !error && viewEntries.length > 0 ? (
        <ul className="space-y-2" data-testid="mcp-registry-results">
          {viewEntries.map(({ item: entry, rank, badges }) => (
            <li
              key={entry.id}
              className="space-y-3 rounded-xl border border-card-border bg-card px-4 py-3"
              data-testid={`mcp-registry-entry-${entry.id}`}
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className="font-mono tabular-nums"
                    aria-label={intl.formatMessage(
                      { id: "catalog.rankLabel" },
                      { rank },
                    )}
                    data-testid={`mcp-registry-rank-${entry.id}`}
                  >
                    #{rank}
                  </Badge>
                  <span className="min-w-0 break-all text-ui-base font-medium text-foreground">
                    {entry.name}
                  </span>
                  {badges.map((badge) => (
                    <Badge key={badge} variant={badge === "curated" ? "secondary" : "outline"}>
                      {intl.formatMessage({ id: `catalog.badge.${badge}` })}
                    </Badge>
                  ))}
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
