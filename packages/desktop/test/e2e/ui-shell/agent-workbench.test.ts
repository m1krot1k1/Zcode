import { TID_SIDE_PANE_TOGGLE } from "@zcode/shared/test-ids";
import { clearAppData } from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

describe("Agent Workbench side pane", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("AWB-E2E-001 opens the workspace dashboard from the new-tab launcher", async () => {
    const frame = () => $('[data-workspace-side-frame="true"]');
    const isExpanded = () =>
      browser.execute(() => {
        const sideFrame = document.querySelector<HTMLElement>('[data-workspace-side-frame="true"]');
        const panel = sideFrame?.parentElement;
        return Boolean(
          panel &&
          panel.getBoundingClientRect().width > 100 &&
          getComputedStyle(panel).opacity === "1",
        );
      });
    const toggle = await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
    await toggle.waitForDisplayed({ timeout: 10_000 });
    if (!(await isExpanded())) await toggle.click();
    await browser.waitUntil(isExpanded, {
      timeout: 10_000,
      timeoutMsg: "Side Pane did not expand",
    });
    await frame().waitForDisplayed();

    const active = () => $('[data-side-pane-tab-id][data-state="active"]');
    if (!/New tab|新标签页/.test(await active().getText())) {
      await $("[data-side-pane-add-tab-trigger]").click();
      await browser.waitUntil(async () => /New tab|新标签页/.test(await active().getText()));
    }
    const launcherItem = $(
      '[data-state="active"] [data-side-pane-open-tab-item="agent-workbench"]',
    );
    await launcherItem.waitForClickable({ timeout: 10_000 });
    await launcherItem.click();

    const dashboard = await $('[data-testid="agent-workbench"]');
    await dashboard.waitForDisplayed({ timeout: 10_000 });
    await $("#agent-roster-heading").waitForDisplayed();
    await $("#agent-capacity-heading").waitForDisplayed();
    await $("#agent-run-activity-heading").waitForDisplayed();
    await $("#code-index-heading").waitForDisplayed();
    await $("#code-graph-heading").waitForDisplayed();
    await $("#embedding-config-heading").waitForDisplayed();
    const indexState = await $('[data-testid="agent-workbench-index-state"]').getAttribute(
      "data-code-index-state",
    );
    expect(indexState).toMatch(/^(unindexed|indexing|ready|degraded)$/);
    expect(await $("button*=Build index").isEnabled()).toBe(true);
    expect(
      await $('[data-side-pane-tab-id][data-state="active"]').getAttribute("data-side-pane-tab-id"),
    ).toMatch(/^agent-workbench:/);

    const provider = await $('[data-testid="agent-workbench-embedding-provider"]');
    await provider.click();
    const compatibleOption = await $('[data-testid="agent-workbench-openai-compatible-option"]');
    await compatibleOption.waitForDisplayed({ timeout: 5_000 });
    await compatibleOption.click();
    const endpoint = await $('[data-testid="agent-workbench-embedding-endpoint"]');
    expect(await endpoint.getValue()).toBe("https://openrouter.ai/api/v1/embeddings");
    await $('[data-testid="agent-workbench-embedding-model"]').setValue(
      "openai/text-embedding-3-small",
    );
    const apiKey = await $('[data-testid="agent-workbench-embedding-api-key"]');
    await apiKey.setValue("sk-e2e-token-must-not-be-echoed");
    await $('[data-testid="agent-workbench-save-embedding"]').click();
    await browser.waitUntil(async () => (await apiKey.getValue()) === "", {
      timeout: 5_000,
      timeoutMsg: "Saved API token remained in the Workbench input",
    });
    const forgetToken = await $('[data-testid="agent-workbench-clear-embedding-token"]');
    await browser.waitUntil(async () => forgetToken.isEnabled(), { timeout: 5_000 });
    await forgetToken.click();
    const clearEmbedding = await $('[data-testid="agent-workbench-clear-embedding-settings"]');
    await browser.waitUntil(async () => clearEmbedding.isEnabled(), { timeout: 5_000 });
    await clearEmbedding.click();
  });
});
