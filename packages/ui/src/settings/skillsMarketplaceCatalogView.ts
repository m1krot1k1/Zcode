import {
  compareCatalogEntries,
  skillsBadges,
  SKILLS_POPULAR_MIN_INSTALLS,
  type CatalogBadge,
  type CatalogSortMode,
} from "@zcode/shared";
import type { MarketplaceSkillInfo } from "@zcode/shared";

/**
 * skills.sh 搜索 API 只返回 `installs`（`GET /api/search?q=` → `{ skills: [{ id, source, skillId,
 * name, installs }] }`，2026-11-07 实测 HTTP 200）。没有 published/date 字段，也没有 trending/period
 * 参数或 endpoint，因此此处不伪造“New”徽章或 Trending 页签。
 *
 * 该文件是 Skills 市场的视图模型：tab 过滤、搜索过滤、排序与排名。徽章/排序/阈值全部来自
 * `@zcode/shared` 的 catalog 模块，UI 不重复实现共享规则。
 */
export type { CatalogBadge, CatalogSortMode } from "@zcode/shared";

export type CatalogTab = "allTime" | "popular";

/** 没有 trending 数据源，页签固定为 All Time / Popular。 */
export const CATALOG_TABS: readonly CatalogTab[] = [
  "allTime",
  "popular",
] as const;

/** 大小写不敏感的名称/slug/来源匹配，作为目录的本地过滤器。 */
export function matchesCatalogQuery(
  entry: MarketplaceSkillInfo,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  return (
    entry.name.toLowerCase().includes(query) ||
    entry.skillId.toLowerCase().includes(query) ||
    entry.source.toLowerCase().includes(query)
  );
}

export interface CatalogViewEntry {
  item: MarketplaceSkillInfo;
  /** 当前展示顺序中的排名，从 1 开始。 */
  rank: number;
  badges: CatalogBadge[];
}

export interface CatalogViewInput {
  items: readonly MarketplaceSkillInfo[];
  tab: CatalogTab;
  sort: CatalogSortMode;
  filter: string;
}

/**
 * 单一派生入口：tab 过滤 → 搜索过滤 → 共享排序 → 生成排名与徽章。
 * 排名基于当前可见列表，因此筛选/排序后仍然是连续的 #1、#2…
 * `popular` 只使用真实 installs 阈值，`new` 仅在存在真实发布日期时才可能出现。
 */
export function buildCatalogView(input: CatalogViewInput): CatalogViewEntry[] {
  return input.items
    .filter(
      (item) =>
        input.tab !== "popular" || item.installs >= SKILLS_POPULAR_MIN_INSTALLS,
    )
    .filter((item) => matchesCatalogQuery(item, input.filter))
    .slice()
    .sort((left, right) => compareCatalogEntries(left, right, input.sort))
    .map((item, index) => ({
      item,
      rank: index + 1,
      badges: skillsBadges({ installs: item.installs, publisher: item.source }),
    }));
}
