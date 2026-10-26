import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, clickTestIdByWebDriver } from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";
import { E2E_OPENCODE_MODEL_ID } from "../helpers/open-code-cli-fixture.js";

const CASE_NAME = "conversation-session-opencode-cli-install";
const e2eIt = process.platform === "darwin" ? it : it.skip;
const artifactRoot = process.env.ZCODE_E2E_ARTIFACT_DIR ?? resolve(process.cwd(), ".e2e-artifacts");

describe("OpenCode CLI installation in Model Providers", () => {
  after(async () => {
    await clearAppData();
  });

  e2eIt(
    "installs a missing CLI, verifies it, and exposes its model in the normal Composer",
    async function () {
      this.timeout(420_000);
      await mkdir(join(artifactRoot, CASE_NAME), { recursive: true });
      await prepareV4ConversationE2E({ skipProvider: true });

      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, "agent-integration:opencode-cli"));

      const settingsCard = $('[data-testid="opencode-agent-settings"]');
      await settingsCard.waitForDisplayed({ timeout: 15_000 });
      await browser.waitUntil(
        async () => (await settingsCard.getText()).includes("OpenCode CLI is not installed"),
        {
          timeout: 20_000,
          timeoutMsg: "Изолированный E2E HOME должен начинаться без OpenCode CLI",
        },
      );

      const enabledSwitch = $('[data-testid="opencode-cli-enabled-switch"]');
      if ((await enabledSwitch.getAttribute("aria-checked")) !== "true") {
        await clickTestIdByWebDriver("opencode-cli-enabled-switch");
      }
      await browser.waitUntil(
        async () => (await enabledSwitch.getAttribute("aria-checked")) === "true",
        { timeout: 10_000, timeoutMsg: "OpenCode CLI provider preference не включилась" },
      );

      const installButton = $('[data-testid="opencode-cli-install"]');
      await installButton.waitForClickable({
        timeout: 10_000,
        timeoutMsg: "При отсутствующем CLI не появилась кнопка Install",
      });
      await clickTestIdByWebDriver("opencode-cli-install");

      await browser.waitUntil(
        async () => (await settingsCard.getText()).includes("OpenCode CLI detected (1.19.3)"),
        {
          timeout: 240_000,
          timeoutMsg: "Установка не завершилась повторной проверкой OpenCode CLI",
        },
      );
      await browser.waitUntil(
        async () => !((await installButton.isExisting()) && (await installButton.isDisplayed())),
        { timeout: 15_000, timeoutMsg: "Кнопка Install осталась после успешной проверки CLI" },
      );

      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      await browser.waitUntil(
        async () => browser.execute(() => !document.querySelector('[data-testid="settings-page"]')),
        { timeout: 15_000, timeoutMsg: "Не вернулись из настроек в чат" },
      );

      await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).click();
      const providerTrigger = $('[data-testid="composer-provider-trigger"]');
      await providerTrigger.waitForClickable({
        timeout: 45_000,
        timeoutMsg: "Проверенный OpenCode CLI provider не появился в Composer",
      });
      await providerTrigger.click();
      const providerGroup = $('[data-model-provider-key="registry-provider:opencode"]');
      await providerGroup.waitForClickable({
        timeout: 30_000,
        timeoutMsg: "OpenCode CLI provider group не появился в выборе модели",
      });
      await providerGroup.click();

      const expectedModelValue = encodeCustomModelValue("opencode", E2E_OPENCODE_MODEL_ID);
      const modelItem = $(
        `[data-testid="${testId(TID_CHAT_MODEL_SELECT_ITEM, expectedModelValue)}"]`,
      );
      await modelItem.waitForExist({
        timeout: 30_000,
        timeoutMsg: "Установленный OpenCode CLI не опубликовал модель в Composer",
      });
      await modelItem.click();
      await browser.waitUntil(
        async () =>
          browser.execute(
            (testId, modelValue) =>
              document
                .querySelector(`[data-testid="${testId}"]`)
                ?.getAttribute("data-model-current-value") === modelValue,
            TID_CHAT_MODEL_SELECT_TRIGGER,
            expectedModelValue,
          ),
        { timeout: 10_000, timeoutMsg: "Composer не сохранил выбранную OpenCode модель" },
      );

      // Этот сценарий доказывает установку и выбор модели. Он не запускает auth-команду и не отправляет prompt.
      const e2eHome = process.env.ZCODE_E2E_HOME_DIR;
      assert.ok(e2eHome, "WDIO должен задать изолированный HOME");
      await access(join(e2eHome, ".opencode", "bin", "opencode"));
      await writeFile(
        join(artifactRoot, CASE_NAME, "verified-install.txt"),
        `version=1.19.3\nmodel=${E2E_OPENCODE_MODEL_ID}\n`,
      );
      await browser.saveScreenshot(
        join(artifactRoot, CASE_NAME, "opencode-cli-installed-model-selectable.png"),
      );
    },
  );
});
