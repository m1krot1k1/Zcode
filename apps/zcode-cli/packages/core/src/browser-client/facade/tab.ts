import {
  BROWSER_VIEWPORT_LIMITS,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserDialog,
  type BrowserKeyModifier,
  type BrowserMouseButton,
  type BrowserPageState,
  type BrowserSnapshot,
  type BrowserSnapshotElement,
  type BrowserTabSummary,
  type BrowserViewportSize,
} from "@zcode/contracts/browser-control";
import { createBrowserApiProxy, type BrowserApiPolicy } from "../manifest.js";
import {
  configurePlaywrightObjectWrapper,
  createPlaywrightAPI,
  type PlaywrightAPI,
} from "../playwright.js";
import { base64ToBytes, expectOk, expectPayload } from "../result.js";
import { BrowserCapabilityCollection } from "./capabilities.js";
import { createCuaApi, createDomCuaApi, type CuaTab, type DomCuaTab } from "./cua.js";
import { createJsDialog, type JsDialog } from "./dialogs.js";
import { RawTab } from "./raw-tab.js";
import { BrowserRecordingAPI } from "./recording.js";
import type { BrowserCapabilityInfo, BrowserExecuteFn, Point } from "./types.js";

function validateViewportSize(viewportSize: BrowserViewportSize): void {
  if (
    !Number.isInteger(viewportSize?.width) ||
    viewportSize.width < BROWSER_VIEWPORT_LIMITS.minWidth ||
    viewportSize.width > BROWSER_VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewportSize?.height) ||
    viewportSize.height < BROWSER_VIEWPORT_LIMITS.minHeight ||
    viewportSize.height > BROWSER_VIEWPORT_LIMITS.maxHeight
  ) {
    throw new TypeError(
      `setViewportSize requires integer width ${BROWSER_VIEWPORT_LIMITS.minWidth}..${BROWSER_VIEWPORT_LIMITS.maxWidth} ` +
        `and height ${BROWSER_VIEWPORT_LIMITS.minHeight}..${BROWSER_VIEWPORT_LIMITS.maxHeight}`,
    );
  }
}

export class Tab {
  readonly id: string;
  readonly raw: RawTab;
  readonly capabilities: BrowserCapabilityCollection;
  playwright: PlaywrightAPI;
  recording: BrowserRecordingAPI;
  private wrapObject = <T extends object>(value: T, _objectName: string): T => value;
  private viewportSizeValue: BrowserViewportSize | null;

