import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWebElementPicker } from "@/hooks/useWebElementPicker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { BrowserSiteSettingsEntry } from "@/browser-use/BrowserSiteSettingsEntry.js";
import { BrowserToolbar } from "@/EmbeddedBrowserPaneParts.js";
import { EmbeddedBrowserPermissionPrompts } from "@/browser-use/EmbeddedBrowserPermissionPrompts.js";
import { BrowserViewportSurface } from "@/browser-use/BrowserViewportSurface.js";
import { BrowserViewportToolbar } from "@/browser-use/BrowserViewportToolbar.js";
import { useDesktopZoomFactor } from "@/browser-use/useDesktopZoomFactor.js";
import { useBrowserGuestAttachment } from "@/browser-use/unified-browser-view/useBrowserGuestAttachment.js";
import { useBrowserGuestEventWiring } from "@/browser-use/unified-browser-view/useBrowserGuestEventWiring.js";
import { useBrowserGuestNavigationQueue } from "@/browser-use/unified-browser-view/useBrowserGuestNavigationQueue.js";
import { useBrowserLayoutState } from "@/browser-use/unified-browser-view/useBrowserLayoutState.js";
import { useBrowserNavigation } from "@/browser-use/unified-browser-view/useBrowserNavigation.js";
import { useBrowserViewActions } from "@/browser-use/unified-browser-view/useBrowserViewActions.js";
import type { UnifiedBrowserViewProps } from "@/browser-use/unified-browser-view/types.js";
import {
  DEFAULT_BROWSER_URL,
  displayBrowserUrl,
  safeWebviewCall,
} from "@/embeddedBrowserHelpers.js";

/**
 * UnifiedBrowserView —— 统一浏览器视图（`<webview>` + CDP-on-guest 架构）。
 *
 * 网页像素由 renderer 内的 `<webview>` guest 直接渲染（DOM 内合成，可被 DOM 浮层覆盖，
 * 彻底解决 WebContentsView 原生层遮挡菜单的问题）。human 的导航/前进后退/刷新/元素拾取
 * 直接调用 webview 方法（低延迟、无握手依赖）；chrome 状态由 webview 事件驱动。
 *
 * 同时在 did-attach 时把 guest 的 webContentsId 上报给 main（browserViewAttachGuest），
 * 让 main 能给该 guest 挂 CDP（webContents.debugger），供 agent 通过协议控制这个 tab。
 *
 * chrome 复用 EmbeddedBrowserPaneParts 的 BrowserToolbar；
 * URL 归一化 / 未挂载兜底复用 embeddedBrowserHelpers。布局状态、guest 归属、事件接线、
 * 导航命令与工具栏动作分别由 unified-browser-view/ 下的 hook 承担。
 */
