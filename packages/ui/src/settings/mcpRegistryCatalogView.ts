import {
  compareCatalogEntries,
  getMcpCuratedRank,
  isNewPublishedAt,
  type CatalogBadge,
  type CatalogSortMode,
  type ClineMcpMarketplaceEntry,
  type CommunityMcpPreset,
  type McpServerConfig,
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
function mcpCatalogBadges(entry: McpCatalogEntryLike, now: Date = new Date()): CatalogBadge[] {
  const badges: CatalogBadge[] = [];
  if (getMcpCuratedRank(entry.name) !== undefined) badges.push("curated");
  if (isNewPublishedAt(entry.publishedAt, 30, now)) badges.push("new");
  return badges;
}

/** 大小写不敏感的名称/描述/id 子串匹配，作为目录的本地过滤器。 */
function matchesMcpCatalogQuery(entry: McpRegistryMarketplaceEntry, rawQuery: string): boolean {
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

function normalizeNpmPackageName(packageSpec: string): string | undefined {
  const value = packageSpec.trim();
  if (!value || value.startsWith("-")) return undefined;
  const scopeEnd = value.startsWith("@") ? value.indexOf("/") : -1;
  const versionSeparator =
    scopeEnd >= 0 ? value.indexOf("@", scopeEnd + 1) : value.lastIndexOf("@");
  const name = versionSeparator > 0 ? value.slice(0, versionSeparator) : value;
  return /^[a-z0-9][a-z0-9._-]*$|^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu.test(name)
    ? name.toLowerCase()
    : undefined;
}

function getNpxPackageNames(args: readonly string[] | undefined): string[] {
  const packages: string[] = [];
  for (let index = 0; index < (args?.length ?? 0); index += 1) {
    const argument = args?.[index]?.trim() ?? "";
    if (argument === "-p" || argument === "--package") {
      const packageName = normalizeNpmPackageName(args?.[index + 1] ?? "");
      if (packageName) packages.push(packageName);
      index += 1;
      continue;
    }
    if (argument.startsWith("--package=")) {
      const packageName = normalizeNpmPackageName(argument.slice("--package=".length));
      if (packageName) packages.push(packageName);
      continue;
    }
    if (argument.startsWith("-")) continue;
    const packageName = normalizeNpmPackageName(argument);
    if (packageName) packages.push(packageName);
    break;
  }
  return packages;
}

function normalizeHttpsEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

/** 目录可能用不同 ID 返回同一服务；以安装目标去重，保留后续条目中的其他独立选项。 */
function deduplicateMcpRegistryEntries(
  entries: readonly McpRegistryMarketplaceEntry[],
): McpRegistryMarketplaceEntry[] {
  const seenPackages = new Set<string>();
  const seenEndpoints = new Set<string>();

  return entries.flatMap((entry) => {
    const options = entry.options.filter((option) => {
      if (option.kind === "remote") {
        const endpoint = option.url ? normalizeHttpsEndpoint(option.url) : undefined;
        if (!endpoint) return true;
        if (seenEndpoints.has(endpoint)) return false;
        seenEndpoints.add(endpoint);
        return true;
      }

      const command = option.command?.toLowerCase();
      if (command !== "npx" && command !== "uvx" && command !== "docker") return true;
      // Registry-парсер добавляет npm identifier последним аргументом для каждого поддерживаемого runner.
      const packageName = normalizeNpmPackageName(option.args?.at(-1) ?? "");
      if (!packageName) return true;
      if (seenPackages.has(packageName)) return false;
      seenPackages.add(packageName);
      return true;
    });

    return options.length > 0 ? [{ ...entry, options }] : [];
  });
}

/** Hide Registry install variants already represented by a reviewed preset or saved MCP config. */
export function removeReviewedMcpPresetDuplicates(
  entries: readonly McpRegistryMarketplaceEntry[],
  presets: readonly CommunityMcpPreset[],
  configuredServers: readonly McpServerConfig[] = [],
): McpRegistryMarketplaceEntry[] {
  const reviewedPackages = new Set<string>(
    presets.flatMap((preset) => {
      if (preset.kind !== "stdio") return [];
      const packageName = normalizeNpmPackageName(preset.packageName);
      return packageName ? [packageName] : [];
    }),
  );
  for (const server of configuredServers) {
    if (server.command?.toLowerCase() !== "npx") continue;
    for (const packageName of getNpxPackageNames(server.args)) reviewedPackages.add(packageName);
  }
  const reviewedEndpoints = new Set<string>(
    presets.flatMap((preset) => {
      if (preset.kind !== "hosted") return [];
      const endpoint = normalizeHttpsEndpoint(preset.url);
      return endpoint ? [endpoint] : [];
    }),
  );
  for (const server of configuredServers) {
    const endpoint = server.url ? normalizeHttpsEndpoint(server.url) : undefined;
    if (endpoint) reviewedEndpoints.add(endpoint);
  }

  const filteredEntries = entries.flatMap((entry) => {
    const options = entry.options.filter((option) => {
      if (option.kind === "remote") {
        const endpoint = option.url ? normalizeHttpsEndpoint(option.url) : undefined;
        return !endpoint || !reviewedEndpoints.has(endpoint);
      }
      if (option.command?.toLowerCase() !== "npx") return true;
      const packageNames = getNpxPackageNames(option.args);
      return !packageNames.some((packageName) => reviewedPackages.has(packageName));
    });
    return options.length > 0 ? [{ ...entry, options }] : [];
  });

  return deduplicateMcpRegistryEntries(filteredEntries);
}

/** Remove reviewed presets already installed in the active settings scope from Add suggestions. */
export function filterUninstalledMcpPresets(
  presets: readonly CommunityMcpPreset[],
  installedPresetIds: ReadonlySet<string>,
): CommunityMcpPreset[] {
  return presets.filter((preset) => !installedPresetIds.has(preset.id));
}

/** Hide an external Cline alias when its reviewed local preset is already shown for this query. */
export function filterReviewedClinePresetDuplicates(
  entries: readonly ClineMcpMarketplaceEntry[],
  visiblePresets: readonly CommunityMcpPreset[],
): ClineMcpMarketplaceEntry[] {
  const visiblePresetIds = new Set(visiblePresets.map((preset) => preset.id));
  return entries.filter(
    (entry) => !entry.localPresetId || !visiblePresetIds.has(entry.localPresetId),
  );
}

interface McpCatalogViewEntry {
  item: McpCatalogEntryLike;
  /** 当前展示顺序中的排名，从 1 开始。 */
  rank: number;
  badges: CatalogBadge[];
  /** Number of registry entries hidden behind this capability family. */
  similarCount?: number;
}


/**
 * Capability family for the registry list. Different marketplace/registry entries may
 * implement the same function (five filesystem servers, several playwright servers).
 * We keep one best entry per family and expose the rest behind "show similar".
 */
const MCP_FAMILY_KEYWORDS = [
  "filesystem",
  "playwright",
  "puppeteer",
  "browser",
  "github",
  "gitlab",
  "git",
  "postgresql",
  "postgres",
  "sqlite",
  "mysql",
  "mongodb",
  "redis",
  "memory",
  "slack",
  "notion",
  "linear",
  "jira",
  "docker",
  "kubernetes",
  "aws",
  "gcp",
  "azure",
  "fetch",
  "search",
  "database",
  "sql",
  "email",
  "calendar",
  "drive",
  "sheets",
  "docs",
  "pdf",
  "shell",
  "terminal",
  "weather",
  "news",
  "files",
  "file",
] as const;
const MCP_FAMILY_GENERIC_TOKENS = new Set([
  "mcp",
  "server",
  "servers",
  "srv",
  "api",
  "io",
  "github",
  "com",
  "org",
  "net",
  "official",
  "plugin",
  "plugins",
  "tool",
  "tools",
  "the",
  "ai",
]);

export function mcpCapabilityFamily(name: string): string {
  const raw = name.trim().toLowerCase();
  const tail = raw.slice(raw.lastIndexOf("/") + 1);
  const tokens = tail
    .replace(/[^a-z0-9]+/gu, "-")
    .split("-")
    .filter(Boolean)
    .filter((token) => !MCP_FAMILY_GENERIC_TOKENS.has(token));
  for (const keyword of MCP_FAMILY_KEYWORDS) {
    if (tokens.includes(keyword) || tail.includes(keyword)) return keyword;
  }
  return tokens.join("-") || tail;
}

function pickBestFamilyEntry(entries: readonly McpCatalogEntryLike[]): McpCatalogEntryLike {
  return entries.reduce((best, candidate) => {
    const bestRank = best.curatedRank;
    const candidateRank = candidate.curatedRank;
    if (bestRank !== undefined && candidateRank === undefined) return best;
    if (bestRank === undefined && candidateRank !== undefined) return candidate;
    if (bestRank !== undefined && candidateRank !== undefined) {
      return candidateRank < bestRank ? candidate : best;
    }
    return best;
  });
}

interface McpCatalogViewInput {
  entries: readonly McpRegistryMarketplaceEntry[];
  tab: McpCatalogTab;
  sort: McpCatalogSortMode;
  filter: string;
  /** An explicit Registry search must not be hidden by the curated-only tab. */
  searchResults?: boolean;
  /** Show every registry entry instead of one per capability family. */
  showSimilar?: boolean;
  now?: Date;
}

/**
 * 单一派生入口：普通浏览时 Popular 仅精选；显式搜索使用 Registry 返回集合，随后排序、排名与徽章。
 *
 * `recommended` 使用共享比较器：curated rank 升序，未收录条目排在其后，再按 name；
 * `name` 按 localeCompare。排名基于当前可见列表，因此筛选/排序后仍然连续。
 */
export function buildMcpCatalogView(input: McpCatalogViewInput): McpCatalogViewEntry[] {
  const ranked = withMcpCuratedRank(input.entries);
  const visible = ranked
    .filter(
      (entry) => input.searchResults || input.tab === "all" || entry.curatedRank !== undefined,
    )
    .filter((entry) => matchesMcpCatalogQuery(entry, input.filter))
    .slice()
    .sort((left, right) => compareCatalogEntries(left, right, input.sort));

  if (input.showSimilar) {
    return visible.map((item, index) => ({
      item,
      rank: index + 1,
      badges: mcpCatalogBadges(item, input.now),
    }));
  }

  const groups = new Map<string, McpCatalogEntryLike[]>();
  for (const entry of visible) {
    const family = mcpCapabilityFamily(entry.name);
    const group = groups.get(family);
    if (group) group.push(entry);
    else groups.set(family, [entry]);
  }
  const order = new Map(visible.map((entry, index) => [entry.id, index]));
  const selected = [...groups.values()].map((group) => ({
    item: pickBestFamilyEntry(group),
    similarCount: group.length - 1,
  }));
  selected.sort(
    (left, right) => (order.get(left.item.id) ?? 0) - (order.get(right.item.id) ?? 0),
  );
  return selected.map(({ item, similarCount }, index) => ({
    item,
    rank: index + 1,
    badges: mcpCatalogBadges(item, input.now),
    ...(similarCount > 0 ? { similarCount } : {}),
  }));
}
