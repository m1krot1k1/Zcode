import {
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_USAGE_TAB,
  TID_TASK_SETTINGS_BUTTON,
  TID_MODEL_PROVIDER_NAV_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "../helpers/desktop-app.js";
import { clearAppUsageE2EFixture } from "../helpers/usage-stats-app-usage-fixture.js";

describe("Usage Stats App Usage E2E", () => {
  after(async () => {
    await clearAppData();
  });

  it("US-AU-02/03/04/05: 聚合、range、Token Activity 与模型图表", async function () {
    this.timeout(120_000);
    await openAppUsage();

    await assertBodyIncludes(["e2e-model-alpha", "e2e-model-beta"]);
    await assertBodyIncludesAny(["Token Activity", "Активность по токенам", "Token 活动"]);
    await assertBodyIncludesAny([
      "Daily Token Trend",
      "График токенов по дням",
      "每日 Token 趋势图",
    ]);
    await assertBodyIncludesAny(["Model Usage", "Использование моделей", "模型用量"]);
    // tokenNumberFormat 使用系统区域格式；俄语会显示 9,5 тыс. с неразрывным пробелом.
    await assertBodyIncludesAny(["9.5K", "9,510", "9510", "9,5 тыс."]);

    await clickButtonByText(["Last 7 days", "За последние 7 дней", "近 7 日"]);
    await assertPressedButton(["Last 7 days", "За последние 7 дней", "近 7 日"]);
    await assertBodyIncludes(["e2e-model-alpha", "e2e-model-beta"]);
    // 7d 使用精确时间戳边界，恰好第 7 天的 fixture 会落在窗口外。
    await assertBodyIncludesAny(["2.4K", "2,406", "2406", "2,4 тыс."]);

    await clickButtonByText(["Weekly", "По неделям", "每周"]);
    await assertPressedButton(["Weekly", "По неделям", "每周"]);
    await clickButtonByText(["Cumulative", "Накопительно", "累计"]);
    await assertPressedButton(["Cumulative", "Накопительно", "累计"]);

    await clickButtonByText(["Last 30 days", "За последние 30 дней", "近 30 日"]);
    await assertPressedButton(["Last 30 days", "За последние 30 дней", "近 30 日"]);
    await assertBodyIncludes(["e2e-model-gamma"]);
    await assertBodyIncludesAny(["4.5K", "4,510", "4510", "4,5 тыс."]);
  });

  it("US-CG-01: Code Graph section exposes an interactive local graph", async function () {
    this.timeout(60_000);
    await waitForDefaultWorkspaceReady(60_000);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 20_000,
      timeoutMsg: "Code Graph E2E cannot open settings",
    });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "codeGraph"), {
      timeout: 10_000,
      timeoutMsg: "Code Graph settings section did not appear",
    });

    const graph = await $('[data-testid="usage-code-graph"]');
    await graph.waitForDisplayed({ timeout: 15_000 });
    const canvas = await $('[data-testid="usage-code-graph-canvas"]');
    await canvas.waitForDisplayed({ timeout: 10_000 });
    const stats = await $('[data-testid="usage-code-graph-stats"]');
    await stats.waitForDisplayed({ timeout: 10_000 });
    await browser.waitUntil(async () => (await stats.getAttribute("aria-busy")) === "false", {
      timeout: 15_000,
      timeoutMsg: "Code graph status remained in its loading state",
    });

    const callFilter = await findButtonByText(["Calls", "Вызовы", "调用"]);
    expect(await callFilter.getAttribute("aria-pressed")).toBe("true");
    await callFilter.click();
    await browser.waitUntil(
      async () => (await callFilter.getAttribute("aria-pressed")) === "false",
      {
        timeout: 5_000,
        timeoutMsg: "Code graph call filter did not toggle",
      },
    );
    const structureFilter = await findButtonByText(["Structure", "Структура"]);
    expect(await structureFilter.getAttribute("aria-pressed")).toBe("true");
    await structureFilter.click();
    await browser.waitUntil(
      async () => (await structureFilter.getAttribute("aria-pressed")) === "false",
      {
        timeout: 5_000,
        timeoutMsg: "Code graph structure filter did not toggle",
      },
    );
    expect((await canvas.getSize()).height).toBeGreaterThanOrEqual(440);

    const wideSize = await browser.execute(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    if (wideSize.width >= 1280) {
      expect((await canvas.getSize()).width).toBeGreaterThanOrEqual(
        (await graph.getSize()).width * 0.5,
      );
    }
    try {
      await setRendererViewport(Math.min(wideSize.width, 1000), Math.min(wideSize.height, 760));
      await browser.waitUntil(async () => (await canvas.getSize()).height >= 440, {
        timeout: 5_000,
        timeoutMsg: "Code graph canvas collapsed at a narrow window size",
      });
      expect(await canvas.isDisplayed()).toBe(true);
    } finally {
      await clearRendererViewport();
    }
  });

  it("US-CI-01: composer index popover opens and routes to Code Graph", async function () {
    this.timeout(60_000);
    await waitForDefaultWorkspaceReady(60_000);
    await clickTestIdByDom("composer-code-index-trigger", {
      timeout: 20_000,
      timeoutMsg: "Composer code index control did not appear",
    });
    await $('[data-testid="composer-code-index-popover"]').waitForDisplayed({ timeout: 10_000 });
    await assertBodyIncludesAny(["Code index", "Индекс кода", "代码索引"]);

    const search = await $('[data-testid="composer-code-index-search"]');
    if (await search.isExisting()) {
      await search.setValue("CodeIndexPopover");
      await search.click();
      await browser.keys("ENTER");
      await browser.waitUntil(
        async () =>
          (await $('[data-testid="composer-code-index-results"]').isExisting()) ||
          (await $('[data-testid="composer-code-index-popover"]').getText()).includes(
            "No indexed code matches",
          ) ||
          (await $('[data-testid="composer-code-index-popover"]').getText()).includes(
            "没有找到匹配",
          ),
        { timeout: 10_000, timeoutMsg: "Code index search did not return a result state" },
      );
    }

    await clickButtonByText(["Open Code Graph", "Открыть граф кода", "打开代码图谱"]);
    await $('[data-testid="usage-code-graph"]').waitForDisplayed({ timeout: 20_000 });
    await assertBodyIncludesAny(["Workspace code graph", "Граф кода рабочей области", "工作区代码图谱"]);
  });

  it("US-CI-02: embedding Test keeps the draft token until Save persists it", async function () {
    this.timeout(60_000);
    await openAppUsage();
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
      timeout: 10_000,
      timeoutMsg: "Model settings section did not appear",
    });
    await clickTestIdByDom(
      testId(TID_MODEL_PROVIDER_NAV_ITEM, "workspace-intelligence:embeddings"),
      {
      timeout: 15_000,
        timeoutMsg: "Model settings do not expose the workspace embeddings entry",
      },
    );

    const endpoint = await $('[data-testid="agent-workbench-embedding-endpoint"]');
    const provider = await $('[data-testid="agent-workbench-embedding-provider"]');
    const model = await $('[data-testid="agent-workbench-embedding-model"]');
    const apiKey = await $('[data-testid="agent-workbench-embedding-api-key"]');
    const providerLocation = await provider.getLocation();
    const providerSize = await provider.getSize();
    const endpointLocation = await endpoint.getLocation();
    const endpointSize = await endpoint.getSize();
    const fieldsDoNotOverlap =
      providerLocation.x + providerSize.width <= endpointLocation.x ||
      providerLocation.y + providerSize.height <= endpointLocation.y ||
      endpointLocation.y + endpointSize.height <= providerLocation.y;
    expect(fieldsDoNotOverlap).toBe(true);
    await endpoint.setValue("http://127.0.0.1:1/api/embed");
    await model.setValue("e2e-draft-embedding-model");
    await apiKey.setValue("e2e-transient-token");
    await clickTestIdByDom("agent-workbench-test-embedding");

    const message = await $('[data-testid="agent-workbench-embedding-message"]');
    await message.waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(async () => (await apiKey.getValue()) === "e2e-transient-token", {
      timeout: 5_000,
      timeoutMsg: "Test cleared the transient embedding token before Save",
    });

    await clickTestIdByDom("agent-workbench-save-embedding");
    await browser.waitUntil(async () => (await apiKey.getValue()) === "", {
      timeout: 5_000,
      timeoutMsg: "Save did not clear the persisted token from the password field",
    });
    await browser.waitUntil(
      async () =>
        ["Saved · leave blank to keep", "Сохранён. Оставьте поле пустым, чтобы не менять его."]
          .includes((await apiKey.getAttribute("placeholder")) ?? ""),
      {
        timeout: 5_000,
        timeoutMsg: "Saved embedding token was not reflected in the password field",
      },
    );

    await clickTestIdByDom("agent-workbench-test-embedding");
    await message.waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(
      async () =>
        ["Saved · leave blank to keep", "Сохранён. Оставьте поле пустым, чтобы не менять его."]
          .includes((await apiKey.getAttribute("placeholder")) ?? ""),
      {
        timeout: 5_000,
        timeoutMsg: "A repeated Test lost the saved-token state",
      },
    );

    await clickButtonByText(["Forget saved token", "Удалить сохранённый токен"]);
    await clickButtonByText(["Clear configuration", "Сбросить настройки"]);
  });

  it("US-AU-01: usage facts 清空后显示确定空态", async function () {
    this.timeout(60_000);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "usage"), {
      timeout: 10_000,
      timeoutMsg: "Usage Stats section did not appear",
    });
    await clickTestIdByDom(testId(TID_SETTINGS_USAGE_TAB, "app"), {
      timeout: 10_000,
      timeoutMsg: "App Usage tab did not appear",
    });
    clearAppUsageE2EFixture(getE2EAppDataPaths().homeDir);
    await clickButtonByText(["Refresh", "Обновить", "刷新"]);
    await browser.waitUntil(
      async () => {
        const body = await $("body").getText();
        return /No usage data yet|Данных об использовании пока нет|还没有可展示的数据/.test(body);
      },
      { timeout: 20_000, timeoutMsg: "清空 usage facts 后没有显示 App Usage 空态" },
    );
    await assertBodyExcludes(["e2e-model-alpha", "e2e-model-gamma"]);
  });
});

