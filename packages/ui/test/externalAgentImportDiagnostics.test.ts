// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  ExternalAgentImportSelectionPanel,
  type ExternalAgentImportCategoryState,
} from "../src/settings/ExternalAgentImportDialog.js";

describe("external agent MCP import diagnostics", () => {
  it("shows a safe diagnostic when the Cline MCP configuration cannot be parsed", () => {
    const sourcePath = "/Users/example/.cline/data/settings/cline_mcp_settings.json";
    const state: ExternalAgentImportCategoryState = {
      activeScope: "global",
      discovery: {
        agents: [
          {
            agent: "cline",
            discovered: true,
            categories: [
              {
                category: "mcpServers",
                discoveredCount: 0,
                importableCount: 0,
                skippedCount: 0,
                sourcePaths: [sourcePath],
                sourceRoots: [],
                diagnostics: [{ path: sourcePath, code: "invalidConfig" }],
                selectedByDefault: false,
              },
            ],
          },
        ],
      },
      error: null,
      expandedSourceKeys: [],
      importMode: "copy",
      importTargetScope: "global",
      loading: false,
      selectedCount: 0,
      selectedKeys: [],
      selections: [],
      totalImportableCount: 0,
      loadDiscovery: vi.fn(),
      setActiveSourceScope: vi.fn(),
      setImportMode: vi.fn(),
      setImportTargetScope: vi.fn(),
      setResourceSelection: vi.fn(),
      toggleExpanded: vi.fn(),
      toggleSelection: vi.fn(),
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          {},
          createElement(ExternalAgentImportSelectionPanel, {
            category: "mcpServers",
            state,
            workspacePath: null,
          }),
        ),
      ),
    );

    expect(screen.getByRole("alert").textContent).toContain("malformed");
    expect(screen.getByRole("alert").textContent).toContain(sourcePath);
  });
});
