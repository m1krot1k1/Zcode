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
        createElement(McpCommunityCatalog, { presets: [preset], onSelect, onOpenSource }),
      ),
    );

    const entry = container.querySelector('[data-mcp-catalog-entry="firecrawl"]');
    if (!(entry instanceof HTMLElement)) throw new Error("Firecrawl catalog card is missing");
    const card = within(entry);
    expect(card.getByText("Optional API key for account features")).toBeTruthy();
    fireEvent.click(card.getByRole("button", { name: "Open Firecrawl package source" }));
    expect(onOpenSource).toHaveBeenCalledWith("https://github.com/firecrawl/firecrawl-mcp-server");

    fireEvent.click(card.getByRole("button", { name: "Configure" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(preset);
  });
});
