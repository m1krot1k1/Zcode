// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { McpRegistryMarketplaceEntry } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { McpRegistryMarketplace } from "@/settings/McpRegistryMarketplace.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
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

function renderPanel(onConfigure = vi.fn()) {
  const searchMarketplace = vi.fn().mockResolvedValue({
    query: "sequential",
    entries: [sequential],
  });
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
      screen.getByText(
        "npx -y @modelcontextprotocol/server-sequential-thinking@2025.1.0",
      ),
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

    expect(onConfigure).toHaveBeenCalledWith(sequential, sequential.options[0]);
  });
});
