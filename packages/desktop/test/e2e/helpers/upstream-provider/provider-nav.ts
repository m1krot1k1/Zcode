import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";

import {
  clickTestIdByDom,
  getE2EAppDataPaths,
  readModelProvider,
  readModelProviders,
} from "../desktop-app.js";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  UPSTREAM_PROVIDER_NAV_KEY,
} from "./config.js";

export async function clickUpstreamProviderNavItem() {
  const navTestId = testId(TID_MODEL_PROVIDER_NAV_ITEM, UPSTREAM_PROVIDER_NAV_KEY);
  let latestReason = "not-started";
  try {
    await browser.waitUntil(
      async () => {
        const clicked = (await browser.execute((currentTestId) => {
          const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
          if (!element) {
            return { clicked: false, reason: "missing" };
          }
          if (
            element instanceof HTMLButtonElement &&
            (element.disabled || element.getAttribute("aria-disabled") === "true")
          ) {
            return { clicked: false, reason: "disabled" };
          }
          element.click();
          return { clicked: true, reason: "clicked" };
        }, navTestId)) as { clicked: boolean; reason: string };
        latestReason = clicked.reason;
        if (clicked.clicked) {
          return true;
        }

        // 修复原因：设置页的 provider registry 来自 host 异步快照。
        // e2e 每个 session 都会重置 HOME，刚进设置页时左侧导航可能还在旧 section
        // 或 loading。周期性重新进入模型供应商页，避免把初始化窗口误报成业务失败。
        await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
          timeout: 2000,
          timeoutMsg: "设置页模型供应商分区入口不可点击",
        }).catch(() => undefined);
        await browser.pause(250);
        return false;
      },
      {
        timeout: 45000,
        timeoutMsg: `设置页没有出现默认 ${UPSTREAM_PROVIDER_NAME} provider`,
      },
    );
  } catch (error) {
    throw new Error(
      `设置页没有出现默认 ${UPSTREAM_PROVIDER_NAME} provider: ${latestReason}\n${JSON.stringify(
        await collectProviderNavDiagnostics(navTestId),
        null,
        2,
      )}`,
      { cause: error },
    );
  }
}

async function collectProviderNavDiagnostics(navTestId: string) {
  const providers = await readModelProviders();
  const appDataPaths = getE2EAppDataPaths();
  const dom = await browser.execute(
    (providerNavPrefix, expectedNavTestId, settingsPageTestId) => {
      const navItems = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${providerNavPrefix}-"]`),
      ).map((element) => ({
        ariaDisabled: element.getAttribute("aria-disabled"),
        ariaLabel: element.getAttribute("aria-label"),
        ariaSelected: element.getAttribute("aria-selected"),
        disabled: element instanceof HTMLButtonElement ? element.disabled : false,
        state: element.getAttribute("data-state"),
        testId: element.dataset.testid ?? "",
        text: element.innerText.trim(),
      }));
      return {
        bodyText: document.body?.innerText?.slice(0, 1600) ?? "",
        expectedExists: Boolean(document.querySelector(`[data-testid="${expectedNavTestId}"]`)),
        navItems,
        readyState: document.readyState,
        settingsVisible: Boolean(document.querySelector(`[data-testid="${settingsPageTestId}"]`)),
        testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .slice(0, 120)
          .map((element) => element.dataset.testid ?? ""),
        url: window.location.href,
      };
    },
    TID_MODEL_PROVIDER_NAV_ITEM,
    navTestId,
    TID_SETTINGS_PAGE,
  );

  return {
    appDataPaths,
    dom,
    providers: providers.map((provider) => ({
      apiKeyLength: provider.apiKey.trim().length,
      enabled: provider.enabled,
      id: provider.id,
      modelCount: provider.models.length,
      models: provider.models.map((model) => (typeof model === "string" ? model : model.id)),
      name: provider.name,
      source: provider.source,
    })),
  };
}

export async function waitForModelProviderNavSelected(navKey: string) {
  const navTestId = testId(TID_MODEL_PROVIDER_NAV_ITEM, navKey);
  await browser.waitUntil(
    async () =>
      browser.execute((currentTestId) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === currentTestId,
        );
        // 修复原因：模型供应商导航选中态是产品状态，不应依赖具体 CSS class。
        // UI 现在通过 aria-selected / data-state 暴露稳定协议，E2E 读取语义字段。
        return (
          element?.getAttribute("aria-selected") === "true" ||
          element?.getAttribute("data-state") === "selected"
        );
      }, navTestId),
    {
      timeout: 15000,
      timeoutMsg: `模型供应商导航没有选中 ${navKey}`,
    },
  );
}

export async function waitForUpstreamProviderSaved(
  predicate: (provider: NonNullable<Awaited<ReturnType<typeof readModelProvider>>>) => boolean,
  timeoutMsg: string,
) {
  await browser.waitUntil(
    async () => {
      const provider = await readModelProvider(UPSTREAM_PROVIDER_ID);
      return Boolean(provider && predicate(provider));
    },
    {
      timeout: 15000,
      timeoutMsg,
    },
  );
}
