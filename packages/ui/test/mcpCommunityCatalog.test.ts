// @vitest-environment jsdom
import { fireEvent, render, within } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { COMMUNITY_MCP_PRESETS } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { McpCommunityCatalog } from "../src/settings/McpSettingsSection.js";

describe("MCP curated catalog", () => {
  it("shows Firecrawl auth and provenance and delegates selection to the existing draft flow", () => {
    const onSelect = vi.fn();
    const onOpenSource = vi.fn();
    const preset = COMMUNITY_MCP_PRESETS.find((item) => item.id === "firecrawl");
    if (!preset) throw new Error("Firecrawl catalog entry is missing");

    const { container } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(McpCommunityCatalog, {
          presets: [preset],
          discoveredEntries: [],
          discoveryState: "ready",
          rejectedEntryCount: 0,
          onRefreshDiscovery: vi.fn(),
          onSelect,
          onOpenSource,
        }),
      ),
    );

    const entry = container.querySelector('[data-mcp-catalog-entry="firecrawl"]');
    if (!(entry instanceof HTMLElement)) throw new Error("Firecrawl catalog card is missing");
    const card = within(entry);
    expect(card.getByText("Optional API key for account features")).toBeTruthy();
    fireEvent.click(card.getByRole("button", { name: "Open Firecrawl source" }));
    expect(onOpenSource).toHaveBeenCalledWith("https://github.com/firecrawl/firecrawl-mcp-server");

    fireEvent.click(card.getByRole("button", { name: "Configure" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(preset);
  });

  it("shows hosted auth and usage warnings while creating only a portable endpoint draft", () => {
    const onSelect = vi.fn();
    const onOpenSource = vi.fn();
    const preset = COMMUNITY_MCP_PRESETS.find((item) => item.id === "apify");
    if (!preset) throw new Error("Apify catalog entry is missing");
    const { container } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(McpCommunityCatalog, {
          presets: [preset],
          discoveredEntries: [],
          discoveryState: "ready",
          rejectedEntryCount: 0,
          onRefreshDiscovery: vi.fn(),
          onSelect,
          onOpenSource,
        }),
      ),
    );
    const entry = container.querySelector('[data-mcp-catalog-entry="apify"]');
    if (!(entry instanceof HTMLElement)) throw new Error("Apify catalog card is missing");
    const card = within(entry);
    expect(card.getByText("Provider OAuth or API key")).toBeTruthy();
    expect(
      card.getByText(
        "Actor runs and platform usage may cost money; individual Actor pricing varies.",
      ),
    ).toBeTruthy();
    fireEvent.click(card.getByRole("button", { name: "Configure" }));
    expect(onSelect).toHaveBeenCalledWith(preset);
  });

  it("shows unknown Cline listings as unverified metadata without install or configure actions", () => {
    const onSelect = vi.fn();
    const onOpenSource = vi.fn();
    const { container } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(McpCommunityCatalog, {
          presets: [],
          discoveredEntries: [
            {
              id: "remote-search",
              name: "Remote Search",
              description: "Search a remote source",
              tags: ["search"],
              author: "Community",
              sourceUrl: "https://github.com/example/search-mcp",
            },
          ],
          discoveryState: "ready",
          rejectedEntryCount: 0,
          onRefreshDiscovery: vi.fn(),
          onSelect,
          onOpenSource,
        }),
      ),
    );

    const entry = container.querySelector('[data-mcp-marketplace-entry="remote-search"]');
    if (!(entry instanceof HTMLElement)) throw new Error("External listing is missing");
    const card = within(entry);
    expect(card.getByText("Cline listing · unverified")).toBeTruthy();
    expect(card.queryByRole("button", { name: /install|configure/i })).toBeNull();
    fireEvent.click(card.getByRole("button", { name: "Open source for Remote Search" }));
    expect(onOpenSource).toHaveBeenCalledWith("https://github.com/example/search-mcp");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps local presets available when discovery fails and offers retry", () => {
    const onRefreshDiscovery = vi.fn();
    const onSelect = vi.fn();
    const preset = COMMUNITY_MCP_PRESETS.find((item) => item.id === "playwright");
    if (!preset) throw new Error("Playwright catalog entry is missing");

    const { container } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(McpCommunityCatalog, {
          presets: [preset],
          discoveredEntries: [],
          discoveryState: "error",
          rejectedEntryCount: 0,
          onRefreshDiscovery,
          onSelect,
          onOpenSource: vi.fn(),
        }),
      ),
    );

    const view = within(container);
    expect(
      view.getByText("The Cline catalog is unavailable. Built-in presets are still available."),
    ).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Refresh Cline catalog" }));
    expect(onRefreshDiscovery).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Configure" }));
    expect(onSelect).toHaveBeenCalledWith(preset);
  });
});