export function UnifiedBrowserView({
  browserKey,
  onOpenPermissionSettings,
  isResidencyRestore = false,
  isVisible,
  isSelected = isVisible,
  isCurrentTask = isSelected,
  initialUrl,
  faviconUrl,
  navigationRequest,
  onUrlChange,
  onPageMetadataChange,
  onNavigationRequestHandled,
  workspacePath,
  workspaceIdentity,
  workspaceKey,
  remoteSessionId,
  sessionId,
  residencyGeneration,
  browserUseOperationUntil,
  browserResizeBaselineVersion,
  screenshotSurfaceRequest,
  deferEmptyGuest = false,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
}: UnifiedBrowserViewProps): React.JSX.Element {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const desktopZoomFactor = useDesktopZoomFactor();

  const {
    addressValue,
    setAddressValue,
    browserState,
    setBrowserState,
    hasInitialNavigation,
    hasNavigated,
    setHasNavigated,
    webviewGeneration,
    setWebviewGeneration,
    webview,
    setWebview,
    permissionGuestWebContentsId,
    guestAttachRetryNonce,
    setGuestAttachRetryNonce,
    shouldComposeSurface,
    setGuestZoomFactor,
    browserRegionRef,
    notifyBrowserViewportResize,
    showResizeWarning,
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
    effectiveIsResponsiveMode,
    effectiveViewportSize,
    shouldNormalizeGuestZoom,
    effectiveViewportZoom,
  } = useBrowserLayoutState({
    browserKey,
    initialUrl,
    isVisible,
    browserUseOperationUntil,
    browserResizeBaselineVersion,
    desktopZoomFactor,
    sessionId,
    initialHumanViewportPreference,
    onHumanViewportPreferenceChange,
    screenshotSurfaceRequest,
  });

  const {
    refs,
    lastReportedGuestRef,
    onPageMetadataChangeRef,
    onUrlChangeRef,
    logWebviewTeardown,
    completePendingGuestNavigation,
    waitForGuestNavigationTakeover,
  } = useBrowserGuestNavigationQueue({
    browserKey,
    initialUrl,
    webviewGeneration,
    hasInitialNavigation,
    hasNavigated,
    onPageMetadataChange,
    onUrlChange,
  });
  const { webviewTeardownProbeRef } = refs;

  const { reportBrowserGuest, detachBrowserGuestBeforeReplacement } =
    useBrowserGuestAttachment({
      browserKey,
      workspaceKey,
      workspaceIdentity,
      workspacePath,
      remoteSessionId,
      sessionId,
      residencyGeneration,
      platform,
      webview,
      lastReportedGuestRef,
      setGuestAttachRetryNonce,
      synchronizeInitialHumanViewport,
    });

  const {
    cancelPicking: cancelWebElementPicking,
    isPicking: isWebElementPicking,
    togglePicking: toggleWebElementPicking,
  } = useWebElementPicker({
    // 传输无关出口：webview 就绪时走 <webview>.executeJavaScript(script, true)；
    // 尚为 null 时返回 cancelled（合法选择结果），保持 no-op。
    executeJs: (script) =>
      webview
        ? webview.executeJavaScript(script, true)
        : Promise.resolve({ status: "cancelled" }),
    workspacePath: workspacePath ?? "",
    workspaceIdentity: workspaceKey ?? workspaceIdentity,
  });

  // ---- 从 webview 同步 chrome 状态（url/前进后退/标题）----
  const syncBrowserState = useCallback(
    (target: ElectronWebviewTag) => {
      // guest 在 dom-ready 前 / 导航 churn / 重附过程中未 attach，同步方法会抛
      // "must be attached to the DOM"，统一走 safeWebviewCall 兜底，避免冒泡到 window.onerror。
      const onDetached = (error: unknown) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的状态同步", {
          error: error instanceof Error ? error.message : String(error),
        });
      };
      const currentUrl =
        safeWebviewCall(() => target.getURL(), "", onDetached) ||
        DEFAULT_BROWSER_URL;
      const canGoBack = safeWebviewCall(
        () => target.canGoBack(),
        false,
        onDetached,
      );
      const canGoForward = safeWebviewCall(
        () => target.canGoForward(),
        false,
        onDetached,
      );
      const title = safeWebviewCall(() => target.getTitle(), "", onDetached);
      if (currentUrl !== DEFAULT_BROWSER_URL) {
        refs.lastRestorableUrlRef.current = currentUrl;
      }
      setAddressValue(displayBrowserUrl(currentUrl));
      setBrowserState((prev) => ({
        ...prev,
        canGoBack,
        canGoForward,
        currentUrl,
        isReady: true,
        title,
      }));
      onPageMetadataChangeRef.current?.({ title: title || undefined });
      // 页面 url 不可信：仅用于展示与 tab 持久化，不参与任何执行路径。
      if (currentUrl !== DEFAULT_BROWSER_URL) {
        onUrlChangeRef.current?.(currentUrl);
      }
    },
    [
      refs.lastRestorableUrlRef,
      setAddressValue,
      setBrowserState,
      onPageMetadataChangeRef,
      onUrlChangeRef,
    ],
  );

  useBrowserGuestEventWiring({
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
  });

  useEffect(() => {
    if (!webview) return;
    const wasResponsiveMode = refs.wasResponsiveModeRef.current;
    refs.wasResponsiveModeRef.current = shouldNormalizeGuestZoom;

    if (shouldNormalizeGuestZoom) {
      setGuestZoomFactor(webview, 1);
    } else if (wasResponsiveMode) {
      // 只在退出自由尺寸时恢复当前应用 zoom；普通浏览期间继续沿用 Electron 原生传播。
      setGuestZoomFactor(webview, desktopZoomFactor);
    }
  }, [
    desktopZoomFactor,
    shouldNormalizeGuestZoom,
    setGuestZoomFactor,
    webview,
    refs.wasResponsiveModeRef,
  ]);

  useEffect(() => {
    reportBrowserGuest(isSelected);
  }, [guestAttachRetryNonce, isSelected, reportBrowserGuest]);

  useEffect(() => {
    const effectiveWorkspaceKey =
      workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
    if (!effectiveWorkspaceKey || !sessionId) return;
    const restoreUrl =
      browserState.currentUrl && browserState.currentUrl !== DEFAULT_BROWSER_URL
        ? browserState.currentUrl
        : (refs.lastRestorableUrlRef.current ?? null);
    void platform
      .browserViewReportResidency?.({
        tabId: browserKey,
        workspaceKey: effectiveWorkspaceKey,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId,
        selected: isSelected,
        visible: isVisible,
        currentTask: isCurrentTask,
        loading: browserState.isLoading,
        restoreUrl,
        title: browserState.title || null,
        // favicon 不能只停留在 renderer tab state：residency 上报遗漏后，
        // 挂起与冷启动恢复得到的 shell 必然退回地球图标。
        ...(faviconUrl === undefined ? {} : { faviconUrl }),
      })
      .catch((error) => {
        logger.debug("[browser-use] 上报 tab residency 失败", {
          error: error instanceof Error ? error.message : String(error),
          tabId: browserKey,
        });
      });
  }, [
    browserKey,
    browserState.currentUrl,
    browserState.isLoading,
    browserState.title,
    faviconUrl,
    isCurrentTask,
    isSelected,
    isVisible,
    platform,
    remoteSessionId,
    sessionId,
    workspaceKey,
    workspaceIdentity,
    workspacePath,
    refs.lastRestorableUrlRef,
  ]);

  const { openUrl, rebuildBrowserGuest } = useBrowserNavigation({
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
  });

  const {
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
  } = useBrowserViewActions({
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
  });

  const faviconListenerRef = useRef<{
    node: ElectronWebviewTag;
    listener: (event: ElectronWebviewFaviconEvent) => void;
  } | null>(null);
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      const current = faviconListenerRef.current;
      if (current?.node === node) return;
      if (current) {
        current.node.removeEventListener(
          "page-favicon-updated",
          current.listener,
        );
        faviconListenerRef.current = null;
      }
      if (node) {
        const listener = (event: ElectronWebviewFaviconEvent) => {
          onPageMetadataChangeRef.current?.({
            faviconUrl: event.favicons[0] ?? null,
          });
        };
        // favicon 是可能只触发一次的 guest 事件；等 useEffect 才接线时，
        // 它可能已在 webview ref 提交与 effect 执行之间发出。ref 阶段同步监听可封住该窗口。
        node.addEventListener("page-favicon-updated", listener);
        faviconListenerRef.current = { node, listener };
      } else if (webviewTeardownProbeRef.current.hadWebview) {
        // generation 换代（受控重建）与父级卸载都会先走到这里；紧随其后若有新节点 ref
        // 回调则是换代，否则是整树/条件卸载。销毁归因打点见 webviewTeardownProbeRef 注释。
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("ref-null");
      }
      if (node) webviewTeardownProbeRef.current.hadWebview = true;
      setWebview(node);
    },
    [
      logWebviewTeardown,
      onPageMetadataChangeRef,
      setWebview,
      webviewTeardownProbeRef,
    ],
  );

  const handleRetryGuest = useCallback(() => {
    void rebuildBrowserGuest(refs.lastRestorableUrlRef.current, "manual-retry");
  }, [rebuildBrowserGuest, refs.lastRestorableUrlRef]);

  // 加载失败只是这次导航被拒，guest 本身还活着：重走 openUrl 即可，不必重建 guest。
  const handleRetryLoad = useCallback(() => {
    const retryUrl =
      refs.lastRestorableUrlRef.current ?? browserState.currentUrl;
    if (!retryUrl) return;
    void openUrl(retryUrl, "toolbar");
  }, [browserState.currentUrl, openUrl, refs.lastRestorableUrlRef]);

  // 把 addressValue 草稿纳入空置态判断后，用户只要开始输入、尚未回车，
  // 就会提前隐藏空置态并裸露 webview。空置态只由已确认导航与加载/错误状态决定。
  const isEmptyBrowserState =
    !hasNavigated && !browserState.isLoading && !browserState.errorMessage;
  const shouldMountWebview =
    !deferEmptyGuest ||
    isResidencyRestore ||
    hasNavigated ||
    hasInitialNavigation;
  const prevShouldMountWebviewRef = useRef(shouldMountWebview);
  useEffect(() => {
    const previous = prevShouldMountWebviewRef.current;
    prevShouldMountWebviewRef.current = shouldMountWebview;
    if (
      previous &&
      !shouldMountWebview &&
      webviewTeardownProbeRef.current.hadWebview
    ) {
      logWebviewTeardown("should-mount-flip");
    }
  }, [logWebviewTeardown, shouldMountWebview, webviewTeardownProbeRef]);

  let permissionOrigin: string | null = null;
  try {
    const url = new URL(browserState.currentUrl);
    if (["http:", "https:"].includes(url.protocol))
      permissionOrigin = url.origin;
  } catch {
    /* 空白页没有站点权限。 */
  }

  // inactive 的 display:none 会让 Electron 保留旧 compositor surface，后台截图会按旧表面平铺。
  // prepare 期间的 flex 只用于合成；外层 inert、pointer-events-none 和 aria-hidden 隔离交互与 a11y。
  return (
    <div
      aria-hidden={!isVisible}
      data-browser-screenshot-webview-state={
        screenshotSurfaceRequest ? (webview ? "ready" : "missing") : undefined
      }
      className={cn(
        isVisible || shouldComposeSurface ? "flex" : "hidden",
        "relative h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
      )}
    >
      <BrowserToolbar
        addressValue={addressValue}
        browserState={browserState}
        permissionControl={
          permissionOrigin ? (
            <BrowserSiteSettingsEntry
              origin={permissionOrigin}
              onOpenSettings={onOpenPermissionSettings}
            />
          ) : null
        }
        formatMessage={intl.formatMessage}
        onAddressChange={setAddressValue}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onOpenExternal={handleOpenExternal}
        onOpenDevTools={handleOpenDevTools}
        onPickElement={handleTogglePicker}
        onReload={handleReload}
        onToggleResponsiveMode={handleToggleResponsiveMode}
        onSubmit={handleSubmit}
        isElementPickerActive={isWebElementPicking}
        isResponsiveMode={isResponsiveMode}
      />
      {/* 权限弹窗层：只在可见 tab 挂载（多 tab 共享 store，避免重复渲染与
          后台请求误显示）；permission 请求再按 guest 归属过滤到发起 tab。 */}
      {isVisible ? (
        <EmbeddedBrowserPermissionPrompts
          guestWebContentsId={permissionGuestWebContentsId}
        />
      ) : null}
      {isResponsiveMode ? (
        <BrowserViewportToolbar
          isVisible={isVisible}
          onViewportSizeChange={handleResponsiveViewportInput}
          onZoomChange={setResponsiveViewportZoom}
          viewportSize={responsiveViewportSize}
          zoom={responsiveViewportZoom}
        />
      ) : null}
      <BrowserViewportSurface
        browserRegionRef={browserRegionRef}
        browserState={browserState}
        desktopZoomFactor={desktopZoomFactor}
        isResidencyRestore={isResidencyRestore}
        formatMessage={intl.formatMessage}
        isEmptyBrowserState={isEmptyBrowserState}
        isComposed={isVisible || shouldComposeSurface}
        isResponsiveMode={effectiveIsResponsiveMode}
        isViewportEmulated={
          effectiveIsResponsiveMode &&
          screenshotSurfaceRequest?.viewportMode !== "natural"
        }
        onRetryGuest={handleRetryGuest}
        onRetryLoad={handleRetryLoad}
        onViewportResize={notifyBrowserViewportResize}
        onViewportSizeChange={handleResponsiveViewportSizeChange}
        onWebviewRef={handleWebviewRef}
        shouldMountWebview={shouldMountWebview}
        showResizeWarning={showResizeWarning}
        webviewGeneration={webviewGeneration}
        viewportSize={effectiveViewportSize}
        viewportZoom={effectiveViewportZoom}
      />
    </div>
  );
}
