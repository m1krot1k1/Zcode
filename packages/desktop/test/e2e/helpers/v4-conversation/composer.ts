import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  TID_V4_STOP,
  TID_V4_TIMELINE,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, setInputValueByTestIdDom } from "../desktop-app.js";
import { V4_MAIN_PANE_ID } from "./constants.js";
import { getV4ConversationState } from "./pane.js";

/**
 * v4 composer 输入（M5 起为 Lexical contenteditable）：写入走
 * setInputValueByTestIdDom 的 __zcodeLexicalInputE2E bridge 分支（驱动真实 editor state）。
 */
export async function sendV4Prompt(prompt: string) {
  await setV4ComposerText(prompt);
  const mainPaneTestId = testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID);
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (paneTestId, sendButtonTestId) => {
            const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
            const button = pane?.querySelector<HTMLButtonElement>(
              `[data-testid="${sendButtonTestId}"]`,
            );
            return Boolean(button && !button.disabled);
          },
          mainPaneTestId,
          TID_V4_COMPOSER_SEND,
        ),
      {
        timeout: 30000,
        timeoutMsg: "v4 发送按钮没有变为可用",
      },
    );
  } catch (error) {
    // 修复原因：会话切换竞态发生时，单独的“按钮 disabled”无法区分 projection connecting、
    // 上一轮仍在运行或 composer 未写入；把失败瞬间的 DOM 状态带回日志，避免继续靠猜测修复。
    const diagnostics = await browser.execute(
      (paneTestId, inputTestId, sendTestId, stopTestId) => {
        const panes = Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid^="${paneTestId}"]`),
        );
        const active = document.activeElement as HTMLElement | null;
        return {
          activeTestId: active?.getAttribute("data-testid") ?? null,
          panes: panes.map((pane) => {
            const input = pane.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
            const send = pane.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
            return {
              paneTestId: pane.getAttribute("data-testid"),
              sessionId: pane.getAttribute("data-session-id"),
              inputText: input?.innerText ?? input?.textContent ?? null,
              sendDisabled: send?.disabled ?? null,
              sendTitle: send?.getAttribute("title") ?? null,
              canStop: Boolean(pane.querySelector(`[data-testid="${stopTestId}"]`)),
            };
          }),
        };
      },
      TID_V4_SESSION_PANE,
      TID_V4_COMPOSER_INPUT,
      TID_V4_COMPOSER_SEND,
      TID_V4_STOP,
    );
    throw new Error(`v4 发送按钮没有变为可用; diagnostics=${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
  const submitResult = await browser.execute(
    (paneTestId, sendButtonTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const button = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendButtonTestId}"]`);
      if (!pane) return { submitted: false, reason: "pane-missing" };
      if (!button) return { submitted: false, reason: "button-missing" };
      if (button.disabled) return { submitted: false, reason: "button-disabled" };

      const form = button.closest("form");
      if (!form) {
        button.click();
        return { submitted: true, method: "click-fallback" };
      }

      let submitEventSeen = false;
      const onSubmit = () => {
        submitEventSeen = true;
      };
      form.addEventListener("submit", onSubmit, { capture: true, once: true });
      form.requestSubmit(button);
      return {
        submitted: submitEventSeen,
        method: "request-submit",
        reason: submitEventSeen ? undefined : "submit-event-not-seen",
      };
    },
    mainPaneTestId,
    TID_V4_COMPOSER_SEND,
  );
  if (!submitResult.submitted) {
    throw new Error(`v4 composer 没有派发 submit 事件: ${JSON.stringify(submitResult)}`);
  }
}

/**
 * 发送普通 prompt 并等待 renderer 明确接受：主 pane composer 清空且真实 user row 出现。
 * 不重试 submit，避免首发已进入 Host、但慢渲染尚未投影时重复发送同一条消息。
 */
export async function sendV4PromptAndWaitAccepted(
  prompt: string,
  userMessageMarker: string,
  timeoutMsg: string,
  timeout = 60_000,
) {
  await sendV4Prompt(prompt);
  let latest: {
    composerText: string | null;
    paneExists: boolean;
    sendDisabled: boolean | null;
    sessionId: string | null;
    userMessageSeen: boolean;
  } | null = null;
  const readAcceptance = () =>
    browser.execute(
      (paneTestId, inputTestId, sendTestId, timelineTestId, marker) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const input = pane?.querySelector<
          HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } }
        >(`[data-testid="${inputTestId}"]`);
        const send = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
        const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
        const userMessageSeen = Array.from(
          timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
        ).some(
          (row) =>
            row.classList.contains("group/user-row") &&
            (row.innerText || row.textContent || "").includes(marker),
        );
        return {
          composerText: input?.__zcodeLexicalInputE2E?.getText() ?? null,
          paneExists: Boolean(pane),
          sendDisabled: send?.disabled ?? null,
          sessionId: pane?.getAttribute("data-session-id") ?? null,
          userMessageSeen,
        };
      },
      testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
      TID_V4_COMPOSER_INPUT,
      TID_V4_COMPOSER_SEND,
      TID_V4_TIMELINE,
      userMessageMarker,
    );

  try {
    await browser.waitUntil(
      async () => {
        latest = await readAcceptance();
        return latest.composerText === "" && latest.userMessageSeen;
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await readAcceptance().catch(() => latest);
    const state = await getV4ConversationState().catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError),
    }));
    throw new Error(
      `${timeoutMsg}; acceptance=${JSON.stringify(latest)}; state=${JSON.stringify(state)}`,
      { cause: error },
    );
  }
}

/** 只写入 v4 composer，不触发发送。 */
export async function setV4ComposerText(text: string) {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, text, {
    timeout: 15000,
    timeoutMsg: "v4 composer 输入框没有出现或不可输入",
  });
}

export async function waitForV4ComposerText(expected: string, timeoutMsg: string, timeout = 10000) {
  await browser.waitUntil(async () => (await getV4ComposerText()) === expected, {
    timeout,
    timeoutMsg,
  });
}

/** 点击 v4 composer 发送按钮（输入已由调用方写入，如 slash 命令）。 */
export async function clickV4Send() {
  await browser.waitUntil(
    async () =>
      browser.execute((sendButtonTestId) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-testid="${sendButtonTestId}"]`,
        );
        return Boolean(button && !button.disabled);
      }, TID_V4_COMPOSER_SEND),
    {
      timeout: 30000,
      timeoutMsg: "v4 发送按钮没有变为可用",
    },
  );
  await clickTestIdByDom(TID_V4_COMPOSER_SEND, {
    timeout: 15000,
    timeoutMsg: "v4 发送按钮没有出现或不可点击",
  });
}

/** 读取 composer 当前文本（Lexical E2E bridge）。bridge 未挂载返回 null。 */
export function getV4ComposerText(): Promise<string | null> {
  return browser.execute((inputTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    const bridge = (
      element as (HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } }) | null
    )?.__zcodeLexicalInputE2E;
    return bridge ? bridge.getText() : null;
  }, TID_V4_COMPOSER_INPUT);
}

/** composer 本体或其 Lexical 子节点当前是否持有焦点。 */
export function isV4ComposerFocused(): Promise<boolean> {
  return browser.execute((inputTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    return Boolean(element && document.activeElement && element.contains(document.activeElement));
  }, TID_V4_COMPOSER_INPUT);
}
