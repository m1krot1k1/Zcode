import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  HostMessageTypes,
  type RemoteTarget,
  type WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";
import type { RemoteSessionsContext, RemoteWorkspaceConnectContext } from "./types.js";
import { requestKey } from "./state.js";

export function createRemoteConnectionInitiator(
  ctx: RemoteSessionsContext,
  deps: {
    getWindowHost: (win: BrowserWindow) => ElectronUtilityProcess;
    emitConnectionLog: (
      win: BrowserWindow,
      payload: {
        requestId?: string;
        sessionId?: string;
        level: "info" | "warn" | "error";
        message: string;
      },
    ) => void;
  },
) {
  async function createRemoteWorkspaceSession(
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: RemoteWorkspaceConnectContext,
    lifecycle?: {
      remoteUsageTelemetryEligible?: boolean;
      onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
    },
  ): Promise<string> {
    if (ctx.state.appShutdownStarted) {
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    const child = deps.getWindowHost(win);
    const resolvedTarget =
      target.kind === "wsl" && ctx.options.resolveWslTarget
        ? await ctx.options.resolveWslTarget(target)
        : target;
    if (ctx.state.appShutdownStarted) {
      // WSL identity 解析跨 await，期间退出屏障可能已清空 Main 请求关联并开始回收 Host。
      // 恢复后必须重新验证生命周期，禁止在 shutdown barrier 之后注册迟到请求。
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法创建远程工作区连接");
    }
    const resolvedRequestId = requestId ?? randomUUID();
    const key = requestKey(win.webContents.id, resolvedRequestId);
    if (ctx.state.pendingByRequestKey.has(key)) {
      throw new Error(`远程连接 requestId 重复，requestId=${resolvedRequestId}`);
    }
    deps.emitConnectionLog(win, {
      requestId: resolvedRequestId,
      level: "info",
      message: `正在通过窗口 Host 连接 ${resolvedTarget.kind} workspace`,
    });
    return new Promise<string>((resolve, reject) => {
      ctx.state.pendingByRequestKey.set(key, {
        requestId: resolvedRequestId,
        webContentsId: win.webContents.id,
        win,
        remoteUsageTelemetryEligible: lifecycle?.remoteUsageTelemetryEligible ?? false,
        onConnected: lifecycle?.onConnected,
        resolve,
        reject,
      });
      child.postMessage({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: resolvedRequestId,
        target: resolvedTarget,
        remoteAssets: ctx.options.resolveRemoteAssetDirs(),
        ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
        ...(context?.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
        ...(context?.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      });
    });
  }

  return { createRemoteWorkspaceSession };
}
