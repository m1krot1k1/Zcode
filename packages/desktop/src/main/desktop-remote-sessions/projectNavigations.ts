import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  buildRemoteEnvironmentKey,
  HostMessageTypes,
  type HostPreparedProjectWorkspace,
  type HostProjectWorkspaceNavigationInput,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";
import type { RemoteAttachmentRoute, RemoteSessionsContext } from "./types.js";
import { requestKey } from "./state.js";

export function createProjectNavigations(
  ctx: RemoteSessionsContext,
  deps: {
    getWindowHost: (win: BrowserWindow) => ElectronUtilityProcess;
    executeProviderProvisioning: (
      child: ElectronUtilityProcess,
      remoteSessionId: string,
      environmentKey: string,
      trigger: ProviderProvisioningTrigger,
    ) => Promise<void>;
  },
) {
  function acceptPreparedProjectWorkspace(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    result: { ok: true; value: HostPreparedProjectWorkspace } | { ok: false; error: string },
  ): void {
    const key = requestKey(webContentsId, requestId);
    const pending = ctx.state.pendingProjectNavigations.get(key);
    if (!pending || pending.child !== child) return;
    if (!result.ok) {
      ctx.state.pendingProjectNavigations.delete(key);
      pending.reject(new Error(result.error));
      return;
    }
    const descriptor = result.value.remote;
    if (!descriptor) {
      ctx.state.pendingProjectNavigations.delete(key);
      pending.resolve(result.value);
      return;
    }
    const resolveWhenReady = (route: RemoteAttachmentRoute, ownsRegistration: boolean) => {
      void (route.providerProvisioningReady ?? Promise.resolve()).then(
        () => {
          // 每个 join 都必须等同一屏障，并保留自己的取消资格到成功提交。
          if (ctx.state.pendingProjectNavigations.get(key) !== pending) return;
          ctx.state.pendingProjectNavigations.delete(key);
          if (
            ctx.state.routesBySessionId.get(descriptor.remoteSessionId) !== route ||
            route.attachmentState !== "attachable"
          )
            pending.reject(new Error("项目导航 scope 已失效"));
          else pending.resolve(result.value);
        },
        (error: unknown) => {
          if (ctx.state.pendingProjectNavigations.get(key) === pending)
            ctx.state.pendingProjectNavigations.delete(key);
          if (
            ownsRegistration &&
            ctx.state.routesBySessionId.get(descriptor.remoteSessionId) === route &&
            route.mobileOnly
          ) {
            ctx.state.routesBySessionId.delete(descriptor.remoteSessionId);
            route.providerProvisioningDispose?.();
            child.postMessage({
              type: HostMessageTypes.DisposeRemoteWorkspaceSession,
              requestId: randomUUID(),
              remoteSessionId: descriptor.remoteSessionId,
            });
          }
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    };
    const existing = ctx.state.routesBySessionId.get(descriptor.remoteSessionId);
    if (existing) {
      if (
        existing.webContentsId !== webContentsId ||
        existing.attachmentState !== "attachable" ||
        existing.descriptor.workspaceIdentity !== descriptor.workspaceIdentity ||
        existing.descriptor.workspacePath !== descriptor.workspacePath
      ) {
        ctx.state.pendingProjectNavigations.delete(key);
        pending.reject(new Error("Project navigation scope conflicts with existing route"));
      } else resolveWhenReady(existing, false);
      return;
    }
    const route: RemoteAttachmentRoute = {
      webContentsId,
      descriptor,
      mobileOnly: true,
      attachmentState: "attachable",
      connectedAtMonotonicMs: ctx.monotonicNowMs(),
      connectFinalized: true,
      remoteUsageTelemetryEligible: false,
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
    route.providerProvisioningReady = registration.initialSync;
    resolveWhenReady(route, true);
  }

  function prepareProjectWorkspace(
    win: BrowserWindow,
    request: HostProjectWorkspaceNavigationInput,
    requestId: string = randomUUID(),
  ): Promise<HostPreparedProjectWorkspace> {
    if (ctx.state.appShutdownStarted || win.isDestroyed() || win.webContents.isDestroyed())
      return Promise.reject(new Error("窗口已关闭，项目导航已取消"));
    const child = deps.getWindowHost(win);
    const key = requestKey(win.webContents.id, requestId);
    if (ctx.state.pendingProjectNavigations.has(key))
      return Promise.reject(new Error("项目导航 requestId 重复"));
    return new Promise((resolve, reject) => {
      ctx.state.pendingProjectNavigations.set(key, { child, win, requestId, resolve, reject });
      try {
        child.postMessage({
          type: HostMessageTypes.PrepareProjectWorkspace,
          requestId,
          ...request,
          clientMode: "web-remote-replayable",
        });
      } catch (error) {
        ctx.state.pendingProjectNavigations.delete(key);
        reject(error);
      }
    });
  }

  return { prepareProjectWorkspace, acceptPreparedProjectWorkspace };
}
