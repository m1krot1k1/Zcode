import { useCallback, useEffect } from "react";
import type { BrowserGuestNavigationRefs } from "@/browser-use/unified-browser-view/useBrowserGuestNavigationQueue.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  DEFAULT_BROWSER_URL,
  displayBrowserUrl,
  normalizeBrowserUrl,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";
import { logger } from "@/logger.js";

type BrowserNavigationParams = {
  browserKey: string;
  webview: ElectronWebviewTag | null;
  browserState: BrowserState;
  initialUrl?: string | null;
  navigationRequest?: { id: string; url: string } | null;
  onUrlChange?: (url: string) => void;
  onNavigationRequestHandled?: (requestId: string) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  refs: BrowserGuestNavigationRefs;
  completePendingGuestNavigation: () => void;
  waitForGuestNavigationTakeover: (url: string) => Promise<void>;
  detachBrowserGuestBeforeReplacement: () => Promise<boolean>;
  cancelWebElementPicking: () => unknown;
  setBrowserState: React.Dispatch<React.SetStateAction<BrowserState>>;
  setAddressValue: React.Dispatch<React.SetStateAction<string>>;
  setHasNavigated: React.Dispatch<React.SetStateAction<boolean>>;
  setWebviewGeneration: React.Dispatch<React.SetStateAction<number>>;
};

export type BrowserNavigation = {
  openUrl: (
    input: string,
    source?: "toolbar" | "restore" | "request",
  ) => Promise<void>;
  rebuildBrowserGuest: (
    recoveryUrl: string | null,
    trigger: "address-navigation" | "external-navigation" | "manual-retry",
  ) => Promise<boolean>;
};

/**
 * 导航命令：显式重建失效 guest、地址栏/外部请求的 loadURL 排队与回执，
 * 以及 initialUrl / navigationRequest 的消费去重。
 */
