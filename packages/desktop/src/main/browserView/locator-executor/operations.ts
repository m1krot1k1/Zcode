import { dispatchClickAt, dispatchKey, modifiersBitmask } from "../browserCommandInput.js";
import {
  assertFocusedInputTarget,
  createInputTargetToken,
  IAB_INPUT_TARGET_TOKEN_PROPERTY,
  pasteTextIntoFocusedTarget,
} from "../browserVirtualClipboard.js";
import { PLAYWRIGHT_GLOBAL, modifierNames, pressParts, runtimeError } from "./runtime.js";
import { strictVisibleSelectorSetup } from "./selectors.js";
import type {
  ActionProbe,
  LocatorAction,
  LocatorRuntime,
  LocatorTarget,
  RuntimeResponse,
} from "./types.js";

export async function performLocatorAction(
  runtime: LocatorRuntime,
  target: LocatorTarget,
  action: LocatorAction,
  probe: ActionProbe,
): Promise<unknown> {
  switch (action.operation) {
    case "textContent":
      return querySingleValue(runtime, target, "elements[0].textContent");
    case "innerText":
      return querySingleValue(runtime, target, "elements[0].innerText");
    case "getAttribute":
      return querySingleValue(
        runtime,
        target,
        `elements[0].getAttribute(${JSON.stringify(action.attribute)})`,
      );
    case "click":
    case "dblclick": {
      await dispatchClickAt(
        runtime.view,
        { cx: probe.x!, cy: probe.y! },
        action.button ?? "left",
        action.operation === "dblclick",
        modifiersBitmask(modifierNames(action.modifiers)),
      );
      return null;
    }
    case "fill": {
      const value = String(action.value ?? "");
      const inputTargetToken = createInputTargetToken();
      if (action.replace !== false) {
        const result = await querySingleValue(
          runtime,
          target,
          `(() => {
              const result = injected.fill(elements[0], ${JSON.stringify(value)});
              if (result === "needsinput") {
                const input = injected.retarget(elements[0], "follow-label") ?? elements[0];
                Object.defineProperty(input, ${JSON.stringify(IAB_INPUT_TARGET_TOKEN_PROPERTY)}, {
                  configurable: true,
                  value: ${JSON.stringify(inputTargetToken)},
                  writable: true,
                });
              }
              return result;
            })()`,
        );
        if (result === "done") return null;
        if (result !== "needsinput") throw new Error(`locator.fill failed: ${String(result)}`);
      } else {
        await focusForInput(runtime, target, inputTargetToken);
      }
      const context = await runtime.context(target.frame);
      await pasteTextIntoFocusedTarget(runtime.view, value, {
        includeRichText: false,
        initialTarget: {
          contextId: context.contextId,
          sessionId: context.sessionId,
        },
        inputTargetToken,
        replaceInputValue: action.replace !== false,
      });
      return null;
    }
    case "press": {
      const inputTargetToken = createInputTargetToken();
      await focusForInput(runtime, target, inputTargetToken, false);
      const context = await runtime.context(target.frame);
      await assertFocusedInputTarget(runtime.view, context, inputTargetToken);
      const press = pressParts(action.value, action.modifiers);
      await dispatchKey(
        runtime.view,
        press.key,
        modifiersBitmask(press.modifiers),
        context.sessionId,
      );
      return null;
    }
    case "setChecked": {
      if (probe.checked !== action.checked) {
        await dispatchClickAt(runtime.view, { cx: probe.x!, cy: probe.y! }, "left", false);
      }
      const checked = await querySingleValue(runtime, target, "Boolean(elements[0].checked)");
      if (checked !== action.checked) {
        throw new Error(
          `locator.setChecked(${String(action.checked)}) did not change the element state`,
        );
      }
      return null;
    }
    case "selectOption":
      return selectOption(runtime, target, action);
    case "downloadMedia": {
      // IAB 的 locator.downloadMedia 不是普通 click：它在 Playwright isolated world 中
      // 提取 media/link URL，再用临时 download anchor 触发浏览器下载。直接点元素会在
      // 普通链接上导航，并把“未下载”伪装成成功。
      await querySingleValue(
        runtime,
        target,
        `(() => {
            const element = elements[0];
            element.scrollIntoView({ block: "center", inline: "nearest" });
            const media = element.closest?.("img, video, source, a[href]") ??
              element.querySelector?.("img, video, source, a[href]") ?? element;
            const read = (value, name) => typeof value?.[name] === "string" ? value[name] : null;
            const url = read(media, "currentSrc") ?? read(media, "src") ?? read(media, "href") ?? "";
            if (!url) throw new Error("Matched element does not expose a downloadable URL");
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = url.split("/").pop()?.split("?")[0] || "download";
            anchor.rel = "noopener";
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            return true;
          })()`,
      );
      return null;
    }
    case "evaluate":
      return evaluateLocator(runtime, target, action);
    default:
      throw new Error(`unsupported locator operation: ${action.operation}`);
  }
}

