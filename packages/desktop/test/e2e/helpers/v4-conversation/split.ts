import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_PANE_SHELL,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import { waitForV4Pane } from "./pane.js";
import type { V4PaneSnapshot } from "./types.js";

// ── M5⑤ 分屏（Layout/Focus 两层）：pane 级定位与焦点断言 ──
// 分屏后同 testid（composer 输入/发送等）在两个 pane 各有一份，全局 helper 只会
// 命中 DOM 序第一个（primary）。以下 helper 一律先按 v4-pane-shell-<paneId>
// 收口作用域再定位，焦点断言读外壳的 data-focused。

/** 读取当前 focused pane 的 paneId（data-focused="true" 的外壳）；无外壳返回 null。 */
export function getV4FocusedPaneId(): Promise<string | null> {
  return browser.execute((shellPrefix) => {
    const focused = document.querySelector<HTMLElement>(
      `[data-testid^="${shellPrefix}-"][data-focused="true"]`,
    );
    return focused?.getAttribute("data-pane-id") ?? null;
  }, TID_V4_PANE_SHELL);
}

/** 对 pane 外壳派发 pointerdown（Focus 层 onPointerDownCapture → focus 该 pane）。 */
export async function focusV4Pane(paneId: string) {
  const dispatched = await browser.execute(
    (shellTestId) => {
      const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
      if (!shell) return false;
      shell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      return true;
    },
    testId(TID_V4_PANE_SHELL, paneId),
  );
  if (!dispatched) {
    throw new Error(`focusV4Pane: pane 外壳不存在: ${paneId}`);
  }
  await browser.waitUntil(async () => (await getV4FocusedPaneId()) === paneId, {
    timeout: 15000,
    timeoutMsg: `pane ${paneId} 没有获得焦点`,
  });
}

/** pane 作用域内点 stop（分屏时全局 TID_V4_STOP 会命中 DOM 序第一个 pane）。 */
export async function clickV4StopInPane(paneId: string) {
  const clicked = await browser.execute(
    (shellTestId, stopTestId) => {
      const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
      const btn = shell?.querySelector<HTMLButtonElement>(`[data-testid="${stopTestId}"]`);
      btn?.click();
      return Boolean(btn);
    },
    testId(TID_V4_PANE_SHELL, paneId),
    TID_V4_STOP,
  );
  if (!clicked) {
    throw new Error(`pane ${paneId} 内没有可点击的 stop 按钮`);
  }
}

/** pane 作用域内点分屏 pane 的 session pane snapshot（按 paneId）。 */
export async function waitForV4PaneById(
  paneId: string,
  predicate: (snapshot: V4PaneSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  return waitForV4Pane(predicate, timeoutMsg, timeout, paneId);
}

/** pane 作用域内写 composer 文本并点发送（同 sendV4Prompt，但按 paneId 收口）。 */
export async function sendV4PromptInPane(paneId: string, prompt: string) {
  const paneShellTestId = testId(TID_V4_PANE_SHELL, paneId);
  // M5：composer 为 Lexical contenteditable——写入走编辑器挂载的 __zcodeLexicalInputE2E
  // bridge（驱动真实 editor state）；bridge.focus() 同时驱动 Focus 层 → composer 归属该 pane。
  await browser.waitUntil(
    async () =>
      browser.execute(
        (shellTestId, inputTestId, nextValue) => {
          const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
          const element = shell?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          if (!element) return false;
          const bridge = (
            element as HTMLElement & {
              __zcodeLexicalInputE2E?: {
                focus: () => void;
                getText: () => string;
                setText: (text: string) => void;
              };
            }
          ).__zcodeLexicalInputE2E;
          if (!bridge) return false;
          bridge.focus();
          bridge.setText(nextValue);
          return bridge.getText() === nextValue;
        },
        paneShellTestId,
        TID_V4_COMPOSER_INPUT,
        prompt,
      ),
    {
      timeout: 15000,
      timeoutMsg: `pane ${paneId} 的 composer 输入框没有出现或不可输入`,
    },
  );
  await browser.waitUntil(
    async () =>
      browser.execute(
        (shellTestId, sendTestId) => {
          const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
          const button = shell?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
          if (!button || button.disabled) return false;
          button.click();
          return true;
        },
        paneShellTestId,
        TID_V4_COMPOSER_SEND,
      ),
    {
      timeout: 30000,
      timeoutMsg: `pane ${paneId} 的发送按钮没有变为可用`,
    },
  );
}
