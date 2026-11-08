// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { McpRegistryMarketplaceEntry } from "@zcode/shared";
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
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2025.1.0"],
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
) {
  const searchMarketplace = vi.fn(searchImpl);
  const view = render(
    <ZCodeIntlProvider initialLocale="en-US">
      <ServiceProvider
        services={{ mcpSyncService: { searchMarketplace } } as unknown as IServiceAccessor}
      >
        <McpRegistryMarketplace onConfigure={onConfigure} />
      </ServiceProvider>
    </ZCodeIntlProvider>,
  );
  mounted.push(view.unmount);
  return { searchMarketplace, onConfigure };
}

describe("Official MCP Registry panel", () => {
  it("searches and shows the exact local npx command", async () => {
    const { searchMarketplace } = renderPanel();

    fireEvent.change(screen.getByTestId("mcp-registry-search"), {
      target: { value: "sequential" },
    });
    fireEvent.click(screen.getByTestId("mcp-registry-submit"));

    await screen.findByText("io.modelcontextprotocol/sequential-thinking");
    expect(searchMarketplace).toHaveBeenCalledWith("sequential");
    expect(
      screen.getByText("npx -y @modelcontextprotocol/server-sequential-thinking@2025.1.0"),
    ).toBeTruthy();
    const configureButton = screen.getByTestId(
      "mcp-registry-configure-io.modelcontextprotocol/sequential-thinking-0",
    );
    expect(configureButton).toBeTruthy();
  });

  it("hands the selected install option to the MCP form", async () => {
    const onConfigure = vi.fn();
    renderPanel(onConfigure);

    fireEvent.change(screen.getByTestId("mcp-registry-search"), {
      target: { value: "sequential" },
    });
    fireEvent.click(screen.getByTestId("mcp-registry-submit"));
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

    fireEvent.change(screen.getByTestId("mcp-registry-search"), {
      target: { value: "yandex" },
    });
    fireEvent.click(screen.getByTestId("mcp-registry-submit"));

    await screen.findByText(uncurated.name);
    expect(screen.getByTestId("mcp-registry-tab-all").getAttribute("data-state")).toBe("active");
    expect(searchMarketplace).toHaveBeenCalledWith("yandex");
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

    fireEvent.change(screen.getByTestId("mcp-registry-search"), {
      target: { value: "yandex" },
    });
    fireEvent.click(screen.getByTestId("mcp-registry-submit"));
    await waitFor(() => expect(searchMarketplace).toHaveBeenCalledWith("yandex"));

    fireEvent.click(screen.getByLabelText("Clear search"));
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
