import { describe, expect, it } from "vitest";
import {
  COMMUNITY_MCP_PRESETS,
  communityMcpPresetConfig,
} from "../src/mcp.js";

describe("community MCP presets", () => {
  it("не вшивает секреты и ставится через npx", () => {
    expect(COMMUNITY_MCP_PRESETS.map((preset) => preset.id)).toEqual([
      "context7",
      "chrome-devtools",
      "playwright",
      "duckduckgo-search",
      "web-fetch",
    ]);
    for (const preset of COMMUNITY_MCP_PRESETS) {
      const config = communityMcpPresetConfig(preset);
      expect(config).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", preset.packageName],
      });
      expect(config.env).toBeUndefined();
      expect(config.headers).toBeUndefined();
      expect(config.oauth).toBeUndefined();
    }
  });
});
