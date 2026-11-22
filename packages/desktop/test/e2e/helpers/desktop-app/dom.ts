import { basename } from "node:path";
import { sel } from "../selectors.js";

export function readExactTestIdAttribute(testId: string, attributeName: string): string | null {
  // Bug 根因：Windows workspacePath 含反斜杠，直接拼入 CSS selector 会被当成转义字符。
  // 枚举稳定的 data-testid 节点后按属性值比较，同时兼容 Windows 和 macOS 原生路径。
  const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
    (item) => item.dataset.testid === testId,
  );
  return element?.getAttribute(attributeName) ?? null;
}

export function dispatchMouseDownByExactTestId(testId: string): boolean {
  // Bug 根因：Skill option id 包含 Windows 绝对路径，反斜杠直接拼入 CSS selector
  // 会被当成转义字符。按属性值比较后派发 mousedown，兼容所有原生路径格式。
  const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
    (item) => item.dataset.testid === testId,
  );
  if (!element) {
    return false;
  }
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  return true;
}

async function hasTestId(testId: string) {
  const value = await browser.execute(readExactTestIdAttribute, testId, "data-testid");
  return value === testId;
}

interface DomTestIdOptions {
  timeout?: number;
  timeoutMsg?: string;
}

interface SetInputValueByTestIdDomOptions extends DomTestIdOptions {
  /** 等待异步恢复收口后，重新建立并验证 Lexical 末尾光标。 */
  stabilizeLexicalCaretAtEnd?: boolean;
}

