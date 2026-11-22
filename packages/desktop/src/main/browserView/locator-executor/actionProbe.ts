import { logger } from "../../logger.js";
import { PLAYWRIGHT_GLOBAL } from "./runtime.js";
import { STRICT_VISIBLE_SELECTOR_HELPER } from "./selectors.js";
import type {
  ActionProbe,
  ActionProbeExecution,
  CdpTarget,
  FrameBoundary,
  LocatorRuntime,
  LocatorTarget,
  PointerFramePoints,
  ScrollAlignment,
} from "./types.js";

export async function probeLocatorAction(
  runtime: LocatorRuntime,
  target: LocatorTarget,
  options: {
    force: boolean;
    needsEditable: boolean;
    needsEnabled: boolean;
    needsHitTarget: boolean;
    needsStable: boolean;
    scrollAlignment: ScrollAlignment;
  },
  timeoutMs: number,
): Promise<ActionProbeExecution> {
  const operation = (async (): Promise<ActionProbe> => {
    const context = await runtime.context(target.frame);
    const expression = `(async () => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      ${STRICT_VISIBLE_SELECTOR_HELPER}
      const parsedSelector = injected.parseSelector(${JSON.stringify(target.selector)});
      const resolveCurrentElement = () =>
        querySelectorStrictWithVisibleFallback(injected, parsedSelector, root);
      let element = resolveCurrentElement();
      if (!element) return { count: 0, actionable: false };
      const stateNames = [];
      if (!${String(options.force)}) stateNames.push("visible");
      if (${String(options.needsEnabled && !options.force)}) stateNames.push("enabled");
      if (${String(options.needsEditable)}) stateNames.push("editable");
      const checkStates = (candidate) => {
        if (!candidate.isConnected) return "detached";
        for (const stateName of stateNames) {
          const result = injected.elementState(candidate, stateName);
          if (result.received === "error:notconnected") return "detached";
          if (!result.matches) return stateName;
        }
        return null;
      };
      const initialState = checkStates(element);
      if (initialState) {
        const reason = initialState === "visible" ? "hidden" :
          initialState === "enabled" ? "disabled" :
          initialState === "editable" ? "not-editable" : "not-stable";
        return { count: initialState === "detached" ? 0 : 1, actionable: false, reason };
      }
      element.scrollIntoView({
        block: ${JSON.stringify(options.scrollAlignment.block)},
        inline: ${JSON.stringify(options.scrollAlignment.inline)},
        behavior: "instant"
      });
      const waitForAnimationFrame = () => new Promise(resolve => {
        const view = element.ownerDocument?.defaultView;
        if (typeof view?.requestAnimationFrame === "function") view.requestAnimationFrame(() => resolve(undefined));
        else globalThis.setTimeout(() => resolve(undefined), 0);
      });
      let rect = element.getBoundingClientRect();
      if (${String(options.needsStable)}) {
        let stableFrames = 0;
        for (let index = 0; index < 10 && stableFrames < 2; index += 1) {
          await waitForAnimationFrame();
          // Bug 根因：el-table 等页面会在 rAF 间用同 locator、同几何的新 DOM node 替换旧 node。
          // locator 描述当前匹配目标，不绑定首次 node identity；detach 后应重解析再比较几何。
          const currentElement = element.isConnected ? element : resolveCurrentElement();
          if (!currentElement) return { count: 0, actionable: false };
          const next = currentElement.getBoundingClientRect();
          const unchanged = rect.left === next.left && rect.top === next.top &&
            rect.width === next.width && rect.height === next.height;
          stableFrames = unchanged ? stableFrames + 1 : 0;
          rect = next;
          element = currentElement;
        }
        if (stableFrames < 2) return { count: 1, actionable: false, reason: "not-stable" };
      }
      const finalState = checkStates(element);
      if (finalState) {
        const reason = finalState === "visible" ? "hidden" :
          finalState === "enabled" ? "disabled" :
          finalState === "editable" ? "not-editable" : "not-stable";
        return { count: finalState === "detached" ? 0 : 1, actionable: false, reason };
      }
      const checked = "checked" in element ? Boolean(element.checked) : undefined;
      if (!${String(options.needsHitTarget)}) return { count: 1, actionable: true, checked };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const inViewport = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 &&
        x <= globalThis.innerWidth && y <= globalThis.innerHeight;
      const hitResult = inViewport ? injected.expectHitTarget({ x, y }, element) : "outside-viewport";
      const receivesEvents = hitResult === "done";
      if (!inViewport) return { count: 1, actionable: false, reason: "outside-viewport", checked };
      if (!receivesEvents) {
        const obstruction = typeof hitResult === "string" ? hitResult :
          hitResult?.hitTargetDescription ?? "another element";
        return { count: 1, actionable: false, reason: "covered", obstruction, checked };
      }
      return { count: 1, actionable: true, x, y, checked };
      })()`;
    const rawValue = (await runtime.evaluate(context, expression, true, timeoutMs)).value;
    const value = requireActionProbe(rawValue, target.selector);
    return value;
  })();
  return raceActionProbe(runtime, operation, target.frame, timeoutMs);
}

