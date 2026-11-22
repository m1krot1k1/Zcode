import type { RemoteDisconnectReason } from "../desktopRemoteUsageArmsTelemetry.js";
import type { RemoteAttachmentRoute, RemoteSessionsContext } from "./types.js";

export function createRemoteUsageTelemetry(ctx: RemoteSessionsContext) {
  function reportRemoteRouteConnected(route: RemoteAttachmentRoute): void {
    try {
      ctx.options.reportRemoteConnectionStateChanged?.({
        rendererId: route.webContentsId,
        remoteKind: route.descriptor.target.kind,
        transition: "connected",
      });
    } catch (error) {
      ctx.options.logger.warn("[remote-usage-arms] connected reporter failed", {
        error,
      });
    }
  }

  function retireActiveRoute(
    route: RemoteAttachmentRoute,
    reason: RemoteDisconnectReason,
    mutate: () => void,
  ): void {
    const wasActive =
      route.remoteUsageTelemetryEligible &&
      route.attachmentState === "attachable" &&
      route.connectFinalized;
    mutate();
    if (!wasActive) return;

    const common = {
      rendererId: route.webContentsId,
      remoteKind: route.descriptor.target.kind,
    };
    try {
      ctx.options.reportRemoteConnectionStateChanged?.({
        ...common,
        transition: reason,
      });
    } catch (error) {
      // telemetry 是连接生命周期的旁路，不能因 reporter 异常回滚 route 退出状态。
      ctx.options.logger.warn("[remote-usage-arms] disconnect gauge reporter failed", { error });
    }
    try {
      ctx.options.reportRemoteDisconnect?.({
        ...common,
        disconnectReason: reason,
        durationMs: Math.max(0, Math.round(ctx.monotonicNowMs() - route.connectedAtMonotonicMs)),
      });
    } catch (error) {
      ctx.options.logger.warn("[remote-usage-arms] disconnect reporter failed", {
        error,
      });
    }
  }

  return { reportRemoteRouteConnected, retireActiveRoute };
}