export async function waitForTestIdByDom(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有渲染 test id: ${testId}` }: DomTestIdOptions = {},
) {
  await browser.waitUntil(async () => hasTestId(testId), {
    timeout,
    timeoutMsg,
  });
}

export async function clickTestIdByDom(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可点击的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  // 修复原因：Electron Linux 容器里的 Chromium 会把部分设置页元素排到超大坐标，
  // WebDriver clickable 会误判失败。DOM click 仍触发 React onClick，可专注验证业务逻辑。
  let latestReason = "not-started";
  try {
    await browser.waitUntil(
      async () => {
        const latest = (await browser.execute((currentTestId) => {
          const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (item) => item.dataset.testid === currentTestId,
          );
          if (!element) {
            return { clicked: false, reason: "missing" };
          }
          const disabled =
            (element instanceof HTMLButtonElement ||
              element instanceof HTMLInputElement ||
              element instanceof HTMLSelectElement ||
              element instanceof HTMLTextAreaElement) &&
            element.disabled;
          if (disabled) {
            return { clicked: false, reason: "disabled" };
          }
          element.click();
          return { clicked: true };
        }, testId)) as { clicked: boolean; reason?: string };
        latestReason = latest.reason ?? "clicked";
        return latest.clicked;
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    // 修复原因：React/Radix 控件可能在等待命中后的下一帧重挂载。
    // 等待和点击必须在同一次 DOM 查询内完成，否则偶发 missing 会污染 e2e 认证。
    throw new Error(`${timeoutMsg}: ${latestReason}`, {
      cause: error,
    });
  }
}

export async function clickTestIdByWebDriver(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可点击的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  // Bug 根因：Radix DropdownMenu/Select 的 trigger 依赖 pointerdown 手势，
  // element.click() 只派发 click，测试会误报 portal item 不存在。这里保留真实
  // WebDriver 指针链，只给明确使用此类 trigger 的 case 调用。
  const element = $(sel(testId));
  await element.waitForClickable({ timeout, timeoutMsg });
  await element.click();
}

export async function hoverTestIdByWebDriver(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可悬停的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  const element = $(sel(testId));
  await element.waitForDisplayed({ timeout, timeoutMsg });
  await element.moveTo();
}

export async function setInputValueByTestIdDom(
  testId: string,
  value: string,
  {
    stabilizeLexicalCaretAtEnd = false,
    timeout = 10000,
    timeoutMsg = `页面没有可输入的 test id: ${testId}`,
  }: SetInputValueByTestIdDomOptions = {},
) {
  // 修复原因：同一类容器坐标异常会让输入框无法通过 WebDriver 聚焦。
  // 这里使用原生 value setter 并派发 input/change/blur，继续走页面保存逻辑。
  // M5：v4 composer 恢复为 Lexical contenteditable——写入改走编辑器挂载的
  // __zcodeLexicalInputE2E bridge（驱动真实 editor state，避免 DOM 直改绕过 Lexical）。
  // bridge 由 E2ELexicalInputBridgePlugin 短轮询补挂，可能晚于节点出现，故带重试。
  await waitForTestIdByDom(testId, { timeout, timeoutMsg });
  type SetInputResult = {
    ok: boolean;
    reason?: string;
    tagName?: string | null;
    value?: string;
  };
  let result: SetInputResult = { ok: false, reason: "not-attempted" };
  const attempt = async () => {
    result = (await browser.execute(
      (currentTestId, nextValue) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === currentTestId,
        );
        if (
          element &&
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement) &&
          (element.isContentEditable || element.hasAttribute("data-e2e-lexical-bridge"))
        ) {
          const bridge = (
            element as HTMLElement & {
              __zcodeLexicalInputE2E?: {
                focus: () => void;
                getText: () => string;
                setText: (text: string) => void;
              };
            }
          ).__zcodeLexicalInputE2E;
          if (!bridge) {
            return {
              ok: false,
              reason: "lexical-bridge-not-ready",
              tagName: element.tagName,
            };
          }
          // Bugfix: Lexical editor.update 在微任务里才 commit，setText 后同步 getText 读到旧值。
          // 这里先读当前值命中即成功，否则写入并标记 pending，交由外层 waitUntil 轮询确认。
          if (bridge.getText() === nextValue) {
            return { ok: true, value: nextValue };
          }
          bridge.focus();
          bridge.setText(nextValue);
          return {
            ok: false,
            reason: "lexical-pending",
            value: bridge.getText(),
          };
        }
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return {
            ok: false,
            reason: "not-input",
            tagName: element?.tagName ?? null,
          };
        }
        if (element.disabled || element.readOnly) {
          return {
            ok: false,
            reason: "not-editable",
            tagName: element.tagName,
          };
        }

        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        element.focus();
        if (descriptor?.set) {
          descriptor.set.call(element, nextValue);
        } else {
          element.value = nextValue;
        }
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: nextValue,
            inputType: "insertText",
          }),
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: element.value === nextValue, value: element.value };
      },
      testId,
      value,
    )) as SetInputResult;
    return result;
  };
  await browser
    .waitUntil(
      async () => {
        const current = await attempt();
        // Bug 根因：点击行内编辑后 React 会把 user row 重挂载；waitForTestId 与
        // execute 之间可能正好处在旧节点卸载、新 Lexical 节点尚未挂载的帧。
        // missing 不是“选择器指向非输入框”的终态，必须和 bridge 初始化一起重试。
        return (
          current.ok ||
          (current.reason !== "lexical-bridge-not-ready" &&
            current.reason !== "lexical-pending" &&
            !(current.reason === "not-input" && current.tagName === null))
        );
      },
      { timeout, timeoutMsg },
    )
    .catch(() => undefined);

  if (!result.ok) {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(result)}`);
  }

  if (stabilizeLexicalCaretAtEnd) {
    // Bug 原因：task 切换时 pane 会先变更 sessionId，Lexical 的草稿恢复和自动
    // 聚焦则在后续 RAF 完成。普通 setText 虽已写入文本，caret 仍可能被迟到
    // 的恢复移到文本前。该选项默认关闭，只让需要跨恢复稳定末尾 caret 的 case 显式启用。
    type LexicalCaretResult = {
      ok: boolean;
      reason?: string;
      text?: string;
    };
    let caretResult: LexicalCaretResult = { ok: false, reason: "not-attempted" };
    try {
      await browser.waitUntil(
        async () => {
          caretResult = (await browser.executeAsync(
            (currentTestId, nextValue, done) => {
              // ConversationComposer 的草稿恢复与聚焦各占一层 RAF；等它们收口后
              // 再用同一 bridge 重放 setText，避免只看到 sessionId 更新就提前写入。
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const element = Array.from(
                    document.querySelectorAll<HTMLElement>("[data-testid]"),
                  ).find((item) => item.dataset.testid === currentTestId) as
                    | (HTMLElement & {
                        __zcodeLexicalInputE2E?: {
                          focus: () => void;
                          getText: () => string;
                          setText: (text: string) => void;
                        };
                      })
                    | undefined;
                  const bridge = element?.__zcodeLexicalInputE2E;
                  if (!element?.isContentEditable || !bridge) {
                    done({ ok: false, reason: "lexical-not-editable" });
                    return;
                  }

                  bridge.setText(nextValue);
                  bridge.focus();
                  requestAnimationFrame(() => {
                    const selection = window.getSelection();
                    const focusNode = selection?.focusNode ?? null;
                    const trailingRange = document.createRange();
                    if (focusNode !== null && element.contains(focusNode) && selection) {
                      trailingRange.setStart(focusNode, selection.focusOffset);
                      trailingRange.setEnd(element, element.childNodes.length);
                    }
                    const text = bridge.getText();
                    const caretAtEnd =
                      focusNode !== null &&
                      element.contains(focusNode) &&
                      selection?.isCollapsed === true &&
                      trailingRange.toString() === "";
                    done({
                      ok: text === nextValue && caretAtEnd,
                      reason:
                        text === nextValue ? "caret-not-at-end" : "text-restored-by-initializer",
                      text,
                    });
                  });
                }),
              );
            },
            testId,
            value,
          )) as LexicalCaretResult;
          return caretResult.ok;
        },
        {
          timeout,
          timeoutMsg: `${timeoutMsg}: Lexical caret 未稳定在文本末尾`,
        },
      );
    } catch (error) {
      throw new Error(`${timeoutMsg}: ${JSON.stringify(caretResult)}`, {
        cause: error,
      });
    }
  }

  await browser.pause(50);
  await browser.execute((currentTestId) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === currentTestId,
    );
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.blur();
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
  }, testId);
}

export function workspaceLabel(workspacePath: string) {
  return basename(workspacePath) || workspacePath;
}

export async function getTabLabels(): Promise<string[]> {
  return browser.execute(() => {
    // 虚拟项目侧栏：项目行的 data-project-name 就是旧 workspace 标签名（目录 basename）。
    const projectSections = Array.from(
      document.querySelectorAll<HTMLElement>("[data-project-id][data-project-name]"),
    );
    if (projectSections.length > 0) {
      return projectSections
        .map((node) => node.getAttribute("data-project-name")?.trim() ?? "")
        .filter(Boolean);
    }

    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='tab-item-'] span"))
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}