async function openAppUsage(): Promise<void> {
  await waitForDefaultWorkspaceReady(60_000);
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 20_000,
    timeoutMsg: "App Usage E2E 无法打开设置页",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "usage"), {
    timeout: 20_000,
    timeoutMsg: "设置页 Usage 分区没有出现",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_USAGE_TAB, "app"), {
    timeout: 20_000,
    timeoutMsg: "App Usage tab 没有出现",
  });
  await browser.waitUntil(
    async () =>
      /Token activity|Активность по токенам|Token 活动/i.test(await $("body").getText()),
    { timeout: 30_000, timeoutMsg: "App Usage 数据没有完成加载" },
  );
}

async function clickButtonByText(labels: string[]): Promise<void> {
  for (const button of await $$("button")) {
    if (labels.includes((await button.getText()).trim())) {
      await button.click();
      return;
    }
  }
  throw new Error(`找不到按钮: ${labels.join("/")}`);
}

async function findButtonByText(labels: string[]) {
  for (const button of await $$("button[aria-pressed]")) {
    if (labels.includes((await button.getText()).trim())) return button;
  }
  throw new Error(`找不到筛选按钮: ${labels.join("/")}`);
}

async function assertPressedButton(labels: string[]): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((candidateLabels) => {
        const target = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => candidateLabels.includes(button.textContent?.trim() ?? ""),
        );
        return target?.getAttribute("data-state") === "active";
      }, labels),
    { timeout: 10_000, timeoutMsg: `${labels.join("/")} 没有进入 active 状态` },
  );
}

