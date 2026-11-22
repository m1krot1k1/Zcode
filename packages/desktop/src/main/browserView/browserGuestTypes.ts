import type { WebFrameMain } from "electron";
import type {
  BrowserClientMode,
  BrowserGuestAttachRejectReason,
  BrowserViewportSize,
  BrowserCommandResult,
  BrowserRecordingJob,
  BrowserViewResidencyTransitionPayload,
} from "@zcode/shared";
import type { BrowserWebmRecorderFactory } from "./browserVideoRecorder.js";
import type { BrowserTabRecoveryStore } from "./browserTabRecoveryStore.js";

export interface GuestWebContents {
  readonly id: number;
  readonly hostWebContents?: { getZoomFactor(): number } | null;
  readonly mainFrame: WebFrameMain;
  getType(): string;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  reload(): void;
  stop(): void;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    getAllEntries(): Array<{ url: string; title?: string; pageState?: string }>;
    getActiveIndex(): number;
    restore(options: {
      entries: Array<{ url: string; title?: string; pageState?: string }>;
      index: number;
    }): Promise<void>;
  };
  close(options?: { waitForBeforeUnload?: boolean }): void;
  isCurrentlyAudible?(): boolean;
  isBeingCaptured?(): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
    on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
    removeListener(
      event: "message",
      listener: (event: unknown, method: string, params: unknown) => void,
    ): void;
  };
  once(event: "destroyed", listener: () => void): void;
  session?: {
    on(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
    removeListener(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
  };
}

export interface GuestDownloadItem {
  getSavePath(): string;
  once(event: "done", listener: (event: unknown, state: string) => void): void;
}

export interface BrowserGuestExecutionContext {
  requestId: string;
  browserId: string;
  browserGeneration: number;
  windowId: number;
  workspaceKey: string;
  sessionId: string;
  turnId?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
}

export interface InternalExecutionContext extends BrowserGuestExecutionContext {
  legacy?: boolean;
}

export type TabLifecycle = "active" | "deliverable" | "handoff" | "closed";

export type GuestBindingLifecycle = "detached" | "attached" | "detaching" | "destroyed";

export type GuestRecoveryReason =
  | BrowserGuestAttachRejectReason
  | "guest-destroyed"
  | "attach-timeout";

export const TAB_CONTEXT_RECOVERY_HINT =
  "This is pre-action stale-binding recovery, not post-action popup observation. " +
  "Keep the existing browser binding; call browser.tabs.list(), then browser.tabs.get(info.id). " +
  "If the controlled list is empty, inspect browser.user.openTabs() and use browser.user.claimTab(info) " +
  "before creating a new tab.";

export interface ManagedTab {
  tabId: string;
  owner: InternalExecutionContext;
  guest?: GuestWebContents;
  /** guest replacement generation；命令 dispatch 前用来拒绝 stale guest。 */
  guestGeneration: number;
  /** 曾经成功绑定过 guest；用于区分新建 tab 的首次等待与已有 tab 的自愈。 */
  hasAttachedGuest: boolean;
  attachFailure?: GuestRecoveryReason;
  rebindRequested: boolean;
  cdpAttached: boolean;
  /** guest 的 native CDP 生命周期；DOM 销毁前必须先经过 detaching。 */
  guestLifecycle: GuestBindingLifecycle;
  /** 尚未 settle 的 debugger.sendCommand 数量，teardown 会等待其归零或超时。 */
  pendingCdpCommands: number;
  /** 命令流空闲释放的计时器；每次 CDP 命令完成后重置，detachGuest 时清除。 */
  guestCdpIdleTimer?: ReturnType<typeof setTimeout>;
  /** re-attach 会话态恢复 flight；业务命令必须 await 它完成才能派发（串行屏障）。 */
  guestCdpRestoreFlight?: Promise<void>;
  /** 当前已持有 viewport 临界区；CDP 重连直接重放，不能再次入队等待自己。 */
  insideViewportMutation?: boolean;
  /** 同一 guest 的 replacement teardown 只允许一个 flight，重复 ACK 共享结果。 */
  guestTeardownFlight?: Promise<boolean>;
  lifecycle: TabLifecycle;
  origin: "agent" | "user";
  /** human IAB tab 在同 window/workspace 首次操作前可被任一 session 发现。 */
  claimable: boolean;
  /** claimed user tab finalize/closeSession 时恢复为用户 tab，不能像 agent tab 一样关闭。 */
  userOwner?: InternalExecutionContext;
  active: boolean;
  /** Agent/UI 设置的单 tab CSS viewport；undefined 表示跟随宿主自然尺寸。 */
  viewportOverride?: BrowserViewportSize;
  /** pane 隐藏为 0×0 时仅供后台执行使用；重新前台可见后必须清除。 */
  backgroundViewportFallback?: BrowserViewportSize;
  /** 串行化 transient clear 与显式 set/reset，保证最后一次用户/Agent 设置胜出。 */
  viewportMutation?: Promise<void>;
  downloadCleanup?: () => void;
  activityCleanup?: () => void;
  /**
   * 注销 debugger 的 "message" 监听。guest 换代后旧监听不该继续挂着：它每次事件都要查表
   * 再靠 current.guest !== guest 兜底丢弃，属于纯泄漏。注意这只是 JS 层清理，native 侧的
   * CDP 通路要靠 debugger.detach() 才真正断开。
   */
  cdpMessageCleanup?: () => void;
  /**
   * 注销 render-process-gone 监听。该监听负责在 guest renderer 被杀、WebContents 尚存的
   * 窗口里主动断开 CDP —— 这是唯一能避免 api::Debugger 走隐式析构的时机。
   */
  crashGuardCleanup?: () => void;
  loading: boolean;
  mediaActive: boolean;
  cachedUrl: string;
  cachedTitle: string;
  cachedFaviconUrl: string | null;
  openedAt: number;
  restoredFromStore?: boolean;
}

export interface PendingWaiter {
  resolve: (guest: GuestWebContents | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface RunningRequest {
  context: InternalExecutionContext;
  controller: AbortController;
  dispatched: boolean;
  tabId?: string;
}

export interface InFlightScreenshot {
  execution: Promise<BrowserCommandResult>;
  requestId: string;
  startedAt: number;
}

export interface BrowserRecordingEntry {
  id: string;
  context: InternalExecutionContext;
  tabId: string;
  controller: AbortController;
  status: BrowserRecordingJob["status"];
  phase: BrowserRecordingJob["phase"];
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingJob["artifact"];
  error?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface DownloadRecord {
  tabId: string;
  path: string | null;
  state: "pending" | "completed" | "cancelled" | "interrupted";
}

export interface DownloadWaiter {
  resolve: (downloadId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
}

export const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;

// 透明 presentation 已就位时整幅 capture 的硬上限；正常应在数百 ms 内完成。
export const HIDDEN_WINDOW_CAPTURE_DEADLINE_MS = 5_000;

// 单个 tab 上"已放弃等待但底层 CDP capture 仍未结算"的硬上限。CDP 截图没有单请求
// 取消 API，重试会在 Chromium 内遗留 pending command；compositor 持续不可用时
// 不设上限会无限叠加（帧恢复时它们会同时排空，但 pendingCdpCommands 不归零、
// detach 走超时路径）。达到上限后同 tab 截图快速失败并提示重开 tab，旧 capture
// 真实落定后名额自动回收。
export const MAX_ABANDONED_SCREENSHOT_CAPTURES = 3;

/** teardown 等待 CDP 在途命令收敛的上限；超时后仍会尝试 native detach。 */
export const DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS = 1_000;

// CDP 命令流空闲释放阈值：覆盖实测崩溃窗口（turn 内命令间隙 0.4~9s）的同时，
// 不打断 agent 密集操作流（命令间隔通常远小于该值）。
export const DEFAULT_GUEST_CDP_IDLE_RELEASE_MS = 1_500;

export const RECORDING_RESULT_TTL_MS = 60 * 60 * 1_000;

export const DEFAULT_BACKGROUND_BROWSER_VIEWPORT: BrowserViewportSize = {
  width: 800,
  height: 600,
};

export type BrowserTabRecoveryStorePort = Pick<
  BrowserTabRecoveryStore,
  "upsert" | "upsertPageState" | "getPageState" | "removePageState" | "remove" | "listShells"
> &
  Partial<Pick<BrowserTabRecoveryStore, "whenIdle">>;

export interface BrowserGuestManagerResidencyOptions {
  tabLimit?: number;
  suspendAckTimeoutMs?: number;
  now?: () => number;
  recoveryStore?: BrowserTabRecoveryStorePort;
  onSuspendTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onRestoreTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onResidencyChanged?(payload: BrowserViewResidencyTransitionPayload): void;
  onRecoveryOrphanCloseRequested?(payload: { tabId: string; reason: "recovery-orphan" }): void;
  warn?(message: string): void;
  recording?: {
    tempRoot?: string;
    createRecorder?: BrowserWebmRecorderFactory;
    now?: () => number;
  };
}
