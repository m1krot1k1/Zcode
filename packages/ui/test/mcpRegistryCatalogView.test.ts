import { describe, expect, it } from "vitest";
import type { McpRegistryMarketplaceEntry } from "@zcode/shared";
import { buildMcpCatalogView } from "../src/settings/mcpRegistryCatalogView.js";

const nonCurated: McpRegistryMarketplaceEntry = {
  id: "io.example/yandex-wordstat",
  name: "io.example/yandex-wordstat",
  description: "Search volume research",
  version: "1.0.0",
  options: [
    {
      kind: "stdio",
      command: "npx",
      args: ["-y", "@example/yandex-wordstat"],
      requiresAuth: false,
    },
  ],
};

describe("MCP registry catalog view", () => {
  it("keeps explicit search results outside the curated Popular shortlist", () => {
    const view = buildMcpCatalogView({
      entries: [nonCurated],
      tab: "popular",
      sort: "recommended",
      filter: "",
      searchResults: true,
    });

    expect(view.map((entry) => entry.item.name)).toEqual([nonCurated.name]);
  });

  it("keeps curated browsing limited to the editorial shortlist", () => {
    const view = buildMcpCatalogView({
      entries: [nonCurated],
      tab: "popular",
      sort: "recommended",
      filter: "",
    });

    expect(view).toEqual([]);
  });
});