export function useBrowserNavigation({
  browserKey,
  webview,
  browserState,
  initialUrl,
  navigationRequest,
  onUrlChange,
  onNavigationRequestHandled,
  intl,
  refs,
  completePendingGuestNavigation,
  waitForGuestNavigationTakeover,
  detachBrowserGuestBeforeReplacement,
  cancelWebElementPicking,
  setBrowserState,
  setAddressValue,
  setHasNavigated,
  setWebviewGeneration,
}: BrowserNavigationParams): BrowserNavigation {
  const {
    pendingUrlRef,
    lastRequestedUrlRef,
    lastAppliedInitialUrlRef,
    lastHandledNavigationRequestIdRef,
    lastRestorableUrlRef,
    guestRecoveryInProgressRef,
    lastReportedGuestRef,
  } = refs;

  const rebuildBrowserGuest = useCallback(
    async (
      recoveryUrl: string | null,
      trigger: "address-navigation" | "external-navigation" | "manual-retry",
    ): Promise<boolean> => {
      guestRecoveryInProgressRef.current = true;
      void cancelWebElementPicking();

      const detached = await detachBrowserGuestBeforeReplacement();
      if (!detached) {
        guestRecoveryInProgressRef.current = false;
        return false;
      }

      pendingUrlRef.current = recoveryUrl;
      lastRequestedUrlRef.current = null;
      lastAppliedInitialUrlRef.current = null;
      lastReportedGuestRef.current = null;

      logger.warn("[browser-use] 显式导航触发重建失败的 guest renderer", {
        browserKey,
        recoveryUrl,
        trigger,
      });
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
      setWebviewGeneration((current) => current + 1);
      return true;
    },
    [
      browserKey,
      cancelWebElementPicking,
      detachBrowserGuestBeforeReplacement,
      guestRecoveryInProgressRef,
      lastAppliedInitialUrlRef,
      lastReportedGuestRef,
      lastRequestedUrlRef,
      pendingUrlRef,
      setAddressValue,
      setBrowserState,
      setHasNavigated,
      setWebviewGeneration,
    ],
  );

  // ---- 导航（human 直驱 webview.loadURL；未就绪则排队到 dom-ready 消费）----
  const openUrl = useCallback(
    async (
      input: string,
      source: "toolbar" | "restore" | "request" = "toolbar",
    ) => {
      const nextUrl = normalizeBrowserUrl(input);
      if (!nextUrl) {
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.invalidUrl" }),
          // 地址非法与上一次的网络失败无关；不清空会让错误态继续挂着旧的证书指引。
          loadErrorCode: null,
        }));
        return;
      }

      // 外部请求若只能排队给尚未就绪的 guest，必须等 dom-ready 真正接管 loadURL 后再回执；
      // 地址栏/恢复导航没有上游消费确认，不需要等待该生命周期信号。
      const navigationTakenOver =
        source === "request" && (!webview || !browserState.isReady)
          ? waitForGuestNavigationTakeover(nextUrl)
          : null;

      // launch-failed 后 isReady=false，只把地址栏 URL 写进 pendingUrl 不够：
      // 失效 guest 永远不会再触发 dom-ready，失败态与排队导航都会永久卡住。
      if (
        browserState.guestFailure &&
        (source === "toolbar" || source === "request")
      ) {
        lastRestorableUrlRef.current = nextUrl;
        onUrlChange?.(nextUrl);
        const rebuilt = await rebuildBrowserGuest(
          nextUrl,
          source === "request" ? "external-navigation" : "address-navigation",
        );
        if (!rebuilt) completePendingGuestNavigation();
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      // 去重：外部 request 与 restore 可能同拍给出同一 URL，连续 loadURL 会触发 ERR_ABORTED(-3)。
      if (
        nextUrl === lastRequestedUrlRef.current &&
        (pendingUrlRef.current === nextUrl || browserState.isLoading)
      ) {
        setAddressValue(displayBrowserUrl(nextUrl));
        setHasNavigated(true);
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      setAddressValue(displayBrowserUrl(nextUrl));
      setHasNavigated(true);
      lastRestorableUrlRef.current = nextUrl;
      onUrlChange?.(nextUrl);
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: null,
        loadErrorCode: null,
      }));
      lastRequestedUrlRef.current = nextUrl;

      if (!webview || !browserState.isReady) {
        pendingUrlRef.current = nextUrl;
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      try {
        await webview.loadURL(nextUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ERR_ABORTED")) return;
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage(
            { id: "browser.loadFailed" },
            { message },
          ),
          isLoading: false,
        }));
      }
    },
    [
      browserState.guestFailure,
      browserState.isLoading,
      browserState.isReady,
      completePendingGuestNavigation,
      intl,
      lastRequestedUrlRef,
      lastRestorableUrlRef,
      onUrlChange,
      pendingUrlRef,
      rebuildBrowserGuest,
      setAddressValue,
      setBrowserState,
      setHasNavigated,
      waitForGuestNavigationTakeover,
      webview,
    ],
  );

  // ---- 挂载时导航到初始/恢复 URL（human tab 恢复态）----
  useEffect(() => {
    if (!initialUrl || initialUrl === DEFAULT_BROWSER_URL) return;
    lastRestorableUrlRef.current = initialUrl;
    if (lastAppliedInitialUrlRef.current === initialUrl) return;
    if (browserState.currentUrl === initialUrl) {
      lastAppliedInitialUrlRef.current = initialUrl;
      setHasNavigated(true);
      setAddressValue(displayBrowserUrl(initialUrl));
      return;
    }
    lastAppliedInitialUrlRef.current = initialUrl;
    void openUrl(initialUrl, "restore");
  }, [
    browserState.currentUrl,
    initialUrl,
    openUrl,
    lastAppliedInitialUrlRef,
    lastRestorableUrlRef,
    setAddressValue,
    setHasNavigated,
  ]);

  // ---- 外部导航请求（{id,url}）：导航并回执 ----
  useEffect(() => {
    if (!navigationRequest) return;
    if (lastHandledNavigationRequestIdRef.current === navigationRequest.id)
      return;
    lastHandledNavigationRequestIdRef.current = navigationRequest.id;
    void openUrl(navigationRequest.url, "request").finally(() => {
      onNavigationRequestHandled?.(navigationRequest.id);
    });
  }, [
    navigationRequest,
    onNavigationRequestHandled,
    openUrl,
    lastHandledNavigationRequestIdRef,
  ]);

  return { openUrl, rebuildBrowserGuest };
}
