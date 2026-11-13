import {
  TID_CHAT_INPUT,
  TID_CHAT_SEND_BUTTON,
  TID_CHAT_STOP_BUTTON,
  TID_CHAT_VIEW,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import AppPage from "../../pages/app.page.js";
import { clickTestIdByDom, setInputValueByTestIdDom } from "../desktop-app.js";

type LexicalInputE2EBridge = {
  focus: () => void;
  getText: () => string;
  setText: (text: string) => void;
};

type LexicalInputE2EElement = HTMLElement & {
  __zcodeLexicalInputE2E?: LexicalInputE2EBridge;
};

export function inspectConversationComposer(): Promise<{
  displayed: boolean;
  draftReady: boolean;
  inputTestId: string | null;
  variant: "legacy" | "v4" | null;
}> {
  return browser.execute(
    (v4InputTestId, legacyInputTestId, v4PaneTestId, legacyViewTestId) => {
      const isDisplayed = (element: Element | null) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const v4Input = document.querySelector(`[data-testid="${v4InputTestId}"]`);
      if (isDisplayed(v4Input)) {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${v4PaneTestId}"]`);
        return {
          displayed: true,
          draftReady: pane?.getAttribute("data-session-id") === "draft",
          inputTestId: v4InputTestId,
          variant: "v4" as const,
        };
      }
      const legacyInput = document.querySelector(`[data-testid="${legacyInputTestId}"]`);
      const root = document.querySelector<HTMLElement>(`[data-testid="${legacyViewTestId}"]`);
      return {
        displayed: isDisplayed(legacyInput),
        draftReady:
          Boolean(root) &&
          !root?.getAttribute("data-task-id") &&
          !root?.getAttribute("data-session-id") &&
          root?.getAttribute("data-state") === "idle" &&
          root?.getAttribute("data-model-switch-pending") !== "true",
        inputTestId: isDisplayed(legacyInput) ? legacyInputTestId : null,
        variant: isDisplayed(legacyInput) ? ("legacy" as const) : null,
      };
    },
    TID_V4_COMPOSER_INPUT,
    TID_CHAT_INPUT,
    testId(TID_V4_SESSION_PANE, "workspace-main"),
    TID_CHAT_VIEW,
  );
}

export async function sendPrompt(prompt: string) {
  await typeChatPrompt(prompt);
  await clickChatSend();
}

export async function typeChatPrompt(prompt: string) {
  const composer = await inspectConversationComposer();
  if (composer.variant === "v4") {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, prompt, {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    return;
  }
  await AppPage.chatInput.waitForDisplayed({ timeout: 15000 });
  await AppPage.chatInput.click();
  const lexicalBridgeResult = await writePromptWithLexicalBridge(prompt);
  if (lexicalBridgeResult.ok) {
    return;
  }

  if (shouldTypePromptWithKeyboard(prompt) && (await getComposerText()) === "") {
    // 修复原因：Lexical bridge 是稳定路径；只有 bridge 未挂载时才退回真实键盘输入。
    // 这仍能触发 React draft 状态，避免旧 DOM 兜底只改可见文本。
    await browser.keys(prompt);
    await browser.waitUntil(async () => (await getComposerText()) === prompt.trim(), {
      timeout: 10000,
      timeoutMsg: `聊天输入框没有通过键盘写入 prompt: ${prompt}`,
    });
    return;
  }

  // 修复原因：Lexical E2E bridge 理论上总会随输入框挂载；这里保留旧 DOM 写法只作为
  // bridge 尚未初始化时的兜底，并把原因带进失败上下文，避免 slash command 再次静默丢状态。
  const result = (await browser.executeAsync(
    (inputTestId, text, bridgeReason, done) => {
      const input = document.querySelector<LexicalInputE2EElement>(
        `[data-testid="${inputTestId}"]`,
      );
      if (!input) {
        done({
          actual: "",
          inserted: false,
          ok: false,
          reason: "input-missing",
        });
        return;
      }

      input.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("delete");

      let inserted = true;
      const lines = text.split("\n");
      for (const [lineIndex, line] of lines.entries()) {
        inserted = document.execCommand("insertText", false, line) && inserted;
        if (lineIndex < lines.length - 1) {
          inserted = document.execCommand("insertLineBreak") && inserted;
        }
      }

      requestAnimationFrame(() => {
        const actual = (input.innerText || input.textContent || "").replace(/\u00a0/g, " ").trim();
        done({
          actual,
          bridgeReason,
          inserted,
          ok: actual === text.trim(),
        });
      });
    },
    TID_CHAT_INPUT,
    prompt,
    lexicalBridgeResult.reason ?? "bridge-unavailable",
  )) as {
    actual: string;
    bridgeReason?: string;
    inserted: boolean;
    ok: boolean;
    reason?: string;
  };

  if (!result.ok) {
    throw new Error(`聊天输入框没有写入完整 prompt: ${JSON.stringify(result)}`);
  }
}

function shouldTypePromptWithKeyboard(prompt: string) {
  // 修复原因：可见 slash 命令 case 验证的是命令分发本身，不是 slash panel 选项。
  // 真实键盘输入会打开 Lexical slash suggestion，CI 慢帧里可能把 `/goal`
  // 变成 suggestion 的编辑器状态，导致点击发送后没有产生可见 user query。
  return !prompt.includes("\n") && !isVisibleSlashCommandPrompt(prompt);
}

function isVisibleSlashCommandPrompt(prompt: string) {
  return /^\/(?:goal|target|compact|compress)(?:\s|$)/i.test(prompt.trim());
}

async function writePromptWithLexicalBridge(prompt: string): Promise<{
  actual?: string;
  ok: boolean;
  reason?: string;
}> {
  try {
    await browser.waitUntil(
      async () =>
        browser.execute((inputTestId) => {
          const input = document.querySelector<LexicalInputE2EElement>(
            `[data-testid="${inputTestId}"]`,
          );
          return Boolean(input?.__zcodeLexicalInputE2E);
        }, TID_CHAT_INPUT),
      {
        timeout: 5000,
        timeoutMsg: "聊天输入框 Lexical E2E bridge 没有就绪",
      },
    );
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const setResult = (await browser.execute(
    (inputTestId, text) => {
      try {
        const input = document.querySelector<LexicalInputE2EElement>(
          `[data-testid="${inputTestId}"]`,
        );
        const bridge = input?.__zcodeLexicalInputE2E;
        if (!bridge) {
          return { ok: false, reason: "bridge-missing" };
        }
        bridge.setText(text);
        bridge.focus();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    TID_CHAT_INPUT,
    prompt,
  )) as { ok: boolean; reason?: string };

  if (!setResult.ok) {
    return setResult;
  }

  let latest: {
    bridgeText?: string;
    domText?: string;
    ok: boolean;
    reason?: string;
  } = {
    ok: false,
  };
  try {
    await browser.waitUntil(
      async () => {
        latest = await readLexicalBridgePromptSnapshot();
        return latest.bridgeText === prompt.trim();
      },
      {
        timeout: 10000,
        timeoutMsg: `聊天输入框没有通过 Lexical bridge 写入 prompt: ${prompt}`,
      },
    );
  } catch (error) {
    throw new Error(
      `聊天输入框没有通过 Lexical bridge 写入 prompt: ${prompt}; latest=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
  return { actual: latest.bridgeText, ok: true };
}

function readLexicalBridgePromptSnapshot(): Promise<{
  bridgeText?: string;
  domText?: string;
  ok: boolean;
  reason?: string;
}> {
  return browser.execute((inputTestId) => {
    try {
      const input = document.querySelector<LexicalInputE2EElement>(
        `[data-testid="${inputTestId}"]`,
      );
      const bridge = input?.__zcodeLexicalInputE2E;
      if (!bridge) {
        return { ok: false, reason: "bridge-missing" };
      }
      return {
        bridgeText: bridge.getText().trim(),
        domText: (input.innerText || input.textContent || "").replace(/\u00a0/g, " ").trim(),
        ok: true,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }, TID_CHAT_INPUT);
}

export async function clickChatSend() {
  const sendButtonTestId = await resolveVisibleComposerControlTestId(
    TID_V4_COMPOSER_SEND,
    TID_CHAT_SEND_BUTTON,
  );
  await browser.waitUntil(
    async () =>
      browser.execute((sendButtonTestId) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-testid="${sendButtonTestId}"]`,
        );
        return Boolean(button && !button.disabled);
      }, sendButtonTestId),
    {
      timeout: 30000,
      timeoutMsg: "聊天发送按钮没有变为可用",
    },
  );
  await clickTestIdByDom(sendButtonTestId, {
    timeout: 15000,
    timeoutMsg: "聊天发送按钮没有出现或不可点击",
  });
}

export async function clickChatStop() {
  const stopButtonTestId = await resolveVisibleComposerControlTestId(
    TID_V4_STOP,
    TID_CHAT_STOP_BUTTON,
  );
  await clickTestIdByDom(stopButtonTestId, {
    timeout: 30000,
    timeoutMsg: "聊天停止按钮没有出现或不可点击",
  });
}

export async function waitForComposerText(expected: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await getComposerText()) === expected, {
    timeout: 10000,
    timeoutMsg,
  });
}

export function getComposerText() {
  return browser.execute(
    (inputTestIds) => {
      const input = inputTestIds
        .map((inputTestId) => document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`))
        .find(Boolean);
      return (input?.innerText || input?.textContent || "").replace(/\u00a0/g, " ").trim();
    },
    [TID_V4_COMPOSER_INPUT, TID_CHAT_INPUT],
  );
}

async function resolveVisibleComposerControlTestId(v4TestId: string, legacyTestId: string) {
  return browser.execute(
    (testIds) => {
      const visible = testIds.find((currentTestId) => {
        const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
      return visible ?? testIds[0]!;
    },
    [v4TestId, legacyTestId],
  );
}
