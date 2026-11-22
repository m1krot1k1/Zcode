// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  ExternalAgentImportResultRow,
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

  it("shows the localized reauthorization warning on an imported server result", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          {},
          createElement(ExternalAgentImportResultRow, {
            category: "mcpServers",
            result: {
              name: "oauth-server",
              path: "/Users/example/.cline/data/settings/cline_mcp_settings.json#oauth-server",
              sourceScope: "global",
              status: "imported",
              warnings: ["clineOAuthReauthenticationRequired"],
            },
          }),
        ),
      ),
    );

    expect(
      screen.getByText(
        "Cline OAuth session data was not imported. Authorize this server again in ZCode.",
      ),
    ).toBeTruthy();
  });

  it("localizes portability diagnostics on imported Cline commands", () => {
    cleanup();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          {},
          createElement(ExternalAgentImportResultRow, {
            category: "mcpServers",
            result: {
              name: "playwright",
              path: "/private/cline/settings.json#playwright",
              sourceScope: "global",
              status: "imported",
              warnings: ["clinePortablePresetApplied", "clineCommandMayNotBePortable"],
            },
          }),
        ),
      ),
    );

    const warning = screen.getByRole("note").textContent ?? "";
    expect(warning).toContain(
      "Matched an installed Cline package to ZCode's pinned portable version.",
    );
    expect(warning).toContain(
      "This Cline command is machine-specific. Its command was kept unchanged.",
    );
  });
});
