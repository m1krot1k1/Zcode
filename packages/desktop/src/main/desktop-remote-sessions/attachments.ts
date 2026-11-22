import { randomUUID } from "node:crypto";
import { MessageChannelMain } from "electron";
import type {
  BrowserWindow,
  MessagePortMain,
  UtilityProcess as ElectronUtilityProcess,
} from "electron";
import {
  HostMessageTypes,
  InternalChannels,
  PlatformChannels,
  sanitizeRemoteConnectionLog,
  scopedServicePortPayloadSchema,
} from "@zcode/shared";
import type { RemoteAttachmentRoute, RemoteSessionsContext } from "./types.js";

export function createAttachmentBridge(
  ctx: RemoteSessionsContext,
  deps: {
    reportRemoteRouteConnected: (route: RemoteAttachmentRoute) => void;
    ensureHostListener: (child: ElectronUtilityProcess, webContentsId: number) => void;
  },
) {
  function getWindowHost(win: BrowserWindow): ElectronUtilityProcess {
    const child = ctx.options.windowHostProcessMap.get(win.webContents.id);
    if (!child || child.pid == null) {
      throw new Error(`未找到窗口 Local Host，windowId=${win.webContents.id}`);
    }
    deps.ensureHostListener(child, win.webContents.id);
    return child;
  }

  function createMessageChannel() {
    return ctx.options.createMessageChannel?.() ?? new MessageChannelMain();
  }

  function emitConnectionLog(
    win: BrowserWindow,
    payload: {
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      message: string;
    },
  ): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(PlatformChannels.RemoteConnectionLog, {
      label: `window-host-${win.webContents.id}`,
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      level: payload.level,
      source: "window-host-controller",
      message: sanitizeRemoteConnectionLog(payload.message),
      // Bugfix: R1 改造曾把完整 ISO 时间直接交给连接日志 UI，长时间戳会挤压 flex 日志列并换行。
      // 这里恢复既有的紧凑时钟展示契约，Host 的 requestId 路由和原始日志内容保持不变。
      timestamp: new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  }

  function detachServicePort(
    child: ElectronUtilityProcess,
    attachmentId: string,
    reason: string,
  ): void {
    try {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId,
      });
    } catch (error) {
      // 候选 port 的回收属于幂等清理，不能因 Host 已退出导致 ready promise 再次悬空。
      ctx.options.logger.warn("[window-host-remote] detach renderer attachment failed", {
        attachmentId,
        reason,
        error,
      });
    }
  }

  function closeMessagePort(port: MessagePortMain | undefined): void {
    if (!port) return;
    try {
      port.close();
    } catch {
      // MessagePort 关闭失败不影响 Host 内 attachment 的 close/dispose 幂等收口。
    }
  }

  async function attachRendererPort(
    win: BrowserWindow,
    route: RemoteAttachmentRoute,
    reason: string,
  ): Promise<void> {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法 attachment 远程 workspace");
    }
    if (
      ctx.state.routesBySessionId.get(route.descriptor.remoteSessionId) !== route ||
      route.attachmentState !== "attachable"
    )
      throw new Error("远程 workspace scope 已失效，不能创建 attachment");
    const child = getWindowHost(win);
    const descriptor = route.descriptor;
    if (!descriptor.workspacePath || !descriptor.workspaceIdentity) {
      throw new Error(
        `远程 descriptor 缺少 workspace scope，sessionId=${descriptor.remoteSessionId}`,
      );
    }
    const attachmentId = randomUUID();
    const rendererPayload = scopedServicePortPayloadSchema.parse({
      attachmentId,
      sessionId: descriptor.remoteSessionId,
      target: descriptor.target,
      ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
      workspacePath: descriptor.workspacePath,
      workspaceIdentity: descriptor.workspaceIdentity,
      ...(descriptor.workspacePurpose ? { workspacePurpose: descriptor.workspacePurpose } : {}),
    });
    const { port1, port2 } = createMessageChannel();
    const previousAttachmentId = route.rendererAttachmentId;
    const superseded = route.pendingRendererAttachment;
    if (superseded) {
      clearTimeout(superseded.timeout);
      route.pendingRendererAttachment = undefined;
      detachServicePort(child, superseded.attachmentId, "superseded");
      superseded.reject(
        new Error(`renderer attachment 已被后续换代替代，sessionId=${descriptor.remoteSessionId}`),
      );
    }

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = route.pendingRendererAttachment;
        if (!pending || pending.attachmentId !== attachmentId) return;
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "ready-timeout");
        const error = new Error(
          `renderer attachment ready 超时，sessionId=${descriptor.remoteSessionId}`,
        );
        ctx.options.logger.warn("[window-host-remote] renderer attachment ready timeout", {
          sessionId: descriptor.remoteSessionId,
          attachmentId,
          reason,
        });
        reject(error);
      }, ctx.options.rendererAttachmentReadyTimeoutMs ?? 15_000);
      timeout.unref?.();
      route.pendingRendererAttachment = {
        attachmentId,
        previousAttachmentId,
        reason,
        ready: () => ready,
        timeout,
        resolve,
        reject,
      };

      try {
        child.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId,
            clientMode: "desktop-continuous",
            scope: {
              kind: "remote",
              ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: descriptor.workspacePath,
              workspaceIdentity: descriptor.workspaceIdentity,
            },
          },
          [port2],
        );
        win.webContents.postMessage(InternalChannels.ScopedServicePort, rendererPayload, [port1]);
      } catch (error) {
        clearTimeout(timeout);
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "delivery-failed");
        closeMessagePort(port1);
        closeMessagePort(port2);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return ready;
  }

  function waitForRendererAttachmentReady(route: RemoteAttachmentRoute): Promise<void> {
    if (route.pendingRendererAttachment) {
      return route.pendingRendererAttachment.ready();
    }
    if (route.rendererAttachmentId) {
      return Promise.resolve();
    }
    return Promise.reject(
      new Error(
        `远程 workspace route 尚无可用 renderer attachment，sessionId=${route.descriptor.remoteSessionId}`,
      ),
    );
  }

  function confirmRendererAttachmentReady(
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ): void {
    const route = ctx.state.routesBySessionId.get(payload.sessionId);
    const pending = route?.pendingRendererAttachment;
    if (
      !route ||
      route.webContentsId !== webContentsId ||
      !pending ||
      pending.attachmentId !== payload.attachmentId
    ) {
      ctx.options.logger.warn("[window-host-remote] ignore stale renderer attachment ready", {
        webContentsId,
        sessionId: payload.sessionId,
        attachmentId: payload.attachmentId,
      });
      return;
    }

    clearTimeout(pending.timeout);
    route.pendingRendererAttachment = undefined;
    const child = ctx.options.windowHostProcessMap.get(route.webContentsId);
    if (!child || child.pid == null) {
      pending.reject(new Error(`窗口 Local Host 已退出，sessionId=${payload.sessionId}`));
      return;
    }
    route.rendererAttachmentId = pending.attachmentId;
    if (pending.previousAttachmentId) {
      // Host generation bind 会 fail-closed 立即失效 A；Main 仍需等 renderer 注册 B
      // 后再提升 route 并做幂等清理。reload 复挂没有 generation 换代，也因此不会提前拆掉可用旧 port。
      detachServicePort(child, pending.previousAttachmentId, "candidate-promoted");
    }
    ctx.options.logger.info(
      `[window-host-remote] renderer attachment ready, sessionId=${payload.sessionId}, reason=${pending.reason}`,
    );
    if (!route.connectFinalized) {
      route.connectFinalized = true;
      if (route.remoteUsageTelemetryEligible) {
        deps.reportRemoteRouteConnected(route);
      }
    }
    pending.resolve();
  }

  return {
    getWindowHost,
    createMessageChannel,
    emitConnectionLog,
    detachServicePort,
    attachRendererPort,
    waitForRendererAttachmentReady,
    confirmRendererAttachmentReady,
  };
}