  constructor(
    private readonly execute: BrowserExecuteFn,
    readonly tabId?: string,
    summary?: Pick<BrowserTabSummary, "url" | "title" | "active" | "viewport">,
    capabilityDescriptors: readonly BrowserCapabilityInfo[] = [],
    readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {
    this.id = tabId ?? "";
    this.raw = new RawTab((command) => this.run(command));
    this.capabilities = new BrowserCapabilityCollection(
      () => capabilityDescriptors,
      readCapabilityDocumentation,
    );
    this.playwright = createPlaywrightAPI((command) => this.run(command));
    this.recording = new BrowserRecordingAPI((command) => this.run(command));
    this.viewportSizeValue = summary?.viewport ? { ...summary.viewport } : null;
  }

  private run(command: BrowserCommand): Promise<BrowserCommandResult> {
    const withTab = this.tabId ? { ...command, tabId: this.tabId } : command;
    return this.execute(withTab);
  }

  /** Browser connection capability policy 在对象建好后注入，并保持 Playwright 对象 identity。 */
  applyPlaywrightPolicy(policy: BrowserApiPolicy): this {
    const wrap = <T extends object>(value: T, objectName: string): T =>
      createBrowserApiProxy(value, objectName, policy, { hideUnknown: true });
    this.wrapObject = wrap;
    this.playwright = configurePlaywrightObjectWrapper(this.playwright, wrap);
    this.recording = wrap(this.recording, "BrowserRecordingAPI");
    return this;
  }

  private async action(command: BrowserCommand): Promise<void> {
    expectOk(command, await this.run(command));
  }

  async goto(url: string): Promise<void> {
    await this.action({ method: "navigate", url });
  }

  async url(): Promise<string | undefined> {
    return (await this.getState()).url || undefined;
  }

  async title(): Promise<string | undefined> {
    return (await this.getState()).title || undefined;
  }

  async navigate(url: string): Promise<void> {
    await this.goto(url);
  }

  async getState(): Promise<BrowserPageState> {
    const command: BrowserCommand = { method: "getState" };
    const result = await this.run(command);
    return expectPayload(command, result, result.state, "state");
  }

  /** 对齐 Playwright Page.setViewportSize；ZCode 额外施加内置自由尺寸的安全边界。 */
  async setViewportSize(viewportSize: BrowserViewportSize): Promise<void> {
    validateViewportSize(viewportSize);
    await this.action({ method: "browserViewportSet", ...viewportSize });
    this.viewportSizeValue = { ...viewportSize };
  }

  /** 对齐 Playwright Page.viewportSize；返回本次 tab binding 最近一次观察到的实际值。 */
  viewportSize(): BrowserViewportSize | null {
    return this.viewportSizeValue ? { ...this.viewportSizeValue } : null;
  }

  async screenshot(opts?: {
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Uint8Array> {
    const command: BrowserCommand = { method: "screenshot", ...opts };
    const result = await this.run(command);
    const image = expectPayload(command, result, result.image, "image");
    return base64ToBytes(image.base64);
  }

  async back(): Promise<void> {
    await this.action({ method: "back" });
  }

  async forward(): Promise<void> {
    await this.action({ method: "forward" });
  }

  async reload(): Promise<void> {
    await this.action({ method: "reload" });
  }

  async snapshot(opts?: {
    maxElements?: number;
    includeHidden?: boolean;
  }): Promise<BrowserSnapshot> {
    const command: BrowserCommand = { method: "snapshot", ...opts };
    const result = await this.run(command);
    return expectPayload(command, result, result.snapshot, "snapshot");
  }

  async click(
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
  ): Promise<void> {
    await this.action(
      typeof target === "string"
        ? { method: "click", ref: target, ...opts }
        : (() => {
            const { x, y, ...rest } = target;
            return { method: "click", x, y, ...rest, ...opts };
          })(),
    );
  }

  async type(text: string, opts?: { ref?: string }): Promise<void> {
    await this.action({ method: "type", text, ref: opts?.ref });
  }

  async press(
    key: string,
    opts?: { ref?: string; modifiers?: BrowserKeyModifier[] },
  ): Promise<void> {
    await this.action({ method: "press", key, ref: opts?.ref, modifiers: opts?.modifiers });
  }

  async scroll(opts: { ref?: string; x?: number; y?: number }): Promise<void> {
    await this.action({ method: "scroll", ...opts });
  }

  async hover(target: string | Point): Promise<void> {
    await this.action(
      typeof target === "string"
        ? { method: "hover", ref: target }
        : { method: "hover", x: target.x, y: target.y },
    );
  }

  async select(ref: string, values: string[]): Promise<void> {
    await this.action({ method: "select", ref, values });
  }

  async check(ref: string, checked = true): Promise<void> {
    await this.action({ method: "check", ref, checked });
  }

  async drag(
    from: string | Point,
    to: string | Point,
    opts?: { modifiers?: BrowserKeyModifier[] },
  ): Promise<void> {
    const fromPart = typeof from === "string" ? { fromRef: from } : { from };
    const toPart = typeof to === "string" ? { toRef: to } : { to };
    await this.action({ method: "drag", ...fromPart, ...toPart, ...opts });
  }

  async close(): Promise<void> {
    await this.action({ method: "close" });
  }

  async finalize(opts?: { deliverable?: boolean }): Promise<void> {
    await this.action({ method: "finalize", deliverable: opts?.deliverable });
  }

  async markDeliverable(): Promise<void> {
    await this.action({ method: "markDeliverable", tabId: this.id });
  }

  async markHandoff(): Promise<void> {
    await this.action({ method: "markHandoff", tabId: this.id });
  }

  async elementInfo(x: number, y: number): Promise<BrowserSnapshotElement | undefined> {
    const command: BrowserCommand = { method: "elementInfo", x, y };
    const result = expectOk(command, await this.run(command));
    return result.element;
  }

  async evaluate(expressionOrFn: string | ((...args: unknown[]) => unknown)): Promise<unknown> {
    const expression =
      typeof expressionOrFn === "function" ? `(${expressionOrFn.toString()})()` : expressionOrFn;
    const command: BrowserCommand = { method: "evaluate", expression };
    const result = expectOk(command, await this.run(command));
    return result.value;
  }

  async getDialog(): Promise<BrowserDialog | null> {
    const command: BrowserCommand = { method: "getDialog" };
    const result = expectOk(command, await this.run(command));
    return result.dialog ?? null;
  }

  async getJsDialog(): Promise<JsDialog | undefined> {
    const dialog = await this.getDialog();
    if (!dialog) return undefined;
    const value = createJsDialog(dialog, (accept, promptText) =>
      this.handleDialog(accept, promptText),
    );
    const objectName =
      dialog.type === "confirm"
        ? "ConfirmDialog"
        : dialog.type === "prompt"
          ? "PromptDialog"
          : dialog.type === "beforeunload"
            ? "BeforeUnloadDialog"
            : "AlertDialog";
    return this.wrapObject(value, objectName);
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.action({ method: "handleDialog", accept, promptText });
  }

  get cua(): CuaTab {
    return this.wrapObject(
      createCuaApi((command) => this.action(command)),
      "CUAAPI",
    );
  }

  get dom_cua(): DomCuaTab {
    return this.wrapObject(
      createDomCuaApi(
        (command) => this.action(command),
        () => this.snapshot(),
      ),
      "DomCUAAPI",
    );
  }
}
