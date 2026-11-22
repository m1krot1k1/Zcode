import { describe, expect, it } from "vitest";
import {
  MCP_CURATED_SERVERS,
  OFFICIAL_PUBLISHERS,
  SKILLS_POPULAR_MIN_INSTALLS,
  compareCatalogEntries,
  getMcpCuratedRank,
  getPluginCuratedRank,
  isNewPublishedAt,
  isOfficialPublisher,
  skillsBadges,
  type CatalogEntryLike,
} from "../src/catalog/index.js";

const NOW = new Date("2026-11-07T00:00:00.000Z");
const names = (entries: readonly CatalogEntryLike[]) => entries.map((entry) => entry.name);

describe("catalog contract constants", () => {
  it("keeps the popular threshold and official publisher allow-list stable", () => {
    expect(SKILLS_POPULAR_MIN_INSTALLS).toBe(1000);
    expect(OFFICIAL_PUBLISHERS).toContain("anthropics");
    expect(OFFICIAL_PUBLISHERS).toContain("vercel");
    expect(MCP_CURATED_SERVERS[0]).toBe("sequential-thinking");
  });
});

describe("isOfficialPublisher", () => {
  it("matches bare owners case-insensitively with surrounding whitespace", () => {
    expect(isOfficialPublisher(" Anthropics ")).toBe(true);
    expect(isOfficialPublisher("VERCEL-LABS")).toBe(true);
  });

  it("matches the owner segment after a slash or in a repository URL", () => {
    expect(isOfficialPublisher("anthropics/skills")).toBe(true);
    expect(isOfficialPublisher("https://github.com/google-labs-code/skills")).toBe(true);
  });

  it("rejects unknown, empty and non-string publishers", () => {
    expect(isOfficialPublisher("some-random-user")).toBe(false);
    expect(isOfficialPublisher("")).toBe(false);
    expect(isOfficialPublisher(undefined)).toBe(false);
    expect(isOfficialPublisher(null)).toBe(false);
  });
});

describe("getMcpCuratedRank", () => {
  it("returns the curated index for canonical names", () => {
    expect(getMcpCuratedRank("sequential-thinking")).toBe(0);
    expect(getMcpCuratedRank("  GitHub ")).toBe(2);
  });

  it("normalizes registry names with reverse-DNS prefixes and path segments", () => {
    expect(getMcpCuratedRank("io.github.modelcontextprotocol/server-sequential-thinking")).toBe(0);
    expect(getMcpCuratedRank("io.github.upstash/context7-mcp")).toBe(3);
    expect(getMcpCuratedRank("@modelcontextprotocol/server-filesystem")).toBe(1);
    expect(getMcpCuratedRank("mcp-server-github")).toBe(2);
    expect(getMcpCuratedRank("filesystem/")).toBe(1);
  });

  it("returns undefined for uncurated or empty names", () => {
    expect(getMcpCuratedRank("some-third-party-server")).toBeUndefined();
    expect(getMcpCuratedRank("")).toBeUndefined();
  });
});

describe("getPluginCuratedRank", () => {
  it("derives the curated rank from official plugin ids, names and paths", () => {
    expect(getPluginCuratedRank("pdf@zcode-plugins-official")).toBe(0);
    expect(getPluginCuratedRank("PDF")).toBe(0);
    expect(getPluginCuratedRank("zcode/official-plugin/documents")).toBe(3);
  });

  it("returns undefined for plugins outside the curated list", () => {
    expect(getPluginCuratedRank("unknown-plugin@zcode-plugins-official")).toBeUndefined();
    expect(getPluginCuratedRank("")).toBeUndefined();
  });
});

