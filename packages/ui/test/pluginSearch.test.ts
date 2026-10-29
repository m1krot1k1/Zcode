import { describe, expect, it } from "vitest";
import type { SkillSummary, ZCodePluginInfo } from "@zcode/shared";
import { storeItemMatches, type StorePluginItem } from "../src/settings/pluginStoreListing.js";
import { filterPluginsByQuery } from "../src/settings/pluginCapabilityProjection.js";
import { groupSkillsByPlugin } from "../src/settings/pluginManagedResourceGroups.js";

describe("plugin name pinyin search", () => {
  const plugin = { id: "lark@official", name: "lark", marketplace: "official" } as ZCodePluginInfo;
  const item: StorePluginItem = {
    ...plugin,
    installed: true,
    restorable: false,
    orphaned: false,
    listing: {
      displayName: "Lark CLI",
      displayNameI18n: { "zh-CN": "飞书 CLI" },
      descriptionI18n: { "zh-CN": "文档协作" },
    },
  };
  const items = new Map([[item.id, item]]);
  for (const locale of ["zh-CN", "en-US"]) {
    it(`matches Chinese names by full pinyin and initials in ${locale}`, () => {
      for (const query of ["feishu", " FEI SHU ", "fs", "飞书", "LARK", "official"]) {
        expect(storeItemMatches(item, query, locale), query).toBe(true);
        expect(filterPluginsByQuery([plugin], query, items, locale), query).toEqual([plugin]);
      }
    });
  }
  it("does not add fuzzy typos, description initials, or cross-market aliases", () => {
    for (const query of ["feisuh", "wdxz", "nonesuch"])
      expect(storeItemMatches(item, query, "zh-CN")).toBe(false);
    const other = { ...plugin, id: "lark@other", marketplace: "other" };
    expect(filterPluginsByQuery([other], "fs", items, "zh-CN")).toEqual([]);
    expect(
      filterPluginsByQuery(
        [plugin],
        "fs",
        new Map([[plugin.id, { ...item, id: other.id }]]),
        "zh-CN",
      ),
    ).toEqual([]);
  });
  it("supports Chinese raw names without listing metadata", () => {
    expect(
      storeItemMatches({ ...item, name: "文档助手", listing: undefined }, "wdzs", "en-US"),
    ).toBe(true);
  });
});

describe("skill search and install acceptance", () => {
  const skill: SkillSummary = {
    body: "",
    description: "check the release notes",
    enabled: true,
    id: "skill-release-checklist",
    name: "release-checklist",
    path: "/home/.zcode/cli/plugins/cache/toolbox/skills/release-checklist/SKILL.md",
    pluginName: "toolbox",
    scope: "plugin",
  };
  const plugin = {
    id: "toolbox@official",
    name: "toolbox",
    marketplace: "official",
    components: [
      {
        kind: "skill",
        items: [{ name: "release-checklist", description: "check the release notes" }],
      },
    ],
  } as ZCodePluginInfo;
  const installed: StorePluginItem = {
    id: plugin.id,
    name: plugin.name,
    marketplace: plugin.marketplace,
    installed: true,
    restorable: false,
    orphaned: false,
    info: plugin,
  };
  const notInstalled: StorePluginItem = {
    id: "toolbox@official",
    name: "toolbox",
    marketplace: "official",
    installed: false,
    restorable: false,
    orphaned: false,
  };

  it("finds a materialized skill in the store and the skills list", () => {
    expect(storeItemMatches(installed, "release-checklist", "en-US")).toBe(true);
    expect(storeItemMatches(installed, "release notes", "en-US")).toBe(true);
    expect(filterPluginsByQuery([plugin], "release-checklist")).toEqual([plugin]);
    expect(groupSkillsByPlugin([skill], "release notes").plugin.map((item) => item.name)).toEqual([
      "release-checklist",
    ]);
  });

  it("does not invent a skill name for a plugin that has no component list", () => {
    expect(storeItemMatches(notInstalled, "release-checklist", "en-US")).toBe(false);
    expect(storeItemMatches(installed, "unrelated", "en-US")).toBe(false);
    expect(groupSkillsByPlugin([skill], "unrelated").plugin).toEqual([]);
  });
});
