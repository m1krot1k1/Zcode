import type {
  BrowserBackendDescriptor,
  BrowserCapabilityDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserViewportSize,
} from "@zcode/contracts/browser-control";

export type BrowserExecuteFn = (command: BrowserCommand) => Promise<BrowserCommandResult>;
export type BrowserAvailabilityGuard = () => void;
export type BrowserTransportExecuteFn = (
  browserId: string,
  browserGeneration: number,
  command: BrowserCommand,
) => Promise<BrowserCommandResult>;
export type { BrowserBackendType } from "@zcode/contracts/browser-control";
export type BrowserCapabilityInfo = BrowserCapabilityDescriptor;

/** 视口坐标点（cua 坐标路 / drag / elementInfo 用；与 CDP Input 同坐标系）。 */
export interface Point {
  x: number;
  y: number;
}

export type BrowserInfo = BrowserBackendDescriptor;
export type BrowserDescriptor = Omit<BrowserInfo, "generation">;

export interface BrowserTabInfo {
  id: string;
  active?: boolean;
  title?: string;
  url?: string;
  viewport: BrowserViewportSize;
}

/** Tab 成员的动作签名：只表达命令是否成功，错误由 result 层抛出。 */
export type BrowserActionFn = (command: BrowserCommand) => Promise<void>;

/**
 * browser-client 只依赖 backend-neutral transport。IAB、Chrome extension 和 CDP provider
 * 都通过相同 descriptor/execute 接口接入，facade 不再自行伪造某个 backend 可用。
 */
export interface BrowserClientTransport {
  list(): Promise<BrowserInfo[]>;
  execute: BrowserTransportExecuteFn;
}