describe("compareCatalogEntries", () => {
  const entries: CatalogEntryLike[] = [
    { name: "b-unranked-many", installs: 5000 },
    { name: "a-unranked-few", installs: 10 },
    { name: "d-ranked-2", installs: 200, curatedRank: 1 },
    { name: "c-ranked-1", curatedRank: 0 },
    { name: "e-unranked-none" },
  ];

  it("recommended: curated rank asc, unranked last, then installs desc, then name", () => {
    expect(names([...entries].sort((a, b) => compareCatalogEntries(a, b, "recommended")))).toEqual([
      "c-ranked-1",
      "d-ranked-2",
      "b-unranked-many",
      "a-unranked-few",
      "e-unranked-none",
    ]);
  });

  it("installs: installs desc, missing last, then name", () => {
    expect(names([...entries].sort((a, b) => compareCatalogEntries(a, b, "installs")))).toEqual([
      "b-unranked-many",
      "d-ranked-2",
      "a-unranked-few",
      "c-ranked-1",
      "e-unranked-none",
    ]);
  });

  it("newest: publishedAt desc, missing or unparseable last, then name", () => {
    const dated: CatalogEntryLike[] = [
      { name: "old", publishedAt: "2026-01-01T00:00:00Z" },
      { name: "new", publishedAt: "2026-11-01T00:00:00Z" },
      { name: "invalid", publishedAt: "not-a-date" },
      { name: "missing" },
    ];
    expect(names([...dated].sort((a, b) => compareCatalogEntries(a, b, "newest")))).toEqual([
      "new",
      "old",
      "invalid",
      "missing",
    ]);
  });

  it("name: localeCompare", () => {
    expect(
      names(
        [...entries].sort((a, b) => compareCatalogEntries(a, b, "name")),
      ),
    ).toEqual(["a-unranked-few", "b-unranked-many", "c-ranked-1", "d-ranked-2", "e-unranked-none"]);
  });

  it("never treats a missing metric as zero", () => {
    const missing: CatalogEntryLike = { name: "a" };
    const zero: CatalogEntryLike = { name: "b", installs: 0 };
    expect(compareCatalogEntries(missing, zero, "installs")).toBeGreaterThan(0);
    expect(compareCatalogEntries(missing, zero, "recommended")).toBeGreaterThan(0);
  });
});

describe("isNewPublishedAt", () => {
  it("accepts a real ISO timestamp inside the window", () => {
    expect(isNewPublishedAt("2026-10-20T00:00:00.000Z", 30, NOW)).toBe(true);
    expect(isNewPublishedAt("2026-10-08", 30, NOW)).toBe(true);
  });

  it("rejects timestamps outside the window or in the future", () => {
    expect(isNewPublishedAt("2026-09-01T00:00:00.000Z", 30, NOW)).toBe(false);
    expect(isNewPublishedAt("2026-12-01T00:00:00.000Z", 30, NOW)).toBe(false);
  });

  it("rejects missing, non-ISO and malformed dates", () => {
    expect(isNewPublishedAt(undefined, 30, NOW)).toBe(false);
    expect(isNewPublishedAt(null, 30, NOW)).toBe(false);
    expect(isNewPublishedAt("", 30, NOW)).toBe(false);
    expect(isNewPublishedAt("March 1, 2026", 30, NOW)).toBe(false);
    expect(isNewPublishedAt("2026-13-45", 30, NOW)).toBe(false);
  });
});

describe("skillsBadges", () => {
  it("adds official and popular with real values", () => {
    expect(
      skillsBadges({ publisher: "vercel-labs", installs: SKILLS_POPULAR_MIN_INSTALLS, now: NOW }),
    ).toEqual(["official", "popular"]);
  });

  it("does not add popular for missing, NaN or below-threshold installs", () => {
    expect(skillsBadges({ installs: undefined, now: NOW })).toEqual([]);
    expect(skillsBadges({ installs: Number.NaN, now: NOW })).toEqual([]);
    expect(skillsBadges({ installs: SKILLS_POPULAR_MIN_INSTALLS - 1, now: NOW })).toEqual([]);
  });

  it("adds new only with a proven recent publication date", () => {
    expect(skillsBadges({ publishedAt: "2026-11-01T00:00:00Z", now: NOW })).toEqual(["new"]);
    expect(skillsBadges({ publishedAt: "2025-01-01T00:00:00Z", now: NOW })).toEqual([]);
    expect(skillsBadges({ publishedAt: "unknown", now: NOW })).toEqual([]);
  });

  it("keeps a stable badge order", () => {
    expect(
      skillsBadges({
        publisher: "anthropics",
        installs: 25_000,
        publishedAt: "2026-11-05",
        now: NOW,
      }),
    ).toEqual(["official", "popular", "new"]);
  });
});
