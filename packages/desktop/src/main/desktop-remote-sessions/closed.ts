import { BrowserWindow } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type { RemoteDisconnectReason } from "../desktopRemoteUsageArmsTelemetry.js";
import type { RemoteAttachmentRoute, RemoteSessionsContext } from "./types.js";

export function createRemoteClosedHandler(
  ctx: RemoteSessionsContext,
  deps: {
    detachServicePort: (
      child: ElectronUtilityProcess,
      attachmentId: string,
      reason: string,
    ) => void;
    emitConnectionLog: (
      win: BrowserWindow,
      payload: {
        requestId?: string;
        sessionId?: string;
        level: "info" | "warn" | "error";
        message: string;
      },
    ) => void;
    retireActiveRoute: (
      route: RemoteAttachmentRoute,
      reason: RemoteDisconnectReason,
      mutate: () => void,
    ) => void;
  },
) {
  function detachRouteAttachments(
    route: RemoteAttachmentRoute,
    reason: string,
    error: Error,
  ): void {
    const child = ctx.options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) deps.detachServicePort(child, pending.attachmentId, reason);
      pending.reject(error);
    }
    if (route.rendererAttachmentId) {
      if (child) deps.detachServicePort(child, route.rendererAttachmentId, reason);
      route.rendererAttachmentId = undefined;
    }
  }

  function handleClosed(
    webContentsId: number,
    event: {
      remoteSessionId: string;
      reason: "connection-closed" | "disposed" | "connect-cancelled";
      exitCode?: number | null;
      signal?: string | null;
      error?: string;
      recoverable?: boolean;
      recoveryAttempt?: number;
      recoveryLimit?: number;
      recoveryBudgetExhausted?: boolean;
      reasonCode?: string;
      retryable?: boolean;
    },
  ): void {
    const route = ctx.state.routesBySessionId.get(event.remoteSessionId);
    if (!route || route.webContentsId !== webContentsId) return;
    if (event.reason !== "connection-closed") {
      route.providerProvisioningDispose?.();
      deps.retireActiveRoute(route, "disposed", () => {
        ctx.state.routesBySessionId.delete(event.remoteSessionId);
      });
      detachRouteAttachments(
        route,
        "session-released",
        new Error(`远程 workspace 已释放，sessionId=${event.remoteSessionId}`),
      );
      return;
    }
    deps.retireActiveRoute(route, "connection-closed", () => {
      route.attachmentState = "closed";
    });
    route.providerProvisioningDispose?.();
    // 连接断开只把 route 标成 closed，已暴露的 desktop attachment 仍留在窗口 Host；
    // sessionId 换代后 Main 又会删除 route，导致旧 ChannelServer 永久失去回收入口。
    detachRouteAttachments(
      route,
      "session-connection-closed",
      new Error(`远程 workspace 已关闭，sessionId=${event.remoteSessionId}`),
    );
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (event.recoverable !== true) {
      ctx.options.webRemoteControlManagerRef.current?.failRemoteSession(
        event.remoteSessionId,
        "window-host:connection-offline",
        {
          reason: "workspace-closed",
          message: "远程工作区连接已结束，请在桌面端重新连接。",
        },
      );
    }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PlatformChannels.RemoteSessionClosed, {
        sessionId: event.remoteSessionId,
        reason: "host-exit" as const,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
        ...(event.error ? { error: event.error } : {}),
        ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}),
        ...(event.recoveryAttempt ? { recoveryAttempt: event.recoveryAttempt } : {}),
        ...(event.recoveryLimit ? { recoveryLimit: event.recoveryLimit } : {}),
        ...(event.recoveryBudgetExhausted !== undefined
          ? { recoveryBudgetExhausted: event.recoveryBudgetExhausted }
          : {}),
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
      });
      deps.emitConnectionLog(win, {
        sessionId: event.remoteSessionId,
        level: "warn",
        message: event.error || "远程 workspace 连接已断开",
      });
    }
  }

  return { handleClosed };
}
