import {
  compareCatalogEntries,
  getPluginCuratedRank,
  type CatalogBadge,
  type CatalogEntryLike,
} from "@zcode/shared";
import {
  resolveItemDisplayName,
  storeItemMatches,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";

/**
 * Plugin 市场目录视图模型。
 *
 * 数据事实：市场 manifest（ZCode official / Claude official）不发布 install counts 和
 * publish date，只有 id、name、marketplace、description、version 与 listing 展示字段
 * （category/publisherType/author/icon…）。因此目录不渲染任何安装量、下载量或趋势数值，
 * 默认顺序是**策展顺序**（见 docs/catalog-leaderboard.md），不是热度。
 *
 * 徽章/排序/阈值全部来自 `@zcode/shared` 的 catalog 模块，UI 不重复实现共享规则。
 */
export type { CatalogBadge } from "@zcode/shared";

/** 目录真实来源：官方市场条目的 publisherType 只有 official / community 两种。 */
export type PluginCatalogSource = "official" | "community";

/** 页签：All + 两个真实来源。仓库里没有 anthropics 插件目录来源的目录条目（见报告）。 */
export type PluginCatalogTab = "all" | PluginCatalogSource;

export const PLUGIN_CATALOG_TABS: readonly PluginCatalogTab[] = [
  "all",
  "official",
  "community",
] as const;

/** 只有 recommended（策展）和 name 可用；installs/newest 缺少真实数据源。 */
export type PluginCatalogSort = "recommended" | "name";

export const PLUGIN_CATALOG_SORTS: readonly PluginCatalogSort[] = ["recommended", "name"] as const;

/**
 * 条目来源：`listing.publisherType` 是官方市场目录的唯一真实归属字段；
 * 旧目录未提供时按公开（official）处理，与 CONTEXT.md 的 Public Segment 规则一致。
 */
export function resolvePluginCatalogSource(
  item: Pick<StorePluginItem, "listing">,
): PluginCatalogSource {
  return item.listing?.publisherType === "community" ? "community" : "official";
}

/**
 * 徽章：来源徽章始终来自真实 publisherType；Featured 只在
 * `getPluginCuratedRank` 命中共享策展名单时出现，绝不表示安装量或热度。
 */
export function resolvePluginCatalogBadges(
  item: Pick<StorePluginItem, "id" | "listing">,
): CatalogBadge[] {
  const badges: CatalogBadge[] = [
    resolvePluginCatalogSource(item) === "official" ? "official" : "community",
  ];
  if (getPluginCuratedRank(item.id) !== undefined) badges.push("featured");
  return badges;
}

export interface PluginCatalogViewEntry {
  item: StorePluginItem;
  /** 当前可见顺序中的排名，从 1 开始。 */
  rank: number;
  source: PluginCatalogSource;
  badges: CatalogBadge[];
}

export interface PluginCatalogViewInput {
  items: readonly StorePluginItem[];
  tab: PluginCatalogTab;
  sort: PluginCatalogSort;
  /** 搜索只做过滤，不改变当前排序。 */
  filter: string;
  locale: string;
}

const SOURCE_ORDER: Record<PluginCatalogSource, number> = { official: 0, community: 1 };

function toCatalogEntry(item: StorePluginItem, locale: string): CatalogEntryLike {
  return {
    name: resolveItemDisplayName(item, locale),
    curatedRank: getPluginCuratedRank(item.id),
  };
}

/**
 * 单一派生入口：页签过滤 → 搜索过滤 → 排序 → 生成排名与徽章。
 * 推荐顺序：official 分组在前，组内按共享策展 rank，其后 community，最后按名称稳定兜底。
 */
export function buildPluginCatalogView(input: PluginCatalogViewInput): PluginCatalogViewEntry[] {
  const visible = input.items
    .filter((item) => input.tab === "all" || resolvePluginCatalogSource(item) === input.tab)
    .filter((item) => storeItemMatches(item, input.filter, input.locale));

  visible.sort((left, right) => {
    const leftEntry = toCatalogEntry(left, input.locale);
    const rightEntry = toCatalogEntry(right, input.locale);
    if (input.sort === "name") return compareCatalogEntries(leftEntry, rightEntry, "name");
    const source =
      SOURCE_ORDER[resolvePluginCatalogSource(left)] -
      SOURCE_ORDER[resolvePluginCatalogSource(right)];
    return source !== 0
      ? source
      : compareCatalogEntries(leftEntry, rightEntry, "recommended");
  });

  return visible.map((item, index) => ({
    item,
    rank: index + 1,
    source: resolvePluginCatalogSource(item),
    badges: resolvePluginCatalogBadges(item),
  }));
}
