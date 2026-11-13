import type {
  BrowserViewportSize,
  BrowserGuestAttachResult,
  BrowserViewResidencyReportPayload,
  BrowserViewCloseTabRequest,
  BrowserViewRestoredTabShell,
  BrowserCommand,
  BrowserCommandResult,
} from "@zcode/shared";
import type { ControlledView } from "./browserCommandExecutor.js";
import type { BrowserScreenshotSurfaceCoordinator } from "./browserScreenshotSurfaceCoordinator.js";
import type { BrowserWindowForTransparentBootstrap } from "./browserTransparentWindowBootstrap.js";
import type {
  BrowserGuestExecutionContext,
  BrowserGuestManagerResidencyOptions,
  InternalExecutionContext,
} from "./browserGuestTypes.js";
import {
  DEFAULT_ATTACH_TIMEOUT_MS,
  DEFAULT_GUEST_CDP_IDLE_RELEASE_MS,
} from "./browserGuestTypes.js";
import { createBrowserGuestContext } from "./browserGuestContext.js";
import type { BrowserGuestContext } from "./browserGuestContext.js";
import { createBrowserGuestTabs } from "./browserGuestTabs.js";
import { createBrowserGuestLifecycle } from "./browserGuestLifecycle.js";
import { createBrowserGuestExecution } from "./browserGuestExecution.js";
import { createBrowserGuestScreenshots } from "./browserGuestScreenshots.js";
import { createBrowserGuestRecording } from "./browserGuestRecording.js";
import { createBrowserGuestCdp } from "./browserGuestCdp.js";
import { createBrowserGuestResidency } from "./browserGuestResidency.js";
import { createBrowserGuestViewport } from "./browserGuestViewport.js";
import { createBrowserGuestRuntime } from "./browserGuestRuntime.js";

/**
 * IAB guest registry 的公开入口。状态机由 `BrowserGuestContext` 唯一持有，
 * 各域模块（tabs / lifecycle / execution / screenshots / recording / cdp /
 * residency / viewport / runtime）通过 ctx 共享同一份状态，避免跨 scope 竞态。
 */
export class BrowserGuestManager {
  private readonly ctx: BrowserGuestContext;

  constructor(
    log?: (msg: string) => void,
    attachTimeoutMs: number = DEFAULT_ATTACH_TIMEOUT_MS,
    onCloseTabRequested?: (tabId: string, owner?: BrowserGuestExecutionContext) => void,
    onOpenTabRequested?: (tabId: string, owner: BrowserGuestExecutionContext) => void,
    onVisibilityChanged?: (
      visible: boolean,
      owner: BrowserGuestExecutionContext,
      tabId?: string,
    ) => void,
    onViewportChanged?: (
      viewport: BrowserViewportSize | null,
      owner: BrowserGuestExecutionContext,
      tabId: string,
    ) => void,
    resizeScreenshotToCssPixels?: ControlledView["resizeScreenshotToCssPixels"],
    screenshotSurfaceCoordinator?: BrowserScreenshotSurfaceCoordinator,
    residencyOptions: BrowserGuestManagerResidencyOptions = {},
    resolveOwnerWindow?: (windowId: number) => BrowserWindowForTransparentBootstrap | null,
    cdpIdleReleaseMs: number = DEFAULT_GUEST_CDP_IDLE_RELEASE_MS,
  ) {
    const ctx = createBrowserGuestContext(
      {
        log,
        attachTimeoutMs,
        onCloseTabRequested,
        onOpenTabRequested,
        onVisibilityChanged,
        onViewportChanged,
        resizeScreenshotToCssPixels,
        screenshotSurfaceCoordinator,
        residencyOptions,
        resolveOwnerWindow,
        cdpIdleReleaseMs,
      },
      // residency 淘汰回调只在 tab 创建之后触发，闭包捕获 ctx 不会在 init 期读取。
      (record) => ctx.closeTabForLimit(record),
    ) as BrowserGuestContext;
    Object.assign(ctx, createBrowserGuestTabs(ctx));
    Object.assign(ctx, createBrowserGuestLifecycle(ctx));
    Object.assign(ctx, createBrowserGuestExecution(ctx));
    Object.assign(ctx, createBrowserGuestScreenshots(ctx));
    Object.assign(ctx, createBrowserGuestRecording(ctx));
    Object.assign(ctx, createBrowserGuestCdp(ctx));
    Object.assign(ctx, createBrowserGuestResidency(ctx));
    Object.assign(ctx, createBrowserGuestViewport(ctx));
    Object.assign(ctx, createBrowserGuestRuntime(ctx));
    this.ctx = ctx;
  }

  listGuestWebContentsIds(): number[] {
    return this.ctx.listGuestWebContentsIds();
  }

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
  ): BrowserGuestAttachResult {
    return this.ctx.attachGuest(tabId, webContentsId, options);
  }

  async updateViewportFromRenderer(
    tabId: string,
    viewport: BrowserViewportSize | null,
    windowId: number,
  ): Promise<void> {
    return this.ctx.updateViewportFromRenderer(tabId, viewport, windowId);
  }

  getTabOwner(tabId: string): BrowserGuestExecutionContext | null {
    return this.ctx.getTabOwner(tabId);
  }

  getTabOwnerByWebContentsId(
    webContentsId: number,
  ): (BrowserGuestExecutionContext & { tabId: string }) | null {
    return this.ctx.getTabOwnerByWebContentsId(webContentsId);
  }

  async reportResidency(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
  ): Promise<void> {
    return this.ctx.reportResidency(payload);
  }

  acknowledgeSuspend(payload: { tabId: string; generation: number; windowId: number }): void {
    return this.ctx.acknowledgeSuspend(payload);
  }

  async closeTabFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    return this.ctx.closeTabFromRenderer(payload);
  }

  async whenRecoveryIdle(): Promise<void> {
    return this.ctx.whenRecoveryIdle();
  }

  async ensureResidentFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    return this.ctx.ensureResidentFromRenderer(payload);
  }

  async restoreTabs(payload: {
    windowId: number;
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserViewRestoredTabShell[]> {
    return this.ctx.restoreTabs(payload);
  }

  async execute(
    contextOrKey: BrowserGuestExecutionContext | string,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    return this.ctx.execute(contextOrKey, command, signal);
  }

  endTurn(context: InternalExecutionContext, turnId?: string): void {
    return this.ctx.endTurn(context, turnId);
  }

  closeSession(context: InternalExecutionContext): void {
    return this.ctx.closeSession(context);
  }

  closeWindow(windowId: number): void {
    return this.ctx.closeWindow(windowId);
  }

  detach(key: string): void {
    return this.ctx.detach(key);
  }

  async detachGuestBeforeReplacement(
    tabId: string,
    webContentsId: number,
    windowId: number,
  ): Promise<boolean> {
    return this.ctx.detachGuestBeforeReplacement(tabId, webContentsId, windowId);
  }

  collectMemoryDiagnostics(): Record<string, number> {
    return this.ctx.collectMemoryDiagnostics();
  }

  hasGuest(key: string): boolean {
    return this.ctx.hasGuest(key);
  }

  disposeAll(): void {
    return this.ctx.disposeAll();
  }
}

export type { BrowserGuestExecutionContext } from "./browserGuestTypes.js";
export { sanitizeBrowserMetaUrl } from "./browserGuestUtils.js";
