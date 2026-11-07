import { useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  PluginStoreCard,
  type PluginStoreActions,
} from "@/settings/PluginStoreCard.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import {
  PLUGIN_CATALOG_SORTS,
  PLUGIN_CATALOG_TABS,
  buildPluginCatalogView,
  type CatalogBadge,
  type PluginCatalogSort,
  type PluginCatalogTab,
} from "@/settings/pluginCatalogView.js";

const TAB_LABEL_IDS: Record<PluginCatalogTab, string> = {
  all: "catalog.tabs.all",
  official: "catalog.tabs.official",
  community: "catalog.tabs.community",
};

const SORT_LABEL_IDS: Record<PluginCatalogSort, string> = {
  recommended: "catalog.sort.recommended",
  name: "catalog.sort.name",
};

const BADGE_LABEL_IDS: Record<CatalogBadge, string> = {
  official: "catalog.badge.official",
  community: "catalog.badge.community",
  featured: "catalog.badge.featured",
  popular: "catalog.badge.popular",
  new: "catalog.badge.new",
  curated: "catalog.badge.curated",
};

/**
 * 插件市场目录（策展排序）。
 *
 * 展示真实来源徽章与策展 Featured 徽章，不渲染任何安装量/下载量/趋势数值。
 * 安装入口与已安装状态完全复用 `PluginStoreCard`，本组件不新增写入路径。
 */
export function PluginCatalogView({
  items,
  actions,
  query,
  onQueryChange,
  initialTab = "all",
}: {
  items: StorePluginItem[];
  actions: PluginStoreActions;
  query: string;
  onQueryChange: (query: string) => void;
  initialTab?: PluginCatalogTab;
}) {
  const { intl, locale } = useZCodeIntl();
  const [tab, setTab] = useState<PluginCatalogTab>(initialTab);
  const [sort, setSort] = useState<PluginCatalogSort>("recommended");

  const entries = useMemo(
    () => buildPluginCatalogView({ items, tab, sort, filter: query, locale }),
    [items, tab, sort, query, locale],
  );
  const marketplaceLabel = intl.formatMessage({ id: "catalog.source.marketplace" });
  const curatedNote = intl.formatMessage({ id: "catalog.curatedNote" });

  return (
    <div className="space-y-4" data-testid="plugin-catalog">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div
          role="tablist"
          aria-label={marketplaceLabel}
          className="flex flex-wrap items-center gap-1.5"
        >
          {PLUGIN_CATALOG_TABS.map((candidate) => (
            <CatalogPill
              key={candidate}
              active={tab === candidate}
              testId={`plugin-catalog-tab-${candidate}`}
              label={intl.formatMessage({ id: TAB_LABEL_IDS[candidate] })}
              onClick={() => setTab(candidate)}
            />
          ))}
        </div>
        <div
          role="group"
          aria-label={intl.formatMessage({ id: "catalog.sort.label" })}
          className="flex flex-wrap items-center gap-1.5"
        >
          {PLUGIN_CATALOG_SORTS.map((candidate) => (
            <CatalogPill
              key={candidate}
              active={sort === candidate}
              testId={`plugin-catalog-sort-${candidate}`}
              label={intl.formatMessage({ id: SORT_LABEL_IDS[candidate] })}
              onClick={() => setSort(candidate)}
            />
          ))}
        </div>
        <SettingsSearchInput
          data-testid="plugin-catalog-search"
          containerClassName="ml-auto min-w-0 flex-[1_1_14rem] sm:max-w-xs"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onClear={() => onQueryChange("")}
          placeholder={intl.formatMessage({ id: "settings.plugins.store.searchPlaceholder" })}
        />
      </div>

      <p
        data-testid="plugin-catalog-note"
        className="flex flex-wrap items-center gap-x-1.5 text-ui-sm text-foreground-subtle"
      >
        <span>{marketplaceLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{curatedNote}</span>
      </p>

      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: query.trim()
              ? "settings.plugins.store.searchEmpty"
              : "settings.plugins.marketplacePlugins.empty",
          })}
        </p>
      ) : (
        <ul className="grid gap-x-6 gap-y-1 @min-[40rem]/plugin-store:grid-cols-2">
          {entries.map((entry) => (
            <li key={entry.item.id} className="flex min-w-0 items-start gap-2">
              <span
                data-testid="plugin-catalog-rank"
                data-rank={entry.rank}
                aria-label={intl.formatMessage(
                  { id: "catalog.rankLabel" },
                  { rank: String(entry.rank) },
                )}
                className="mt-3 w-7 shrink-0 text-right font-mono text-ui-xs tabular-nums text-foreground-subtlest"
              >
                #{entry.rank}
              </span>
              <div className="min-w-0 flex-1">
                <PluginStoreCard item={entry.item} actions={actions} locale={locale} />
                <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5">
                  {entry.badges.map((badge) => (
                    <span
                      key={badge}
                      data-testid="plugin-catalog-badge"
                      data-badge={badge}
                      data-plugin-id={entry.item.id}
                      className="inline-flex shrink-0 items-center rounded-full bg-surface px-1.5 py-0.5 text-ui-xs leading-none whitespace-nowrap text-foreground-subtle"
                    >
                      {intl.formatMessage({ id: BADGE_LABEL_IDS[badge] })}
                    </span>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CatalogPill({
  active,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
        active
          ? "bg-selected text-foreground"
          : "text-foreground-subtle hover:bg-hover hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
