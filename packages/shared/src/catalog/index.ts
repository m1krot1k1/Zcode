/**
 * Shared catalog/leaderboard contract for Skills, MCP servers and Plugins.
 *
 * Data provenance (must stay in sync with the UI surfaces that consume this module):
 * - Skills: install counts come from the skills.sh API. They are measured values and may be
 *   missing; a missing count must never be rendered as `0`.
 * - MCP: the Official MCP Registry (https://registry.modelcontextprotocol.io) publishes server
 *   metadata but no install counts, so ordering is **curated** — editorial ordering chosen by
 *   the product team, *not* measured installs.
 * - Plugins: marketplace manifests (ZCode official + Claude official marketplaces) also expose no
 *   install counts, so ordering is **curated** for the same reason.
 *
 * Fabricating metrics (invented installs, download counts, stars or trend values) is forbidden on
 * every surface that uses this contract.
 */

/** Badge shown on a catalog card. `featured`, `community` and `curated` are rendered by the MCP/plugin surfaces. */
export type CatalogBadge = "official" | "popular" | "new" | "featured" | "community" | "curated";

/** Sort modes shared by every catalog surface. `recommended` is the default. */
export type CatalogSortMode = "recommended" | "installs" | "name" | "newest";

/** Minimal shape the shared comparators need; UI-specific entry types structurally satisfy it. */
export interface CatalogEntryLike {
  name: string;
  installs?: number;
  publishedAt?: string;
  curatedRank?: number;
}

/**
 * Minimum skills.sh install count for the `popular` (Pop) badge.
 *
 * This is a display threshold, not a ranking signal: it only decides whether the badge appears.
 * Real skills.sh counts vary by several orders of magnitude, so 1000 separates "used by a real
 * audience" from long-tail entries without making the badge universal.
 */
export const SKILLS_POPULAR_MIN_INSTALLS = 1000;

/**
 * Publishers whose Skills/Plugins entries are treated as official.
 *
 * Editorial allow-list of GitHub owners; keep it short and verified against the marketplace
 * sources. Matching is case-insensitive and accepts `owner`, `owner/repo` and GitHub URLs.
 */
export const OFFICIAL_PUBLISHERS: readonly string[] = [
  "vercel-labs",
  "anthropics",
  "google",
  "google-labs-code",
  "vercel",
];

/**
 * Curated popularity order for well-known MCP servers.
 *
 * The Official MCP Registry has no install counts, so this order is **editorial**: it reflects
 * how commonly these servers are recommended, not measured usage. Do not present it as installs.
 */
export const MCP_CURATED_SERVERS: readonly string[] = [
  "sequential-thinking",
  "filesystem",
  "github",
  "context7",
  "playwright",
  "chrome-devtools",
  "memory",
  "fetch",
  "git",
  "time",
  "sentry",
  "notion",
  "slack",
  "postgres",
  "sqlite",
];

/**
 * Curated plugin order derived from the official plugin definitions in this repo.
 *
 * Source of truth for membership: `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` and
 * `DOCUMENT_PLUGIN_RANKS` in `packages/shared/src/plugin-marketplaces.ts` /
 * `packages/shared/src/pluginStoreOrdering.ts` (documents first, then the remaining built-ins).
 * Marketplaces expose no install counts, so this order is **editorial ordering, not installs**.
 */
const PLUGIN_CURATED_NAMES: readonly string[] = [
  "pdf",
  "presentations",
  "spreadsheets",
  "documents",
  "browser-use",
  "image-search",
  "zcode-guide",
  "skill-creator",
  "plugin-creator",
  "visualize",
];

const PLUGIN_CURATED_RANKS = new Map(
  PLUGIN_CURATED_NAMES.map((name, index) => [name, index] as const),
);

/** Hosts that may appear in front of an owner segment in a publisher string. */
const PUBLISHER_HOSTS = new Set(["github.com", "www.github.com", "gitlab.com", "www.gitlab.com"]);

/**
 * Reverse-DNS / package prefixes stripped from MCP server names before matching the curated list.
 * Applied repeatedly, so `io.github.foo/...` and `mcp-server-*` both normalize.
 */
