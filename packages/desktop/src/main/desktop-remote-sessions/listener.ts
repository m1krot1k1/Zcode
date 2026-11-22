import type { BrowserWindow } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  hostResponseMessageSchema,
  HostResponseTypes,
  remoteConnectionFailureLogLevel,
  sanitizeRemoteConnectionLog,
  type HostPreparedProjectWorkspace,
  type RemoteTarget,
  type WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";
import type { RemoteDisconnectReason } from "../desktopRemoteUsageArmsTelemetry.js";
import type { RemoteAttachmentRoute, RemoteSessionsContext } from "./types.js";
import { requestKey } from "./state.js";

export function createHostResponseListener(
  ctx: RemoteSessionsContext,
  deps: {
    emitConnectionLog: (
      win: BrowserWindow,
      payload: {
        requestId?: string;
        sessionId?: string;
        level: "info" | "warn" | "error";
        message: string;
      },
    ) => void;
    handleConnected: (
      child: ElectronUtilityProcess,
      webContentsId: number,
      requestId: string,
      descriptor: WindowHostRemoteWorkspaceDescriptor,
    ) => void;
    handleReconnected: (
      child: ElectronUtilityProcess,
      webContentsId: number,
      previousRemoteSessionId: string,
      descriptor: WindowHostRemoteWorkspaceDescriptor,
    ) => void;
    handleClosed: (
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
    ) => void;
    acceptPreparedProjectWorkspace: (
      child: ElectronUtilityProcess,
      webContentsId: number,
      requestId: string,
      result: { ok: true; value: HostPreparedProjectWorkspace } | { ok: false; error: string },
    ) => void;
    retireActiveRoute: (
      route: RemoteAttachmentRoute,
      reason: RemoteDisconnectReason,
      mutate: () => void,
    ) => void;
  },
) {
  function ensureHostListener(child: ElectronUtilityProcess, webContentsId: number): void {
    if (ctx.state.listenedHosts.has(child)) return;
    ctx.state.listenedHosts.add(child);
    child.on("message", (message: unknown) => {
      const parsed = hostResponseMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.type === HostResponseTypes.ProjectWorkspacePrepared) {
        deps.acceptPreparedProjectWorkspace(
          child,
          webContentsId,
          parsed.data.requestId,
          parsed.data.result,
        );
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectionLog) {
        const pending = ctx.state.pendingByRequestKey.get(
          requestKey(webContentsId, parsed.data.requestId),
        );
        if (!pending) return;
        // 多个远程连接共享 window Host，不能再从进程 label/stdout 猜日志归属；
        // Host 已带上连接 requestId，Main 只向对应发起窗口做薄转发。
        deps.emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: parsed.data.level,
          message: parsed.data.message,
        });
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningSourceChanged) {
        void ctx.providerProvisioningCoordinator.requestAll(parsed.data.trigger);
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningExecutionResult) {
        const pending = ctx.state.pendingProviderProvisioningExecutions.get(parsed.data.requestId);
        if (!pending || pending.child !== child) return;
        ctx.state.pendingProviderProvisioningExecutions.delete(parsed.data.requestId);
        const logContext = {
          environmentKey: parsed.data.environmentKey,
          trigger: pending.trigger,
          status: parsed.data.status,
          durationMs: Math.max(0, ctx.monotonicNowMs() - pending.startedAtMonotonicMs),
        };
        if (parsed.data.status !== "applied" && parsed.data.status !== "already-applied") {
          const errorCode =
            parsed.data.errorCode ??
            (parsed.data.status === "unsupported"
              ? "capability-unavailable"
              : "target-apply-failed");
          // 首次失败以前在 warning 前返回，连接面板也只剩开始日志，无法区分本地与远端故障。
          // 仅记录经过 schema 校验的阶段码；远端 error 自由文本仍不进入日志或反馈。
          ctx.options.logger.warn("[provider-provisioning] Environment sync did not apply", {
            ...logContext,
            errorCode,
          });
          if (pending.trigger === "environment-online") {
            pending.reject(
              new Error(`Provider Provisioning 首次同步失败 (${parsed.data.status}; ${errorCode})`),
            );
            return;
          }
        } else {
          ctx.options.logger.info("[provider-provisioning] Environment sync completed", logContext);
        }
        pending.resolve();
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnected) {
        deps.handleConnected(child, webContentsId, parsed.data.requestId, parsed.data.descriptor);
        return;
      }
      if (
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBound ||
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBindFailed
      ) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = ctx.state.pendingWorkspaceBindsByRequestKey.get(key);
        if (!pending) return;
        ctx.state.pendingWorkspaceBindsByRequestKey.delete(key);
        clearTimeout(pending.timeout);
        if (parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBound) {
          pending.resolve(parsed.data.previousWorkspaceIdentity);
        } else {
          const error = new Error(parsed.data.error) as Error & {
            code?: string;
            retryable?: boolean;
          };
          if (parsed.data.reasonCode) error.code = parsed.data.reasonCode;
          if (parsed.data.retryable !== undefined) error.retryable = parsed.data.retryable;
          pending.reject(error);
        }
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceReconnected) {
        deps.handleReconnected(
          child,
          webContentsId,
          parsed.data.previousRemoteSessionId,
          parsed.data.descriptor,
        );
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectFailed) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = ctx.state.pendingByRequestKey.get(key);
        if (!pending) return;
        ctx.state.pendingByRequestKey.delete(key);
        deps.emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: remoteConnectionFailureLogLevel(parsed.data.reasonCode ?? ""),
          message: sanitizeRemoteConnectionLog(parsed.data.error),
        });
        const error = new Error(parsed.data.error) as Error & {
          code?: string;
          retryable?: boolean;
          profileId?: string;
          resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
        };
        if (parsed.data.reasonCode) error.code = parsed.data.reasonCode;
        if (parsed.data.retryable !== undefined) error.retryable = parsed.data.retryable;
        if (parsed.data.profileId) error.profileId = parsed.data.profileId;
        if (parsed.data.resolvedWslTarget) error.resolvedWslTarget = parsed.data.resolvedWslTarget;
        pending.reject(error);
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceClosed) {
        deps.handleClosed(webContentsId, parsed.data);
      }
    });
    child.once("exit", () => {
      const error = new Error("窗口 Local Host 已退出");
      for (const [key, pending] of ctx.state.pendingProjectNavigations) {
        if (pending.child !== child) continue;
        ctx.state.pendingProjectNavigations.delete(key);
        pending.reject(error);
      }

      for (const [requestId, pendingExecution] of ctx.state.pendingProviderProvisioningExecutions) {
        if (pendingExecution.child !== child) continue;
        ctx.state.pendingProviderProvisioningExecutions.delete(requestId);
        pendingExecution.reject(error);
      }
      for (const [key, pending] of Array.from(ctx.state.pendingByRequestKey)) {
        if (pending.webContentsId === webContentsId) {
          ctx.state.pendingByRequestKey.delete(key);
          pending.reject(error);
        }
      }
      for (const [key, pending] of Array.from(ctx.state.pendingWorkspaceBindsByRequestKey)) {
        if (!key.startsWith(`${webContentsId}\0`)) continue;
        ctx.state.pendingWorkspaceBindsByRequestKey.delete(key);
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      for (const [sessionId, route] of Array.from(ctx.state.routesBySessionId)) {
        if (route.webContentsId !== webContentsId) continue;
        route.providerProvisioningDispose?.();
        deps.retireActiveRoute(route, "host-exit", () => {
          ctx.state.routesBySessionId.delete(sessionId);
        });
        if (route.pendingRendererAttachment) {
          clearTimeout(route.pendingRendererAttachment.timeout);
          route.pendingRendererAttachment.reject(error);
        }
      }
    });
  }

  return { ensureHostListener };
}
