import { ProviderProvisioningEnvironmentCoordinator } from "../providerProvisioningEnvironmentCoordinator.js";
import { createRemoteSessionsState } from "./state.js";
import { createRemoteUsageTelemetry } from "./telemetry.js";
import { createAttachmentBridge } from "./attachments.js";
import { createProviderProvisioningExecution } from "./provisioning.js";
import { createRemoteWorkspaceBinds } from "./binds.js";
import { createRemoteConnectionHandlers } from "./connected.js";
import { createRemoteClosedHandler } from "./closed.js";
import { createProjectNavigations } from "./projectNavigations.js";
import { createRemoteConnectionInitiator } from "./connection.js";
import { createRemoteSessionLifecycle } from "./lifecycle.js";
import { createHostResponseListener } from "./listener.js";
import type { RemoteSessionManagerOptions, RemoteSessionsContext } from "./types.js";

export function createRemoteWorkspaceSessionManager(options: RemoteSessionManagerOptions) {
  const state = createRemoteSessionsState();
  const ctx: RemoteSessionsContext = {
    options,
    state,
    providerProvisioningCoordinator:
      options.providerProvisioningCoordinator ?? new ProviderProvisioningEnvironmentCoordinator(),
    monotonicNowMs: options.monotonicNowMs ?? (() => performance.now()),
    workspaceBindReadyTimeoutMs: options.workspaceBindReadyTimeoutMs ?? 30_000,
  };

  const telemetry = createRemoteUsageTelemetry(ctx);
  // getWindowHost 首次解析窗口 Host 时才安装 listener；那时下方的 listener 已完成构造。
  const attachments = createAttachmentBridge(ctx, {
    reportRemoteRouteConnected: telemetry.reportRemoteRouteConnected,
    ensureHostListener: (child, webContentsId) => listener.ensureHostListener(child, webContentsId),
  });
  const provisioning = createProviderProvisioningExecution(ctx);
  const binds = createRemoteWorkspaceBinds(ctx, {
    attachRendererPort: attachments.attachRendererPort,
    waitForRendererAttachmentReady: attachments.waitForRendererAttachmentReady,
  });
  const connected = createRemoteConnectionHandlers(ctx, {
    attachRendererPort: attachments.attachRendererPort,
    waitForJoinedRouteReady: binds.waitForJoinedRouteReady,
    emitConnectionLog: attachments.emitConnectionLog,
    reportRemoteRouteConnected: telemetry.reportRemoteRouteConnected,
    executeProviderProvisioning: provisioning.executeProviderProvisioning,
  });
  const closed = createRemoteClosedHandler(ctx, {
    detachServicePort: attachments.detachServicePort,
    emitConnectionLog: attachments.emitConnectionLog,
    retireActiveRoute: telemetry.retireActiveRoute,
  });
  const projectNavigations = createProjectNavigations(ctx, {
    getWindowHost: attachments.getWindowHost,
    executeProviderProvisioning: provisioning.executeProviderProvisioning,
  });
  const connection = createRemoteConnectionInitiator(ctx, {
    getWindowHost: attachments.getWindowHost,
    emitConnectionLog: attachments.emitConnectionLog,
  });
  const lifecycle = createRemoteSessionLifecycle(ctx, {
    getWindowHost: attachments.getWindowHost,
    createMessageChannel: attachments.createMessageChannel,
    detachServicePort: attachments.detachServicePort,
    attachRendererPort: attachments.attachRendererPort,
    retireActiveRoute: telemetry.retireActiveRoute,
  });
  const listener = createHostResponseListener(ctx, {
    emitConnectionLog: attachments.emitConnectionLog,
    handleConnected: connected.handleConnected,
    handleReconnected: connected.handleReconnected,
    handleClosed: closed.handleClosed,
    acceptPreparedProjectWorkspace: projectNavigations.acceptPreparedProjectWorkspace,
    retireActiveRoute: telemetry.retireActiveRoute,
  });

  return {
    prepareProjectWorkspace: projectNavigations.prepareProjectWorkspace,
    createRemoteWorkspaceSession: connection.createRemoteWorkspaceSession,
    attachRemoteWorkspaceSessionHost: lifecycle.attachRemoteWorkspaceSessionHost,
    bindRemoteWorkspaceSessionContext: binds.bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady: attachments.confirmRendererAttachmentReady,
    reattachRemoteWorkspaceSessionsForWindow: lifecycle.reattachRemoteWorkspaceSessionsForWindow,
    hasRemoteWorkspaceSessionForTarget: lifecycle.hasRemoteWorkspaceSessionForTarget,
    getRemoteConnectionStats: lifecycle.getRemoteConnectionStats,
    disposeRemoteWorkspaceSession: lifecycle.disposeRemoteWorkspaceSession,
    disposeRemoteWorkspaceSessionsForWindow: lifecycle.disposeRemoteWorkspaceSessionsForWindow,
    disposeAllAndWaitForAppShutdown: lifecycle.disposeAllAndWaitForAppShutdown,
    cancelPendingRemoteWorkspaceSessionsForWindow:
      lifecycle.cancelPendingRemoteWorkspaceSessionsForWindow,
    handleWorkspaceRunningTaskCountChanged: () => {
      // Running-task 事实现在由窗口 Host registry/ControllerProjection 持有；Main 不再维护 WSL pool。
    },
  };
}
