import type {
  BrowserKeyModifier,
  BrowserMouseButton,
  BrowserSnapshot,
} from "@zcode/contracts/browser-control";
import type { BrowserActionFn, Point } from "./types.js";

export interface CuaTab {
  click(options: Point & { button?: number; keypress?: string[] }): Promise<void>;
  double_click(options: Point & { keypress?: string[] }): Promise<void>;
  downloadMedia(options: Point & { timeoutMs?: number }): Promise<void>;
  drag(options: { keys?: string[]; path: Point[] }): Promise<void>;
  keypress(options: { keys: string[] }): Promise<void>;
  move(options: Point & { keys?: string[] }): Promise<void>;
  scroll(options: Point & { keypress?: string[]; scrollX: number; scrollY: number }): Promise<void>;
  type(options: { text: string }): Promise<void>;
}

export interface DomCuaTab {
  get_visible_dom(): Promise<BrowserSnapshot>;
  click(options: { node_id: string }): Promise<void>;
  double_click(options: { node_id: string }): Promise<void>;
  downloadMedia(options: { node_id: string; timeoutMs?: number }): Promise<void>;
  type(options: { text: string }): Promise<void>;
  scroll(options: { node_id?: string; x: number; y: number }): Promise<void>;
  keypress(options: { keys: string[] }): Promise<void>;
}

function cuaButton(button = 1): BrowserMouseButton {
  if (button === 2) return "middle";
  if (button === 3) return "right";
  if (button === 1) return "left";
  throw new Error(`Unsupported CUA mouse button: ${button}`);
}

function cuaModifiers(keys: string[] = []): BrowserKeyModifier[] {
  return keys.filter((key): key is BrowserKeyModifier =>
    ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key),
  );
}

/** cua 对象保持按 getter 惰性构造：每次访问都生成新的成员闭包，命令顺序与 inline 版一致。 */
export function createCuaApi(action: BrowserActionFn): CuaTab {
  return {
    click: ({ x, y, button, keypress }) => {
      const modifiers = cuaModifiers(keypress);
      return action({
        method: "click",
        x,
        y,
        button: cuaButton(button),
        ...(modifiers.length > 0 ? { modifiers } : {}),
      });
    },
    double_click: ({ x, y, keypress }) => {
      const modifiers = cuaModifiers(keypress);
      return action({
        method: "click",
        x,
        y,
        doubleClick: true,
        ...(modifiers.length > 0 ? { modifiers } : {}),
      });
    },
    downloadMedia: ({ x, y }) => action({ method: "click", x, y }),
    drag: ({ keys, path }) => {
      if (path.length === 0) throw new Error("cua.drag requires a non-empty path");
      const modifiers = cuaModifiers(keys);
      return action({
        method: "cuaDrag",
        path,
        ...(modifiers.length > 0 ? { modifiers } : {}),
      });
    },
    keypress: ({ keys }) => action({ method: "cuaKeypress", keys }),
    move: ({ x, y, keys }) => {
      const modifiers = cuaModifiers(keys);
      return action({
        method: "hover",
        x,
        y,
        ...(modifiers.length > 0 ? { modifiers } : {}),
      });
    },
    scroll: ({ x, y, keypress, scrollX, scrollY }) => {
      const modifiers = cuaModifiers(keypress);
      return action({
        method: "cuaScroll",
        x,
        y,
        scrollX,
        scrollY,
        ...(modifiers.length > 0 ? { modifiers } : {}),
      });
    },
    type: ({ text }) => action({ method: "type", text }),
  };
}

export function createDomCuaApi(
  action: BrowserActionFn,
  snapshot: () => Promise<BrowserSnapshot>,
): DomCuaTab {
  return {
    get_visible_dom: () => snapshot(),
    click: ({ node_id }) => action({ method: "click", ref: node_id }),
    double_click: ({ node_id }) => action({ method: "click", ref: node_id, doubleClick: true }),
    downloadMedia: ({ node_id }) => action({ method: "click", ref: node_id }),
    type: ({ text }) => action({ method: "type", text }),
    scroll: ({ node_id, x, y }) =>
      action({ method: "domCuaScroll", nodeId: node_id, scrollX: x, scrollY: y }),
    keypress: ({ keys }) => action({ method: "cuaKeypress", keys }),
  };
}
