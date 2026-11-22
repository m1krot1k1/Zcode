// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  COMMUNITY_MCP_PRESETS,
  filterCommunityMcpPresets,
  type McpServerConfig,
  type McpRegistryMarketplaceEntry,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  McpRegistryMarketplace,
  resetMcpRegistryCatalogPreloadForTests,
} from "@/settings/McpRegistryMarketplace.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  resetMcpRegistryCatalogPreloadForTests();
});

const sequential: McpRegistryMarketplaceEntry = {
  id: "io.modelcontextprotocol/sequential-thinking",
  name: "io.modelcontextprotocol/sequential-thinking",
  description: "Structured sequential reasoning",
  version: "2025.1.0",
  repositoryUrl: "https://github.com/modelcontextprotocol/servers",
  options: [
    {
      kind: "stdio",
      command: "npx",
      // Keep this search fixture distinct from the bundled preset package; the marketplace
      // intentionally hides exact package duplicates from Registry results.
      args: ["-y", "@example/server-sequential@2025.1.0"],
      requiresAuth: false,
    },
  ],
};

function renderPanel(
  onConfigure = vi.fn(),
  searchImpl: (
    query: string,
  ) => Promise<{ query: string; entries: McpRegistryMarketplaceEntry[] }> = async (query) => ({
    query,
    entries: query.includes("sequential") ? [sequential] : [],
  }),
  configuredServers: readonly McpServerConfig[] = [],
) {
  const searchMarketplace = vi.fn(searchImpl);
  function SearchHarness({
    onConfigure,
  }: {
    onConfigure: ComponentProps<typeof McpRegistryMarketplace>["onConfigure"];
  }) {
    const [query, setQuery] = useState("");
    return (
      <>
        <input
          data-testid="global-mcp-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <McpRegistryMarketplace
          query={query}
          reviewedPresets={filterCommunityMcpPresets(COMMUNITY_MCP_PRESETS, query)}
          configuredServers={configuredServers}
          onConfigure={onConfigure}
        />
      </>
    );
  }
  const view = render(
    <ZCodeIntlProvider initialLocale="en-US">
      <ServiceProvider
        services={{ mcpSyncService: { searchMarketplace } } as unknown as IServiceAccessor}
      >
        <SearchHarness onConfigure={onConfigure} />
      </ServiceProvider>
    </ZCodeIntlProvider>,
  );
  mounted.push(view.unmount);
  return { searchMarketplace, onConfigure };
}

describe("Official MCP Registry panel", () => {
  it("uses the single settings search and shows the Registry npx command", async () => {
    const { searchMarketplace } = renderPanel();

    fireEvent.change(screen.getByTestId("global-mcp-search"), {
      target: { value: "sequential" },
    });

    await screen.findByText("io.modelcontextprotocol/sequential-thinking");
    expect(searchMarketplace).toHaveBeenCalledWith("sequential");
    expect(screen.queryByTestId("mcp-registry-search")).toBeNull();
    expect(
      screen.getByText("npx -y @example/server-sequential@2025.1.0"),
    ).toBeTruthy();
    const configureButton = screen.getByTestId(
      "mcp-registry-configure-io.modelcontextprotocol/sequential-thinking-0",
    );
    expect(configureButton).toBeTruthy();
  });

  it("hands the selected install option to the MCP form", async () => {
    const onConfigure = vi.fn();
    renderPanel(onConfigure);

    fireEvent.change(screen.getByTestId("global-mcp-search"), {
      target: { value: "sequential" },
    });
    await screen.findByText("io.modelcontextprotocol/sequential-thinking");
    fireEvent.click(
      screen.getByTestId("mcp-registry-configure-io.modelcontextprotocol/sequential-thinking-0"),
    );

    expect(onConfigure).toHaveBeenCalledWith(
      expect.objectContaining({ id: sequential.id, name: sequential.name }),
      sequential.options[0],
    );
  });

  it("shows uncurated server results after an explicit search", async () => {
    const uncurated: McpRegistryMarketplaceEntry = {
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
    const { searchMarketplace } = renderPanel(vi.fn(), async (query) => ({
      query,
      entries: query === "yandex" ? [uncurated] : [],
    }));

    fireEvent.change(screen.getByTestId("global-mcp-search"), {
      target: { value: "yandex" },
    });

    await screen.findByText(uncurated.name);
    expect(searchMarketplace).toHaveBeenCalledWith("yandex");
  });

  it("hides an official Registry card already represented by the reviewed local preset", async () => {
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
    const { searchMarketplace } = renderPanel(vi.fn(), async (query) => ({
      query,
      entries: query === "context7" ? [duplicate] : [],
    }));

    fireEvent.change(screen.getByTestId("global-mcp-search"), {
      target: { value: "context7" },
    });
    await waitFor(() => expect(searchMarketplace).toHaveBeenCalledWith("context7"));
    await screen.findByText("No MCP servers match your search");
    expect(screen.queryByTestId("mcp-registry-results")).toBeNull();
  });

  it("hides an exact package already configured in this MCP scope", async () => {
    const installedDuplicate: McpRegistryMarketplaceEntry = {
      id: "io.example/filesystem-copy",
      name: "io.example/filesystem-copy",
      options: [
        {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@agent-infra/mcp-server-filesystem@5.0.0"],
          requiresAuth: false,
        },
      ],
    };
    const searchMarketplace = vi.fn(async (query: string) => ({
      query,
      entries: query === "filesystem" ? [installedDuplicate] : [],
    }));
    renderPanel(vi.fn(), searchMarketplace, [
      {
        type: "stdio",
        command: "npx",
        args: ["-y", "@agent-infra/mcp-server-filesystem@latest"],
      },
    ]);

    fireEvent.change(screen.getByTestId("global-mcp-search"), {
      target: { value: "filesystem" },
    });
    await waitFor(() => expect(searchMarketplace).toHaveBeenCalledWith("filesystem"));
    await screen.findByText("No MCP servers match your search");
    expect(screen.queryByTestId("mcp-registry-results")).toBeNull();
  });

  it("ignores a failed search after the user clears the query", async () => {
    let rejectPendingSearch: ((cause: Error) => void) | undefined;
    const searchMarketplace = vi.fn((query: string) => {
      if (query === "yandex") {
        return new Promise<{ query: string; entries: McpRegistryMarketplaceEntry[] }>(
          (_resolve, reject) => {
            rejectPendingSearch = reject;
          },
        );
      }
      return Promise.resolve({ query, entries: [sequential] });
    });
    renderPanel(vi.fn(), searchMarketplace);
    await screen.findByText(sequential.name);

    fireEvent.change(screen.getByTestId("global-mcp-search"), {
      target: { value: "yandex" },
    });
    await waitFor(() => expect(searchMarketplace).toHaveBeenCalledWith("yandex"));

    fireEvent.change(screen.getByTestId("global-mcp-search"), { target: { value: "" } });
    await act(async () => {
      rejectPendingSearch?.(new Error("stale search failure"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId(`mcp-registry-entry-${sequential.id}`)).toBeTruthy();
  });

  it("shows and retries a failed curated preload instead of caching an empty catalogue", async () => {
    const searchMarketplace = vi.fn(async () => {
      throw new Error("offline");
    });
    renderPanel(vi.fn(), searchMarketplace);

    await screen.findByRole("alert");
    const callsBeforeRetry = searchMarketplace.mock.calls.length;
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button"));

    await waitFor(() => {
      expect(searchMarketplace.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
    await screen.findByRole("alert");
  });
});
