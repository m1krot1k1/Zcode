import { capturePluginManualReview } from "./manual-review.js";
import type { PluginControlAttributes } from "./types.js";

export async function waitForDisplayedPluginControl(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
  timeout = 15000,
): Promise<void> {
  const selector = pluginControlSelector(testIdValue, attributes);
  await browser.waitUntil(
    async () => {
      const element = await browser.$(selector);
      return (await element.isExisting()) && (await element.isDisplayed());
    },
    {
      timeout,
      timeoutMsg: `Plugin UI did not display ${testIdValue} ${JSON.stringify(attributes)}`,
    },
  );
}

export async function clickPluginControl(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
): Promise<void> {
  let latest = "not-started";
  const selector = pluginControlSelector(testIdValue, attributes);
  try {
    await browser.waitUntil(
      async () => {
        const elements = await browser.$$(selector);
        if ((await elements.length) === 0) {
          latest = "missing";
          return false;
        }
        let sawHidden = false;
        let sawDisabled = false;
        for (const element of elements) {
          if (!(await element.isDisplayed())) {
            sawHidden = true;
            continue;
          }
          if (!(await element.isEnabled())) {
            sawDisabled = true;
            continue;
          }
          try {
            await element.scrollIntoView();
            await element.click();
            latest = "clicked";
            return true;
          } catch (error) {
            latest = error instanceof Error ? error.message : String(error);
          }
        }
        latest = sawDisabled ? "disabled" : sawHidden ? "hidden" : latest;
        return false;
      },
      { timeout: 30000 },
    );
  } catch (error) {
    const dialogs = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]'))
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) => element.innerText.slice(0, 1000)),
    );
    await capturePluginManualReview("PLM-UI-FAIL", testIdValue).catch(() => {});
    throw new Error(
      `Could not click ${testIdValue}: ${latest}; dialogs=${JSON.stringify(dialogs)}`,
      { cause: error },
    );
  }
}

export function pluginControlSelector(
  testIdValue: string,
  attributes: PluginControlAttributes,
): string {
  const selectors = [`[data-testid=${JSON.stringify(testIdValue)}]`];
  const attributeEntries: Array<[string, string | undefined]> = [
    ["data-plugin-id", attributes.pluginId],
    ["data-marketplace-id", attributes.marketplaceId],
    ["data-group-key", attributes.groupKey],
    ["data-component-kind", attributes.componentKind],
    ["data-config-key", attributes.configKey],
  ];
  for (const [name, value] of attributeEntries) {
    if (value) selectors.push(`[${name}=${JSON.stringify(value)}]`);
  }
  return selectors.join("");
}

export async function waitForPluginControl(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
  timeout = 15000,
): Promise<void> {
  await browser.waitUntil(() => hasPluginControl(testIdValue, attributes), {
    timeout,
    timeoutMsg: `Plugin UI did not render ${testIdValue} ${JSON.stringify(attributes)}`,
  });
}

export async function hasPluginControl(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
): Promise<boolean> {
  return browser.execute(
    (id, expected) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
        (candidate) =>
          candidate.dataset.testid === id &&
          (!expected.pluginId || candidate.dataset.pluginId === expected.pluginId) &&
          (!expected.marketplaceId || candidate.dataset.marketplaceId === expected.marketplaceId) &&
          (!expected.groupKey || candidate.dataset.groupKey === expected.groupKey) &&
          (!expected.componentKind || candidate.dataset.componentKind === expected.componentKind) &&
          (!expected.configKey || candidate.dataset.configKey === expected.configKey),
      ),
    testIdValue,
    attributes,
  );
}

export async function getPluginControlText(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
): Promise<string> {
  return browser.execute(
    (id, expected) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (candidate) =>
          candidate.dataset.testid === id &&
          (!expected.pluginId || candidate.dataset.pluginId === expected.pluginId) &&
          (!expected.marketplaceId || candidate.dataset.marketplaceId === expected.marketplaceId),
      )?.textContent ?? "",
    testIdValue,
    attributes,
  );
}

export async function readPluginControlChecked(
  testIdValue: string,
  attributes: PluginControlAttributes,
): Promise<boolean> {
  await waitForPluginControl(testIdValue, attributes);
  return browser.execute(
    (id, expected) => {
      const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (candidate) =>
          candidate.dataset.testid === id &&
          (!expected.pluginId || candidate.dataset.pluginId === expected.pluginId),
      );
      return element?.getAttribute("data-state") === "checked";
    },
    testIdValue,
    attributes,
  );
}

export async function setPluginControlValue(
  testIdValue: string,
  attributes: PluginControlAttributes,
  value: string,
): Promise<void> {
  await waitForPluginControl(testIdValue, attributes);
  const result = await browser.execute(
    (id, expected, nextValue) => {
      const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (candidate) =>
          candidate.dataset.testid === id &&
          (!expected.configKey || candidate.dataset.configKey === expected.configKey),
      );
      if (!(element instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, nextValue);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    testIdValue,
    attributes,
    value,
  );
  if (!result) throw new Error(`Could not set ${testIdValue} to ${value}`);
}
