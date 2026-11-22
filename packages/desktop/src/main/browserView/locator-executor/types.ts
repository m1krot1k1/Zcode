import type { BrowserPlaywrightAction } from "@zcode/shared";
import type { ControlledView } from "../browserCommandTypes.js";

export type LocatorAction = Extract<BrowserPlaywrightAction, { name: "locator" }>;

export interface CdpTarget {
  frameId: string;
  sessionId?: string;
}

export interface FrameContext extends CdpTarget {
  contextId: number;
}

export interface RuntimeResult {
  objectId?: string;
  subtype?: string;
  value?: unknown;
}

export interface RuntimeResponse {
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
  result?: RuntimeResult;
}

export interface LocatorTarget {
  boundaries: FrameBoundary[];
  frame: CdpTarget;
  selector: string;
}

export interface FrameBoundary {
  childSize: { height: number; width: number };
  contentQuad: [number, number, number, number, number, number, number, number];
  ownerBackendNodeId: number;
  parent: CdpTarget;
}

export interface PointerFramePoints {
  boundaryPoints: Map<FrameBoundary, { x: number; y: number }>;
  top: { x: number; y: number };
}

export interface ActionProbe {
  count: number;
  actionable: boolean;
  checked?: boolean;
  reason?: "disabled" | "hidden" | "not-editable" | "not-stable" | "outside-viewport" | "covered";
  obstruction?: string;
  x?: number;
  y?: number;
}

export interface ScrollAlignment {
  block: "center" | "end" | "nearest" | "start";
  inline: "center" | "end" | "nearest" | "start";
}

export const POINTER_SCROLL_ALIGNMENTS: readonly ScrollAlignment[] = [
  { block: "center", inline: "center" },
  { block: "end", inline: "end" },
  { block: "start", inline: "start" },
  { block: "nearest", inline: "nearest" },
];

export type ActionProbeExecution =
  | { kind: "done"; value: ActionProbe }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export type IabLocatorExecution =
  | { kind: "done"; value?: unknown }
  | { kind: "timeout"; reason: string }
  | { kind: "cancelled" };

/**
 * 会话对 locator 执行器暴露的最小运行时：isolated world 上下文、Runtime.evaluate 与
 * 目标 session 的 CDP 转发。执行流程拆分到多个模块后仍共用同一份会话状态，
 * 保证 selector 解析、frame target 与 CDP trusted input 的顺序不变。
 */
export interface LocatorRuntime {
  readonly signal?: AbortSignal;
  readonly view: ControlledView;
  context(target: CdpTarget): Promise<FrameContext>;
  evaluate(
    context: FrameContext,
    expression: string,
    returnByValue: boolean,
    timeoutMs?: number,
  ): Promise<RuntimeResult>;
  send(target: { sessionId?: string }, method: string, params?: unknown): Promise<unknown>;
}
