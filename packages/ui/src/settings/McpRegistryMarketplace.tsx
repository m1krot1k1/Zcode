import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MCP_CURATED_SERVERS,
  type CommunityMcpPreset,
  type McpServerConfig,
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
import {
  buildMcpCatalogView,
  mergeMcpRegistryEntries,
  MCP_CATALOG_TABS,
  removeReviewedMcpPresetDuplicates,
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
export function resetMcpRegistryCatalogPreloadForTests(): void {
  curatedPreload = null;
}

const SORT_MODES: readonly McpCatalogSortMode[] = ["recommended", "name"];

async function loadCuratedEntries(
  search: (query: string) => Promise<McpRegistryMarketplaceResult>,
): Promise<McpRegistryMarketplaceEntry[]> {
  const collected: McpRegistryMarketplaceEntry[] = [];
  let failedSearches = 0;
  for (let index = 0; index < MCP_CURATED_SERVERS.length; index += PRELOAD_BATCH_SIZE) {
    const batch = MCP_CURATED_SERVERS.slice(index, index + PRELOAD_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((name) => search(name)));
    for (const result of results) {
      if (result.status === "fulfilled") collected.push(...result.value.entries);
      else failedSearches += 1;
    }
  }
  if (failedSearches === MCP_CURATED_SERVERS.length) {
    throw new Error("All curated MCP Registry searches failed.");
  }
  // Popular 只展示真实命中的精选条目；未命中的名字不生成占位卡片。
  return mergeMcpRegistryEntries(
    [],
    collected.filter((entry) => entry.options.length > 0),
  );
}

export function McpRegistryMarketplace({
  onConfigure,
  onVisibleCountChange,
  query,
  reviewedPresets,
  configuredServers,
}: {
  onConfigure: (entry: McpRegistryMarketplaceEntry, option: McpRegistryInstallOption) => void;
  onVisibleCountChange?: (count: number | null) => void;
  query: string;
  reviewedPresets: readonly CommunityMcpPreset[];
  configuredServers: readonly McpServerConfig[];
}) {
  const { intl } = useZCodeIntl();
  const { mcpSyncService } = useServices();
  const [catalogEntries, setCatalogEntries] = useState<McpRegistryMarketplaceEntry[]>([]);
  const [searchEntries, setSearchEntries] = useState<McpRegistryMarketplaceEntry[]>([]);
  const [searchResultQuery, setSearchResultQuery] = useState("");
  const [tab, setTab] = useState<McpCatalogTab>("popular");
  const [sort, setSort] = useState<McpCatalogSortMode>("recommended");
  const [showSimilar, setShowSimilar] = useState(false);
  const [preloadLoading, setPreloadLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchRequestSeqRef = useRef(0);
  const normalizedQuery = query.trim();
  const hasSearched = Boolean(normalizedQuery);
  const loading = preloadLoading || searchLoading;
  const error = searchError ?? (hasSearched ? null : preloadError);

  useEffect(() => {
    let active = true;
    setPreloadLoading(true);
    const task =
      curatedPreload ?? loadCuratedEntries((name) => mcpSyncService.searchMarketplace(name));
    curatedPreload = task;
    task
      .then((loaded) => {
        if (!active || loaded.length === 0) return;
        setCatalogEntries((current) => mergeMcpRegistryEntries(current, loaded));
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (curatedPreload === task) curatedPreload = null;
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[McpRegistryMarketplace] curated registry preload failed", {
          error: message,
        });
        setPreloadError(message);
      })
      .finally(() => {
        if (active) setPreloadLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mcpSyncService]);

  const executeSearch = useCallback(
    async (rawQuery: string) => {
      const normalized = rawQuery.trim();
      const requestSeq = ++searchRequestSeqRef.current;
      if (!normalized) {
        setSearchEntries([]);
        setSearchResultQuery("");
        setSearchError(null);
        setSearchLoading(false);
        return;
      }
      setSearchEntries([]);
      setSearchResultQuery("");
      setSearchError(null);
      setSearchLoading(true);
      try {
        const result = await mcpSyncService.searchMarketplace(normalized);
        if (requestSeq !== searchRequestSeqRef.current) return;
        setSearchEntries(
          removeReviewedMcpPresetDuplicates(result.entries, reviewedPresets, configuredServers),
        );
        setSearchResultQuery(normalized);
      } catch (cause) {
        if (requestSeq !== searchRequestSeqRef.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[McpRegistryMarketplace] Official MCP Registry search failed", {
          error: message,
          query: normalized,
        });
        setSearchError(message);
      } finally {
        if (requestSeq === searchRequestSeqRef.current) setSearchLoading(false);
      }
    },
    [configuredServers, mcpSyncService, reviewedPresets],
  );

  useEffect(() => {
    const normalized = query.trim();
    setSearchEntries([]);
    setSearchResultQuery("");
    setSearchError(null);
    setSearchLoading(Boolean(normalized));
    const timer = window.setTimeout(() => void executeSearch(normalized), normalized ? 320 : 0);
    return () => {
      window.clearTimeout(timer);
      searchRequestSeqRef.current += 1;
    };
  }, [executeSearch, query]);

  const reloadCurated = async () => {
    resetMcpRegistryCatalogPreloadForTests();
    setPreloadError(null);
    setPreloadLoading(true);
    try {
      const loaded = await loadCuratedEntries((name) => mcpSyncService.searchMarketplace(name));
      curatedPreload = Promise.resolve(loaded);
      setCatalogEntries((current) => mergeMcpRegistryEntries(current, loaded));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[McpRegistryMarketplace] curated registry reload failed", { error: message });
      setPreloadError(message);
    } finally {
      setPreloadLoading(false);
    }
  };

  const viewEntries = useMemo(
    () =>
      buildMcpCatalogView({
        entries: hasSearched
          ? searchResultQuery === normalizedQuery
            ? searchEntries
            : []
          : removeReviewedMcpPresetDuplicates(catalogEntries, reviewedPresets, configuredServers),
        tab,
        sort,
        filter: "",
        searchResults: hasSearched,
        showSimilar,
      }),
    [
      catalogEntries,
      configuredServers,
      hasSearched,
      searchEntries,
      searchResultQuery,
      normalizedQuery,
      reviewedPresets,
      tab,
      sort,
      showSimilar,
    ],
  );
  const hiddenSimilarCount = showSimilar
    ? 0
    : viewEntries.reduce((sum, entry) => sum + (entry.similarCount ?? 0), 0);
  const listReady = hasSearched
    ? !searchLoading && searchResultQuery === normalizedQuery
    : !preloadLoading;

  useEffect(() => {
    onVisibleCountChange?.(listReady ? viewEntries.length : null);
  }, [listReady, normalizedQuery, onVisibleCountChange, viewEntries.length]);

  return (
    <section className="space-y-3" data-testid="mcp-registry-marketplace">
      <div className="space-y-1">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.mcp.registry.title" })}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.registry.description" })}
        </p>
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.registry.localLaunchNote" })}
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
          {hiddenSimilarCount > 0 || showSimilar ? (
            <Button
              type="button"
              size="sm"
              variant={showSimilar ? "secondary" : "ghost"}
              aria-pressed={showSimilar}
              data-testid="mcp-registry-similar-toggle"
              onClick={() => setShowSimilar((current) => !current)}
            >
              {intl.formatMessage(
                {
                  id: showSimilar
                    ? "settings.mcp.registry.hideSimilar"
                    : "settings.mcp.registry.showSimilar",
                },
                { count: hiddenSimilarCount },
              )}
            </Button>
          ) : null}
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
              if (searchError && hasSearched) void executeSearch(normalizedQuery);
              else void reloadCurated();
            }}
          >
            {intl.formatMessage({ id: "settings.mcp.registry.retry" })}
          </Button>
        </div>
      ) : null}

      {listReady && !error && viewEntries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.mcp.registry.empty" })}
        </p>
      ) : null}

      {listReady && !error && viewEntries.length > 0 ? (
        <ul className="space-y-2" data-testid="mcp-registry-results">
          {viewEntries.map(({ item: entry, rank, badges, similarCount }) => (
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
                    aria-label={intl.formatMessage({ id: "catalog.rankLabel" }, { rank })}
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
                  {similarCount ? (
                    <Badge variant="outline">
                      {intl.formatMessage(
                        { id: "settings.mcp.registry.similarCount" },
                        { count: similarCount },
                      )}
                    </Badge>
                  ) : null}
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