function requireActionProbe(value: unknown, selector: string): ActionProbe {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isInteger((value as { count?: unknown }).count) ||
    Number((value as { count?: unknown }).count) < 0 ||
    Number((value as { count?: unknown }).count) > 1 ||
    typeof (value as { actionable?: unknown }).actionable !== "boolean"
  ) {
    // 直接读取异步 Runtime.evaluate 返回值的 count 会在 CDP 空 payload 时泄漏
    // “Cannot read properties of undefined”。这里保留 backend 故障语义，禁止伪装成零匹配。
    logger.debug("[browser-use] invalid pointer probe payload", {
      selector,
      valueKeys: value && typeof value === "object" ? Object.keys(value) : [],
      valueType: value === null ? "null" : typeof value,
    });
    throw new Error(
      `Playwright pointer probe returned an invalid payload for selector ${selector}`,
    );
  }
  const probe = value as ActionProbe;
  if (
    (probe.x !== undefined && !Number.isFinite(probe.x)) ||
    (probe.y !== undefined && !Number.isFinite(probe.y))
  ) {
    throw new Error(
      `Playwright pointer probe returned invalid coordinates for selector ${selector}`,
    );
  }
  return probe;
}

export function pointerFramePoints(target: LocatorTarget, probe: ActionProbe): PointerFramePoints {
  if (probe.x === undefined || probe.y === undefined) {
    throw new Error(
      `Playwright pointer probe returned no click point for selector ${target.selector}`,
    );
  }
  let point = { x: probe.x, y: probe.y };
  const boundaryPoints = new Map<FrameBoundary, { x: number; y: number }>();
  for (const boundary of target.boundaries.toReversed()) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = boundary.contentQuad;
    const u = point.x / boundary.childSize.width;
    const v = point.y / boundary.childSize.height;
    point = {
      x: x0 * (1 - u) * (1 - v) + x1 * u * (1 - v) + x2 * u * v + x3 * (1 - u) * v,
      y: y0 * (1 - u) * (1 - v) + y1 * u * (1 - v) + y2 * u * v + y3 * (1 - u) * v,
    };
    boundaryPoints.set(boundary, point);
  }
  return { boundaryPoints, top: point };
}

export async function frameObstruction(
  runtime: LocatorRuntime,
  target: LocatorTarget,
  points: PointerFramePoints,
): Promise<string | undefined> {
  for (const boundary of target.boundaries.toReversed()) {
    const point = points.boundaryPoints.get(boundary);
    if (!point) throw new Error("Playwright pointer frame chain is incomplete");
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    try {
      const hit = (await runtime.send(boundary.parent, "DOM.getNodeForLocation", {
        includeUserAgentShadowDOM: true,
        x,
        y,
      })) as { backendNodeId?: number };
      if (!hit.backendNodeId || hit.backendNodeId === boundary.ownerBackendNodeId) continue;
      const described = (await runtime.send(boundary.parent, "DOM.describeNode", {
        backendNodeId: hit.backendNodeId,
      })) as {
        node?: {
          attributes?: string[];
          localName?: string;
          nodeName?: string;
        };
      };
      const node = described.node;
      const name = node?.localName || node?.nodeName?.toLowerCase() || "another element";
      return `<${name}>`;
    } catch {
      // frame boundary 的辅助遮挡探测失败不覆盖主 selector/actionability 结果。
    }
  }
  return undefined;
}

function raceActionProbe(
  runtime: LocatorRuntime,
  operation: Promise<ActionProbe>,
  target: CdpTarget,
  timeoutMs: number,
): Promise<ActionProbeExecution> {
  if (runtime.signal?.aborted) return Promise.resolve({ kind: "cancelled" });
  return new Promise<ActionProbeExecution>((resolve, reject) => {
    let settled = false;
    const finish = (result: ActionProbeExecution) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runtime.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const terminate = () => {
      void runtime.view.cdp
        .send("Runtime.terminateExecution", undefined, target.sessionId)
        .catch(() => undefined);
    };
    // Runtime.evaluate.timeout 在 injected checkElementStates 等待 rAF 时不足以保证
    // host 侧截止。用剩余 locator 预算竞速，避免 3s routine timeout 外溢成 30s MCP AbortError。
    const timer = setTimeout(
      () => {
        terminate();
        finish({ kind: "timeout" });
      },
      Math.max(0, timeoutMs),
    );
    const onAbort = () => {
      terminate();
      finish({ kind: "cancelled" });
    };
    runtime.signal?.addEventListener("abort", onAbort, { once: true });
    if (runtime.signal?.aborted) onAbort();
    operation.then(
      (value) => finish({ kind: "done", value }),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        runtime.signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
