import type {
  WebRemoteControlAuthStateChange,
  WebRemoteControlContext,
  WebRemoteControlFailure,
  WebRemoteControlStartResult,
  WebRemoteControlStatus,
  WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";

import { createBridgeServices } from "./bridge.js";
import { createFailure } from "./helpers.js";
import { createLifecycleServices } from "./lifecycle.js";
import { createOutboundServices } from "./outbound.js";
import { createPayloadRoutingServices } from "./payloadRouting.js";
import {
  applyServices,
  createEmptyServices,
  type WebRemoteControlManagerServices,
} from "./services.js";
import { createStartAuthorizationServices } from "./startAuthorization.js";
import { createStartServices } from "./start.js";
import { createStatusServices } from "./status.js";
import { createTelemetryServices } from "./telemetry.js";
import { createTransportStateServices } from "./transportState.js";
import {
  createManagerState,
  type WebRemoteControlManagerDependencies,
  type WebRemoteControlManagerState,
  type WebRemoteControlStartAuthorization,
} from "./types.js";
import { createViewServices } from "./views.js";

export function createWebRemoteControlManager(dependencies: WebRemoteControlManagerDependencies) {
  const state: WebRemoteControlManagerState = createManagerState();
  const services: WebRemoteControlManagerServices = createEmptyServices();
  const startAuthorizations = createStartAuthorizationServices(state);

  applyServices(services, createOutboundServices(dependencies.logger));
  applyServices(services, createTelemetryServices(dependencies));
  applyServices(services, createViewServices({ state, dependencies, services }));
  applyServices(services, createStatusServices({ state, dependencies, services }));
  applyServices(services, createBridgeServices({ state, dependencies, services }));
  applyServices(services, createLifecycleServices({ state, dependencies, services }));
  applyServices(services, createPayloadRoutingServices({ dependencies, services }));
  applyServices(services, createTransportStateServices({ services }));
  applyServices(services, {
    clearStartAuthorizationsForWindow: startAuthorizations.clearStartAuthorizationsForWindow,
  });
  applyServices(services, createStartServices({ state, dependencies, services }));

  async function restorePreviouslyEnabled(
    windowId: number,
    candidates: Array<WebRemoteControlContext & { label?: string }>,
  ): Promise<boolean> {
    // 修复原因：候选快照与 syncAvailableWorkspaces 共用同一份 WorkspaceTarget 表，label 是必填展示字段；
    // 生产调用方传入完整目标，只有仅携带 context 的调用需要回退到路径，不能写入缺 label 的列表项。
    state.availableWorkspacesByWindowId.set(
      windowId,
      candidates.map((candidate) => ({
        ...candidate,
        label: candidate.label ?? candidate.workspacePath,
        kind: candidate.workspaceIdentity || candidate.remoteSessionId ? "remote" : "local",
      })),
    );
    // 401/登出后只有登录通知能解除门禁，workspace 同步不能重试失效 JWT。
    if (
      state.startupRestoreClaimed ||
      state.runtimes.has(windowId) ||
      state.authRequiredWindows.has(windowId)
    )
      return false;
    const revision = state.lifecycleRevision;
    const persistedContext = await dependencies.startupRestoreStorageProvider
      .load()
      .catch((error) => {
        dependencies.logger.warn("[web-remote-control] load startup restore context failed", error);
        return undefined;
      });
    if (revision !== state.lifecycleRevision || state.startupRestoreClaimed || !persistedContext) {
      return false;
    }

    const persistedWorkspaceKey = resolveWebRemoteControlWorkspaceKey(persistedContext);
    // 磁盘读取期间可能发生 tab 关闭或远端重连，只能消费最新完整快照。
    const currentContext = state.availableWorkspacesByWindowId
      .get(windowId)
      ?.find(
        (candidate) => resolveWebRemoteControlWorkspaceKey(candidate) === persistedWorkspaceKey,
      );
    if (!currentContext || (currentContext.kind === "remote" && !currentContext.remoteSessionId)) {
      return false;
    }

    state.startupRestoreClaimed = true;
    dependencies.logger.info(
      `[web-remote-control] restoring previous enabled state window=${windowId} workspace=${currentContext.workspacePath} remoteSession=${currentContext.remoteSessionId ?? "none"}`,
    );
    try {
      await services.start(windowId, {
        workspacePath: currentContext.workspacePath,
        workspaceIdentity: currentContext.workspaceIdentity,
        remoteSessionId: currentContext.remoteSessionId,
        initialTaskId: persistedContext.initialTaskId,
      });
      return true;
    } catch (error) {
      if (revision === state.lifecycleRevision) state.startupRestoreClaimed = false;
      dependencies.logger.warn("[web-remote-control] restore previous enabled state failed", error);
      return false;
    }
  }

  return {
    authorizeStart: startAuthorizations.authorizeStart,
    async startAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      startAuthorizations.consumeStartAuthorization(windowId, context, authorization);
      return services.start(windowId, context);
    },
    async start(
      windowId: number,
      context: WebRemoteControlContext,
    ): Promise<WebRemoteControlStartResult> {
      return services.start(windowId, context);
    },

    async stop(windowId: number): Promise<void> {
      state.lifecycleRevision += 1;
      state.authNotificationRevision += 1;
      state.startupRestoreClaimed = true;
      state.authRequiredWindows.delete(windowId);
      services.clearStartAuthorizationsForWindow(windowId);
      // Bugfix: 清除自动恢复设置需要写磁盘，失败时不能阻止用户关闭当前远控连接。
      // 先释放 transport 和 attachment，再把持久化错误返回 UI，保证本次运行立即停止。
      await services.stopWindowRuntime(windowId, "manual-stop");
      await dependencies.startupRestoreStorageProvider.clear();
    },

    async suspend(windowId: number, reason: string): Promise<void> {
      services.clearStartAuthorizationsForWindow(windowId);
      await services.stopWindowRuntime(windowId, reason);
    },

    async notifyAuthStateChanged(
      windowId: number,
      change: WebRemoteControlAuthStateChange,
    ): Promise<void> {
      const revision = ++state.authNotificationRevision;
      if (change.state === "signed-in") {
        const login = await dependencies.getLogin();
        const endpointUrls = await dependencies.getEndpointUrls?.();
        if (revision !== state.authNotificationRevision) return;
        if (!login?.jwt || !login.userId) {
          services.requireAuthentication(windowId);
          return;
        }
        const endpointOrigin = new URL(endpointUrls?.origin ?? dependencies.mobileRemoteControlUrl)
          .origin;
        const staleWindows = [...state.windowLifecycles].filter(
          ([, lifecycle]) =>
            lifecycle.identity &&
            (lifecycle.identity.userId !== login.userId ||
              lifecycle.identity.endpointOrigin !== endpointOrigin),
        );
        if (staleWindows.length > 0) {
          state.lifecycleRevision += 1;
          state.startupRestoreClaimed = false;
          // 先同步撤销所有旧代再等待；已认证 socket 不会重新验证 JWT，不能只等下一次取 token。
          await Promise.all(
            staleWindows.map(([id]) => {
              services.clearStartAuthorizationsForWindow(id);
              return services.stopWindowRuntime(id, "auth-identity-changed");
            }),
          );
          if (revision !== state.authNotificationRevision) return;
        }
        for (const id of state.authRequiredWindows)
          dependencies.onStatusChanged?.(id, { status: "idle" });
        state.authRequiredWindows.clear();
        for (const [candidateWindowId, contexts] of state.availableWorkspacesByWindowId) {
          if (await restorePreviouslyEnabled(candidateWindowId, contexts)) break;
          if (revision !== state.authNotificationRevision) return;
        }
        return;
      }
      state.lifecycleRevision += 1;
      state.startupRestoreClaimed = false;
      const windowIds = new Set([
        windowId,
        ...state.availableWorkspacesByWindowId.keys(),
        ...state.runtimes.keys(),
        ...state.windowLifecycles.keys(),
      ]);
      // 先同步撤销所有窗口的启动/连接，再等待调用方；登出不能被慢 HTTP 写回复活。
      for (const id of windowIds) {
        services.clearStartAuthorizationsForWindow(id);
        services.requireAuthentication(id);
      }
    },

    restorePreviouslyEnabled,

    getStatus(windowId: number): WebRemoteControlStatus {
      if (!dependencies.featureGate.isEnabled()) {
        return {
          status: "idle",
          failure: createFailure(
            "unsupported-action",
            "Web remote control is disabled in this build.",
          ),
        };
      }

      if (state.authRequiredWindows.has(windowId)) return { status: "auth-required" };
      const runtime = state.runtimes.get(windowId);
      if (!runtime) {
        return { status: "idle" };
      }

      return services.buildRuntimeStatus(runtime);
    },

    syncAvailableWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceTarget[]): void {
      state.availableWorkspacesByWindowId.set(windowId, workspaces);
      const runtime = state.runtimes.get(windowId);
      if (!runtime) {
        return;
      }
      services.pushWorkspaceListUpdated(runtime);
    },

    async replaceRemoteSession(event: {
      previousSessionId: string;
      sessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<void> {
      for (const [windowId, runtime] of state.runtimes) {
        const bridge = runtime.currentBridge;
        const bridgeMatches =
          bridge?.remoteSessionId === event.previousSessionId &&
          bridge.workspacePath === event.workspacePath &&
          bridge.workspaceIdentity === event.workspaceIdentity;
        const runtimeMatches = runtime.remoteSessionId === event.previousSessionId;
        const availableWorkspaces = state.availableWorkspacesByWindowId.get(windowId);
        if (availableWorkspaces) {
          state.availableWorkspacesByWindowId.set(
            windowId,
            availableWorkspaces.map((workspace) =>
              workspace.remoteSessionId === event.previousSessionId &&
              workspace.workspacePath === event.workspacePath &&
              workspace.workspaceIdentity === event.workspaceIdentity
                ? { ...workspace, remoteSessionId: event.sessionId, connectionState: "connected" }
                : workspace,
            ),
          );
        }
        if (runtimeMatches) runtime.remoteSessionId = event.sessionId;
        if (!bridgeMatches || !bridge) {
          if (runtimeMatches || availableWorkspaces) services.pushWorkspaceListUpdated(runtime);
          continue;
        }

        // Bug 原因：过去 Main 复用相同 bridge identity 重建 acknowledged protocol，
        // 新协议的 seq 从 1 开始，手机 assembler 却仍等待 N+1，新帧会被当成旧 duplicate
        // 静默丢弃。这里只发非终态 degraded，由 Web 已有恢复流程以新 identity 主动重建。
        bridge.degraded = true;
        runtime.pendingBridgeInvalidation = {
          zcode_type: "bridge-degraded",
          bridgeSessionId: bridge.bridgeSessionId,
          ...(bridge.bridgeGeneration === undefined
            ? {}
            : { bridgeGeneration: bridge.bridgeGeneration }),
          ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
          reason: "source-session-replaced",
        };
        services.disposeRuntimeBridgeResources(runtime);
        services.sendPendingBridgeInvalidation(runtime);
        services.pushWorkspaceListUpdated(runtime);
      }
    },

    async disposeWindow(windowId: number): Promise<void> {
      state.lifecycleRevision += 1;
      state.authRequiredWindows.delete(windowId);
      services.clearStartAuthorizationsForWindow(windowId);
      await services.stopWindowRuntime(windowId, "window-disposed");
      state.availableWorkspacesByWindowId.delete(windowId);
      state.pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    },

    failRemoteSession(
      remoteSessionId: string,
      reason: string,
      failure: WebRemoteControlFailure,
    ): void {
      for (const [windowId, runtime] of state.runtimes) {
        const bridge = runtime.currentBridge;
        const bridgeUsesRemoteSession = bridge?.remoteSessionId === remoteSessionId;
        const runtimeUsesRemoteSession = runtime.remoteSessionId === remoteSessionId;

        if (!bridgeUsesRemoteSession && !runtimeUsesRemoteSession) {
          continue;
        }

        // Bugfix: 远程 workspace session 只是某个 workspace/bridge 的依赖，不能把它的断开升级成
        // 窗口级 Web 远控 device WS 失败；否则单个远端空闲退出会错误关闭电脑端全局远控入口。
        if (bridgeUsesRemoteSession) {
          services.disposeRuntimeBridgeResources(runtime);
          services.sendAppPayload(runtime, {
            zcode_type: "workspace-bridge-error",
            bridgeSessionId: bridge.bridgeSessionId,
            ...(bridge.bridgeGeneration !== undefined
              ? { bridgeGeneration: bridge.bridgeGeneration }
              : {}),
            ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
            requestId: `remote-session-closed:${remoteSessionId}`,
            reason: failure.reason,
            error: failure.message ?? failure.reason,
          });
        }
        if (runtimeUsesRemoteSession) {
          runtime.remoteSessionId = undefined;
        }
        // workspace 生命周期不能复活因401或KICKED终止的设备连接。
        if (runtime.status !== "error") {
          runtime.status = runtime.mobileConnected ? "active" : "running";
          runtime.error = undefined;
          runtime.failure = undefined;
        }
        state.runtimes.set(windowId, runtime);
        services.emitRuntimeStatus(runtime);
      }
      dependencies.disposeWorkspaceHostAttachmentsForRemoteSession(remoteSessionId, reason);
    },
  };
}
