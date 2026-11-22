import { BrowserWindow, ipcMain, nativeImage, protocol, webContents } from "electron";
import { PlatformChannels, type Locale } from "@zcode/shared";
import { logger } from "../logger.js";
import { EmbeddedBrowserJavaScriptDialogController } from "../embeddedBrowserJavaScriptDialog.js";
import { buildBrowserViewCloseTabNotification } from "../browserView/browserCloseTabNotification.js";
import { BrowserGuestManager } from "../browserView/browserGuestManager.js";
import { createElectronBrowserWebmRecorder } from "../browserView/electronBrowserWebmRecorder.js";
import { createDesktopBrowserScreenshotSurfaceCoordinator } from "../browserView/browserScreenshotSurfaceCoordinatorWiring.js";
import {
  browserOperationResetsResizeBaseline,
  resolveBrowserOperationTabId,
} from "../browserView/browserOperationIndicator.js";
import {
  createLocalMediaPreviewPathRegistry,
  installLocalMediaPreviewProtocol,
  registerLocalMediaPreviewScheme,
} from "../localMediaPreviewProtocol.js";
import { setBrowserUseGuestWebContentsIdsProvider } from "../resourceManagerWindow.js";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../pluginSandbox/index.js";

export type LocalMediaPreviewPathRegistry = ReturnType<typeof createLocalMediaPreviewPathRegistry>;
export type BrowserGuestManagerInstance = InstanceType<typeof BrowserGuestManager>;
export type BrowserScreenshotSurfaceCoordinator = ReturnType<
  typeof createDesktopBrowserScreenshotSurfaceCoordinator
>;
export type EmbeddedBrowserDialogController = InstanceType<
  typeof EmbeddedBrowserJavaScriptDialogController
>;

export interface DesktopBrowserLifecycle {
  embeddedBrowserDialogController: EmbeddedBrowserDialogController;
  browserScreenshotSurfaceCoordinator: BrowserScreenshotSurfaceCoordinator;
  browserGuestManager: BrowserGuestManagerInstance;
  runBrowserCommandOnView: (params: {
    win: BrowserWindow;
    requestId: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode?: "desktop-continuous" | "web-remote-replayable";
    sessionContext?: "live" | "cached";
    command: unknown;
  }) => Promise<{ ok: boolean; [k: string]: unknown }>;
}

