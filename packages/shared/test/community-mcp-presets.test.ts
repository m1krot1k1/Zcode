import { describe, expect, it } from "vitest";
import {
  COMMUNITY_MCP_PRESETS,
  communityMcpPresetConfig,
  filterCommunityMcpPresets,
} from "../src/mcp.js";

describe("community MCP presets", () => {
  it("не вшивает секреты, показывает происхождение и использует пользовательскую авторизацию", () => {
    expect(COMMUNITY_MCP_PRESETS.map((preset) => preset.id)).toEqual([
      "context7",
      "chrome-devtools",
      "playwright",
      "duckduckgo-search",
      "web-fetch",
      "firecrawl",
    ]);
    for (const preset of COMMUNITY_MCP_PRESETS) {
      const config = communityMcpPresetConfig(preset);
      expect(preset.sourceUrl).toMatch(/^https:\/\//u);
      expect(config).toMatchObject({
        type: "stdio",
        command: "npx",
        args: ["-y", `${preset.packageName}${preset.version ? `@${preset.version}` : ""}`],
      });
      expect(config.headers).toBeUndefined();
      expect(config.oauth).toBeUndefined();
      if (preset.authRequirement === "none") {
        expect(config.env).toBeUndefined();
      } else {
        expect(config.env).toEqual({ FIRECRAWL_API_KEY: "" });
        expect(Object.values(config.env ?? {}).every((value) => value === "")).toBe(true);
      }
    }
    expect(COMMUNITY_MCP_PRESETS.find((preset) => preset.id === "firecrawl")?.version).toBe(
      "3.33.0",
    );
  });

  it("фильтрует каталог по имени, идентификатору и пакету", () => {
    expect(filterCommunityMcpPresets(COMMUNITY_MCP_PRESETS, "  FIRECRAWL ")).toEqual([
      expect.objectContaining({ id: "firecrawl" }),
    ]);
    expect(filterCommunityMcpPresets(COMMUNITY_MCP_PRESETS, "@playwright/mcp")).toEqual([
      expect.objectContaining({ id: "playwright" }),
    ]);
    expect(filterCommunityMcpPresets(COMMUNITY_MCP_PRESETS, "not installed")).toEqual([]);
  });
});
