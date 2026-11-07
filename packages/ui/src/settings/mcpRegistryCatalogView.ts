import {
  compareCatalogEntries,
  getMcpCuratedRank,
  isNewPublishedAt,
  type CatalogBadge,
  type CatalogSortMode,
  type McpRegistryMarketplaceEntry,
} from "@zcode/shared";

/**
 * MCP 目录视图模型。
 *
 * 官方 MCP Registry（`registry.modelcontextprotocol.io/v0/servers`，2026-11-07 实测 HTTP 200）
 * 只返回 name / description / version / repository / `_meta` 时间戳，没有 installs、downloads
 * 或 trend 字段。因此排序只能使用 `MCP_CURATED_SERVERS` 的编辑顺序，界面必须标注
 * `catalog.curatedNote`，不能伪造安装量。
 *
 * 排序、筛选、徽章和排名都收敛在这里，组件只负责渲染；共享比较器来自
 * `packages/shared/src/catalog/index.ts`。
 */

export type McpCatalogTab = "popular" | "all";

/** MCP 没有安装量也没有 trend 数据源，只保留两种有真实依据的排序。 */
export type McpCatalogSortMode = Extract<CatalogSortMode, "recommended" | "name">;

/**
 * Registry 条目 + 目录派生字段。`publishedAt` 只有在服务端确实透出真实发布时间时才会存在；
 * 当前 `McpRegistryMarketplaceEntry` 尚未携带该字段，因此这里只做结构化兼容，不补造日期。
 */
interface McpCatalogEntryLike extends McpRegistryMarketplaceEntry {
  publishedAt?: string;
  curatedRank?: number;
}

export const MCP_CATALOG_TABS: readonly McpCatalogTab[] = ["popular", "all"] as const;

/** 给条目附加 curated rank；不在精选列表中的条目 rank 为 undefined。 */
function withMcpCuratedRank(
  entries: readonly McpRegistryMarketplaceEntry[],
): McpCatalogEntryLike[] {
  return entries.map((entry) => {
    const curatedRank = getMcpCuratedRank(entry.name);
    return curatedRank === undefined ? { ...entry } : { ...entry, curatedRank };
  });
}

/**
 * 徽章只来自真实数据：
 * - `curated`：条目命中 `MCP_CURATED_SERVERS`（编辑推荐，不代表安装量）；
 * - `new`：需要真实的 ISO-8601 `publishedAt` 且落在 30 天窗口内。
 *
 * Registry 响应没有 official/publisher 标记，所以这里不产出 `official` 徽章。
 */
function mcpCatalogBadges(
  entry: McpCatalogEntryLike,
  now: Date = new Date(),
): CatalogBadge[] {
  const badges: CatalogBadge[] = [];
  if (getMcpCuratedRank(entry.name) !== undefined) badges.push("curated");
  if (isNewPublishedAt(entry.publishedAt, 30, now)) badges.push("new");
  return badges;
}

/** 大小写不敏感的名称/描述/id 子串匹配，作为目录的本地过滤器。 */
function matchesMcpCatalogQuery(
  entry: McpRegistryMarketplaceEntry,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  return (
    entry.name.toLowerCase().includes(query) ||
    entry.id.toLowerCase().includes(query) ||
    (entry.description?.toLowerCase().includes(query) ?? false)
  );
}

/** 按 id 去重合并；后到的结果覆盖旧字段（同一 id 的最新搜索结果优先）。 */
export function mergeMcpRegistryEntries(
  current: readonly McpRegistryMarketplaceEntry[],
  incoming: readonly McpRegistryMarketplaceEntry[],
): McpRegistryMarketplaceEntry[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    merged.set(entry.id, { ...merged.get(entry.id), ...entry });
  }
  return [...merged.values()];
}

interface McpCatalogViewEntry {
  item: McpCatalogEntryLike;
  /** 当前展示顺序中的排名，从 1 开始。 */
  rank: number;
  badges: CatalogBadge[];
}

interface McpCatalogViewInput {
  entries: readonly McpRegistryMarketplaceEntry[];
  tab: McpCatalogTab;
  sort: McpCatalogSortMode;
  filter: string;
  now?: Date;
}

/**
 * 单一派生入口：tab 过滤（Popular 仅精选）→ 搜索过滤 → 排序 → 排名与徽章。
 *
 * `recommended` 使用共享比较器：curated rank 升序，未收录条目排在其后，再按 name；
 * `name` 按 localeCompare。排名基于当前可见列表，因此筛选/排序后仍然连续。
 */
export function buildMcpCatalogView(input: McpCatalogViewInput): McpCatalogViewEntry[] {
  const ranked = withMcpCuratedRank(input.entries);
  return ranked
    .filter((entry) => input.tab === "all" || entry.curatedRank !== undefined)
    .filter((entry) => matchesMcpCatalogQuery(entry, input.filter))
    .slice()
    .sort((left, right) => compareCatalogEntries(left, right, input.sort))
    .map((item, index) => ({
      item,
      rank: index + 1,
      badges: mcpCatalogBadges(item, input.now),
    }));
}
