import { readFile } from "node:fs/promises";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "../helpers/desktop-app.js";
import { sel } from "../helpers/selectors.js";

const PROXY_LIST = "http://127.0.0.1:7890\nsocks5://127.0.0.1:1080";

describe("设置页代理列表 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("按行保存代理列表、默认保持直连，并可手动选择活动代理", async function () {
    this.timeout(90_000);

    await waitForDefaultWorkspaceReady(30_000);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "没有找到设置入口按钮",
    });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
      timeout: 15_000,
      timeoutMsg: "设置页没有出现通用分区入口",
    });

    await clickTestIdByWebDriver("settings-http-proxy-manage");
    const proxyListEditor = await $('[data-testid="settings-proxy-list-editor"]');
    await proxyListEditor.setValue(
      `  ${PROXY_LIST.split("\n")[0]}  \n ${PROXY_LIST.split("\n")[1]} `,
    );
    const perProxyTestButtons = await $(
      '[data-testid^="settings-proxy-test-"]:not([data-testid="settings-proxy-test-all"])',
    );
    if (await perProxyTestButtons.isExisting()) {
      throw new Error("Проверка должна быть одной общей кнопкой, не у каждой строки");
    }
    if (!(await $('[data-testid="settings-proxy-test-all"]').isDisplayed())) {
      throw new Error("Не найдена общая кнопка проверки списка прокси");
    }
    await clickTestIdByWebDriver("settings-proxy-test-all");
    await browser.waitUntil(
      async () =>
        await $('[data-testid="settings-proxy-status-0"]')
          .isDisplayed()
          .catch(() => false),
      {
        timeout: 15_000,
        timeoutMsg: "Проверка прокси не показала ни успешный, ни ошибочный статус",
      },
    );
    await browser.waitUntil(
      async () =>
        await $('[data-testid="settings-proxy-status-1"]')
          .isDisplayed()
          .catch(() => false),
      {
        timeout: 15_000,
        timeoutMsg: "全代理检查没有为第二条代理显示结果",
      },
    );
    if ((await readSettings(getE2EAppDataPaths().appDataDir)).httpProxy) {
      throw new Error("Проверка прокси изменила активный маршрут");
    }
    await clickTestIdByWebDriver("settings-proxy-save");

    const appDataDir = getE2EAppDataPaths().appDataDir;
    await browser.waitUntil(
      async () => {
        const settings = await readSettings(appDataDir);
        return settings.httpProxyList === PROXY_LIST && !settings.httpProxy;
      },
      {
        timeout: 15_000,
        timeoutMsg: "代理列表未保存，或保存列表时错误地启用了代理",
      },
    );

    await clickTestIdByWebDriver("settings-http-proxy-manage");
    await clickTestIdByWebDriver("settings-proxy-use-1");

    await browser.waitUntil(
      async () => (await readSettings(appDataDir)).httpProxy === PROXY_LIST.split("\n")[1],
      { timeout: 15_000, timeoutMsg: "所选代理没有保存为当前活动代理" },
    );
  });
});

async function readSettings(appDataDir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(`${appDataDir}/setting.json`, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}
