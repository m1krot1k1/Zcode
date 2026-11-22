import { useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { BrowserGuestNavigationRefs } from "@/browser-use/unified-browser-view/useBrowserGuestNavigationQueue.js";
import type { PendingGuestNavigationCompletion } from "@/browser-use/unified-browser-view/types.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  DEFAULT_BROWSER_URL,
  displayBrowserUrl,
  isRecoverableBrowserGuestExitReason,
  safeWebviewCall,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";
import { logger } from "@/logger.js";

type BrowserGuestEventWiringParams = {
  browserKey: string;
  webview: ElectronWebviewTag | null;
  platform: IPlatformService;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  isResidencyRestore: boolean;
  isSelected: boolean;
  isResponsiveMode: boolean;
  refs: BrowserGuestNavigationRefs;
  onPageMetadataChangeRef: React.RefObject<
    | ((metadata: { title?: string; faviconUrl?: string | null }) => void)
    | undefined
  >;
  reportBrowserGuest: (active: boolean) => void;
  detachBrowserGuestBeforeReplacement: () => Promise<boolean>;
  cancelWebElementPicking: () => unknown;
  completePendingGuestNavigation: (
    completion?: PendingGuestNavigationCompletion | null,
  ) => void;
  syncBrowserState: (target: ElectronWebviewTag) => void;
  setGuestZoomFactor: (
    target: ElectronWebviewTag,
    targetZoomFactor: number,
  ) => void;
  setBrowserState: React.Dispatch<React.SetStateAction<BrowserState>>;
  setAddressValue: React.Dispatch<React.SetStateAction<string>>;
  setHasNavigated: React.Dispatch<React.SetStateAction<boolean>>;
  setWebviewGeneration: React.Dispatch<React.SetStateAction<number>>;
};

/**
 * webview 事件接线：attach/dom-ready 上报 guestId、消费排队导航、同步 chrome 状态，
 * 并在 guest renderer 退出时经 CDP detach ACK 后原位重建。
 */
export function useBrowserGuestEventWiring({
  browserKey,
  webview,
  platform,
  intl,
  isResidencyRestore,
  isSelected,
  isResponsiveMode,
  refs,
  onPageMetadataChangeRef,
  reportBrowserGuest,
  detachBrowserGuestBeforeReplacement,
  cancelWebElementPicking,
  completePendingGuestNavigation,
  syncBrowserState,
  setGuestZoomFactor,
  setBrowserState,
  setAddressValue,
  setHasNavigated,
  setWebviewGeneration,
}: BrowserGuestEventWiringParams): void {
  const {
    pendingUrlRef,
    pendingGuestNavigationCompletionRef,
    guestRecoveryInProgressRef,
    lastRestorableUrlRef,
    lastRequestedUrlRef,
    lastAppliedInitialUrlRef,
    lastReportedGuestRef,
  } = refs;

  useEffect(() => {
    if (!webview) return;

    const handleDidAttach = () => {
      // navigationHistory.restore 只能用于从未加载过页面的新 guest。若等到
      // dom-ready 才上报，默认 about:blank 已提交，只能退化为 URL 重载；attach 后立即上报，
      // 让 main 有机会在首次导航提交前恢复完整 Chromium pageState。
      if (isResidencyRestore) {
        // `<webview>` 必须先有 src 才会创建 guest，但保留属性会在 attach 后再次提交
        // about:blank 并中断 main 的 history restore。guest 已存在后立刻撤销 bootstrap src。
        webview.removeAttribute("src");
      }
      reportBrowserGuest(isSelected);
    };

    const handleDomReady = () => {
      // Electron/Chromium 会把主窗口页面 zoom 继续传播到 guest；仅补偿外层
      // transform 时，guest innerWidth/DPR 仍会变化。自由尺寸必须把 guest zoom 固定为 1，
      // 普通模式仍交给 Electron 自然传播，避免主动改写网页 zoom。
      if (isResponsiveMode) setGuestZoomFactor(webview, 1);
      // did-attach 是完整历史恢复的最早时机；dom-ready 保留为 Electron 版本兼容兜底。
      reportBrowserGuest(isSelected);

      // <webview> 的 src 属性只在首挂生效，后续导航统一走命令式 loadURL：消费排队 URL。
      const pending = pendingUrlRef.current;
      if (pending) {
        const pendingCompletion = pendingGuestNavigationCompletionRef.current;
        pendingUrlRef.current = null;
        setBrowserState((prev) => ({ ...prev, isReady: true }));
        void (async () => {
          try {
            await webview.loadURL(pending);
          } catch (loadError: unknown) {
            const message =
              loadError instanceof Error
                ? loadError.message
                : String(loadError);
            if (!message.includes("ERR_ABORTED")) {
              setBrowserState((prev) => ({
                ...prev,
                errorMessage: intl.formatMessage(
                  { id: "browser.loadFailed" },
                  { message },
                ),
                isLoading: false,
              }));
            }
          } finally {
            // 只把外部请求写入 pendingUrl 后就回执是不够的：失败 guest 永远不会消费它。
            // 替代 guest 到达 dom-ready 并完成一次 loadURL 尝试，才算真正接管该导航意图。
            completePendingGuestNavigation(pendingCompletion);
          }
        })();
        return;
      }
      guestRecoveryInProgressRef.current = false;
      syncBrowserState(webview);
    };

    const handleDidStartLoading = () => {
      void cancelWebElementPicking();
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: null,
        loadErrorCode: null,
        isLoading: true,
      }));
    };

    const handleDidStopLoading = () => {
      guestRecoveryInProgressRef.current = false;
      setBrowserState((prev) => ({ ...prev, isLoading: false }));
      syncBrowserState(webview);
    };

    const handleNavigation = () => {
      syncBrowserState(webview);
    };

    const handleTitleUpdated = (event: ElectronWebviewTitleEvent) => {
      setBrowserState((prev) => ({ ...prev, title: event.title }));
      onPageMetadataChangeRef.current?.({ title: event.title || undefined });
    };

    const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
      // 忽略子帧失败与 -3(ERR_ABORTED，被后续导航打断)。
      if (!event.isMainFrame || event.errorCode === -3) return;
      logger.warn("[browser-use] 页面加载失败", {
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        url: event.validatedURL,
      });
      setBrowserState((prev) => ({
        ...prev,
        currentUrl: event.validatedURL || prev.currentUrl,
        errorMessage: intl.formatMessage(
          { id: "browser.loadFailed" },
          { message: event.errorDescription },
        ),
        loadErrorCode: event.errorCode,
        isLoading: false,
      }));
      setAddressValue(
        displayBrowserUrl(
          event.validatedURL ||
            safeWebviewCall(() => webview.getURL(), "") ||
            DEFAULT_BROWSER_URL,
        ),
      );
      guestRecoveryInProgressRef.current = false;
    };

    const handleRenderProcessGone = (
      event: ElectronWebviewRenderProcessGoneEvent,
    ) => {
      const { exitCode, reason } = event.details;
      if (!isRecoverableBrowserGuestExitReason(reason)) {
        logger.warn("[browser-use] guest renderer 异常退出且不可自动恢复", {
          browserKey,
          exitCode,
          reason,
        });
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage(
            { id: "browser.loadFailed" },
            { message: `renderer ${reason} (${exitCode})` },
          ),
          // renderer 退出后需要重建整个 guest，单纯重新导航无法恢复。
          // guestFailure 让界面优先展示重建入口，而不是普通页面加载错误的重试入口。
          guestFailure: { exitCode, reason },
          isLoading: false,
          isReady: false,
        }));
        // 替代 guest 若再次启动失败，已经形成明确失败结果；结束等待，让上层不再永久挂起请求。
        completePendingGuestNavigation();
        return;
      }
      if (guestRecoveryInProgressRef.current) return;

      guestRecoveryInProgressRef.current = true;
      const recoveryUrl = lastRestorableUrlRef.current;
      void cancelWebElementPicking();

      logger.warn(
        "[browser-use] guest renderer 异常退出，原位重建并恢复最近 URL",
        {
          browserKey,
          exitCode,
          reason,
          recoveryUrl,
        },
      );
      void (async () => {
        const detached = await detachBrowserGuestBeforeReplacement();
        if (!detached) {
          guestRecoveryInProgressRef.current = false;
          setBrowserState((prev) => ({
            ...prev,
            errorMessage: null,
            loadErrorCode: null,
            guestFailure: { exitCode, reason },
            isLoading: false,
            isReady: false,
          }));
          completePendingGuestNavigation();
          return;
        }

        pendingUrlRef.current = recoveryUrl;
        lastRequestedUrlRef.current = null;
        lastAppliedInitialUrlRef.current = null;
        lastReportedGuestRef.current = null;
        setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
        setHasNavigated(Boolean(recoveryUrl));
        setBrowserState((prev) => ({
          ...prev,
          canGoBack: false,
          canGoForward: false,
          currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
          errorMessage: null,
          loadErrorCode: null,
          guestFailure: null,
          isLoading: Boolean(recoveryUrl),
          isReady: false,
        }));
        // renderer 观察到了 guest 退出，但 main 的 render-process-gone 监听并非
        // 每次都先到达。必须等待上面的 CDP detach ACK 后再递增 key；否则 React 卸载旧
        // `<webview>` 会让 Electron DevToolsSession 在在途通知中访问已析构 client。
        setWebviewGeneration((current) => current + 1);
      })();
    };

    webview.addEventListener("did-attach", handleDidAttach);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("page-title-updated", handleTitleUpdated);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);

    return () => {
      webview.removeEventListener("did-attach", handleDidAttach);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("page-title-updated", handleTitleUpdated);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener(
        "render-process-gone",
        handleRenderProcessGone,
      );
    };
  }, [
    browserKey,
    cancelWebElementPicking,
    completePendingGuestNavigation,
    detachBrowserGuestBeforeReplacement,
    intl,
    isResidencyRestore,
    isSelected,
    platform,
    reportBrowserGuest,
    setGuestZoomFactor,
    syncBrowserState,
    webview,
  ]);
}