export function createLocalMediaPreviewRuntime(): LocalMediaPreviewPathRegistry {
  registerLocalMediaPreviewScheme(protocol, [PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
  return createLocalMediaPreviewPathRegistry();
}

export function installLocalMediaPreviewSessionProtocol(
  pathRegistry: LocalMediaPreviewPathRegistry,
  targetSession: Electron.Session,
): void {
  installLocalMediaPreviewProtocol(targetSession.protocol, {
    isPathAuthorized: pathRegistry.isAuthorized,
  });
}

export function createDesktopBrowserLifecycle(options: {
  iconPath: string;
  getApplicationLocale: () => Locale;
}): DesktopBrowserLifecycle {
  const embeddedBrowserDialogController = new EmbeddedBrowserJavaScriptDialogController({
    iconPath: options.iconPath,
    getLocale: options.getApplicationLocale,
    logger,
  });
  ipcMain.on(PlatformChannels.EmbeddedBrowserJavaScriptDialog, (event, payload: unknown) => {
    event.returnValue = embeddedBrowserDialogController.handleDialogRequest(
      event.sender.id,
      event.senderFrame?.url ?? "",
      payload,
    );
  });
  // browser-use CDP-on-guest pivot：main 进程按 key 管理 `<webview>` guest 的
  // webContents + CDP，为 executor 提供 ControlledView。所有 execute/attach 出口都走这里。
  // BrowserGuestManager 虽是 main singleton，但 tab owner 带 window/workspace/session/generation；
  // create/close 只投递到 owner window，禁止旧的全窗口广播造成跨窗口 attach。
  const browserScreenshotSurfaceCoordinator = createDesktopBrowserScreenshotSurfaceCoordinator({
    fromId: (windowId) => BrowserWindow.fromId(windowId),
    fromWebContentsId: (webContentsId) => webContents.fromId(webContentsId) ?? null,
    log: (message) => logger.debug(message),
    warn: (message) => logger.warn(message),
  });
  const browserGuestManager = new BrowserGuestManager(
    (msg) => logger.debug(msg),
    undefined,
    (tabId, owner) => {
      const win = owner ? BrowserWindow.fromId(owner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(
          PlatformChannels.BrowserViewCloseTab,
          buildBrowserViewCloseTabNotification(tabId, owner),
        );
      }
    },
    (tabId, owner) => {
      const win = BrowserWindow.fromId(owner.windowId);
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewReady, {
          workspaceKey: owner.workspaceKey,
          ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
          sessionId: owner.sessionId,
          tabId,
          browserId: owner.browserId,
          browserGeneration: owner.browserGeneration,
        });
      }
    },
    (visible, owner, tabId) => {
      const win = BrowserWindow.fromId(owner.windowId);
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewVisibility, {
          visible,
          workspaceKey: owner.workspaceKey,
          remoteSessionId: owner.remoteSessionId,
          sessionId: owner.sessionId,
          ...(tabId ? { tabId } : {}),
          browserId: owner.browserId,
          browserGeneration: owner.browserGeneration,
        });
      }
    },
    (viewport, owner, tabId) => {
      const win = BrowserWindow.fromId(owner.windowId);
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewViewportChanged, {
          workspaceKey: owner.workspaceKey,
          ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
          sessionId: owner.sessionId,
          tabId,
          browserId: owner.browserId,
          browserGeneration: owner.browserGeneration,
          viewport,
        });
      }
    },
    (base64Png, target) => {
      const source = nativeImage.createFromBuffer(Buffer.from(base64Png, "base64"));
      if (source.isEmpty()) return undefined;
      const resized = source.resize({
        width: target.width,
        height: target.height,
        quality: "best",
      });
      if (resized.isEmpty()) return undefined;
      return resized.toPNG().toString("base64");
    },
    browserScreenshotSurfaceCoordinator,
    {
      // Browser shell/pageState 不跨进程恢复，以保持“完整退出即清空”的语义，
      // 并避免恢复的 shell 与新 webview 重复 attach。因此不注入 recoveryStore；
      // 进程内 residency 事件仍保留给现有 IPC 兼容层。
      onSuspendTabRequested: (payload) => {
        const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
        const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send(PlatformChannels.BrowserViewSuspend, payload);
        }
      },
      onRestoreTabRequested: (payload) => {
        const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
        const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
        }
      },
      onResidencyChanged: (payload) => {
        const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
        const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
        }
      },
      onRecoveryOrphanCloseRequested: ({ tabId, reason }) => {
        const tabOwner = browserGuestManager.getTabOwner(tabId);
        const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
        if (win && !win.isDestroyed()) {
          win.webContents.send(PlatformChannels.BrowserViewCloseTab, {
            tabId,
            reason,
          });
        }
      },
      warn: (message) => logger.warn(message),
      recording: {
        createRecorder: (input) =>
          createElectronBrowserWebmRecorder(input, (message) => logger.debug(message)),
      },
    },
    // 隐藏窗口截图的透明 presentation：capture 期间 showInactive + opacity 0 主动要帧。
    (windowId) => BrowserWindow.fromId(windowId),
  );
  setBrowserUseGuestWebContentsIdsProvider(() => browserGuestManager.listGuestWebContentsIds());

  // browser-use：带诊断日志地执行 browser 命令（两处 spawnHostProcess wiring 共用）。
  // 打入口/出口便于定位卡点（如 navigate loadURL 挂起、CDP 报错等）。
  // CDP-on-guest pivot：execute 走 browserGuestManager（不再传 win —— guest 已由 attachGuest 关联）。
  async function runBrowserCommandOnView(params: {
    win: BrowserWindow;
    requestId: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode?: "desktop-continuous" | "web-remote-replayable";
    sessionContext?: "live" | "cached";
    command: unknown;
  }): Promise<{ ok: boolean; [k: string]: unknown }> {
    const endDialogAutomation = embeddedBrowserDialogController.beginAutomation(params.win.id);
    const command = params.command as { method?: string; tabId?: unknown } | null;
    const method = command?.method ?? "?";
    const workspaceKey =
      params.workspaceIdentity?.trim() ||
      params.workspaceKey ||
      params.workspacePath ||
      params.sessionId;
    const requestedTabId = resolveBrowserOperationTabId(command);
    const resetsResizeBaseline = browserOperationResetsResizeBaseline(command);
    const sendOperation = (tabId: string) => {
      if (params.win.isDestroyed()) return;
      params.win.webContents.send(PlatformChannels.BrowserViewOperation, {
        workspaceKey,
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
        sessionId: params.sessionId,
        tabId,
        browserId: params.browserId ?? "legacy-iab",
        browserGeneration: params.browserGeneration ?? 0,
        resetsResizeBaseline,
      });
    };
    // 交互说明：绝大多数 Tab API 都显式携带 tabId，可在命令真正执行前亮起操作图标；
    // newTab / default-tab 兼容调用要等 manager 返回真实 meta.tabId 后再补发，避免猜 tab identity。
    if (requestedTabId) sendOperation(requestedTabId);
    logger.debug(
      `[browser-use] execute start browserId=${params.browserId ?? "legacy-iab"} sessionId=${params.sessionId} method=${method}`,
    );
    try {
      const result = await browserGuestManager.execute(
        {
          requestId: params.requestId,
          browserId: params.browserId ?? "legacy-iab",
          browserGeneration: params.browserGeneration ?? 0,
          windowId: params.win.id,
          workspaceKey,
          sessionId: params.sessionId,
          ...(params.turnId ? { turnId: params.turnId } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          clientMode: params.clientMode ?? "desktop-continuous",
        },
        params.command as Parameters<typeof browserGuestManager.execute>[1],
      );
      logger.debug(
        `[browser-use] execute done sessionId=${params.sessionId} method=${method} ok=${result.ok} elapsedMs=${(result as { elapsedMs?: number }).elapsedMs ?? "?"}`,
      );
      if (!requestedTabId) {
        const resolvedTabId = resolveBrowserOperationTabId(command, result);
        if (resolvedTabId) sendOperation(resolvedTabId);
      }
      return result;
    } catch (error) {
      logger.error(
        `[browser-use] execute threw sessionId=${params.sessionId} method=${method}:`,
        error,
      );
      throw error;
    } finally {
      endDialogAutomation();
    }
  }

  return {
    embeddedBrowserDialogController,
    browserScreenshotSurfaceCoordinator,
    browserGuestManager,
    runBrowserCommandOnView,
  };
}
