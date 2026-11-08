import { describe, expect, it } from "vitest";
import {
  compareCatalogEntries,
  SKILLS_POPULAR_MIN_INSTALLS,
  skillsBadges,
  type MarketplaceSkillInfo,
} from "@zcode/shared";
import {
  buildCatalogView,
  CATALOG_TABS,
  matchesCatalogQuery,
} from "../src/settings/skillsMarketplaceCatalogView.js";

function entry(
  overrides: Partial<MarketplaceSkillInfo> & Pick<MarketplaceSkillInfo, "name">,
): MarketplaceSkillInfo {
  return {
    skillId: overrides.skillId ?? overrides.name,
    source: overrides.source ?? "community/repo",
    installs: overrides.installs ?? 0,
    installed: overrides.installed ?? false,
    ...overrides,
  };
}

const catalog: MarketplaceSkillInfo[] = [
  entry({ name: "middle-skill", source: "community/repo", installs: 5_000 }),
  entry({
    name: "top-skill",
    source: "vercel-labs/agent-skills",
    installs: 900_000,
  }),
  entry({ name: "low-skill", source: "someone/handbook", installs: 12 }),
  entry({
    name: "popular-skill",
    source: "community/repo",
    installs: SKILLS_POPULAR_MIN_INSTALLS,
  }),
];

describe("skills marketplace catalog view", () => {
  it("sorts the default view by real installs descending with contiguous ranks", () => {
    const view = buildCatalogView({
      items: catalog,
      tab: "allTime",
      sort: "recommended",
      filter: "",
    });
    expect(view.map((item) => item.item.name)).toEqual([
      "top-skill",
      "middle-skill",
      "popular-skill",
      "low-skill",
    ]);
    expect(view.map((item) => item.rank)).toEqual([1, 2, 3, 4]);
    // 展示的 installs 是 API 原值，不做任何放大或补齐。
    expect(view[0]?.item.installs).toBe(900_000);
    expect(view[3]?.item.installs).toBe(12);
  });

  it("keeps installs and name sort modes deterministic", () => {
    const byName = buildCatalogView({
      items: catalog,
      tab: "allTime",
      sort: "name",
      filter: "",
    });
    expect(byName.map((item) => item.item.name)).toEqual([
      "low-skill",
      "middle-skill",
      "popular-skill",
      "top-skill",
    ]);
    const byInstalls = buildCatalogView({
      items: catalog,
      tab: "allTime",
      sort: "installs",
      filter: "",
    });
    expect(byInstalls[0]?.item.name).toBe("top-skill");
    expect(compareCatalogEntries(catalog[0]!, catalog[1]!, "installs")).toBeGreaterThan(0);
  });

  it("only exposes All Time and Popular tabs and derives badges from real fields", () => {
    expect(CATALOG_TABS).toEqual(["allTime", "popular"]);
    expect(CATALOG_TABS).not.toContain("trending");

    // 共享契约接收 publisher/installs；UI 的 source 字段在视图模型里映射为 publisher。
    expect(skillsBadges({ publisher: "vercel-labs/agent-skills", installs: 1 })).toEqual([
      "official",
    ]);
    expect(skillsBadges({ installs: SKILLS_POPULAR_MIN_INSTALLS })).toEqual(["popular"]);
    // 搜索 API 没有发布日期，因此不存在 New 徽章。
    expect(skillsBadges({ installs: 1 })).toEqual([]);
    // 目录行实际产出的徽章也只来自真实字段。
    const view = buildCatalogView({
      items: catalog,
      tab: "allTime",
      sort: "installs",
      filter: "",
    });
    expect(view.find((item) => item.item.name === "top-skill")?.badges).toEqual([
      "official",
      "popular",
    ]);
    expect(view.find((item) => item.item.name === "low-skill")?.badges).toEqual([]);
  });

  it("filters the catalog case-insensitively and preserves installed state", () => {
    const installed = entry({
      name: "Installed-Skill",
      source: "vercel-labs/agent-skills",
      installs: 900_000,
      installed: true,
    });
    const view = buildCatalogView({
      items: [...catalog, installed],
      tab: "allTime",
      sort: "recommended",
      filter: "INSTALLED-SKILL",
    });
    expect(view).toHaveLength(1);
    expect(view[0]?.item.installed).toBe(true);
    expect(matchesCatalogQuery(installed, "agent-skills")).toBe(true);
    expect(matchesCatalogQuery(installed, "missing")).toBe(false);
  });

  it("Popular tab filters by the real installs threshold", () => {
    const view = buildCatalogView({
      items: catalog,
      tab: "popular",
      sort: "installs",
      filter: "",
    });
    expect(view.map((item) => item.item.name)).toEqual([
      "top-skill",
      "middle-skill",
      "popular-skill",
    ]);
    expect(view.every((item) => item.item.installs >= SKILLS_POPULAR_MIN_INSTALLS)).toBe(true);
  });

  it("keeps explicit search results even when installs are below the Popular threshold", () => {
    const lowInstallMatch = entry({
      name: "yandex-wordstat",
      source: "community/seo-skills",
      installs: 309,
    });
    const view = buildCatalogView({
      items: [lowInstallMatch],
      tab: "popular",
      sort: "recommended",
      filter: "",
      searchResults: true,
    });

    expect(view.map((item) => item.item.name)).toEqual(["yandex-wordstat"]);
  });
});
