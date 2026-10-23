import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E, setV4ComposerText } from "../../../helpers/v4-conversation.js";
import {
  E2E_OPENCODE_MODEL_ID,
  E2E_OPENCODE_REPLY,
} from "../../../helpers/open-code-cli-fixture.js";

const CASE_NAME = "conversation-session-opencode-cli-composer";
const e2eIt = process.platform === "win32" ? it.skip : it;

describe("OpenCode CLI в обычном Composer", () => {
  after(async () => {
    await clearAppData();
  });

  e2eIt(
    "выбирает модель, создаёт draft и показывает ACP-ответ в том же чате без ZCode provider",
    async function () {
      this.timeout(180_000);
      const marker = `E2E_OPENCODE_COMPOSER_${Date.now()}`;
      const paths = getE2EAppDataPaths();
      const tracePath = join(paths.homeDir, ".opencode", "acp-trace.jsonl");
      const artifactDir = join(
        process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"),
        CASE_NAME,
      );

      await prepareV4ConversationE2E({ skipProvider: true });

      await browser.waitUntil(
        async () =>
          browser.execute(
            (testId) => Boolean(document.querySelector(`[data-testid="${testId}"]`)),
            TID_CHAT_MODEL_SELECT_TRIGGER,
          ),
        { timeout: 30_000, timeoutMsg: "OpenCode CLI не появился в обычном Composer" },
      );
      await browser.$(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).click();
      const modelItemTestId = testId(
        TID_CHAT_MODEL_SELECT_ITEM,
        `zcode-opencode-cli:${E2E_OPENCODE_MODEL_ID}`,
      );
      await browser.waitUntil(
        async () =>
          browser.execute(
            (testId) => Boolean(document.querySelector(`[data-testid="${testId}"]`)),
            modelItemTestId,
          ),
        { timeout: 30_000, timeoutMsg: "OpenCode CLI model catalog не загрузился в Composer" },
      );
      await browser.$(`[data-testid="${modelItemTestId}"]`).click();

      await browser.waitUntil(
        async () =>
          browser.execute(
            (testId, modelId) =>
              document.querySelector(`[data-testid="${testId}"]`)?.textContent?.includes(modelId) ??
              false,
            TID_CHAT_MODEL_SELECT_TRIGGER,
            E2E_OPENCODE_MODEL_ID,
          ),
        { timeout: 10_000, timeoutMsg: "Composer не сохранил выбор OpenCode-модели" },
      );
      await setV4ComposerText(marker);
      await browser.waitUntil(
        async () =>
          browser.execute(
            (testId, marker, sendTestId) => {
              const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
                `[data-testid="${testId}"]`,
              );
              const button = document.querySelector<HTMLButtonElement>(
                `[data-testid="${sendTestId}"]`,
              );
              return input?.value === marker && Boolean(button && !button.disabled);
            },
            TID_V4_COMPOSER_INPUT,
            marker,
            TID_V4_COMPOSER_SEND,
          ),
        { timeout: 15_000, timeoutMsg: "Composer не подготовил marker к отправке" },
      );
      await browser.$(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).click();

      await browser.waitUntil(
        async () =>
          browser.execute(
            (runSelector, marker, reply) => {
              const run = document.querySelector<HTMLElement>(runSelector);
              return Boolean(run?.innerText.includes(marker) && run.innerText.includes(reply));
            },
            "[data-external-agent-run-id]",
            marker,
            E2E_OPENCODE_REPLY,
          ),
        { timeout: 45_000, timeoutMsg: "ACP-ответ не появился в transcript этой беседы" },
      );

      const trace = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; modelId?: string; prompt?: string });
      assert.ok(
        trace.some((entry) => entry.event === "model" && entry.modelId === E2E_OPENCODE_MODEL_ID),
      );
      assert.ok(trace.some((entry) => entry.event === "prompt" && entry.prompt?.includes(marker)));
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "acp-trace.jsonl"), await readFile(tracePath, "utf8"));
      await browser.saveScreenshot(join(artifactDir, "opencode-composer-reply.png"));
    },
  );
});
