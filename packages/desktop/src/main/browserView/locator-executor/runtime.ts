import type { BrowserPlaywrightModifier } from "@zcode/shared";
import type { RuntimeResponse } from "./types.js";

export const PLAYWRIGHT_WORLD_NAME = "zcode-playwright-locator";
export const PLAYWRIGHT_GLOBAL = "__zcodePlaywrightInjected";
export const POLL_INTERVAL_MS = 50;

export function abortError(): DOMException {
  return new DOMException("Browser locator action aborted", "AbortError");
}

export function runtimeError(response: RuntimeResponse): string | undefined {
  const exception = response.exceptionDetails;
  if (!exception) return undefined;
  return (
    exception.exception?.description ??
    (exception.exception?.value == null ? undefined : String(exception.exception.value)) ??
    exception.text ??
    "Playwright locator evaluation failed"
  );
}

export function isRecoverableLocatorRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /execution context (?:was )?destroyed|cannot find context|frame (?:was )?detached|inspected target navigated/iu.test(
    error.message,
  );
}

export function modifierNames(
  modifiers?: BrowserPlaywrightModifier[],
): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  return (modifiers ?? []).map((modifier) => {
    if (modifier !== "ControlOrMeta") return modifier;
    return process.platform === "darwin" ? "Meta" : "Control";
  });
}

export function pressParts(value: unknown, modifiers?: BrowserPlaywrightModifier[]) {
  const pieces = String(value ?? "")
    .split("+")
    .filter(Boolean);
  if (pieces.length === 0) throw new Error("locator.press requires a key");
  const key = pieces.pop()!;
  const embedded = pieces.filter((piece): piece is BrowserPlaywrightModifier =>
    ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(piece),
  );
  return { key, modifiers: modifierNames([...(modifiers ?? []), ...embedded]) };
}
