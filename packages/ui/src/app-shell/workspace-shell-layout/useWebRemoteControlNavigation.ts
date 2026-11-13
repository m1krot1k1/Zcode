import { useCallback, useEffect } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  getWebRemoteControlViewportHeight,
  markWebRemoteControlCollapseIntent,
  WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX,
  WEB_REMOTE_CONTROL_MOBILE_QUERY,
} from "@/app-shell/workspace-shell-layout/helpers.js";
import type { WorkspaceShellBaseState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellBaseState.js";
import {
  resolveWebRemoteNavigationDragState,
  resolveWebRemoteNavigationToggleState,
  shouldRenderWebRemoteNavigationPanel,
  type WebRemoteNavigationState,
} from "@/app-shell/webRemoteNavigationLayout.js";
import { logger } from "@/logger.js";

/**
 * 手机 Web 远控顶部导航：高度/折叠态、视口断点订阅、拖拽会话与点击抑制。
 * 导航面板是否渲染由同一状态派生，拖拽只写这一份状态。
 */
export function useWebRemoteControlNavigation(base: WorkspaceShellBaseState) {
  const {
    isWebRemoteControlMobileViewport,
    isWebRemoteControlNavigationCollapsed,
    isWebRemoteControlNavigationDragging,
    isWebRemoteControlShell,
    isWebRemoteControlTaskSwitching,
    setIsWebRemoteControlMobileViewport,
    setIsWebRemoteControlNavigationCollapsed,
    setIsWebRemoteControlNavigationDragging,
    setIsWebRemoteControlTaskSwitching,
    setWebRemoteControlNavigationHeightPx,
    suppressWebRemoteControlNavigationClickRef,
    webRemoteControlNavigationCollapsedRef,
    webRemoteControlNavigationDragRef,
    webRemoteControlNavigationHeightPx,
    webRemoteControlNavigationHeightRef,
  } = base;
  useEffect(() => {
    webRemoteControlNavigationHeightRef.current = webRemoteControlNavigationHeightPx;
    webRemoteControlNavigationCollapsedRef.current = isWebRemoteControlNavigationCollapsed;
  }, [isWebRemoteControlNavigationCollapsed, webRemoteControlNavigationHeightPx]);
  useEffect(() => {
    if (
      !isWebRemoteControlShell ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQueryList = window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY);
    const syncMobileViewport = () => {
      setIsWebRemoteControlMobileViewport(mediaQueryList.matches);
    };

    syncMobileViewport();
    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", syncMobileViewport);
      return () => {
        mediaQueryList.removeEventListener("change", syncMobileViewport);
      };
    }

    mediaQueryList.addListener(syncMobileViewport);
    return () => {
      mediaQueryList.removeListener(syncMobileViewport);
    };
  }, [isWebRemoteControlShell]);

  useEffect(() => {
    if (!isWebRemoteControlShell || typeof window === "undefined") {
      return;
    }

    const clampNavigationHeightToViewport = () => {
      if (webRemoteControlNavigationCollapsedRef.current) {
        return;
      }

      const viewportHeight = getWebRemoteControlViewportHeight();
      setWebRemoteControlNavigationHeightPx(
        (currentHeightPx) =>
          resolveWebRemoteNavigationDragState({
            heightPx: currentHeightPx,
            viewportHeight,
          }).heightPx,
      );
    };

    window.addEventListener("resize", clampNavigationHeightToViewport);
    return () => {
      window.removeEventListener("resize", clampNavigationHeightToViewport);
    };
  }, [isWebRemoteControlShell]);
  const applyWebRemoteNavigationState = useCallback((nextState: WebRemoteNavigationState) => {
    setWebRemoteControlNavigationHeightPx(nextState.heightPx);
    setIsWebRemoteControlNavigationCollapsed(nextState.isCollapsed);
  }, []);
  const toggleWebRemoteNavigation = useCallback(() => {
    const nextState = resolveWebRemoteNavigationToggleState({
      currentHeightPx: webRemoteControlNavigationHeightRef.current,
      isCollapsed: webRemoteControlNavigationCollapsedRef.current,
      viewportHeight: getWebRemoteControlViewportHeight(),
    });

    logger.debug("[WorkspaceShellLayout] Web 远控导航快速切换", nextState);
    applyWebRemoteNavigationState(nextState);
  }, [applyWebRemoteNavigationState]);
  const handleWebRemoteNavigationResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      const startHeightPx = webRemoteControlNavigationCollapsedRef.current
        ? 0
        : webRemoteControlNavigationHeightRef.current;
      webRemoteControlNavigationDragRef.current = {
        pointerId: event.pointerId,
        startHeightPx,
        startY: event.clientY,
        didDrag: false,
      };
      suppressWebRemoteControlNavigationClickRef.current = true;
      setIsWebRemoteControlNavigationDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽开始", {
        startHeightPx,
      });
    },
    [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
  );
  const handleWebRemoteNavigationResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const dragSession = webRemoteControlNavigationDragRef.current;
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      const deltaY = event.clientY - dragSession.startY;
      if (!dragSession.didDrag && Math.abs(deltaY) < WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX) {
        return;
      }

      event.preventDefault();
      dragSession.didDrag = true;
      applyWebRemoteNavigationState(
        resolveWebRemoteNavigationDragState({
          heightPx: dragSession.startHeightPx + deltaY,
          viewportHeight: getWebRemoteControlViewportHeight(),
        }),
      );
    },
    [applyWebRemoteNavigationState],
  );
  const finishWebRemoteNavigationResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
      const dragSession = webRemoteControlNavigationDragRef.current;
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      webRemoteControlNavigationDragRef.current = null;
      setIsWebRemoteControlNavigationDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (cancelled) {
        suppressWebRemoteControlNavigationClickRef.current = false;
        return;
      }

      if (!dragSession.didDrag) {
        toggleWebRemoteNavigation();
        return;
      }

      const nextState = resolveWebRemoteNavigationDragState({
        heightPx: dragSession.startHeightPx + event.clientY - dragSession.startY,
        viewportHeight: getWebRemoteControlViewportHeight(),
      });
      logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽结束", nextState);
      applyWebRemoteNavigationState(nextState);
    },
    [applyWebRemoteNavigationState, toggleWebRemoteNavigation],
  );
  const handleWebRemoteNavigationHandleClick = useCallback(() => {
    if (suppressWebRemoteControlNavigationClickRef.current) {
      suppressWebRemoteControlNavigationClickRef.current = false;
      return;
    }

    toggleWebRemoteNavigation();
  }, [toggleWebRemoteNavigation]);
  const handleWebRemoteTaskOpen = useCallback(
    ({ crossWorkspace }: { crossWorkspace: boolean }) => {
      if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
        return;
      }

      // Bugfix: 远控移动端在“选中任务”后仍保持顶部导航展开，会挤压会话区域，读写消息时需要再手动折叠一次。
      // 这里在任务点击后自动折叠；跨 workspace 跳转时再写一次 session intent，确保新页面首帧也保持折叠态。
      setIsWebRemoteControlNavigationCollapsed(true);
      if (crossWorkspace) {
        markWebRemoteControlCollapseIntent();
      }
    },
    [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
  );
  const handleWebRemoteTaskSwitchingChange = useCallback((switching: boolean) => {
    setIsWebRemoteControlTaskSwitching(switching);
  }, []);
  const renderWebRemoteNavigationPanel = shouldRenderWebRemoteNavigationPanel({
    isCollapsed: isWebRemoteControlNavigationCollapsed,
    isMobileViewport: isWebRemoteControlMobileViewport,
    isWebRemoteControlShell,
  });
  return {
    isWebRemoteControlNavigationCollapsed,
    isWebRemoteControlNavigationDragging,
    isWebRemoteControlMobileViewport,
    isWebRemoteControlTaskSwitching,
    webRemoteControlNavigationHeightPx,
    handleWebRemoteNavigationResizeStart,
    handleWebRemoteNavigationResizeMove,
    finishWebRemoteNavigationResize,
    handleWebRemoteNavigationHandleClick,
    handleWebRemoteTaskOpen,
    handleWebRemoteTaskSwitchingChange,
    renderWebRemoteNavigationPanel,
  };
}

export type WebRemoteControlNavigationState = ReturnType<typeof useWebRemoteControlNavigation>;
