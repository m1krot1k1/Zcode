import type {
  BrowserViewportSize,
  BrowserDialog,
  BrowserGuestAttachResult,
  BrowserViewResidencyReportPayload,
  BrowserViewCloseTabRequest,
  BrowserViewRestoredTabShell,
  BrowserCommand,
  BrowserCommandResult,
  BrowserRecordingJob,
  BrowserRecordingOptions,
  BrowserRecordingAction,
  BrowserTabSummary,
  BrowserUserTabInfo,
  BrowserResponseMeta,
  BrowserGuestAttachRejectReason,
} from "@zcode/shared";
import type { ControlledView } from "./browserCommandExecutor.js";
import type { BrowserScreenshotSurfaceCoordinator } from "./browserScreenshotSurfaceCoordinator.js";
import type {
  BrowserWindowForTransparentBootstrap,
  TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";
import type { BrowserTabResidencyRecord } from "./browserTabResidencyCoordinator.js";
import { BrowserTabResidencyCoordinator } from "./browserTabResidencyCoordinator.js";
import type {
  BrowserGuestExecutionContext,
  BrowserGuestManagerResidencyOptions,
  ManagedTab,
  PendingWaiter,
  RunningRequest,
  InFlightScreenshot,
  BrowserRecordingEntry,
  DownloadRecord,
  DownloadWaiter,
  GuestWebContents,
  InternalExecutionContext,
  GuestRecoveryReason,
} from "./browserGuestTypes.js";

/** BrowserGuestManager 的构造依赖；参数顺序与旧构造签名逐位对应。 */
export interface BrowserGuestManagerDeps {
  log?: (msg: string) => void;
  attachTimeoutMs: number;
  onCloseTabRequested?: (tabId: string, owner?: BrowserGuestExecutionContext) => void;
  onOpenTabRequested?: (tabId: string, owner: BrowserGuestExecutionContext) => void;
  onVisibilityChanged?: (
    visible: boolean,
    owner: BrowserGuestExecutionContext,
    tabId?: string,
  ) => void;
  onViewportChanged?: (
    viewport: BrowserViewportSize | null,
    owner: BrowserGuestExecutionContext,
    tabId: string,
  ) => void;
  resizeScreenshotToCssPixels?: ControlledView["resizeScreenshotToCssPixels"];
  screenshotSurfaceCoordinator?: BrowserScreenshotSurfaceCoordinator;
  residencyOptions: BrowserGuestManagerResidencyOptions;
  resolveOwnerWindow?: (windowId: number) => BrowserWindowForTransparentBootstrap | null;
  cdpIdleReleaseMs: number;
}

/** IAB guest 状态机的运行时状态；是 ctx 的唯一写入 owner。 */
export interface BrowserGuestRuntimeState extends BrowserGuestManagerDeps {
  readonly tabs: Map<string, ManagedTab>;

  /** close 后只保留 opaque id tombstone，拒绝迟到的 renderer attach，不保留 owner/guest。 */
  readonly closedTabIds: Set<string>;

  readonly activeTabByScope: Map<string, string>;

  readonly defaultTabByScope: Map<string, string>;

  readonly waiters: Map<string, PendingWaiter[]>;

  readonly pendingDialogs: Map<string, BrowserDialog>;

  readonly runningRequests: Map<string, RunningRequest>;

  /**
   * CDP Page.captureScreenshot 没有单请求取消 API。外层 timeout/cancel 后 promise 可能仍在
   * Chromium 内执行。请求 abort/deadline 即刻
   * settle 并释放屏障，允许同 tab 立即重试——重叠是瞬态且自排空的：下一次截图的透明
   * presentation 会恢复产帧，旧的挂起 capture 随之落定；结果按各自 promise 链归属，迟到
   * 结果不会误挂到新请求（clearTrackedScreenshot 以 entry identity 幂等）。旧的“保留屏障
   * 直到真实 settle”会把永不落定的挂起请求变成该 tab 的截图死锁（生产实测 pendingMs
   * 120s+），已被废弃。堆积风险由 abandonedScreenshotCaptures 的硬上限兜底。
   */
  readonly inFlightScreenshots: Map<string, InFlightScreenshot>;

  /** 见 MAX_ABANDONED_SCREENSHOT_CAPTURES；key 为 tabId。 */
  readonly abandonedScreenshotCaptures: Map<string, number>;

  readonly recordings: Map<string, BrowserRecordingEntry>;

  readonly downloads: Map<string, DownloadRecord>;

  readonly queuedDownloads: Map<string, string[]>;

  readonly downloadWaiters: Map<string, DownloadWaiter[]>;

  readonly sessionNames: Map<string, string>;

  readonly visibilityByScope: Map<string, boolean>;

  readonly naturalViewportByWindow: Map<number, BrowserViewportSize>;

  readonly residencyCoordinator: BrowserTabResidencyCoordinator;

  readonly suspendAckWaiters: Map<string, () => void>;

  readonly suspendFlights: Map<string, Promise<void>>;

  readonly restoreFlights: Map<string, Promise<GuestWebContents | null>>;

  /** guest 被销毁后重绑时，替代 guest 必须先完成原页面恢复再接收新的 browser 命令。 */
  readonly guestRecoveryFlights: Map<string, Promise<GuestWebContents | null>>;

  /** 同一 tab 的 attach/rebind 只允许一个 flight，避免并发命令各自重建 webview。 */
  readonly guestAttachFlights: Map<string, Promise<GuestWebContents | null>>;

  readonly restoredTabClaims: Map<string, number>;
}

/**
 * 域模块共享的上下文：状态 + 旧 BrowserGuestManager 的成员签名（原 private 成员在
 * 域模块之间通过 ctx 调用）。方法由各域工厂注入，状态只在 RuntimeState 里持有。
 */
export interface BrowserGuestContext extends BrowserGuestRuntimeState {
  /** 资源管理器：当前仍活着的浏览器 guest webContents id，用于把其 renderer 归到内置插件 browser-use */
  listGuestWebContentsIds(): number[];

  attachGuest(
    tabId: string,
    webContentsId: number,
    options?: {
      active?: boolean;
      windowId?: number;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    },
  ): BrowserGuestAttachResult;

  /** Renderer 自由尺寸交互回写；发送方窗口由 IPC 层绑定，不能跨窗口修改其它 tab。 */
  updateViewportFromRenderer(
    tabId: string,
    viewport: BrowserViewportSize | null,
    windowId: number,
  ): Promise<void>;

  getTabOwner(tabId: string): BrowserGuestExecutionContext | null;

  /** 根据 guest WebContents 反查受控 tab，供 webview popup 事件保留原始 session scope。 */
  getTabOwnerByWebContentsId(
    webContentsId: number,
  ): (BrowserGuestExecutionContext & { tabId: string }) | null;

  reportResidency(payload: BrowserViewResidencyReportPayload & { windowId: number }): Promise<void>;

  acknowledgeSuspend(payload: { tabId: string; generation: number; windowId: number }): void;

  closeTabFromRenderer(payload: BrowserViewCloseTabRequest & { windowId: number }): Promise<void>;

  whenRecoveryIdle(): Promise<void>;

  ensureResidentFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void>;

  restoreTabs(payload: {
    windowId: number;
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserViewRestoredTabShell[]>;

  execute(
    contextOrKey: BrowserGuestExecutionContext | string,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult>;

  executeInScope(
    context: InternalExecutionContext,
    command: BrowserCommand,
    running: RunningRequest,
  ): Promise<BrowserCommandResult>;

  /**
   * renderer 的 logical viewport ready 只能证明 CSS 坐标系正确；Windows 负缩放
   * 下 Fit 预览仍可能只有 800×450 raster，CDP 会把它平铺为 1280×720。main 直接读取
   * 已合成的 guest surface，再归一化到逻辑 viewport；这不走曾触发 V8 FATAL 的 renderer
   * `<webview>.capturePage()` 调用，也不改变页面布局、DPR 或交互态 metrics。
   */
  executeScreenshotWithPreparedSurface(
    context: InternalExecutionContext,
    tab: ManagedTab,
    guest: GuestWebContents,
    command: BrowserCommand,
    running: RunningRequest,
    startedAt: number,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): Promise<BrowserCommandResult>;

  /** 窗口隐藏时为整幅 capture 建立一次性透明 presentation；窗口可见或能力未注入时为 no-op。 */
  startHiddenWindowCapturePresentation(
    context: InternalExecutionContext,
    guest: GuestWebContents,
  ): TransparentWindowBootstrap | undefined;

  /**
   * capture 结算的统一出口：execution、请求 abort、可选的有界 deadline 三者先到先结算。
   * 隐藏窗口等帧、上游 30s cancelRequest 等场景下 execution 可能永不落定；不等它，
   * 保证 viewport mutation 队列和 in-flight 槽位随请求一起释放。abort/deadline 先胜时
   * 底层 CDP command 仍在 Chromium 内 pending，计入 abandonedScreenshotCaptures 硬上限。
   */
  settleScreenshotCapture(
    execution: Promise<BrowserCommandResult>,
    signal: AbortSignal,
    context: InternalExecutionContext,
    startedAt: number,
    tabId: string,
    deadlineMs?: number,
  ): Promise<BrowserCommandResult>;

  /** 记一笔“已放弃等待但底层仍在执行”的 capture；真实落定后名额自动回收。 */
  abandonBackendCapture(tabId: string, execution: Promise<BrowserCommandResult>): void;

  releaseAbandonedBackendCapture(tabId: string): void;

  recordingNow(): number;

  /**
   * 挂起截图是否仍存活：对应命令还在执行中（runningRequests 里有未 abort 的条目）。
   * 条目已消失说明命令早已返回（典型为 30s watchdog 判死）而 execution 悬空——死槽位。
   */
  isInFlightScreenshotAlive(tracked: InFlightScreenshot): boolean;

  createRecordingEntry(context: InternalExecutionContext, tab: ManagedTab): BrowserRecordingEntry;

  snapshotRecording(entry: BrowserRecordingEntry): BrowserRecordingJob;

  setRecordingPhase(
    entry: BrowserRecordingEntry,
    phase: Extract<BrowserRecordingJob["phase"], "capturing" | "finalizing">,
  ): void;

  setRecordingTerminal(
    entry: BrowserRecordingEntry,
    status: Extract<BrowserRecordingJob["status"], "completed" | "failed" | "cancelled">,
    error?: string,
  ): void;

  abortRecordings(predicate: (entry: BrowserRecordingEntry) => boolean, reason: string): void;

  runRecording(
    entry: BrowserRecordingEntry,
    tab: ManagedTab,
    rawOptions?: BrowserRecordingOptions,
  ): Promise<void>;

  /** 把录制期间临时改写的 tab viewport 交还给录制前的状态。 */
  restoreRecordingViewport(
    tab: ManagedTab,
    previous: BrowserViewportSize | undefined,
  ): Promise<void>;

  executeRecordingActions(
    view: ControlledView,
    actions: BrowserRecordingAction[],
    signal: AbortSignal,
    viewport: BrowserViewportSize,
  ): Promise<void>;

  executeRecordingAction(
    view: ControlledView,
    action: BrowserRecordingAction,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void>;

  executeRecordingBrowserCommand(view: ControlledView, command: BrowserCommand): Promise<void>;

  resolveRecordingSelectorPoint(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }>;

  resolveRecordingSelectorScrollTarget(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }>;

  moveRecordingPointer(
    view: ControlledView,
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void>;

  installRecordingCursorOverlay(guest: GuestWebContents): Promise<void>;

  removeRecordingCursorOverlay(guest: GuestWebContents): Promise<void>;

  animateRecordingScroll(
    view: ControlledView,
    deltaX: number,
    deltaY: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void>;

  resolveTab(context: InternalExecutionContext, explicitTabId?: string): ManagedTab | undefined;

  createTab(
    context: InternalExecutionContext,
    preferredTabId?: string,
    makeDefault?: boolean,
  ): ManagedTab;

  ensureGuest(tab: ManagedTab, signal: AbortSignal): Promise<GuestWebContents | null>;

  waitForGuestRecovery(
    tab: ManagedTab,
    guest: GuestWebContents,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null>;

  runGuestAttachFlight(tab: ManagedTab): Promise<GuestWebContents | null>;

  ownedTabs(context: InternalExecutionContext): ManagedTab[];

  canClaimUserTab(tab: ManagedTab, context: InternalExecutionContext): boolean;

  openUserTabs(context: InternalExecutionContext): ManagedTab[];

  hasDiscoverableUserPage(tab: ManagedTab): boolean;

  claimTab(tab: ManagedTab, context: InternalExecutionContext): ManagedTab;

  selectTab(tab: ManagedTab, notifyRenderer: boolean): void;

  releaseToUser(tab: ManagedTab): void;

  finalizeTabs(
    context: InternalExecutionContext,
    keep: Map<string, "handoff" | "deliverable">,
  ): void;

  /**
   * tabs.list() 里 active 的唯一判定。语义是「不带 tabId 的命令会落到哪个 tab」，与 resolveTab
   * 对齐，而不是「UI 当前是否可见」——可见性有独立的 browserVisibilitySet/Get 通道。
   *
   * 必须带回退：会话在后台跑时 renderer 的 isVisible 恒为 false，只会上报
   * attachGuest({active:false})，scope 内没有任何 tab 自报 active，activeTabByScope 也是空的。
   * CLI 的 turn-end 自动截图用 tabs.find(t => t.active === true) 寻址且没有回退，于是静默跳过，
   * 用户侧表现为后台会话结束时没有截图。回退到该 scope 最近存活的 tab（与 browserVisibilitySet
   * 和 CLI 侧 tabs.selected() 的 at(-1) 回退一致）后，list 报的 active 与命令落点重新一致。
   */
  effectiveActiveTabId(owner: InternalExecutionContext): string | undefined;

  summary(tab: ManagedTab): Promise<BrowserTabSummary>;

  readTabViewport(tab: ManagedTab): Promise<BrowserViewportSize>;

  userTabInfo(tab: ManagedTab): BrowserUserTabInfo;

  withMeta(
    result: BrowserCommandResult,
    context: InternalExecutionContext,
    tab?: ManagedTab,
    lifecycleOverride?: BrowserResponseMeta["lifecycle"],
  ): BrowserCommandResult;

  cancelledOrUnavailable(
    context: InternalExecutionContext,
    running: RunningRequest,
    startedAt: number,
    tab: ManagedTab,
  ): BrowserCommandResult;

  unavailableTabResult(
    context: InternalExecutionContext,
    tabId: string | undefined,
    startedAt: number,
  ): BrowserCommandResult;

  cancelledResult(
    _context: InternalExecutionContext,
    dispatched: boolean,
    startedAt: number,
  ): BrowserCommandResult;

  abortRequest(requestId: string, context: InternalExecutionContext): boolean;

  endTurn(context: InternalExecutionContext, turnId?: string): void;

  releaseGuestCdpAfterIdle(tab: ManagedTab, reason: string): void;

  /**
   * 命令级空闲释放：每次 CDP 命令完成后重置计时，超过 cdpIdleReleaseMs 无新命令即主动
   * detach。guest renderer 被 Chromium 杀且 render-process-gone 丢失（Electron 已知缺口，
   * 实测 destroyed 直达 + CDP attached → 主进程 UAF）的崩溃窗口集中在 turn 内命令间隙，
   * turnEnded 级释放覆盖不到；密集命令流间隔远小于阈值，不会被误打断。
   */
  scheduleGuestCdpIdleRelease(tab: ManagedTab): void;

  clearGuestCdpIdleRelease(tab: ManagedTab): void;

  closeSession(context: InternalExecutionContext): void;

  /**
   * `closeSession({ closeTabs: true })`：真正关闭该 session 名下的全部 tab。按 session 归属而非完整
   * browser scope 匹配——finalize / deliverable 已释放回该 session 的 tab 换到了 `unclaimed-iab` scope，
   * 仍归它。只给永不回来认领的 session 用（dwf 子代理，
   * docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md §2.3）：它的 sessionId 不是任何
   * 对话，closeSession 保留的 view 无人可见、无人可认领，只会一直挂着 guest。
   */
  closeSessionTabs(context: InternalExecutionContext): Promise<void>;

  closeWindow(windowId: number): void;

  removeTabRecovery(tab: ManagedTab): Promise<void>;

  closeTabDurably(tab: ManagedTab, notifyRenderer?: boolean): Promise<void>;

  closeTab(tab: ManagedTab, notifyRenderer?: boolean): void;

  /**
   * guest renderer 崩溃/被杀时立即断开 CDP。
   *
   * 崩溃链条（主进程 UAF，minidump 落在 DevToolsSession::DispatchProtocolNotification，
   * client_ 的 vptr 为 0）：
   *   Chromium 在内存压力下杀掉 guest renderer
   *     → render-process-gone：WebContents 仍存活，CDP 仍 attached
   *     → renderer 侧递增 webviewGeneration，React 卸载旧 <webview>
   *     → 旧 WebContents 此刻才销毁，api::Debugger 走隐式析构
   *     → DevToolsSession 仍持 client_ 派发在途通知 → UAF → 主进程崩溃 → 整个 app 退出
   *
   * 实测（Electron 41.0.3 / forcefullyCrashRenderer，带毫秒时间戳的对照实验）：
   *   - render-process-gone 时 isDestroyed()=false、isCrashed()=true、isAttached()=true，
   *     detach() 成功且随后 isAttached()=false；
   *   - destroyed 时 isCrashed()/isAttached() 全抛 "Object has been destroyed"，
   *     那里已经不可能 detach —— 所以 destroyed 兜底修不了这个 UAF；
   *   - 崩溃后若不卸载 <webview>，WebContents 无限期停在 crashed 态（10s destroyed 未到）；
   *     一旦 renderer 卸载 <webview>，destroyed 在 ~5ms 内到达。即销毁时机由 renderer 决定，
   *     native detach 的安全窗口只存在于 WebContents 销毁之前。
   * main 的 render-process-gone 是第一道守卫；renderer 重建前的显式 detach ACK 是第二道屏障，
   * 用来覆盖 main 事件未到达的现场。两者都不改变销毁时机，只保证销毁时 CDP 已经断开。
   */
  setupCdpCrashGuard(tab: ManagedTab, guest: GuestWebContents): void;

  setupDialogTracking(tab: ManagedTab, guest: GuestWebContents): void;

  applyViewportOverride(tab: ManagedTab): void;

  setTabViewport(tab: ManagedTab, viewport: BrowserViewportSize): Promise<void>;

  resetTabViewport(tab: ManagedTab): Promise<void>;

  applyBackgroundViewportFallback(tab: ManagedTab, viewport: BrowserViewportSize): Promise<void>;

  /**
   * 前台激活路径的统一收口：后台 fallback viewport 不能在 tab 回到前台后残留。
   * 仅在 attachGuest({active:true}) 时清除是不够的：guest 存活期间的前台切换
   * （activateTab / claim / renderer residency 上报）不会重新 attach，页面就永久钉死在
   * 后台尺寸。restoreNaturalViewportAfterBackground 自带幂等守卫与串行 mutation 队列，
   * 多个前台信号重复触发是安全的。
   */
  maybeRestoreBackgroundViewport(tab: ManagedTab): void;

  restoreNaturalViewportAfterBackground(tab: ManagedTab): void;

  enqueueViewportMutation(tab: ManagedTab, mutation: () => Promise<void>): Promise<void>;

  setupDownloadTracking(tab: ManagedTab, guest: GuestWebContents): void;

  waitForDownload(tabId: string, timeoutMs: number, signal: AbortSignal): Promise<string | null>;

  finishDownloadWaiter(tabId: string, waiter: DownloadWaiter, downloadId: string | null): void;

  /**
   * CDP session 态恢复式 attach：idle/turn 结束释放后再次进入命令期时调用，
   * 返回可等待的 flight——Page.enable 与 viewport override 重放完成后业务命令才允许派发。
   *
   * Page 域 enable 与 Emulation.setDeviceMetricsOverride 都是 per-session 的，
   * detach 时已被 Chromium 清空；
   * 裸 attach("1.3") 得到的是干净 session——dialog 事件黑洞（getDialog 恒 null、evaluate
   * 遇 JS dialog 挂到超时实测 62s）、viewport 仿真与 manager 缓存分叉。且 fire-and-forget
   * 重放没有等待屏障：业务命令（截图/evaluate）可能在恢复完成前执行，重放在首命令场景
   * 失效。恢复命令经 raw 发送（不走 ensure，避免自等待）；viewport 重放走既有串行队列，
   * 队列内触发恢复时直接重放，避免二次入队与当前 flight 互相等待死锁。
   */
  ensureGuestCdpAttached(tab: ManagedTab, guest: GuestWebContents): Promise<void>;

  runGuestCdpSessionRestore(tab: ManagedTab, guest: GuestWebContents): Promise<void>;

  /** 恢复失败时把半途 session 还原为释放态；rollback 自身的失败不得掩盖原始错误。 */
  rollbackGuestCdpRestore(tab: ManagedTab, guest: GuestWebContents): void;

  /** 恢复命令专用发送：只做 pending 计数与下发，不触发 ensure（避免自等待死锁）。 */
  sendGuestCdpCommandRaw(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<unknown>;

  sendGuestCdpCommand(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
    assertCurrentGuest?: () => void,
  ): Promise<unknown>;

  toControlledView(
    guest: GuestWebContents,
    normalizeScreenshotToCssPixels: boolean,
    captureViewportScreenshot: ControlledView["captureViewportScreenshot"] | undefined,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): ControlledView;

  registerTabResidency(
    tab: ManagedTab,
    visible: boolean,
    residency?: BrowserTabResidencyRecord["residency"],
    lastSelectedAt?: number | null,
  ): void;

  closeTabForLimit(record: BrowserTabResidencyRecord): Promise<boolean>;

  restoreSuspendedGuest(tab: ManagedTab, signal: AbortSignal): Promise<GuestWebContents | null>;

  runRestoreSuspendedGuest(tab: ManagedTab, signal: AbortSignal): Promise<GuestWebContents | null>;

  restoreGuestState(tab: ManagedTab, guest: GuestWebContents): Promise<boolean>;

  restoreReboundGuest(tab: ManagedTab, guest: GuestWebContents): Promise<GuestWebContents | null>;

  persistRecoverySnapshot(tab: ManagedTab, guest: GuestWebContents): Promise<void>;

  persistShell(tab: ManagedTab): Promise<void>;

  requireRendererOwnedTab(
    payload:
      | (BrowserViewCloseTabRequest & { windowId: number })
      | (BrowserViewResidencyReportPayload & { windowId: number }),
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;

  setupActivityTracking(tab: ManagedTab, guest: GuestWebContents): void;

  refreshRuntimeProtection(tabId: string): void;

  hasRunningRequestForTab(tabId: string): boolean;

  isTabCaptureActive(tab: ManagedTab): boolean;

  hasPendingDownloadForTab(tabId: string): boolean;

  detachAndCloseGuest(tab: ManagedTab): void;

  rejectGuestAttach(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: BrowserGuestAttachRejectReason,
  ): BrowserGuestAttachResult;

  requestGuestRebind(tab: ManagedTab, reason: GuestRecoveryReason): boolean;

  closeGuestWebContents(tab: ManagedTab, guest?: GuestWebContents): void;

  now(): number;

  warn(message: string, error?: unknown): void;

  detach(key: string): void;

  /**
   * renderer 即将用 React key 替换 `<webview>` 时，先关闭旧 guest 的 native CDP 通路。
   *
   * Electron 的 `render-process-gone` 并非每次都会先到达 main 的 WebContents
   * 监听；renderer 若直接卸载节点，`destroyed` 才到达时已无法调用 debugger.detach()，
   * DevToolsSession 仍可能向已析构 client 派发在途通知并触发主进程 UAF。这里把 DOM 销毁
   * 变成 main ACK 之后的第二阶段，并用 sender window + 当前 guest id 双重校验，避免迟到
   * 的旧代事件断开刚接管 tab 的新 guest。
   */
  detachGuestBeforeReplacement(
    tabId: string,
    webContentsId: number,
    windowId: number,
  ): Promise<boolean>;

  beginGuestTeardown(tab: ManagedTab, guest: GuestWebContents, reason: string): Promise<boolean>;

  runGuestTeardown(tab: ManagedTab, guest: GuestWebContents, reason: string): Promise<boolean>;

  waitForGuestCdpIdle(tab: ManagedTab, timeoutMs: number): Promise<boolean>;

  /** 内存诊断计数器；只读 size。 */
  collectMemoryDiagnostics(): Record<string, number>;

  detachGuest(tab: ManagedTab): void;

  hasGuest(key: string): boolean;

  disposeAll(): void;

  waitForGuest(tabId: string, signal?: AbortSignal): Promise<GuestWebContents | null>;

  removeWaiter(tabId: string, waiter: PendingWaiter): void;

  resolveWaiters(tabId: string, guest: GuestWebContents | null): void;
}

export function createBrowserGuestContext(
  deps: BrowserGuestManagerDeps,
  onEvict: (record: BrowserTabResidencyRecord) => Promise<boolean>,
): BrowserGuestRuntimeState {
  return {
    ...deps,
    tabs: new Map<string, ManagedTab>(),
    closedTabIds: new Set<string>(),
    activeTabByScope: new Map<string, string>(),
    defaultTabByScope: new Map<string, string>(),
    waiters: new Map<string, PendingWaiter[]>(),
    pendingDialogs: new Map<string, BrowserDialog>(),
    runningRequests: new Map<string, RunningRequest>(),
    inFlightScreenshots: new Map<string, InFlightScreenshot>(),
    abandonedScreenshotCaptures: new Map<string, number>(),
    recordings: new Map<string, BrowserRecordingEntry>(),
    downloads: new Map<string, DownloadRecord>(),
    queuedDownloads: new Map<string, string[]>(),
    downloadWaiters: new Map<string, DownloadWaiter[]>(),
    sessionNames: new Map<string, string>(),
    visibilityByScope: new Map<string, boolean>(),
    naturalViewportByWindow: new Map<number, BrowserViewportSize>(),
    suspendAckWaiters: new Map<string, () => void>(),
    suspendFlights: new Map<string, Promise<void>>(),
    restoreFlights: new Map<string, Promise<GuestWebContents | null>>(),
    guestRecoveryFlights: new Map<string, Promise<GuestWebContents | null>>(),
    guestAttachFlights: new Map<string, Promise<GuestWebContents | null>>(),
    restoredTabClaims: new Map<string, number>(),
    residencyCoordinator: new BrowserTabResidencyCoordinator({
      tabLimit: deps.residencyOptions.tabLimit,
      now: deps.residencyOptions.now,
      onEvict,
    }),
  };
}
