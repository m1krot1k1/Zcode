import { app } from "electron";
import { DEFAULT_LOCALE, type Locale } from "@zcode/shared";
import { logger } from "../logger.js";
import {
  handleDeepLink,
  handleOpenWorkspacePath,
  registerDeepLinkProtocol,
  resolveExternalWorkspaceOpenDialogCopy,
} from "../desktopOAuthDeepLink.js";
import { handleSecondInstanceWorkspaceRequest } from "../desktopSecondInstanceDeepLink.js";
import {
  createDeepLinkSingleInstanceData,
  extractWorkspaceOpenPath,
  extractDeepLinkUrlFromArgs,
  extractOpenWorkspacePathFromArgs,
  isWorkspaceOpenUrl,
} from "../desktopDeepLinkUrl.js";
import {
  createStartupDeepLinkConsumptionGate,
  resolveExplicitStartupWorkspaceBootstrap,
  type ExplicitStartupWorkspaceRequest,
} from "../startupWorkspaceDeepLinkGate.js";
import { resolveSystemApplicationLocale } from "../desktopApplicationMenu.js";

export function resolveExternalWorkspaceConfirmationCopy(
  getApplicationLocale: () => Locale,
): ReturnType<typeof resolveExternalWorkspaceOpenDialogCopy> {
  const locale = getApplicationLocale();
  const effectiveLocale =
    locale === DEFAULT_LOCALE && app.isReady() ? resolveSystemApplicationLocale() : locale;
  return resolveExternalWorkspaceOpenDialogCopy(effectiveLocale);
}

export interface DeepLinkLifecycleOptions {
  iconPath: string;
  getApplicationLocale: () => Locale;
  getApplicationWindows: () => Electron.BrowserWindow[];
  ensurePrimaryWindow: (reason: string) => Promise<unknown>;
  focusForceUpdateGateWindow: () => void;
  isForceUpdateMainWindowCreationBlocked: () => boolean;
}

export interface DeepLinkLifecycle {
  install: () => void;
  takeStartupOpenWorkspaceRequest: () => ExplicitStartupWorkspaceRequest | null;
  markStartupRequestConsumed: (request: ExplicitStartupWorkspaceRequest) => void;
  handleReadyProtocolUrl: () => void;
}

export function createDeepLinkLifecycle(options: DeepLinkLifecycleOptions): DeepLinkLifecycle {
  function extractOpenWorkspacePathFromDeepLinkUrl(url: string): string | null {
    try {
      const parsedUrl = new URL(url);
      return isWorkspaceOpenUrl(parsedUrl) ? extractWorkspaceOpenPath(parsedUrl) : null;
    } catch {
      return null;
    }
  }

  const startupOpenWorkspaceArgPath = extractOpenWorkspacePathFromArgs(process.argv);
  const startupProtocolUrl = extractDeepLinkUrlFromArgs(process.argv);
  const startupDeepLinkWorkspacePath = startupOpenWorkspaceArgPath
    ? null
    : extractOpenWorkspacePathFromDeepLinkUrl(startupProtocolUrl ?? "");
  const startupDeepLinkConsumptionGate = createStartupDeepLinkConsumptionGate(startupProtocolUrl);
  let startupOpenWorkspaceRequest: ExplicitStartupWorkspaceRequest | null =
    startupOpenWorkspaceArgPath
      ? { path: startupOpenWorkspaceArgPath, source: "open-workspace-arg" }
      : startupDeepLinkWorkspacePath
        ? { path: startupDeepLinkWorkspacePath, source: "deep-link" }
        : null;

  function applyDeepLink(url: string): void {
    handleDeepLink(url, logger, {
      confirmationCopy: resolveExternalWorkspaceConfirmationCopy(options.getApplicationLocale),
      resolveApplicationWindow: () => options.getApplicationWindows()[0] ?? null,
    });
  }

  function install(): void {
    registerDeepLinkProtocol(logger, { iconPath: options.iconPath });
    app.on("open-url", (event, url) => {
      event.preventDefault();
      const workspacePath = extractOpenWorkspacePathFromDeepLinkUrl(url);
      if (workspacePath && options.isForceUpdateMainWindowCreationBlocked()) {
        logger.warn("[force-update] 已忽略强制升级期间的 open-url workspace 请求");
        options.focusForceUpdateGateWindow();
        return;
      }
      if (workspacePath && options.getApplicationWindows().length === 0) {
        // macOS 冷启动 Finder Service 会先触发 open-url，再创建首窗。
        // 把目标目录按 deep link 来源记录，首窗 bootstrap 前仍要走确认 gate。
        startupOpenWorkspaceRequest = { path: workspacePath, source: "deep-link" };
        if (app.isReady()) {
          void options.ensurePrimaryWindow("open-url-workspace");
        }
        return;
      }
      applyDeepLink(url);
    });
    const gotTheLock = app.requestSingleInstanceLock(
      createDeepLinkSingleInstanceData(process.argv),
    );
    if (!gotTheLock) {
      app.quit();
    }
    app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
      if (
        handleSecondInstanceWorkspaceRequest({
          additionalData,
          argv,
          focusForceUpdateGateWindow: options.focusForceUpdateGateWindow,
          forceUpdateBlocked: options.isForceUpdateMainWindowCreationBlocked(),
          handleDeepLink: (url, handleOptions) => handleDeepLink(url, logger, handleOptions),
          handleOpenWorkspacePath: (path, handleOptions) =>
            handleOpenWorkspacePath(path, logger, {
              allowWithoutReadyWindow: true,
              ...handleOptions,
              resolveApplicationWindow:
                handleOptions?.resolveApplicationWindow ??
                (() => options.getApplicationWindows()[0] ?? null),
            }),
          resolveApplicationWindow: () => options.getApplicationWindows()[0] ?? null,
          logger,
          workspaceConfirmationCopy: resolveExternalWorkspaceConfirmationCopy(
            options.getApplicationLocale,
          ),
        })
      ) {
        return;
      }

      const win = options.getApplicationWindows()[0];
      if (win) {
        if (win.isMinimized()) {
          win.restore();
        }
        if (!win.isVisible()) {
          win.show();
        }
        win.focus();
      }
    });
  }

  function takeStartupOpenWorkspaceRequest(): ExplicitStartupWorkspaceRequest | null {
    const request = startupOpenWorkspaceRequest;
    startupOpenWorkspaceRequest = null;
    return request;
  }

  function markStartupRequestConsumed(request: ExplicitStartupWorkspaceRequest): void {
    startupDeepLinkConsumptionGate.markStartupRequestConsumed(request);
  }

  function handleReadyProtocolUrl(): void {
    const protocolUrl = extractDeepLinkUrlFromArgs(process.argv);
    if (protocolUrl && startupDeepLinkConsumptionGate.shouldHandleReadyProtocolUrl(protocolUrl)) {
      applyDeepLink(protocolUrl);
    }
  }

  return {
    install,
    takeStartupOpenWorkspaceRequest,
    markStartupRequestConsumed,
    handleReadyProtocolUrl,
  };
}

export function resolveExplicitStartupWorkspace(
  request: ExplicitStartupWorkspaceRequest,
  getApplicationLocale: () => Locale,
): ReturnType<typeof resolveExplicitStartupWorkspaceBootstrap> {
  return resolveExplicitStartupWorkspaceBootstrap(request, {
    confirmationCopy: resolveExternalWorkspaceConfirmationCopy(getApplicationLocale),
    logger,
  });
}