const MCP_NAME_PREFIXES: readonly string[] = [
  "io.github.",
  "com.github.",
  "io.gitlab.",
  "io.modelcontextprotocol.",
  "modelcontextprotocol.",
  "mcp-server-",
  "server-",
  "mcp-",
];

/** Common suffixes in registry names (`context7-mcp`, `github-server`) stripped before matching. */
const MCP_NAME_SUFFIXES: readonly string[] = ["-mcp-server", "-mcp", "-server"];

/** ISO-8601 prefix check: `Date.parse` alone happily accepts non-ISO prose dates. */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

/**
 * True when `publisher` names one of {@link OFFICIAL_PUBLISHERS}.
 *
 * Accepts `owner`, `@owner`, `owner/repo`, `owner/repo/sub` and GitHub/GitLab URLs.
 */
export function isOfficialPublisher(publisher?: string | null): boolean {
  const normalized = normalizePublisher(publisher);
  return normalized !== undefined && OFFICIAL_PUBLISHERS.includes(normalized);
}

/**
 * Returns the curated index (0 = top) of an MCP server, or `undefined` when the server is not on
 * the curated list.
 *
 * Normalization: lowercase, trim, take the segment after the last `/`, strip reverse-DNS and
 * `mcp-server-`/`server-` prefixes, strip `-mcp`/`-server` suffixes, and treat `_` as `-`.
 */
export function getMcpCuratedRank(name: string): number | undefined {
  const normalized = normalizeMcpServerName(name);
  if (!normalized) return undefined;
  const index = MCP_CURATED_SERVERS.indexOf(normalized);
  return index >= 0 ? index : undefined;
}

/**
 * Returns the curated index (0 = top) of a plugin, or `undefined` when the plugin is not curated.
 *
 * Accepts a plugin id (`pdf@zcode-plugins-official`), a bare name (`pdf`) or a path
 * (`zcode/official-plugin/pdf`). Marketplace install counts do not exist, so this rank is
 * editorial ordering only.
 */
export function getPluginCuratedRank(idOrName: string): number | undefined {
  const normalized = normalizePluginName(idOrName);
  if (!normalized) return undefined;
  return PLUGIN_CURATED_RANKS.get(normalized);
}

/**
 * Stable comparator for catalog lists.
 *
 * - `recommended`: curated rank ascending (unranked last), then installs descending, then name.
 * - `installs`: installs descending (missing last), then name.
 * - `newest`: publish date descending (missing/unparseable last), then name.
 * - `name`: `localeCompare`.
 *
 * Missing values are always ordered last and never coerced to `0`, so a missing metric cannot
 * masquerade as a real one.
 */
export function compareCatalogEntries(
  a: CatalogEntryLike,
  b: CatalogEntryLike,
  mode: CatalogSortMode,
): number {
  const byName = () => compareNames(a.name, b.name);
  switch (mode) {
    case "installs": {
      const installs = compareOptionalDescending(a.installs, b.installs);
      return installs !== 0 ? installs : byName();
    }
    case "newest": {
      const time = compareOptionalDescending(parseTime(a.publishedAt), parseTime(b.publishedAt));
      return time !== 0 ? time : byName();
    }
    case "name":
      return byName();
    case "recommended":
    default: {
      const rank = compareOptionalAscending(a.curatedRank, b.curatedRank);
      if (rank !== 0) return rank;
      const installs = compareOptionalDescending(a.installs, b.installs);
      return installs !== 0 ? installs : byName();
    }
  }
}

/**
 * True only for a real, parseable ISO-8601 timestamp inside the `days` window ending at `now`.
 *
 * Missing, malformed, non-ISO and future timestamps all return `false`: the `new` badge must be
 * backed by a genuine publication date.
 */
export function isNewPublishedAt(
  publishedAt?: string | null,
  days = 30,
  now: Date = new Date(),
): boolean {
  const time = parseIsoTime(publishedAt);
  if (time === undefined) return false;
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return false;
  const windowStart = nowTime - Math.max(0, days) * 24 * 60 * 60 * 1000;
  return time >= windowStart && time <= nowTime;
}

