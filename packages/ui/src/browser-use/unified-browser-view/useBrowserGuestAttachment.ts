import { useCallback } from "react";
import type { IPlatformService } from "@zcode/shared";
import type {
  BrowserGuestScope,
  ReportedBrowserGuest,
} from "@/browser-use/unified-browser-view/types.js";
import { safeWebviewCall } from "@/embeddedBrowserHelpers.js";
import { logger } from "@/logger.js";

type BrowserGuestAttachmentParams = BrowserGuestScope & {
  platform: IPlatformService;
  webview: ElectronWebviewTag | null;
  lastReportedGuestRef: React.RefObject<ReportedBrowserGuest | null>;
  setGuestAttachRetryNonce: React.Dispatch<React.SetStateAction<number>>;
  synchronizeInitialHumanViewport: () => void;
};

export type BrowserGuestAttachment = {
  reportBrowserGuest: (active: boolean) => void;
  detachBrowserGuestBeforeReplacement: () => Promise<boolean>;
};

/**
 * guest 与 main 的 CDP 归属同步：did-attach/dom-ready 上报 webContentsId，
 * 重建前先等 main 确认旧 guest 的 CDP 已断开。
 */
export function useBrowserGuestAttachment({
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
}: BrowserGuestAttachmentParams): BrowserGuestAttachment {
  const reportBrowserGuest = useCallback(
    (active: boolean) => {
      if (!webview) return;
      if (typeof webview.getWebContentsId !== "function") return;
      const webContentsId = safeWebviewCall(
        () => webview.getWebContentsId(),
        0,
      );
      if (webContentsId <= 0) return;
      const effectiveWorkspaceKey =
        workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
      const scopeFingerprint = JSON.stringify({
        active,
        webContentsId,
        workspaceKey: effectiveWorkspaceKey ?? "",
        remoteSessionId: remoteSessionId ?? "",
        sessionId: sessionId ?? "",
        residencyGeneration: residencyGeneration ?? null,
      });
      const lastReported = lastReportedGuestRef.current;
      if (lastReported?.scopeFingerprint === scopeFingerprint) {
        return;
      }
      lastReportedGuestRef.current = {
        active,
        webContentsId,
        scopeFingerprint,
      };
      const attachRequest = platform.browserViewAttachGuest?.({
        key: browserKey,
        webContentsId,
        active,
        ...(effectiveWorkspaceKey
          ? { workspaceKey: effectiveWorkspaceKey }
          : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(residencyGeneration === undefined ? {} : { residencyGeneration }),
      });
      if (!attachRequest) return;
      void attachRequest
        .then((result) => {
          // 旧 preload 仍可能只返回 undefined；成功 attach 的兼容语义保持不变。
          if (!result || result.ok) {
            synchronizeInitialHumanViewport();
            return;
          }
          logger.warn(
            "[browser-use] main 拒绝 guest attach，等待按 owner scope 重绑",
            {
              browserKey,
              reason: result.reason,
              recoveryRequested: result.recoveryRequested,
            },
          );
          // main 会重放 BrowserViewReady；清掉去重标记，确保同一个 webContentsId 也能重新上报。
          if (result.recoveryRequested) {
            lastReportedGuestRef.current = null;
            setGuestAttachRetryNonce((current) => current + 1);
          }
        })
        .catch((error) => {
          logger.debug("[browser-use] 上报 guest webContentsId 失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [
      browserKey,
      platform,
      remoteSessionId,
      residencyGeneration,
      sessionId,
      synchronizeInitialHumanViewport,
      webview,
      workspaceKey,
      workspaceIdentity,
      workspacePath,
      lastReportedGuestRef,
      setGuestAttachRetryNonce,
    ],
  );

  const detachBrowserGuestBeforeReplacement =
    useCallback(async (): Promise<boolean> => {
      const lastReported = lastReportedGuestRef.current;
      // guest 尚未上报给 main 时就没有 native CDP session，Web 端也不会暴露该桌面能力。
      if (!lastReported || !platform.browserViewDetachGuest) return true;
      try {
        const detached = await platform.browserViewDetachGuest({
          key: browserKey,
          webContentsId: lastReported.webContentsId,
        });
        if (!detached) {
          logger.warn(
            "[browser-use] main 未确认旧 guest CDP 已断开，取消 webview 重建",
            {
              browserKey,
              webContentsId: lastReported.webContentsId,
            },
          );
        }
        return detached;
      } catch (error) {
        logger.warn(
          "[browser-use] 请求 main 断开旧 guest CDP 失败，取消 webview 重建",
          {
            browserKey,
            error: error instanceof Error ? error.message : String(error),
            webContentsId: lastReported.webContentsId,
          },
        );
        return false;
      }
    }, [browserKey, platform, lastReportedGuestRef]);

  return { reportBrowserGuest, detachBrowserGuestBeforeReplacement };
}
