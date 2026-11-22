import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  HostMessageTypes,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  type BindRemoteWorkspaceSessionContextResult,
  type WindowHostRemoteWorkspaceDescriptor,
  type WorkspacePurpose,
} from "@zcode/shared";
import type {
  RemoteAttachmentRoute,
  RemoteSessionsContext,
  RemoteWorkspaceSessionContext,
} from "./types.js";
import { requestKey } from "./state.js";

export function buildWorkspaceContextBindKey(params: {
  workspaceIdentity: string;
  workspacePurpose?: WorkspacePurpose;
}): string {
  return `${params.workspaceIdentity}\0${params.workspacePurpose ?? ""}`;
}

export function createRemoteWorkspaceBinds(
  ctx: RemoteSessionsContext,
  deps: {
    attachRendererPort: (
      win: BrowserWindow,
      route: RemoteAttachmentRoute,
      reason: string,
    ) => Promise<void>;
    waitForRendererAttachmentReady: (route: RemoteAttachmentRoute) => Promise<void>;
  },
) {
  function waitForJoinedRouteReady(
    route: RemoteAttachmentRoute,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): Promise<void> {
    const bindFlight = ctx.state.workspaceContextBindFlightsBySessionId.get(
      descriptor.remoteSessionId,
    );
    if (
      bindFlight &&
      descriptor.workspaceIdentity &&
      bindFlight.contextKey ===
        buildWorkspaceContextBindKey({
          workspaceIdentity: descriptor.workspaceIdentity,
          workspacePurpose: descriptor.workspacePurpose,
        })
    ) {
      return bindFlight.promise.then(() => undefined);
    }
    return deps.waitForRendererAttachmentReady(route);
  }

  async function bindRemoteWorkspaceSessionContext(
    sessionId: string,
    context: RemoteWorkspaceSessionContext,
    expectedWebContentsId?: number,
  ): Promise<BindRemoteWorkspaceSessionContextResult> {
    const route = ctx.state.routesBySessionId.get(sessionId);
    if (!route) {
      throw new Error(`未找到远程 workspace session，sessionId=${sessionId}`);
    }
    if (expectedWebContentsId != null && route.webContentsId !== expectedWebContentsId) {
      throw new Error(`远程 workspace session 不属于当前窗口，sessionId=${sessionId}`);
    }
    const requestedWorkspaceIdentity =
      context.workspaceIdentity?.trim() ||
      buildRemoteWorkspaceIdentity(context.workspacePath, route.descriptor.target);
    const workspaceIdentity = route.descriptor.sourceServerId
      ? buildServerRemoteWorkspaceIdentity({
          serverId: route.descriptor.sourceServerId,
          workspacePath: context.workspacePath,
        })
      : requestedWorkspaceIdentity;
    const contextKey = buildWorkspaceContextBindKey({
      workspaceIdentity,
      workspacePurpose: context.workspacePurpose,
    });
    const existingFlight = ctx.state.workspaceContextBindFlightsBySessionId.get(sessionId);
    if (existingFlight) {
      if (existingFlight.contextKey !== contextKey) {
        throw new Error(`远程 workspace session 正在绑定其它 context，sessionId=${sessionId}`);
      }
      return await existingFlight.promise;
    }
    const requestedWorkspacePurpose = context.workspacePurpose ?? route.descriptor.workspacePurpose;
    if (
      route.descriptor.workspacePath === context.workspacePath &&
      route.descriptor.workspaceIdentity === workspaceIdentity &&
      (route.descriptor.workspacePurpose ?? "project") === (requestedWorkspacePurpose ?? "project")
    ) {
      // Bug 原因：join caller 在首个 bind 完成后会再次提交同一 context。重复换代
      // attachment 会让并行初始化使用的 services 失效；已绑定 context 只等待当前 candidate ready。
      await deps.waitForRendererAttachmentReady(route);
      return createBoundRemoteWorkspaceContextResult(route);
    }
    const promise = performRemoteWorkspaceSessionContextBind({
      route,
      sessionId,
      context,
      requestedWorkspaceIdentity,
      workspaceIdentity,
    });
    ctx.state.workspaceContextBindFlightsBySessionId.set(sessionId, {
      contextKey,
      promise,
    });
    try {
      return await promise;
    } finally {
      const current = ctx.state.workspaceContextBindFlightsBySessionId.get(sessionId);
      if (current?.promise === promise) {
        ctx.state.workspaceContextBindFlightsBySessionId.delete(sessionId);
      }
    }
  }

  async function performRemoteWorkspaceSessionContextBind(params: {
    route: RemoteAttachmentRoute;
    sessionId: string;
    context: RemoteWorkspaceSessionContext;
    requestedWorkspaceIdentity: string;
    workspaceIdentity: string;
  }): Promise<BindRemoteWorkspaceSessionContextResult> {
    const { route, sessionId, context, requestedWorkspaceIdentity, workspaceIdentity } = params;
    const child = ctx.options.windowHostProcessMap.get(route.webContentsId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === route.webContentsId,
    );
    if (!child || !win) {
      throw new Error(`未找到远程 workspace 所属窗口 Host，sessionId=${sessionId}`);
    }
    const requestId = randomUUID();
    const bindRequestKey = requestKey(route.webContentsId, requestId);
    const bindReady = new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = ctx.state.pendingWorkspaceBindsByRequestKey.get(bindRequestKey);
        if (!pending) return;
        ctx.state.pendingWorkspaceBindsByRequestKey.delete(bindRequestKey);
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceBind,
          requestId,
          remoteSessionId: sessionId,
        });
        pending.reject(
          Object.assign(
            new Error(
              `workspace bind ACK 超时，sessionId=${sessionId}, timeoutMs=${ctx.workspaceBindReadyTimeoutMs}`,
            ),
            {
              // Bug 原因：超时会主动发 CancelRemoteWorkspaceBind，但本地先拒绝了无 code 的
              // Error，Renderer 永远走不到已登记的 bindCanceled i18n 分支。
              code: REMOTE_BIND_CANCELED_ERROR_CODE,
              retryable: true,
            },
          ),
        );
      }, ctx.workspaceBindReadyTimeoutMs);
      ctx.state.pendingWorkspaceBindsByRequestKey.set(bindRequestKey, {
        resolve,
        reject,
        timeout,
      });
    });
    child.postMessage({
      type: HostMessageTypes.BindRemoteWorkspaceContext,
      requestId,
      remoteSessionId: sessionId,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      ...(context.workspacePurpose ? { workspacePurpose: context.workspacePurpose } : {}),
      ...(requestedWorkspaceIdentity !== workspaceIdentity
        ? { legacyRouteHint: requestedWorkspaceIdentity }
        : {}),
    });
    let previousWorkspaceIdentity: string | undefined;
    try {
      previousWorkspaceIdentity = await bindReady;
    } catch (error) {
      const pending = ctx.state.pendingWorkspaceBindsByRequestKey.get(bindRequestKey);
      if (pending) clearTimeout(pending.timeout);
      ctx.state.pendingWorkspaceBindsByRequestKey.delete(bindRequestKey);
      throw error;
    }
    route.descriptor = {
      ...route.descriptor,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      ...(context.workspacePurpose ? { workspacePurpose: context.workspacePurpose } : {}),
      generation: route.descriptor.generation + 1,
    };
    // 同一 parentPort 上 Bind 先于 Attach 处理；IPC 只在 renderer 注册新 port 后返回。
    await deps.attachRendererPort(win, route, "workspace-context-bound");
    return createBoundRemoteWorkspaceContextResult(route, previousWorkspaceIdentity);
  }

  function createBoundRemoteWorkspaceContextResult(
    route: RemoteAttachmentRoute,
    previousWorkspaceIdentity?: string,
  ): BindRemoteWorkspaceSessionContextResult {
    return {
      ...(route.descriptor.sourceServerId
        ? { sourceServerId: route.descriptor.sourceServerId }
        : {}),
      remoteSessionId: route.descriptor.remoteSessionId,
      workspacePath: route.descriptor.workspacePath!,
      workspaceIdentity: route.descriptor.workspaceIdentity!,
      ...(route.descriptor.workspacePurpose
        ? { workspacePurpose: route.descriptor.workspacePurpose }
        : {}),
      ...(previousWorkspaceIdentity ? { previousWorkspaceIdentity } : {}),
    };
  }

  return { bindRemoteWorkspaceSessionContext, waitForJoinedRouteReady };
}
