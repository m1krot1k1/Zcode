import { useCallback, useEffect, useState } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewportSize,
  BrowserViewportZoom,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { useBrowserResizeOperationWarning } from "@/browser-use/useBrowserResizeOperationWarning.js";
import { useBrowserScreenshotSurfaceReady } from "@/browser-use/useBrowserScreenshotSurfaceReady.js";
import { useEmbeddedBrowserWheelChain } from "@/browser-use/useEmbeddedBrowserWheelChain.js";
import { useResponsiveBrowserViewportControl } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import {
  DEFAULT_BROWSER_URL,
  INITIAL_BROWSER_STATE,
  safeWebviewCall,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";
import { logger } from "@/logger.js";

type BrowserLayoutStateParams = {
  browserKey: string;
  initialUrl?: string | null;
  isVisible: boolean;
  browserUseOperationUntil?: number;
  browserResizeBaselineVersion?: number;
  desktopZoomFactor: number;
  sessionId?: string;
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
};

export type BrowserLayoutState = {
  addressValue: string;
  setAddressValue: React.Dispatch<React.SetStateAction<string>>;
  browserState: BrowserState;
  setBrowserState: React.Dispatch<React.SetStateAction<BrowserState>>;
  hasInitialNavigation: boolean;
  hasNavigated: boolean;
  setHasNavigated: React.Dispatch<React.SetStateAction<boolean>>;
  webviewGeneration: number;
  setWebviewGeneration: React.Dispatch<React.SetStateAction<number>>;
  webview: ElectronWebviewTag | null;
  setWebview: React.Dispatch<React.SetStateAction<ElectronWebviewTag | null>>;
  permissionGuestWebContentsId: number | undefined;
  guestAttachRetryNonce: number;
  setGuestAttachRetryNonce: React.Dispatch<React.SetStateAction<number>>;
  shouldComposeSurface: boolean;
  setGuestZoomFactor: (
    target: ElectronWebviewTag,
    targetZoomFactor: number,
  ) => void;
  browserRegionRef: React.RefObject<HTMLDivElement | null>;
  notifyBrowserViewportResize: () => void;
  showResizeWarning: boolean;
  isResponsiveMode: boolean;
  responsiveViewportSize: BrowserViewportSize;
  responsiveViewportZoom: BrowserViewportZoom;
  setResponsiveViewportZoom: (zoom: BrowserViewportZoom) => void;
  synchronizeInitialHumanViewport: () => void;
  toggleResponsiveMode: () => void;
  updateResponsiveViewportSize: (size: BrowserViewportSize) => void;
  effectiveIsResponsiveMode: boolean;
  effectiveViewportSize: BrowserViewportSize;
  shouldNormalizeGuestZoom: boolean;
  effectiveViewportZoom: BrowserViewportZoom;
};

/**
 * 浏览器视图的本地状态与预览布局：地址/加载状态、guest 节点、缩放补偿和
 * 响应式 viewport。截图请求只派生临时布局，不写回用户偏好。
 */
export function useBrowserLayoutState({
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
}: BrowserLayoutStateParams): BrowserLayoutState {
  const [addressValue, setAddressValue] = useState("");
  const [browserState, setBrowserState] = useState<BrowserState>(
    INITIAL_BROWSER_STATE,
  );
  const hasInitialNavigation = Boolean(
    initialUrl && initialUrl !== DEFAULT_BROWSER_URL,
  );
  const [hasNavigated, setHasNavigated] = useState(hasInitialNavigation);
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [webview, setWebview] = useState<ElectronWebviewTag | null>(null);
  // 权限气泡的 tab 归属过滤：attach/dom-ready 后读取 guest webContents id；
  // 读不到时保持 undefined（组件按「请求缺归属 id 则兜底渲染」处理）。
  const [permissionGuestWebContentsId, setPermissionGuestWebContentsId] =
    useState<number | undefined>(undefined);
  useEffect(() => {
    if (!webview || typeof webview.getWebContentsId !== "function") return;
    const id = safeWebviewCall(() => webview.getWebContentsId(), 0);
    setPermissionGuestWebContentsId(id > 0 ? id : undefined);
  }, [webview, browserState.isReady]);
  const [guestAttachRetryNonce, setGuestAttachRetryNonce] = useState(0);
  useBrowserScreenshotSurfaceReady({
    request: screenshotSurfaceRequest ?? null,
    webview,
  });
  const shouldComposeSurface = Boolean(screenshotSurfaceRequest);
  const setGuestZoomFactor = useCallback(
    (target: ElectronWebviewTag, targetZoomFactor: number) => {
      if (typeof target.setZoomFactor !== "function") return;
      safeWebviewCall(
        () => target.setZoomFactor(targetZoomFactor),
        undefined,
        (error) => {
          logger.debug("[browser-use] 跳过未就绪 webview 的 zoom 同步", {
            error: error instanceof Error ? error.message : String(error),
            targetZoomFactor,
          });
        },
      );
    },
    [],
  );
  const normalizeResponsiveGuestZoom = useCallback(() => {
    if (webview) setGuestZoomFactor(webview, 1);
  }, [setGuestZoomFactor, webview]);
  const {
    browserRegionRef,
    notifyBrowserViewportResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  } = useBrowserResizeOperationWarning({
    browserKey,
    isVisible,
    operationUntil: browserUseOperationUntil,
    resizeBaselineVersion: browserResizeBaselineVersion,
  });
  const {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  } = useResponsiveBrowserViewportControl({
    browserKey,
    desktopZoomFactor,
    onAgentViewportChange: prepareForAgentViewportChange,
    onViewportSynchronized: normalizeResponsiveGuestZoom,
    onViewportResize: notifyBrowserViewportResize,
    initialHumanViewportPreference,
    onHumanViewportPreferenceChange,
    sessionId,
  });
  // MediaRecorder 录到的是 renderer 中实际合成的 WebView surface。若沿用用户的 Fit/50%
  // 预览，后续 canvas 只能把低分辨率源放大到目标尺寸。录制 lease 因此派生一份 100% surface，
  // 不修改用户的自由尺寸、缩放选择或持久状态；request 释放后 React 会自然恢复原预览。
  const forceUnscaledSurface =
    screenshotSurfaceRequest?.surfaceScaleMode === "unscaled";
  // 普通后台 tab 的 fallback viewport 可能大于窗口；仅传 Fit 不会启用布局，
  // webview 随准备层缩小后永远无法 ready。截图期间统一派生请求尺寸的 responsive 布局，
  // release 后恢复用户模式与尺寸，不写偏好，也不重建 guest。
  const effectiveIsResponsiveMode =
    isResponsiveMode || Boolean(screenshotSurfaceRequest);
  const effectiveViewportSize =
    screenshotSurfaceRequest?.viewport ?? responsiveViewportSize;
  // 普通截图只临时改变布局；fallback metrics 的 guest zoom 由 main 管理。
  // 若把临时 Fit 当作用户模式切换，release 会错误恢复 desktop zoom，破坏后续 CDP 坐标。
  const shouldNormalizeGuestZoom = isResponsiveMode || forceUnscaledSurface;
  // 固定 100%/200% 预览不会随截图画布缩小，Windows 高 DPI 的 guest raster
  // 仍可能被宿主可见范围裁剪。普通截图临时 Fit，释放后恢复用户比例；录制保持 unscaled。
  const effectiveViewportZoom = forceUnscaledSurface
    ? "100"
    : screenshotSurfaceRequest
      ? "fit"
      : responsiveViewportZoom;
  useEmbeddedBrowserWheelChain({
    browserRegionRef,
    isResponsiveMode: effectiveIsResponsiveMode,
    webview,
  });

  return {
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
    toggleResponsiveMode,
    updateResponsiveViewportSize,
    effectiveIsResponsiveMode,
    effectiveViewportSize,
    shouldNormalizeGuestZoom,
    effectiveViewportZoom,
    synchronizeInitialHumanViewport,
  };
}
