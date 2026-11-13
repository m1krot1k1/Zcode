import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserKeyModifier,
  BrowserMouseButton,
} from "@zcode/contracts/browser-control";
import type { Point } from "./types.js";

export class RawTab {
  constructor(private readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>) {}

  navigate(url: string): Promise<BrowserCommandResult> {
    return this.run({ method: "navigate", url });
  }

  getState(): Promise<BrowserCommandResult> {
    return this.run({ method: "getState" });
  }

  screenshot(opts?: {
    ref?: string;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<BrowserCommandResult> {
    return this.run({ method: "screenshot", ...opts });
  }

  back(): Promise<BrowserCommandResult> {
    return this.run({ method: "back" });
  }

  forward(): Promise<BrowserCommandResult> {
    return this.run({ method: "forward" });
  }

  reload(): Promise<BrowserCommandResult> {
    return this.run({ method: "reload" });
  }

  snapshot(opts?: {
    maxElements?: number;
    includeHidden?: boolean;
  }): Promise<BrowserCommandResult> {
    return this.run({ method: "snapshot", ...opts });
  }

  click(
    target:
      | string
      | (Point & {
          button?: BrowserMouseButton;
          doubleClick?: boolean;
          modifiers?: BrowserKeyModifier[];
        }),
    opts?: {
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
    },
  ): Promise<BrowserCommandResult> {
    if (typeof target === "string") {
      return this.run({ method: "click", ref: target, ...opts });
    }
    const { x, y, ...rest } = target;
    return this.run({ method: "click", x, y, ...rest, ...opts });
  }

  type(text: string, opts?: { ref?: string }): Promise<BrowserCommandResult> {
    return this.run({ method: "type", text, ref: opts?.ref });
  }

  press(
    key: string,
    opts?: { ref?: string; modifiers?: BrowserKeyModifier[] },
  ): Promise<BrowserCommandResult> {
    return this.run({ method: "press", key, ref: opts?.ref, modifiers: opts?.modifiers });
  }

  scroll(opts: { ref?: string; x?: number; y?: number }): Promise<BrowserCommandResult> {
    return this.run({ method: "scroll", ...opts });
  }

  hover(target: string | Point): Promise<BrowserCommandResult> {
    if (typeof target === "string") {
      return this.run({ method: "hover", ref: target });
    }
    return this.run({ method: "hover", x: target.x, y: target.y });
  }

  select(ref: string, values: string[]): Promise<BrowserCommandResult> {
    return this.run({ method: "select", ref, values });
  }

  check(ref: string, checked = true): Promise<BrowserCommandResult> {
    return this.run({ method: "check", ref, checked });
  }

  drag(
    from: string | Point,
    to: string | Point,
    opts?: { modifiers?: BrowserKeyModifier[] },
  ): Promise<BrowserCommandResult> {
    const fromPart = typeof from === "string" ? { fromRef: from } : { from };
    const toPart = typeof to === "string" ? { toRef: to } : { to };
    return this.run({ method: "drag", ...fromPart, ...toPart, ...opts });
  }

  close(): Promise<BrowserCommandResult> {
    return this.run({ method: "close" });
  }

  elementInfo(x: number, y: number): Promise<BrowserCommandResult> {
    return this.run({ method: "elementInfo", x, y });
  }

  evaluate(
    expressionOrFn: string | ((...args: unknown[]) => unknown),
  ): Promise<BrowserCommandResult> {
    const expression =
      typeof expressionOrFn === "function" ? `(${expressionOrFn.toString()})()` : expressionOrFn;
    return this.run({ method: "evaluate", expression });
  }

  getDialog(): Promise<BrowserCommandResult> {
    return this.run({ method: "getDialog" });
  }

  handleDialog(accept: boolean, promptText?: string): Promise<BrowserCommandResult> {
    return this.run({ method: "handleDialog", accept, promptText });
  }
}
