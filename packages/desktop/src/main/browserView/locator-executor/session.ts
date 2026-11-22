import { logger } from "../../logger.js";
import type { ControlledView } from "../browserCommandTypes.js";
import { getPlaywrightInjectedScriptSource } from "../playwrightInjectedScriptSource.js";
import { frameObstruction, pointerFramePoints, probeLocatorAction } from "./actionProbe.js";
import { performLocatorAction, querySingleValue, queryValue } from "./operations.js";
import {
  abortError,
  isRecoverableLocatorRace,
  PLAYWRIGHT_GLOBAL,
  PLAYWRIGHT_WORLD_NAME,
  POLL_INTERVAL_MS,
  runtimeError,
} from "./runtime.js";
import { frameSegments, strictVisibleSelectorSetup } from "./selectors.js";
import {
  POINTER_SCROLL_ALIGNMENTS,
  type ActionProbeExecution,
  type CdpTarget,
  type FrameBoundary,
  type FrameContext,
  type IabLocatorExecution,
  type LocatorAction,
  type LocatorRuntime,
  type LocatorTarget,
  type RuntimeResponse,
  type RuntimeResult,
} from "./types.js";

class IabPlaywrightLocatorSession implements LocatorRuntime {
  private readonly contexts = new Map<string, FrameContext>();
  private readonly attachedSessionIds = new Set<string>();
  private rootFrame?: CdpTarget;

