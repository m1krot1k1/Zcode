import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  buildRemoteEnvironmentKey,
  HostMessageTypes,
  PlatformChannels,
  type ProviderProvisioningTrigger,
  type WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";
import type { RemoteAttachmentRoute, RemoteSessionsContext } from "./types.js";
import { isSameRemoteTarget } from "./targets.js";

export function createRemoteConnectionHandlers(
  ctx: RemoteSessionsContext,
  deps: {
    attachRendererPort: (
      win: BrowserWindow,
      route: RemoteAttachmentRoute,
      reason: string,
    ) => Promise<void>;
    waitForJoinedRouteReady: (
      route: RemoteAttachmentRoute,
      descriptor: WindowHostRemoteWorkspaceDescriptor,
    ) => Promise<void>;
    emitConnectionLog: (
      win: BrowserWindow,
      payload: {
        requestId?: string;
        sessionId?: string;
        level: "info" | "warn" | "error";
        message: string;
      },
    ) => void;
    reportRemoteRouteConnected: (route: RemoteAttachmentRoute) => void;
    executeProviderProvisioning: (
      child: ElectronUtilityProcess,
      remoteSessionId: string,
      environmentKey: string,
      trigger: ProviderProvisioningTrigger,
    ) => Promise<void>;
  },
) {
  function handleConnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const key = `${webContentsId}\0${requestId}`;
    const pending = ctx.state.pendingByRequestKey.get(key);
    if (!pending) {
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    ctx.state.pendingByRequestKey.delete(key);
    const existingRoute = ctx.state.routesBySessionId.get(descriptor.remoteSessionId);
    if (existingRoute) {
      if (
        existingRoute.webContentsId !== webContentsId ||
        existingRoute.attachmentState !== "attachable" ||
        !isSameRemoteTarget(existingRoute.descriptor.target, descriptor.target)
      ) {
        // Bug 原因：Host join 合法复用 logical sessionId；只有同窗口、同 target 才能共享
        // Main route。冲突时拒绝新请求，但不能 dispose 仍被旧 owner 使用的 session。
        pending.reject(
          new Error(
            `远程 workspace join 与已有 route 不匹配，sessionId=${descriptor.remoteSessionId}`,
          ),
        );
        return;
      }
      if (existingRoute.mobileOnly) {
        existingRoute.mobileOnly = false;
        // 手机 scope 没有 renderer ready；桌面采用时重新走唯一的连接提交点。
        existingRoute.connectFinalized = false;
        existingRoute.remoteUsageTelemetryEligible ||= pending.remoteUsageTelemetryEligible;
        void (existingRoute.providerProvisioningReady ?? Promise.resolve())
          .then(() => deps.attachRendererPort(pending.win, existingRoute, "desktop-join"))
          .then(
            () => pending.resolve(descriptor.remoteSessionId),
            (error: unknown) =>
              pending.reject(error instanceof Error ? error : new Error(String(error))),
          );
        return;
      }
      // Bug 原因：显式 conversation bind 与 Source 自动恢复可能 join 到同一个 Host
      // logical session。过去这里覆盖 routesBySessionId，旧 candidate 的 ready ACK 会被
      // 判 stale，遗留 timer 最终又回收健康 attachment。重复 connect 只等待唯一 route ready。
      const promoteTelemetryEligibility =
        !existingRoute.remoteUsageTelemetryEligible && pending.remoteUsageTelemetryEligible;
      existingRoute.remoteUsageTelemetryEligible ||= pending.remoteUsageTelemetryEligible;
      if (promoteTelemetryEligibility && existingRoute.connectFinalized) {
        deps.reportRemoteRouteConnected(existingRoute);
      }
      void deps.waitForJoinedRouteReady(existingRoute, descriptor).then(
        () => {
          pending.onConnected?.(descriptor);
          pending.resolve(descriptor.remoteSessionId);
        },
        (error: unknown) =>
          pending.reject(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    const route: RemoteAttachmentRoute = {
      webContentsId,
      descriptor,
      attachmentState: "attachable",
      connectedAtMonotonicMs: ctx.monotonicNowMs(),
      connectFinalized: false,
      remoteUsageTelemetryEligible: pending.remoteUsageTelemetryEligible,
    };
    ctx.state.routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = ctx.providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        deps.executeProviderProvisioning(
          child,
          descriptor.remoteSessionId,
          environmentKey,
          trigger,
        ),
    );
    route.providerProvisioningDispose = registration.dispose;
    void registration.initialSync
      .then(() => deps.attachRendererPort(pending.win, route, "connect"))
      .then(() => {
        deps.emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已连接`,
        });
        pending.onConnected?.(descriptor);
        pending.resolve(descriptor.remoteSessionId);
      })
      .catch((error: unknown) => {
        route.providerProvisioningDispose?.();
        ctx.state.routesBySessionId.delete(descriptor.remoteSessionId);
        child.postMessage({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          requestId: randomUUID(),
          remoteSessionId: descriptor.remoteSessionId,
        });
        deps.emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  function handleReconnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    previousRemoteSessionId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const route = ctx.state.routesBySessionId.get(previousRemoteSessionId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (!route || route.webContentsId !== webContentsId || !win) {
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    ctx.state.routesBySessionId.delete(previousRemoteSessionId);
    route.descriptor = descriptor;
    route.attachmentState = "attachable";
    ctx.state.routesBySessionId.set(descriptor.remoteSessionId, route);
    // Bug 原因：Provisioning lane 以 remoteSessionId 登记，execute 闭包也绑定旧 sessionId；
    // Source 重连换代后若不重新登记，后续下发都会命中 Host 已失效的旧 session，远端再也收不到配置。
    // 先摘掉旧登记再登记新 session，让 lane 按 Environment 重新上线整份重下发（离线期间的本机
    // 配置变更由此补齐）；重连不是首连发布屏障，失败只记录 warning，不拆除已恢复的 Workspace。
    route.providerProvisioningDispose?.();
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = ctx.providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        deps.executeProviderProvisioning(
          child,
          descriptor.remoteSessionId,
          environmentKey,
          trigger,
        ),
    );
    route.providerProvisioningDispose = registration.dispose;
    registration.initialSync.catch((error: unknown) => {
      ctx.options.logger.warn(
        "[provider-provisioning] Environment resync after reconnect did not apply",
        {
          environmentKey,
          previousRemoteSessionId,
          remoteSessionId: descriptor.remoteSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
    void (
      route.mobileOnly
        ? Promise.resolve()
        : deps.attachRendererPort(win, route, "source-server-reconnected")
    )
      .then(() => {
        if (!descriptor.workspacePath || !descriptor.workspaceIdentity) return;
        // Bug 原因：手机 bridge 换代曾被 await 在 Desktop 关键路径上，手机 attachment
        // 失败会落入外层 catch 并 dispose 已就绪的 Desktop session。Desktop continuous
        // 先完成换代；手机 replayable 恢复是隔离的旁路，失败只降级手机。
        if (!route.mobileOnly)
          win.webContents.send(PlatformChannels.RemoteSessionReconnected, {
            previousSessionId: previousRemoteSessionId,
            sessionId: descriptor.remoteSessionId,
            workspacePath: descriptor.workspacePath,
            workspaceIdentity: descriptor.workspaceIdentity,
          });
        deps.emitConnectionLog(win, {
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已自动重连`,
        });
        void ctx.options.webRemoteControlManagerRef.current
          ?.replaceRemoteSession?.({
            previousSessionId: previousRemoteSessionId,
            sessionId: descriptor.remoteSessionId,
            workspacePath: descriptor.workspacePath,
            workspaceIdentity: descriptor.workspaceIdentity,
          })
          .catch((error: unknown) => {
            ctx.options.logger.warn("[window-host-remote] mobile bridge recovery failed", {
              previousRemoteSessionId,
              remoteSessionId: descriptor.remoteSessionId,
              error,
            });
          });
      })
      .catch((error: unknown) => {
        route.providerProvisioningDispose?.();
        ctx.state.routesBySessionId.delete(descriptor.remoteSessionId);
        child.postMessage({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          requestId: randomUUID(),
          remoteSessionId: descriptor.remoteSessionId,
        });
        ctx.options.logger.warn("[window-host-remote] Source reconnect attachment failed", {
          previousRemoteSessionId,
          remoteSessionId: descriptor.remoteSessionId,
          error,
        });
      });
  }

  return { handleConnected, handleReconnected };
}