async function assertBodyIncludes(values: string[]): Promise<void> {
  await browser.waitUntil(
    async () => {
      const body = await $("body").getText();
      const normalizedBody = body.toLocaleLowerCase();
      return values.every((value) => normalizedBody.includes(value.toLocaleLowerCase()));
    },
    { timeout: 20_000, timeoutMsg: `页面缺少文本: ${values.join(", ")}` },
  );
}

async function assertBodyIncludesAny(values: string[]): Promise<void> {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  try {
    await browser.waitUntil(
      async () => {
        const body = await $("body").getText();
        const normalizedBody = normalize(body);
        return values.some((value) => normalizedBody.includes(normalize(value)));
      },
      { timeout: 20_000, timeoutMsg: `页面未出现任一文本: ${values.join(", ")}` },
    );
  } catch {
    const body = (await $("body").getText()).replace(/\s+/g, " ").slice(0, 4_000);
    throw new Error(`页面未出现任一文本: ${values.join(", ")}。当前页面: ${body}`);
  }
}

async function setRendererViewport(width: number, height: number): Promise<void> {
  await sendRendererEmulationCommand("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  await browser.waitUntil(
    async () => browser.execute((expectedWidth) => window.innerWidth === expectedWidth, width),
    { timeout: 10_000, timeoutMsg: `Renderer viewport did not resize to ${width}px` },
  );
}

async function clearRendererViewport(): Promise<void> {
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride");
}

async function sendRendererEmulationCommand(
  method: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  const sent = await browser.electron.execute(
    async (electron, command, commandParams) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) return false;
      const debuggerSession = window.webContents.debugger;
      if (!debuggerSession.isAttached()) debuggerSession.attach("1.3");
      await debuggerSession.sendCommand(command, commandParams);
      return true;
    },
    method,
    params,
  );
  if (!sent) throw new Error(`Cannot send renderer emulation command: ${method}`);
}

async function assertBodyExcludes(values: string[]): Promise<void> {
  await browser.waitUntil(
    async () => {
      const body = await $("body").getText();
      return values.every((value) => !body.includes(value));
    },
    { timeout: 20_000, timeoutMsg: `页面仍包含文本: ${values.join(", ")}` },
  );
}
