import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_MODEL_PROVIDER_NAV_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
} from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  setV4ComposerText,
  waitForV4ComposerText,
  clickV4Send,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";
import {
  E2E_OPENCODE_MODEL_ID,
  E2E_OPENCODE_COMPOSER_TRACE_FILE,
  E2E_OPENCODE_REPLY,
} from "../../../helpers/open-code-cli-fixture.js";
import { sel } from "../../../helpers/selectors.js";

const CASE_NAME = "conversation-session-opencode-cli-composer";
const e2eIt = process.platform === "win32" ? it.skip : it;

describe("OpenCode CLI в обычном Composer", () => {
  after(async () => {
    await clearAppData();
  });

  e2eIt(
    "выбирает opencode/* в picker, отправляет текст и получает ответ в том же v4 timeline без ZCode API provider",
    async function () {
      this.timeout(180_000);
      const marker = `E2E_OPENCODE_COMPOSER_${Date.now()}`;
      const artifactDir = join(
        process.env.ZCODE_E2E_ARTIFACT_DIR ??
          join(process.cwd(), ".e2e-artifacts"),
        CASE_NAME,
      );
      // Трасса живёт вне временного E2E-профиля, который удаляется в after-hook.
      const tracePath = join(
        process.env.ZCODE_E2E_ARTIFACT_DIR ??
          join(process.cwd(), ".e2e-artifacts"),
        E2E_OPENCODE_COMPOSER_TRACE_FILE,
      );

      await prepareV4ConversationE2E({ skipProvider: true });

      // Проверяем весь пользовательский переход: каталог не должен теряться после
      // выключения/включения CLI и возврата из настроек в тот же Composer.
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(
        testId(TID_MODEL_PROVIDER_NAV_ITEM, "agent-integration:opencode-cli"),
      );
      const enabledSwitchTestId = "opencode-cli-enabled-switch";
      const enabledSwitch = $(`[data-testid="${enabledSwitchTestId}"]`);
      await enabledSwitch.waitForDisplayed({ timeout: 15_000 });
      const initialEnabled =
        (await enabledSwitch.getAttribute("aria-checked")) === "true";
      if (initialEnabled) await clickTestIdByWebDriver(enabledSwitchTestId);
      await browser.waitUntil(
        async () =>
          (await enabledSwitch.getAttribute("aria-checked")) === "false",
        {
          timeout: 10_000,
          timeoutMsg: "OpenCode CLI не выключился в настройках",
        },
      );
      await clickTestIdByWebDriver(enabledSwitchTestId);
      await browser.waitUntil(
        async () =>
          (await enabledSwitch.getAttribute("aria-checked")) === "true",
        {
          timeout: 10_000,
          timeoutMsg: "OpenCode CLI не включился повторно в настройках",
        },
      );
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      await browser.waitUntil(
        async () =>
          browser.execute(
            () => !document.querySelector('[data-testid="settings-page"]'),
          ),
        { timeout: 15_000, timeoutMsg: "Не вернулись из настроек в чат" },
      );

      await browser.waitUntil(
        async () =>
          browser.execute(
            (testId) =>
              Boolean(document.querySelector(`[data-testid="${testId}"]`)),
            TID_CHAT_MODEL_SELECT_TRIGGER,
          ),
        {
          timeout: 30_000,
          timeoutMsg: "OpenCode CLI не появился в обычном Composer",
        },
      );
      await browser
        .$(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`)
        .click();
      // Composer 默认展示当前 provider 的模型；OpenCode 目录在 provider submenu 里。
      // 点中 provider 后弹层保持打开，并自动选中该目录的第一个模型。
      const providerTrigger = browser.$(
        '[data-testid="composer-provider-trigger"]',
      );
      await providerTrigger.waitForClickable({
        timeout: 30_000,
        timeoutMsg: "Composer provider trigger не появился",
      });
      await providerTrigger.click();
      const providerGroup = browser.$(
        '[data-model-provider-key="registry-provider:opencode"]',
      );
      await providerGroup.waitForClickable({
        timeout: 30_000,
        timeoutMsg: "OpenCode CLI provider group не появился в Composer",
      });
      await providerGroup.click();
      const expectedModelValue = encodeCustomModelValue(
        "opencode",
        E2E_OPENCODE_MODEL_ID,
      );
      const modelItemTestId = testId(
        TID_CHAT_MODEL_SELECT_ITEM,
        expectedModelValue,
      );
      const modelItem = browser.$(`[data-testid="${modelItemTestId}"]`);
      await modelItem.waitForExist({
        timeout: 30_000,
        timeoutMsg: "OpenCode CLI model catalog не загрузился в Composer",
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
        {
          timeout: 10_000,
          timeoutMsg: "Composer не сохранил выбор OpenCode-модели",
        },
      );
      const swarmToggle = browser.$('[data-testid="v4-composer-swarm-toggle"]');
      await swarmToggle.waitForDisplayed({ timeout: 10_000 });
      expect(await swarmToggle.getAttribute("aria-pressed")).toBe("false");
      await setV4ComposerText(marker);
      await waitForV4ComposerText(
        marker,
        "Composer не подготовил marker к отправке",
      );
      await clickV4Send();

      await waitForV4AssistantMessageContaining(E2E_OPENCODE_REPLY, 45_000);
      const ordinaryTrace = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { event: string; prompt?: string },
        );
      const ordinaryMarkerRequests = ordinaryTrace.filter(
        (entry) => entry.event === "prompt" && entry.prompt?.includes(marker),
      );
      assert.equal(
        ordinaryMarkerRequests.length,
        1,
        "Обычная отправка OpenCode должна сделать один прямой запрос без planner",
      );
      assert.equal(
        ordinaryTrace.some(
          (entry) =>
            entry.event === "prompt" &&
            entry.prompt?.includes(
              "Decide whether this task needs independent parallel work",
            ),
        ),
        false,
        "Обычный чат не должен запускать скрытую декомпозицию",
      );

      const swarmMarker = `E2E_OPENCODE_SWARM_ROOT_${Date.now()}`;
      await setV4ComposerText(swarmMarker);
      await waitForV4ComposerText(
        swarmMarker,
        "OpenCode swarm marker не появился в Composer",
      );
      await swarmToggle.click();
      await browser.waitUntil(
        async () => (await swarmToggle.getAttribute("aria-pressed")) === "true",
        {
          timeout: 5_000,
          timeoutMsg: "Явный переключатель OpenCode swarm не включился",
        },
      );
      await clickV4Send();
      await waitForV4AssistantMessageContaining(
        "E2E_OPENCODE_SWARM_SYNTHESIS_DONE",
        90_000,
      );
      const swarmEvidence = await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const row = Array.from(
              document.querySelectorAll<HTMLElement>(
                '[data-row-kind="swarmRun"]',
              ),
            ).find(
              (candidate) =>
                candidate.getAttribute("data-status") === "completed" &&
                candidate.querySelectorAll(
                  'ul li > button[data-testid^="v4-subagent-open-side-pane-"]',
                ).length === 2,
            );
            if (!row) return null;
            return {
              status: row.dataset.status,
              runId: row.dataset.swarmRunId,
              childSessionIds: Array.from(
                row.querySelectorAll<HTMLButtonElement>(
                  'ul li > button[data-testid^="v4-subagent-open-side-pane-"]',
                ),
              )
                .map((button) =>
                  button.dataset.testid?.replace(
                    /^v4-subagent-open-side-pane-/u,
                    "",
                  ),
                )
                .filter(Boolean),
            };
          }),
        {
          interval: 150,
          timeout: 60_000,
          timeoutMsg:
            "OpenCode model planner не породил две реальные ZCode child sessions",
        },
      );
      expect(swarmEvidence).toMatchObject({
        status: "completed",
        runId: expect.stringMatching(/^swarm_/u),
      });
      expect(swarmEvidence?.childSessionIds).toHaveLength(2);
      expect(new Set(swarmEvidence?.childSessionIds).size).toBe(2);

      const traceRaw = await readFile(tracePath, "utf8");
      const trace = traceRaw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              event: string;
              prompt?: string;
              model?: { providerID?: string; modelID?: string } | null;
            },
        );
      const promptTrace = trace.find(
        (entry) => entry.event === "prompt" && entry.prompt?.includes(marker),
      );
      // Раньше canned-ответ мог пройти тест без trace и без запроса к OpenCode.
      assert.ok(promptTrace, "mock OpenCode не получил отправленный marker");
      const [expectedProviderID, expectedModelID] = E2E_OPENCODE_MODEL_ID.split(
        "/",
        2,
      );
      assert.deepEqual(promptTrace.model, {
        providerID: expectedProviderID,
        modelID: expectedModelID,
      });

      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "composer-trace.jsonl"), traceRaw);
      await browser.saveScreenshot(
        join(artifactDir, "opencode-composer-reply.png"),
      );
    },
  );
});