/**
 * Badges for a Skills entry.
 *
 * - `official` when the publisher is in {@link OFFICIAL_PUBLISHERS}.
 * - `popular` only when `installs` is an actual finite number at or above
 *   {@link SKILLS_POPULAR_MIN_INSTALLS}.
 * - `new` only when {@link isNewPublishedAt} proves the date.
 *
 * `featured`, `community` and `curated` are intentionally not produced here; they belong to the
 * MCP/plugin surfaces and their own editorial configuration.
 */
export function skillsBadges(input: {
  installs?: number;
  publisher?: string | null;
  publishedAt?: string | null;
  now?: Date;
}): CatalogBadge[] {
  const badges: CatalogBadge[] = [];
  if (isOfficialPublisher(input.publisher)) badges.push("official");
  if (
    typeof input.installs === "number" &&
    Number.isFinite(input.installs) &&
    input.installs >= SKILLS_POPULAR_MIN_INSTALLS
  ) {
    badges.push("popular");
  }
  if (isNewPublishedAt(input.publishedAt, 30, input.now ?? new Date())) badges.push("new");
  return badges;
}

function normalizePublisher(publisher?: string | null): string | undefined {
  if (typeof publisher !== "string") return undefined;
  const raw = publisher.trim().toLowerCase();
  if (!raw) return undefined;
  // URL 形式先取 pathname，避免把协议段（`https:`）误当成 owner。
  let path = raw;
  if (raw.includes("://")) {
    try {
      path = new URL(raw).pathname;
    } catch {
      path = raw;
    }
  }
  const segments = path
    .replace(/^@/, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  let owner: string | undefined = segments[0];
  if (!owner) return undefined;
  if (PUBLISHER_HOSTS.has(owner) || (owner.includes(".") && segments.length > 1)) {
    owner = segments[1];
  }
  if (!owner) return undefined;
  return owner.replace(/^@/, "");
}

function normalizeMcpServerName(name: string): string {
  if (typeof name !== "string") return "";
  let normalized = name.trim().toLowerCase().replace(/_/g, "-").replace(/\/+$/, "");
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  const lastAt = normalized.lastIndexOf("@");
  if (lastSlash >= 0) normalized = normalized.slice(lastSlash + 1);
  else if (lastAt > 0) normalized = normalized.slice(lastAt + 1);
  normalized = normalized.replace(/^@/, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of MCP_NAME_PREFIXES) {
      if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
        normalized = normalized.slice(prefix.length);
        changed = true;
      }
    }
    for (const suffix of MCP_NAME_SUFFIXES) {
      if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
        normalized = normalized.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return normalized;
}

function normalizePluginName(idOrName: string): string {
  if (typeof idOrName !== "string") return "";
  let normalized = idOrName.trim().toLowerCase().replace(/\/+$/, "");
  if (!normalized) return "";
  // `plugin@marketplace` → `plugin`; keep scoped ids (`@scope/plugin`) intact for the slash split.
  const at = normalized.lastIndexOf("@");
  if (at > 0) normalized = normalized.slice(0, at);
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0) normalized = normalized.slice(slash + 1);
  return normalized.replace(/^@/, "");
}

function parseIsoTime(publishedAt?: string | null): number | undefined {
  if (typeof publishedAt !== "string") return undefined;
  const value = publishedAt.trim();
  if (!value || !ISO_DATE_PREFIX.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function parseTime(publishedAt?: string): number | undefined {
  return parseIsoTime(publishedAt);
}

function compareOptionalAscending(
  left: number | undefined,
  right: number | undefined,
): number {
  const leftValid = typeof left === "number" && Number.isFinite(left);
  const rightValid = typeof right === "number" && Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return left - right;
}

function compareOptionalDescending(
  left: number | undefined,
  right: number | undefined,
): number {
  const leftValid = typeof left === "number" && Number.isFinite(left);
  const rightValid = typeof right === "number" && Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return right - left;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right);
}
