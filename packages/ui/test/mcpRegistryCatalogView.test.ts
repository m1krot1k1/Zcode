import { describe, expect, it } from "vitest";
import {
  COMMUNITY_MCP_PRESETS,
  type McpServerConfig,
  type McpRegistryMarketplaceEntry,
} from "@zcode/shared";
import {
  buildMcpCatalogView,
  filterReviewedClinePresetDuplicates,
  filterUninstalledMcpPresets,
  mcpCapabilityFamily,
  removeReviewedMcpPresetDuplicates,
} from "../src/settings/mcpRegistryCatalogView.js";

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

  it("removes an official npm variant when a reviewed local preset uses the same package", () => {
    const duplicate: McpRegistryMarketplaceEntry = {
      id: "io.example/context7-copy",
      name: "io.example/context7-copy",
      options: [
        {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp@9.9.9"],
          requiresAuth: false,
        },
      ],
    };
    const alternative: McpRegistryMarketplaceEntry = {
      ...nonCurated,
      id: "io.example/filesystem-alternative",
      name: "io.example/filesystem-alternative",
      options: [
        {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@example/filesystem-mcp@1.0.0"],
          requiresAuth: false,
        },
      ],
    };

    expect(
      removeReviewedMcpPresetDuplicates([duplicate, alternative], COMMUNITY_MCP_PRESETS).map(
        (entry) => entry.id,
      ),
    ).toEqual([alternative.id]);
  });

  it("removes exact npm and endpoint duplicates already configured in the current scope", () => {
    const installedPackageDuplicate: McpRegistryMarketplaceEntry = {
      id: "io.example/filesystem-installed-copy",
      name: "io.example/filesystem-installed-copy",
      options: [
        {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@agent-infra/mcp-server-filesystem@3.2.1"],
          requiresAuth: false,
        },
      ],
    };
    const installedEndpointDuplicate: McpRegistryMarketplaceEntry = {
      id: "io.example/webflow-hosted-copy",
      name: "io.example/webflow-hosted-copy",
      options: [
        {
          kind: "remote",
          url: "https://mcp.example.com/webflow/",
          requiresAuth: true,
        },
      ],
    };
    const alternative: McpRegistryMarketplaceEntry = {
      ...nonCurated,
      id: "io.example/filesystem-alternative",
      name: "io.example/filesystem-alternative",
      options: [
        {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@example/filesystem-mcp@1.0.0"],
          requiresAuth: false,
        },
      ],
    };
    const configuredServers: McpServerConfig[] = [
      { type: "stdio", command: "npx", args: ["-y", "@agent-infra/mcp-server-filesystem@latest"] },
      { type: "http", url: "https://mcp.example.com/webflow" },
    ];

    expect(
      removeReviewedMcpPresetDuplicates(
        [installedPackageDuplicate, installedEndpointDuplicate, alternative],
        [],
        configuredServers,
      ).map((entry) => entry.id),
    ).toEqual([alternative.id]);
  });

  it("deduplicates Registry entries by package and normalized endpoint, not by entry ID", () => {
    const first: McpRegistryMarketplaceEntry = {
      id: "io.example/filesystem-one",
      name: "Filesystem server one",
      options: [
        {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@example/filesystem-mcp@1.0.0"],
          requiresAuth: false,
        },
        {
          kind: "remote",
          url: "https://mcp.example.com/filesystem/",
          requiresAuth: false,
        },
      ],
    };
    const second: McpRegistryMarketplaceEntry = {
      id: "io.other/filesystem-two",
      name: "Filesystem server two",
      options: [
        {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@example/filesystem-mcp@2.0.0"],
          requiresAuth: false,
        },
        {
          kind: "remote",
          url: "https://mcp.example.com/filesystem#registry-alias",
          requiresAuth: false,
        },
        {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@example/other-server@1.0.0"],
          requiresAuth: false,
        },
      ],
    };

    const visible = removeReviewedMcpPresetDuplicates([first, second], []);

    expect(visible.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(visible[1]?.options).toEqual([second.options[2]]);
  });

  it("keeps a preset out of Add suggestions after it is configured in the current scope", () => {
    const context7 = COMMUNITY_MCP_PRESETS.find((preset) => preset.id === "context7");
    if (!context7) throw new Error("Context7 preset is missing");

    expect(filterUninstalledMcpPresets([context7], new Set(["context7"]))).toEqual([]);
    expect(filterUninstalledMcpPresets([context7], new Set())).toEqual([context7]);
  });

  it("hides a Cline alias only while its reviewed preset is visible", () => {
    const alias = {
      id: "cline-context7",
      name: "Context7",
      tags: [],
      localPresetId: "context7",
    };
    const unknown = { id: "cline-unknown", name: "Unknown", tags: [] };
    const context7 = COMMUNITY_MCP_PRESETS.find((preset) => preset.id === "context7");
    if (!context7) throw new Error("Context7 preset is missing");

    expect(filterReviewedClinePresetDuplicates([alias, unknown], [context7])).toEqual([unknown]);
    expect(filterReviewedClinePresetDuplicates([alias, unknown], [])).toEqual([alias, unknown]);
  });

  it("collapses servers with the same capability family and exposes the hidden count", () => {
    const filesystemA: McpRegistryMarketplaceEntry = {
      ...nonCurated,
      id: "io.a/mcp-server-filesystem",
      name: "io.a/mcp-server-filesystem",
    };
    const filesystemB: McpRegistryMarketplaceEntry = {
      ...nonCurated,
      id: "io.b/filesystem-mcp",
      name: "io.b/filesystem-mcp",
    };
    const github: McpRegistryMarketplaceEntry = {
      ...nonCurated,
      id: "io.c/server-github",
      name: "io.c/server-github",
    };

    expect(mcpCapabilityFamily(filesystemA.name)).toBe("filesystem");
    expect(mcpCapabilityFamily(filesystemB.name)).toBe("filesystem");
    expect(mcpCapabilityFamily(github.name)).toBe("github");

    const collapsed = buildMcpCatalogView({
      entries: [filesystemA, filesystemB, github],
      tab: "all",
      sort: "name",
      filter: "",
    });
    expect(collapsed.map((entry) => entry.item.id)).toEqual([filesystemA.id, github.id]);
    expect(collapsed[0]?.similarCount).toBe(1);

    const expanded = buildMcpCatalogView({
      entries: [filesystemA, filesystemB, github],
      tab: "all",
      sort: "name",
      filter: "",
      showSimilar: true,
    });
    expect(expanded).toHaveLength(3);
  });
});
