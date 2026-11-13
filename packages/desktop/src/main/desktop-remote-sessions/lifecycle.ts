import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes, resolveWorkspaceKey, type RemoteTarget } from "@zcode/shared";
import type {
  RemoteConnectionStats,
  RemoteDisconnectReason,
} from "../desktopRemoteUsageArmsTelemetry.js";
import type {
  RemoteAttachmentRoute,
  RemoteSessionsContext,
  RemoteWorkspaceSessionContext,
} from "./types.js";
import { buildRemoteTargetTelemetryKey, isSameRemoteTarget } from "./targets.js";

export function createRemoteSessionLifecycle(
  ctx: RemoteSessionsContext,
  deps: {
    getWindowHost: (win: BrowserWindow) => ElectronUtilityProcess;
    createMessageChannel: () => { port1: MessagePortMain; port2: MessagePortMain };
    detachServicePort: (
      child: ElectronUtilityProcess,
      attachmentId: string,
      reason: string,
    ) => void;
    attachRendererPort: (
      win: BrowserWindow,
      route: RemoteAttachmentRoute,
      reason: string,
    ) => Promise<void>;
    retireActiveRoute: (
      route: RemoteAttachmentRoute,
      reason: RemoteDisconnectReason,
      mutate: () => void,
    ) => void;
  },
) {
  function reattachRemoteWorkspaceSessionsForWindow(win: BrowserWindow, reason: string): void {
    for (const route of ctx.state.routesBySessionId.values()) {
      if (
        !route.mobileOnly &&
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable"
      ) {
        void deps.attachRendererPort(win, route, reason).catch((error: unknown) => {
          ctx.options.logger.warn("[window-host-remote] renderer reattach failed", {
            sessionId: route.descriptor.remoteSessionId,
            reason,
            error,
          });
        });
      }
    }
  }

  function getRemoteConnectionStats(): RemoteConnectionStats {
    const activeRoutes = Array.from(ctx.state.routesBySessionId.values()).filter(
      (route) =>
        route.remoteUsageTelemetryEligible &&
        route.attachmentState === "attachable" &&
        route.connectFinalized,
    );
    return {
      activeSessionCount: activeRoutes.length,
      activeTargetCount: new Set(
        activeRoutes.map((route) => buildRemoteTargetTelemetryKey(route.descriptor.target)),
      ).size,
    };
  }

  function disposeRemoteWorkspaceSession(sessionId: string, _reason?: string): void {
    const route = ctx.state.routesBySessionId.get(sessionId);
    if (!route) return;
    deps.retireActiveRoute(route, "disposed", () => {
      ctx.state.routesBySessionId.delete(sessionId);
    });
    route.providerProvisioningDispose?.();
    const child = ctx.options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) deps.detachServicePort(child, pending.attachmentId, "session-disposed");
      pending.reject(new Error(`远程 workspace session 已释放，sessionId=${sessionId}`));
    }
    if (!child) return;
    if (route.rendererAttachmentId) {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: route.rendererAttachmentId,
      });
    }
    child.postMessage({
      type: HostMessageTypes.DisposeRemoteWorkspaceSession,
      requestId: randomUUID(),
      remoteSessionId: sessionId,
    });
  }

  function disposeRemoteWorkspaceSessionsForWindow(webContentsId: number): void {
    for (const [key, pending] of ctx.state.pendingProjectNavigations) {
      if (pending.win.webContents.id !== webContentsId) continue;
      ctx.state.pendingProjectNavigations.delete(key);
      pending.reject(new Error("窗口已关闭，项目导航已取消"));
    }

    for (const [sessionId, route] of Array.from(ctx.state.routesBySessionId)) {
      if (route.webContentsId !== webContentsId) continue;
      deps.retireActiveRoute(route, "window-closed", () => {
        ctx.state.routesBySessionId.delete(sessionId);
      });
      route.providerProvisioningDispose?.();
      if (route.pendingRendererAttachment) {
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(new Error("窗口已关闭，attachment 已取消"));
      }
    }
    for (const [key, pending] of Array.from(ctx.state.pendingByRequestKey)) {
      if (pending.webContentsId !== webContentsId) continue;
      ctx.state.pendingByRequestKey.delete(key);
      pending.reject(new Error("窗口已关闭，远程连接已取消"));
    }
    for (const [key, pending] of Array.from(ctx.state.pendingWorkspaceBindsByRequestKey)) {
      if (!key.startsWith(`${webContentsId}\0`)) continue;
      ctx.state.pendingWorkspaceBindsByRequestKey.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(new Error("窗口已关闭，workspace bind 已取消"));
    }
  }

  function cancelPendingRemoteWorkspaceSessionsForWindow(
    webContentsId: number,
    _reason: string,
    requestId?: string,
  ): void {
    const child = ctx.options.windowHostProcessMap.get(webContentsId);
    if (!child) return;
    for (const [key, pending] of ctx.state.pendingProjectNavigations) {
      if (
        pending.win.webContents.id !== webContentsId ||
        (requestId && pending.requestId !== requestId)
      )
        continue;
      ctx.state.pendingProjectNavigations.delete(key);
      child.postMessage({
        type: HostMessageTypes.CancelRemoteWorkspaceConnect,
        requestId: pending.requestId,
      });
      pending.reject(new Error("项目导航已取消"));
    }
    for (const pending of ctx.state.pendingByRequestKey.values()) {
      if (
        pending.webContentsId === webContentsId &&
        (!requestId || pending.requestId === requestId)
      ) {
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceConnect,
          requestId: pending.requestId,
        });
      }
    }
  }

  function hasRemoteWorkspaceSessionForTarget(
    win: BrowserWindow,
    target: RemoteTarget,
    context?: RemoteWorkspaceSessionContext,
  ): boolean {
    const workspaceKey = context ? resolveWorkspaceKey(context) : undefined;
    return Array.from(ctx.state.routesBySessionId.values()).some(
      (route) =>
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        isSameRemoteTarget(route.descriptor.target, target) &&
        (!workspaceKey ||
          resolveWorkspaceKey({
            workspacePath: route.descriptor.workspacePath ?? "",
            workspaceIdentity: route.descriptor.workspaceIdentity,
          }) === workspaceKey),
    );
  }

  function attachRemoteWorkspaceSessionHost(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }): {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteTarget["kind"];
  } {
    const route = ctx.state.routesBySessionId.get(params.remoteSessionId);
    if (!route) {
      throw Object.assign(
        new Error(`未找到远程 workspace session，sessionId=${params.remoteSessionId}`),
        {
          code: "REMOTE_SESSION_MISSING" as const,
        },
      );
    }
    if (route.attachmentState !== "attachable") {
      throw Object.assign(new Error("远程 workspace source 当前离线"), {
        code: "REMOTE_SESSION_OFFLINE" as const,
      });
    }
    const win = BrowserWindow.fromId(params.windowId);
    if (!win || win.webContents.id !== route.webContentsId) {
      throw Object.assign(new Error("远程 workspace session 不属于当前窗口"), {
        code: "REMOTE_SESSION_WINDOW_MISMATCH" as const,
      });
    }
    const descriptor = route.descriptor;
    if (
      descriptor.workspacePath !== params.workspacePath ||
      descriptor.workspaceIdentity !== params.workspaceIdentity ||
      params.workspaceKey !== params.workspaceIdentity
    ) {
      throw Object.assign(new Error("远程 workspaceKey 与 logical session 不匹配。"), {
        code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH" as const,
      });
    }
    const process = deps.getWindowHost(win);
    const { port1, port2 } = deps.createMessageChannel();
    process.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId: randomUUID(),
        clientMode: params.clientMode,
        scope: {
          kind: "remote",
          remoteSessionId: params.remoteSessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      },
      [port2],
    );
    return { process, port: port1, remoteKind: descriptor.target.kind };
  }

  async function disposeAllAndWaitForAppShutdown(_reason: string): Promise<void> {
    ctx.state.appShutdownStarted = true;
    const error = new Error("应用正在退出，远程连接已取消");
    for (const pending of ctx.state.pendingProjectNavigations.values()) pending.reject(error);
    ctx.state.pendingProjectNavigations.clear();
    for (const pending of ctx.state.pendingByRequestKey.values()) pending.reject(error);
    ctx.state.pendingByRequestKey.clear();
    for (const pending of ctx.state.pendingWorkspaceBindsByRequestKey.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    ctx.state.pendingWorkspaceBindsByRequestKey.clear();
    for (const [sessionId, route] of Array.from(ctx.state.routesBySessionId)) {
      deps.retireActiveRoute(route, "app-shutdown", () => {
        ctx.state.routesBySessionId.delete(sessionId);
      });
      route.providerProvisioningDispose?.();
      if (!route.pendingRendererAttachment) continue;
      clearTimeout(route.pendingRendererAttachment.timeout);
      route.pendingRendererAttachment.reject(error);
    }
    ctx.state.routesBySessionId.clear();
  }

  return {
    reattachRemoteWorkspaceSessionsForWindow,
    getRemoteConnectionStats,
    disposeRemoteWorkspaceSession,
    disposeRemoteWorkspaceSessionsForWindow,
    cancelPendingRemoteWorkspaceSessionsForWindow,
    hasRemoteWorkspaceSessionForTarget,
    attachRemoteWorkspaceSessionHost,
    disposeAllAndWaitForAppShutdown,
  };
}