async function focusForInput(
  runtime: LocatorRuntime,
  target: LocatorTarget,
  inputTargetToken: string,
  retargetInput = true,
): Promise<void> {
  const focused = await querySingleValue(
    runtime,
    target,
    `(() => {
        const element = ${String(retargetInput)}
          ? injected.retarget(elements[0], "follow-label") ?? elements[0]
          : elements[0];
        const result = element.matches(":focus") ? "done" : injected.focusNode(element, false);
        if (result !== "done") return result;
        Object.defineProperty(element, ${JSON.stringify(IAB_INPUT_TARGET_TOKEN_PROPERTY)}, {
          configurable: true,
          value: ${JSON.stringify(inputTargetToken)},
          writable: true,
        });
        return "done";
      })()`,
  );
  if (focused !== "done") throw new Error(`locator could not focus element: ${String(focused)}`);
}

async function selectOption(
  runtime: LocatorRuntime,
  target: LocatorTarget,
  action: LocatorAction,
): Promise<unknown> {
  const selections = JSON.stringify(action.selections ?? []);
  const result = await querySingleValue(
    runtime,
    target,
    `injected.selectOptions(elements[0], ${selections})`,
  );
  if (typeof result === "string" && result.startsWith("error:")) {
    throw new Error(`locator.selectOption failed: ${result}`);
  }
  return result;
}

async function evaluateLocator(
  runtime: LocatorRuntime,
  target: LocatorTarget,
  action: LocatorAction,
): Promise<unknown> {
  const context = await runtime.context(target.frame);
  const handle = await runtime.evaluate(
    context,
    `(() => {
        const injected = globalThis.${PLAYWRIGHT_GLOBAL};
        const root = document;
        ${strictVisibleSelectorSetup(target.selector)}
        if (!resolvedElement) throw new Error("No element matched selector");
        return resolvedElement;
      })()`,
    false,
  );
  if (!handle.objectId || handle.subtype === "null")
    throw new Error("locator resolved to no elements");
  const functionDeclaration =
    action.expressionKind === "function"
      ? `function(arg) { return (${action.expression})(this, arg); }`
      : `function(arg) { const element = this; return (${action.expression}); }`;
  try {
    const response = (await runtime.send(context, "Runtime.callFunctionOn", {
      objectId: handle.objectId,
      functionDeclaration,
      arguments: [{ value: action.arg }],
      awaitPromise: true,
      returnByValue: true,
    })) as RuntimeResponse;
    const error = runtimeError(response);
    if (error) throw new Error(`playwright.evaluate failed: ${error}`);
    return response.result?.value;
  } finally {
    await runtime.send(context, "Runtime.releaseObject", {
      objectId: handle.objectId,
    }).catch(() => undefined);
  }
}

export async function queryValue(
  runtime: LocatorRuntime,
  target: LocatorTarget,
  body: string,
): Promise<unknown> {
  const context = await runtime.context(target.frame);
  const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      const elements = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(target.selector)}), root);
      return ${body};
    })()`;
  return (await runtime.evaluate(context, expression, true)).value;
}

export async function querySingleValue(
  runtime: LocatorRuntime,
  target: LocatorTarget,
  body: string,
  options: { allowMissing?: boolean } = {},
): Promise<unknown> {
  const context = await runtime.context(target.frame);
  const missingGuard = options.allowMissing
    ? ""
    : 'if (!resolvedElement) throw new Error("No element matched selector");';
  const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      ${strictVisibleSelectorSetup(target.selector)}
      ${missingGuard}
      return ${body};
    })()`;
  return (await runtime.evaluate(context, expression, true)).value;
}