  constructor(
    readonly view: ControlledView,
    private readonly timeoutMs: number,
    readonly signal?: AbortSignal,
  ) {}

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.attachedSessionIds].map((sessionId) =>
        this.view.cdp.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.attachedSessionIds.clear();
  }

  async execute(action: LocatorAction): Promise<IabLocatorExecution> {
    let target = await this.resolveTarget(action.selector);
    if (action.operation === "count") {
      return {
        kind: "done",
        value: await queryValue(this, target, "elements.length"),
      };
    }
    if (action.operation === "allTextContents") {
      return {
        kind: "done",
        value: await queryValue(this, target, "elements.map(element => element.textContent ?? '')"),
      };
    }
    if (action.operation === "isVisible") {
      return {
        kind: "done",
        value: await queryValue(
          this,
          target,
          "Boolean(elements[0] && injected.elementState(elements[0], 'visible').matches)",
        ),
      };
    }
    if (action.operation === "isEnabled") {
      return {
        kind: "done",
        value: await queryValue(
          this,
          target,
          "Boolean(elements[0] && injected.elementState(elements[0], 'enabled').matches)",
        ),
      };
    }
    if (action.operation === "waitFor") return this.waitForState(target, action);
    if (["textContent", "innerText", "getAttribute", "evaluate"].includes(action.operation)) {
      const unique = await this.waitForUnique(target, action.selector);
      if (unique.kind !== "done") return unique;
      return {
        kind: "done",
        value: await performLocatorAction(this, target, action, {
          count: 1,
          actionable: true,
        }),
      };
    }

    const deadline = Date.now() + this.timeoutMs;
    let lastReason = `locator ${action.selector}`;
    let pointerAttempt = 0;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout", reason: lastReason };
      const needsEditable = action.operation === "fill";
      const needsPointer = ["click", "dblclick", "setChecked"].includes(action.operation);
      const needsEnabled = [
        "click",
        "dblclick",
        "fill",
        "press",
        "selectOption",
        "setChecked",
      ].includes(action.operation);
      let probeExecution: ActionProbeExecution;
      try {
        probeExecution = await probeLocatorAction(
          this,
          target,
          {
            // fill 始终检查 visible/enabled/editable，不接受 click 的 force 放宽。
            force: action.operation === "fill" ? false : action.force === true,
            needsEditable,
            needsEnabled,
            // fill/type 不等待 stable，也不做 click 的 hit-target 检查。
            // z.ai 输入框的持续动画会让 stable 永不成立，等待 stable 会卡到 MCP hard timeout。
            // force pointer action 仍等待稳定并滚动，但跳过 hit-target 校验。
            needsHitTarget: needsPointer && action.force !== true,
            needsStable: needsPointer,
            scrollAlignment:
              action.force === true
                ? POINTER_SCROLL_ALIGNMENTS[0]!
                : (POINTER_SCROLL_ALIGNMENTS[pointerAttempt % POINTER_SCROLL_ALIGNMENTS.length] ??
                  POINTER_SCROLL_ALIGNMENTS[0]!),
          },
          remaining,
        );
      } catch (error) {
        if (!isRecoverableLocatorRace(error)) throw error;
        logger.debug("[browser-use] recovering locator after document race", {
          error: error instanceof Error ? error.message : String(error),
          operation: action.operation,
          selector: action.selector,
        });
        await this.resetDocumentContexts();
        target = await this.resolveTarget(action.selector);
        pointerAttempt += 1;
        continue;
      }
      if (probeExecution.kind === "cancelled") return { kind: "cancelled" };
      if (probeExecution.kind === "timeout") return { kind: "timeout", reason: lastReason };
      const probe = probeExecution.value;
      if (probe.count === 1 && probe.actionable) {
        const pointerPoints = needsPointer ? pointerFramePoints(target, probe) : undefined;
        if (needsPointer && action.force !== true) {
          const obstruction = await frameObstruction(this, target, pointerPoints!);
          if (obstruction) {
            lastReason = `${action.operation} actionability (covered by ${obstruction}) for selector ${action.selector}`;
            pointerAttempt += 1;
            continue;
          }
        }
        return {
          kind: "done",
          value: await performLocatorAction(
            this,
            target,
            action,
            pointerPoints ? { ...probe, x: pointerPoints.top.x, y: pointerPoints.top.y } : probe,
          ),
        };
      }
      lastReason =
        probe.count === 0
          ? `locator ${action.selector}`
          : `${action.operation} actionability (${probe.reason ?? "not-actionable"}${probe.obstruction ? ` by ${probe.obstruction}` : ""}) for selector ${action.selector}`;
      pointerAttempt += 1;
      const delayBudget = deadline - Date.now();
      if (delayBudget <= 0) return { kind: "timeout", reason: lastReason };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, delayBudget))))
        return { kind: "cancelled" };
    }
  }

  private async waitForState(
    target: LocatorTarget,
    action: LocatorAction,
  ): Promise<IabLocatorExecution> {
    const state = action.state ?? "visible";
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const value = (await queryValue(
        this,
        target,
        `({ exists: elements.length > 0, visible: Boolean(elements[0] && injected.elementState(elements[0], 'visible').matches) })`,
      )) as { exists: boolean; visible: boolean };
      const matched =
        state === "attached"
          ? value.exists
          : state === "detached"
            ? !value.exists
            : state === "visible"
              ? value.visible
              : !value.visible;
      if (matched) return { kind: "done" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout", reason: `${action.selector} to be ${state}` };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, remaining)))) return { kind: "cancelled" };
    }
  }

  private async waitForUnique(
    target: LocatorTarget,
    selector: string,
  ): Promise<IabLocatorExecution> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const exists = await querySingleValue(this, target, "Boolean(elements[0])", {
        allowMissing: true,
      });
      if (exists === true) return { kind: "done" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout", reason: `locator ${selector}` };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, remaining)))) return { kind: "cancelled" };
    }
  }

  private async resetDocumentContexts(): Promise<void> {
    await Promise.allSettled(
      [...this.attachedSessionIds].map((sessionId) =>
        this.view.cdp.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.attachedSessionIds.clear();
    this.contexts.clear();
    this.rootFrame = undefined;
  }

  private async resolveTarget(selector: string): Promise<LocatorTarget> {
    const segments = frameSegments(selector);
    let frame = await this.mainFrame();
    const boundaries: FrameBoundary[] = [];
    for (const frameSelector of segments.slice(0, -1)) {
      const context = await this.context(frame);
      const handle = await this.evaluate(
        context,
        `(() => {
          const injected = globalThis.${PLAYWRIGHT_GLOBAL};
          const root = document;
          ${strictVisibleSelectorSetup(frameSelector)}
          if (!resolvedElement) {
            throw new Error(${JSON.stringify(`frame locator resolved to no elements: ${frameSelector}`)});
          }
          return resolvedElement;
        })()`,
        false,
      );
      if (!handle.objectId || handle.subtype === "null")
        throw new Error("frame locator became detached");
      try {
        const described = (await this.send(context, "DOM.describeNode", {
          objectId: handle.objectId,
        })) as { node?: { backendNodeId?: number; frameId?: string } };
        const frameId = described.node?.frameId;
        if (!frameId) throw new Error("frame locator did not resolve to a frame owner");
        const ownerBackendNodeId = described.node?.backendNodeId;
        if (!ownerBackendNodeId) throw new Error("frame locator returned no backend node identity");
        const contentQuads = (await this.send(frame, "DOM.getContentQuads", {
          backendNodeId: ownerBackendNodeId,
        })) as { quads?: number[][] };
        const contentQuad = contentQuads.quads?.[0];
        if (
          !contentQuad ||
          contentQuad.length !== 8 ||
          !contentQuad.every((coordinate) => Number.isFinite(coordinate))
        ) {
          throw new Error("frame owner returned no valid content quad");
        }
        const child = await this.childFrame(frame, frameId);
        const childContext = await this.context(child);
        const childSizeValue = (
          await this.evaluate(
            childContext,
            `({ width: globalThis.innerWidth, height: globalThis.innerHeight })`,
            true,
          )
        ).value as { height?: unknown; width?: unknown } | undefined;
        if (
          !childSizeValue ||
          typeof childSizeValue.width !== "number" ||
          typeof childSizeValue.height !== "number" ||
          !Number.isFinite(childSizeValue.width) ||
          !Number.isFinite(childSizeValue.height) ||
          childSizeValue.width <= 0 ||
          childSizeValue.height <= 0
        ) {
          throw new Error("child frame returned no valid viewport size");
        }
        boundaries.push({
          childSize: {
            height: childSizeValue.height,
            width: childSizeValue.width,
          },
          contentQuad: contentQuad as FrameBoundary["contentQuad"],
          ownerBackendNodeId,
          parent: frame,
        });
        frame = child;
      } finally {
        await this.send(context, "Runtime.releaseObject", {
          objectId: handle.objectId,
        }).catch(() => undefined);
      }
    }
    return { boundaries, frame, selector: segments.at(-1)! };
  }

  private async mainFrame(): Promise<CdpTarget> {
    if (this.rootFrame) return this.rootFrame;
    await this.view.cdp.send("Page.enable");
    await this.view.cdp.send("Runtime.enable");
    await this.view.cdp.send("DOM.enable");
    const tree = (await this.view.cdp.send("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    const frameId = tree.frameTree?.frame?.id;
    if (!frameId) throw new Error("Page.getFrameTree returned no main frame id");
    this.rootFrame = { frameId };
    return this.rootFrame;
  }

  private async childFrame(parent: CdpTarget, frameId: string): Promise<CdpTarget> {
    const sameTarget = {
      frameId,
      sessionId: parent.sessionId,
    };
    try {
      await this.context(sameTarget);
      return sameTarget;
    } catch {
      const attached = (await this.view.cdp
        .send("Target.attachToTarget", { flatten: true, targetId: frameId })
        .catch(() => undefined)) as { sessionId?: string } | undefined;
      if (!attached?.sessionId) throw new Error(`unable to attach frame target ${frameId}`);
      this.attachedSessionIds.add(attached.sessionId);
      const target = { ...sameTarget, sessionId: attached.sessionId };
      await this.send(target, "Page.enable");
      await this.send(target, "Runtime.enable");
      await this.send(target, "DOM.enable");
      await this.context(target);
      return target;
    }
  }

  private contextKey(target: CdpTarget): string {
    return `${target.sessionId ?? "root"}:${target.frameId}`;
  }

  async context(target: CdpTarget): Promise<FrameContext> {
    if (this.signal?.aborted) throw abortError();
    const key = this.contextKey(target);
    const existing = this.contexts.get(key);
    if (existing) return existing;
    const world = (await this.send(target, "Page.createIsolatedWorld", {
      frameId: target.frameId,
      grantUniveralAccess: false,
      worldName: PLAYWRIGHT_WORLD_NAME,
    })) as { executionContextId?: number };
    if (!world.executionContextId)
      throw new Error(`unable to create locator world for ${target.frameId}`);
    const context = { ...target, contextId: world.executionContextId };
    await this.inject(context);
    this.contexts.set(key, context);
    return context;
  }

  private async inject(context: FrameContext): Promise<void> {
    const present = await this.evaluate(context, `Boolean(globalThis.${PLAYWRIGHT_GLOBAL})`, true);
    if (present.value === true) return;
    const options = {
      browserName: "chromium",
      customEngines: [],
      isUnderTest: false,
      sdkLanguage: "javascript",
      stableRafCount: 1,
      testIdAttributeName: "data-testid",
    };
    const source = getPlaywrightInjectedScriptSource();
    const expression = `(() => {
      const module = {};
      ${source}
      globalThis.${PLAYWRIGHT_GLOBAL} = new (module.exports.InjectedScript())(
        globalThis,
        ${JSON.stringify(options)}
      );
      return true;
    })()`;
    const injected = await this.evaluate(context, expression, true);
    if (injected.value !== true) throw new Error("unable to initialize Playwright locator runtime");
  }

  async evaluate(
    context: FrameContext,
    expression: string,
    returnByValue: boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<RuntimeResult> {
    if (this.signal?.aborted) throw abortError();
    const terminate = () => {
      void this.view.cdp
        .send("Runtime.terminateExecution", undefined, context.sessionId)
        .catch(() => undefined);
    };
    this.signal?.addEventListener("abort", terminate, { once: true });
    try {
      const response = (await this.send(context, "Runtime.evaluate", {
        awaitPromise: true,
        contextId: context.contextId,
        expression,
        returnByValue,
        timeout: timeoutMs,
      })) as RuntimeResponse;
      const error = runtimeError(response);
      if (error) throw new Error(error);
      return response.result ?? {};
    } finally {
      this.signal?.removeEventListener("abort", terminate);
    }
  }

  send(target: { sessionId?: string }, method: string, params?: unknown): Promise<unknown> {
    if (this.signal?.aborted) return Promise.reject(abortError());
    return this.view.cdp.send(method, params, target.sessionId);
  }

  private delay(timeoutMs: number): Promise<boolean> {
    if (this.signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        resolve(completed);
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      const onAbort = () => finish(false);
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * 使用与 domSnapshot 相同固定版本的 Playwright injected selector runtime；动作由 CDP Input
 * 下发，避免页面主 world 手写 selector 与 synthetic event 造成“快照可见但无法操作”。
 */
export async function executeIabPlaywrightLocator(
  view: ControlledView,
  action: LocatorAction,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IabLocatorExecution> {
  const session = new IabPlaywrightLocatorSession(view, timeoutMs, signal);
  try {
    return await session.execute(action);
  } finally {
    await session.dispose();
  }
}
