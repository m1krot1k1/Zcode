import {
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_ITEM,
  TID_TASK_NEW_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { ensureReadonlyToolFixtureFile } from "../conversation-session-readonly-tool.js";
import {
  clickTestIdByDom,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "../desktop-app.js";
import { ensureUpstreamProviderForE2E } from "../upstream-provider.js";
import { inspectConversationComposer } from "./composer.js";
import { LOGIN_API_KEY } from "./constants.js";

interface PrepareConversationE2EOptions {
  resetDraftBeforeProvider?: boolean;
  skipProvider?: boolean;
}

export async function prepareConversationE2E(options: PrepareConversationE2EOptions = {}) {
  await ensureReadonlyToolFixtureFile();
  await ensureConversationShellReady();
  if (options.resetDraftBeforeProvider) {
    // 修复原因：连续 case 可能停在上一条带 goal 的 active session 上。
    // 先进入空草稿，避免 provider 初始化把默认模型断言写到旧 session。
    await startNewTask();
  }
  if (!options.skipProvider) {
    await ensureUpstreamProviderForE2E();
  }
  await ensureConversationDraftReady();
}

async function ensureConversationShellReady() {
  try {
    await waitForDefaultWorkspaceReady(30000);
    return;
  } catch (error) {
    if (!(await hasApiKeyLoginButton())) {
      throw error;
    }

    // 修复原因：renderer target 切换失败时曾被登录兜底吞掉，误报成
    // “欢迎页没有出现 API Key 登录入口”。只有确认当前页面真是欢迎页时才回退登录。
    await loginWithApiKey();
    await waitForDefaultWorkspaceReady(30000);
  }
}

async function hasApiKeyLoginButton() {
  const exists = await browser
    .execute(
      (currentTestId) => Boolean(document.querySelector(`[data-testid="${currentTestId}"]`)),
      TID_LOGIN_USE_API_KEY_BUTTON,
    )
    .catch(() => false);
  return Boolean(exists);
}

export async function loginWithApiKey() {
  await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON, {
    timeout: 30000,
    timeoutMsg: "欢迎页没有出现 API Key 登录入口",
  });
  await setInputValueByTestIdDom(TID_LOGIN_API_KEY_INPUT, LOGIN_API_KEY, {
    timeout: 15000,
    timeoutMsg: "API Key 登录输入框没有出现",
  });
  await waitForApiKeyContinueEnabled();
  await clickTestIdByDom(TID_LOGIN_API_KEY_CONTINUE_BUTTON, {
    timeout: 15000,
    timeoutMsg: "API Key 登录继续按钮没有出现或不可点击",
  });
}

export async function startNewTask() {
  await clickTestIdByDom(TID_TASK_NEW_BUTTON, {
    timeout: 15000,
    timeoutMsg: "侧栏新任务按钮没有出现或不可点击",
  });
  await waitForConversationDraftReady("新建任务后没有进入空草稿态");
}

async function ensureConversationDraftReady() {
  const current = await inspectConversationComposer();
  if (current.displayed && current.draftReady) {
    return;
  }
  await startNewTask();
}

async function waitForConversationDraftReady(timeoutMsg: string) {
  try {
    await browser.waitUntil(
      async () => {
        const current = await inspectConversationComposer();
        return current.displayed && current.draftReady;
      },
      { timeout: 30000, timeoutMsg },
    );
  } catch (error) {
    const diagnostics = await collectConversationDraftDiagnostics();
    throw new Error(`${timeoutMsg}; diagnostics=${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
}

async function collectConversationDraftDiagnostics() {
  const composer = await inspectConversationComposer().catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const visibleTestIds = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((element) => element.getAttribute("data-testid"))
      .filter((value): value is string => Boolean(value))
      .slice(0, 80),
  );
  return { composer, visibleTestIds };
}

export async function selectTaskById(
  taskId: string,
  {
    timeout = 15000,
    timeoutMsg = `任务列表没有可点击的 task: ${taskId}`,
  }: { timeout?: number; timeoutMsg?: string } = {},
) {
  await clickTestIdByDom(testId(TID_TASK_ITEM, taskId), {
    timeout,
    timeoutMsg,
  });
}

async function waitForApiKeyContinueEnabled() {
  await browser.waitUntil(
    async () =>
      browser.execute((continueButtonTestId) => {
        const button = document.querySelector<HTMLElement>(
          `[data-testid="${continueButtonTestId}"]`,
        );
        return button instanceof HTMLButtonElement && !button.disabled;
      }, TID_LOGIN_API_KEY_CONTINUE_BUTTON),
    {
      timeout: 15000,
      timeoutMsg: "API Key 登录继续按钮没有变为可用",
    },
  );
}
