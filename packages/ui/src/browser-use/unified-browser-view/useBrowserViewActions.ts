import { useCallback, type FormEvent } from "react";
import type { IPlatformService, BrowserViewportSize } from "@zcode/shared";
import type { BrowserLayoutState } from "@/browser-use/unified-browser-view/useBrowserLayoutState.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isDefaultBrowserOpenableUrl,
  safeWebviewCall,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";
import { logger } from "@/logger.js";

type BrowserViewActionsParams = {
  webview: ElectronWebviewTag | null;
  browserState: BrowserState;
  addressValue: string;
  openUrl: (
    input: string,
    source?: "toolbar" | "restore" | "request",
  ) => Promise<void>;
  platform: IPlatformService;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  toggleWebElementPicking: () => Promise<void>;
  toggleResponsiveMode: () => void;
  updateResponsiveViewportSize: (size: BrowserViewportSize) => void;
  notifyBrowserViewportResize: () => void;
  responsiveViewportSize: BrowserLayoutState["responsiveViewportSize"];
  setBrowserState: React.Dispatch<React.SetStateAction<BrowserState>>;
};

export type BrowserViewActions = {
  handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  handleGoBack: () => void;
  handleGoForward: () => void;
  handleReload: () => void;
  handleOpenDevTools: () => void;
  handleOpenExternal: () => void;
  handleTogglePicker: () => void;
  handleToggleResponsiveMode: () => void;
  handleResponsiveViewportSizeChange: (size: BrowserViewportSize) => void;
  handleResponsiveViewportInput: (
    viewportSize: BrowserLayoutState["responsiveViewportSize"],
  ) => void;
};

/**
 * 工具栏与预览控制条的动作：isReady 门控 + safeWebviewCall 兜底点击瞬间的 detach 竞态。
 */
export function useBrowserViewActions({
  webview,
  browserState,
  addressValue,
  openUrl,
  platform,
  intl,
  toggleWebElementPicking,
  toggleResponsiveMode,
  updateResponsiveViewportSize,
  notifyBrowserViewportResize,
  responsiveViewportSize,
  setBrowserState,
}: BrowserViewActionsParams): BrowserViewActions {
  // ---- 工具/导航按钮（isReady 门控 + safeWebviewCall 兜底点击瞬间 detach 竞态）----
  const runWebviewAction = useCallback((action: () => void) => {
    safeWebviewCall(
      () => {
        action();
        return undefined;
      },
      undefined,
      (error) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的操作", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void openUrl(addressValue);
    },
    [addressValue, openUrl],
  );

  const handleGoBack = useCallback(() => {
    if (!webview || !browserState.canGoBack) return;
    runWebviewAction(() => webview.goBack());
  }, [browserState.canGoBack, runWebviewAction, webview]);

  const handleGoForward = useCallback(() => {
    if (!webview || !browserState.canGoForward) return;
    runWebviewAction(() => webview.goForward());
  }, [browserState.canGoForward, runWebviewAction, webview]);

  const handleReload = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.reload());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenDevTools = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.openDevTools());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenExternal = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => {
      const currentUrl = webview.getURL();
      // 安全边界：系统默认浏览器入口只允许 Web URL 和 file URL，仍禁止 about/data 等内联协议。
      if (!isDefaultBrowserOpenableUrl(currentUrl)) return;
      platform.openExternal(currentUrl);
    });
  }, [browserState.isReady, platform, runWebviewAction, webview]);

  const handleTogglePicker = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    void toggleWebElementPicking().catch((error: unknown) => {
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: intl.formatMessage(
          { id: "browser.elementPickerFailed" },
          { message: error instanceof Error ? error.message : String(error) },
        ),
      }));
    });
  }, [
    browserState.isReady,
    intl,
    setBrowserState,
    toggleWebElementPicking,
    webview,
  ]);

  const handleToggleResponsiveMode = useCallback(() => {
    toggleResponsiveMode();
  }, [toggleResponsiveMode]);

  const handleResponsiveViewportSizeChange = updateResponsiveViewportSize;

  const handleResponsiveViewportInput = useCallback(
    (viewportSize: typeof responsiveViewportSize) => {
      notifyBrowserViewportResize();
      updateResponsiveViewportSize(viewportSize);
    },
    [notifyBrowserViewportResize, updateResponsiveViewportSize],
  );

  return {
    handleSubmit,
    handleGoBack,
    handleGoForward,
    handleReload,
    handleOpenDevTools,
    handleOpenExternal,
    handleTogglePicker,
    handleToggleResponsiveMode,
    handleResponsiveViewportSizeChange,
    handleResponsiveViewportInput,
  };
}
