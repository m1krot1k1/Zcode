import {
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_USAGE_TAB,
  TID_TASK_SETTINGS_BUTTON,
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
    await assertBodyIncludesAny(["Token Activity", "Token 活动"]);
    await assertBodyIncludesAny(["Daily Token Trend", "每日 Token 趋势图"]);
    await assertBodyIncludesAny(["Model Usage", "模型用量"]);
    // tokenNumberFormat 按 locale compact：英文为 9.5K，中文在 1 万以下保留 9510。
    await assertBodyIncludesAny(["9.5K", "9,510", "9510"]);

    await clickButtonByText(["Last 7 days", "近 7 日"]);
    await assertPressedButton(["Last 7 days", "近 7 日"]);
    await assertBodyIncludes(["e2e-model-alpha", "e2e-model-beta"]);
    // 7d 使用精确时间戳边界，恰好第 7 天的 fixture 会落在窗口外。
    await assertBodyIncludesAny(["2.4K", "2,406", "2406"]);

    await clickButtonByText(["Weekly", "每周"]);
    await assertPressedButton(["Weekly", "每周"]);
    await clickButtonByText(["Cumulative", "累计"]);
    await assertPressedButton(["Cumulative", "累计"]);

    await clickButtonByText(["Last 30 days", "近 30 日"]);
    await assertPressedButton(["Last 30 days", "近 30 日"]);
    await assertBodyIncludes(["e2e-model-gamma"]);
    await assertBodyIncludesAny(["4.5K", "4,510", "4510"]);
  });

  it("US-CG-01: Usage Stats exposes an interactive local code graph", async function () {
    this.timeout(60_000);
    await openAppUsage();
    await clickTestIdByDom(testId(TID_SETTINGS_USAGE_TAB, "codeGraph"), {
      timeout: 10_000,
      timeoutMsg: "Usage Stats Code Graph tab did not appear",
    });

    const graph = await $('[data-testid="usage-code-graph"]');
    await graph.waitForDisplayed({ timeout: 15_000 });
    const canvas = await $('[data-testid="usage-code-graph-canvas"]');
    await canvas.waitForDisplayed({ timeout: 10_000 });

    const callFilter = await findButtonByText(["Calls", "调用"]);
    expect(await callFilter.getAttribute("aria-pressed")).toBe("true");
    await callFilter.click();
    await browser.waitUntil(
      async () => (await callFilter.getAttribute("aria-pressed")) === "false",
      {
        timeout: 5_000,
        timeoutMsg: "Code graph call filter did not toggle",
      },
    );
  });

  it("US-CI-01: composer index popover opens and routes to Code Graph", async function () {
    this.timeout(60_000);
    await waitForDefaultWorkspaceReady(60_000);
    await clickTestIdByDom("composer-code-index-trigger", {
      timeout: 20_000,
      timeoutMsg: "Composer code index control did not appear",
    });
    await $('[data-testid="composer-code-index-popover"]').waitForDisplayed({ timeout: 10_000 });
    await assertBodyIncludesAny(["Code index", "代码索引"]);

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

    await clickButtonByText(["Open Code Graph", "打开代码图谱"]);
    await $('[data-testid="usage-code-graph"]').waitForDisplayed({ timeout: 20_000 });
    await assertBodyIncludesAny(["Workspace code graph", "工作区代码图谱"]);
  });

  it("US-CI-02: embedding Test clears the draft token without saving", async function () {
    this.timeout(60_000);
    await openAppUsage();
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
      timeout: 10_000,
      timeoutMsg: "Model settings section did not appear",
    });
    await clickTestIdByDom("model-settings-embeddings-toggle", {
      timeout: 15_000,
      timeoutMsg: "Embedding settings did not appear",
    });

    const endpoint = await $('[data-testid="agent-workbench-embedding-endpoint"]');
    const model = await $('[data-testid="agent-workbench-embedding-model"]');
    const apiKey = await $('[data-testid="agent-workbench-embedding-api-key"]');
    await endpoint.setValue("http://127.0.0.1:1/api/embed");
    await model.setValue("e2e-draft-embedding-model");
    await apiKey.setValue("e2e-transient-token");
    await clickTestIdByDom("agent-workbench-test-embedding");

    const message = await $('[data-testid="agent-workbench-embedding-message"]');
    await message.waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(async () => (await apiKey.getValue()) === "", {
      timeout: 5_000,
      timeoutMsg: "Transient embedding token was retained after Test",
    });
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
    await clickButtonByText(["Refresh", "刷新"]);
    await browser.waitUntil(
      async () => {
        const body = await $("body").getText();
        return /No usage data yet|还没有可展示的数据/.test(body);
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
    async () => /Token activity|Token 活动/i.test(await $("body").getText()),
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
  await browser.waitUntil(
    async () => {
      const body = await $("body").getText();
      const normalizedBody = body.toLocaleLowerCase();
      return values.some((value) => normalizedBody.includes(value.toLocaleLowerCase()));
    },
    { timeout: 20_000, timeoutMsg: `页面未出现任一文本: ${values.join(", ")}` },
  );
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
