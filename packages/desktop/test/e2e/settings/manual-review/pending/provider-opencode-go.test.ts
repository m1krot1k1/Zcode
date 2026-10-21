import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import {
  restartIntoWorkspace,
  seedReplayProvider,
} from "../../../helpers/model-provider-restart.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

describe("OpenCode unified API template", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("G149-01：只展示一个 API 模板，并保存统一模型目录", async function () {
    this.timeout(150_000);
    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      await restartIntoWorkspace({
        afterElectronProcessExit: () =>
          seedReplayProvider({
            id: "e2e-go-seed",
            name: "E2E Go seed",
            apiKey: "E2E_GO_FAKE",
            baseURL: "https://e2e.invalid/v1",
            models: [],
          }),
      });
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      const templateId = "opencode-api";
      const before = new Set((await repository.read()).providers.keys());
      await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON);
      const templateSelector = `[data-provider-template-group="other"] [data-testid="${testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, templateId)}"]`;
      const card = $(templateSelector);
      await card.waitForExist({ timeout: 15_000 });
      for (const legacyId of [
        "opencode-go-chat",
        "opencode-go-messages",
        "opencode-go-responses",
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]) {
        expect(
          await $(
            `[data-testid="${testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, legacyId)}"]`,
          ).isExisting(),
        ).toBe(false);
      }
      await card.scrollIntoView({ block: "center" });
      await card.click();
      let providerId = "";
      await browser.waitUntil(
        async () => {
          providerId =
            (await repository.read()).providers.keys().find((id) => !before.has(id)) ?? "";
          return providerId !== "";
        },
        { timeout: 15_000 },
      );
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      await browser.waitUntil(
        async () =>
          (await $(`[data-testid="${TID_MODEL_PROVIDER_BASE_URL_INPUT}"]`).getValue()) ===
          "https://opencode.ai/zen/go/v1",
        { timeout: 15_000 },
      );
      expect(await $(`[data-testid="${TID_MODEL_PROVIDER_API_FORMAT_TRIGGER}"]`).getText()).toMatch(
        /Chat Completions/i,
      );
      await $(`[data-model-provider-model-id="deepseek-v4.1-flash-free"]`).waitForExist({
        timeout: 15_000,
      });
      expect(await $$("[data-model-provider-model-id]").length).toBe(58);
      expect(
        await $$('//button[normalize-space(.)="获取 API Key" or normalize-space(.)="Get API Key"]')
          .length,
      ).toBe(1);
      const key = $(`[data-testid="${TID_MODEL_PROVIDER_API_KEY_INPUT}"]`);
      await key.setValue("E2E_GO_FAKE_KEY");
      await browser.keys("Tab");
      await browser.waitUntil(
        async () => {
          const access = (await repository.read()).providers.get(providerId)?.access;
          return access?.type === "api-key" && access.apiKey === "E2E_GO_FAKE_KEY";
        },
        { timeout: 15_000 },
      );
      expect((await repository.read()).providers.getRule(providerId)?.templateId).toBe(templateId);
      // 假 Key 仅验证模板创建和存储；协议路由由离线模型配置测试验证。
    } finally {
      repository.dispose();
    }
  });
});
