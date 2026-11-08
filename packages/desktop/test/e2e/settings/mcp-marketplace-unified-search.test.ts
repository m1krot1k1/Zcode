import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  waitForTestIdByDom,
} from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

describe("MCP marketplace unified search E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("filters reviewed presets from the single MCP settings search", async function () {
    this.timeout(90_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "Settings entry is unavailable",
    });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, {
      timeout: 15_000,
      timeoutMsg: "Settings page did not render",
    });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"), {
      timeout: 15_000,
      timeoutMsg: "MCP settings section is unavailable",
    });

    const search = await browser.$('[data-testid="plugin-settings-search"]');
    await search.waitForDisplayed({ timeout: 15_000 });
    await search.setValue("context7");
    await browser.waitUntil(
      async () =>
        browser.execute(() => Boolean(document.querySelector('[data-mcp-catalog-entry="context7"]'))),
      {
        timeout: 15_000,
        timeoutMsg: "The shared search did not filter MCP suggestions to Context7",
      },
    );

    const searchSurface = await browser.execute(() => ({
      searchInputs: document.querySelectorAll('[data-testid="plugin-settings-search"]').length,
      registrySearchInputs: document.querySelectorAll('[data-testid="mcp-registry-search"]').length,
      visiblePresetIds: Array.from(document.querySelectorAll<HTMLElement>("[data-mcp-catalog-entry]"))
        .map((element) => element.dataset.mcpCatalogEntry)
        .filter(Boolean),
    }));
    expect(searchSurface).toEqual({
      searchInputs: 1,
      registrySearchInputs: 0,
      visiblePresetIds: ["context7"],
    });
  });
});
