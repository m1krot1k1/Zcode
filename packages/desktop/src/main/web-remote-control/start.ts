import { buildWebRemoteControlExternalQrUrl } from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type { WebRemoteControlContext, WebRemoteControlStartResult } from "@zcode/shared";
import {
  WebRemoteControlDeviceTransport,
  createWebRemoteControlV2Http,
  type WebRemoteControlDeviceTransportOptions,
} from "#src/main/web-remote-relay/index.js";

import { createFailure } from "./helpers.js";
import type { WebRemoteControlManagerServices } from "./services.js";
import {
  EXTERNAL_RELAY_QR_READY_TIMEOUT_MS,
  type WebRemoteControlDeviceTransportLike,
  type WebRemoteControlManagerDependencies,
  type WebRemoteControlManagerState,
  type WindowControlLifecycle,
  type WindowControlRuntime,
} from "./types.js";

export interface StartServices {
  start(windowId: number, context: WebRemoteControlContext): Promise<WebRemoteControlStartResult>;
}

export function createStartServices(config: {
  state: WebRemoteControlManagerState;
  dependencies: WebRemoteControlManagerDependencies;
  services: WebRemoteControlManagerServices;
}): StartServices {
  const { state, dependencies, services } = config;

  function createTransport(
    options: WebRemoteControlDeviceTransportOptions,
  ): WebRemoteControlDeviceTransportLike {
    return dependencies.createDeviceTransport
      ? dependencies.createDeviceTransport(options)
      : new WebRemoteControlDeviceTransport(options);
  }

  function createQrUrl(deviceSid: string, mobileRemoteControlUrl: string): string {
    return buildWebRemoteControlExternalQrUrl({
      baseUrl: mobileRemoteControlUrl,
      deviceSid,
      deviceMid: dependencies.deviceMid,
      deviceName: dependencies.deviceName,
      appVersion: dependencies.appVersion,
    });
  }

  async function start(
    windowId: number,
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStartResult> {
    services.clearStartAuthorizationsForWindow(windowId);
    dependencies.featureGate.assertEnabled();
    state.startupRestoreClaimed = true;
    const stopped = services.stopWindowRuntime(windowId, "restart");
    const controller = new AbortController();
    const lifecycle: WindowControlLifecycle = { controller };
    state.windowLifecycles.set(windowId, lifecycle);
    const signal = controller.signal;
    const assertActive = () => signal.throwIfAborted();
    try {
      await stopped;
      const readAuthContext = async () => {
        for (;;) {
          const revision = state.authNotificationRevision;
          const endpointUrls = await dependencies.getEndpointUrls?.();
          const login = await dependencies.getLogin();
          assertActive();
          // 首次读取尚未绑定身份时也可能发生换号，不能把旧读取绑定到新登录之后。
          if (revision === state.authNotificationRevision) return { endpointUrls, login };
        }
      };
      const { endpointUrls, login } = await readAuthContext();
      const relayWsUrl = endpointUrls?.relayWsUrl ?? dependencies.relayWsUrl;
      const mobileRemoteControlUrl = endpointUrls?.remoteUrl ?? dependencies.mobileRemoteControlUrl;
      const endpointOrigin = new URL(endpointUrls?.origin ?? mobileRemoteControlUrl).origin;
      assertActive();
      if (!login?.jwt || !login.userId) {
        services.requireAuthentication(windowId);
        throw new WebRemoteControlV2ConnectionError("auth-required");
      }
      lifecycle.identity = { userId: login.userId, endpointOrigin };
      state.authRequiredWindows.delete(windowId);
      await dependencies.deviceStorage.clearLegacy();
      assertActive();
      const http = createWebRemoteControlV2Http(endpointOrigin);
      const currentLogin = async () => {
        const current = await dependencies.getLogin();
        const endpoint = await dependencies.getEndpointUrls?.();
        assertActive();
        if (
          !current?.jwt ||
          current.userId !== login.userId ||
          (endpoint && endpoint.origin !== endpointOrigin)
        ) {
          throw new WebRemoteControlV2ConnectionError("auth-required");
        }
        return current;
      };
      const register = (force: boolean, transportSignal: AbortSignal) => {
        const registrationSignal = AbortSignal.any([signal, transportSignal]);
        // 同一 manager 串行读取/更新身份，避免多窗口首次启动各自覆盖持久化 SID。
        const operation = state.registrationQueue.then(async () => {
          const current = await currentLogin();
          const stored = await dependencies.deviceStorage.load();
          registrationSignal.throwIfAborted();
          if (
            !force &&
            stored?.userId === current.userId &&
            stored.endpointOrigin === endpointOrigin
          )
            return stored.deviceSid;
          if (stored?.endpointOrigin === endpointOrigin) {
            try {
              await http.delete(stored.deviceSid, current.jwt, registrationSignal);
            } catch {
              dependencies.logger.warn("[web-remote-control] V2 old device cleanup failed");
            }
          }
          registrationSignal.throwIfAborted();
          const deviceSid = await http.register(
            dependencies.deviceMid,
            current.jwt,
            registrationSignal,
          );
          await currentLogin();
          registrationSignal.throwIfAborted();
          try {
            await dependencies.deviceStorage.save({
              deviceSid,
              userId: current.userId,
              endpointOrigin,
            });
          } catch (error) {
            // 保存失败不是网络故障；裸错误会让 transport 每次退避都注册新 SID，留下孤儿设备。
            // 新 SID 尚未建连，先尽力撤销远端注册，再以不可重试错误结束本次启动。
            dependencies.logger.error(
              "[web-remote-control] V2 device identity persistence failed",
              error,
            );
            try {
              await http.delete(deviceSid, current.jwt, registrationSignal);
            } catch {
              dependencies.logger.warn("[web-remote-control] V2 new device cleanup failed");
            }
            throw new WebRemoteControlV2ConnectionError("relay-unavailable");
          }
          registrationSignal.throwIfAborted();
          dependencies.logger.info("[web-remote-control] V2 device registered");
          return deviceSid;
        });
        state.registrationQueue = operation.catch(() => {});
        return operation;
      };
      let deviceSid = "";
      let runtime: WindowControlRuntime;
      let readySettled = false;
      let persistEnabled: Promise<void> | undefined;
      const readyPromise = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          if (readySettled) return;
          readySettled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", aborted);
          if (error) reject(error);
          else resolve();
        };
        const aborted = () => finish(new Error("Web remote control start cancelled"));
        signal.addEventListener("abort", aborted, { once: true });
        const timeout = setTimeout(
          () =>
            finish(new Error("External relay device did not reach QR-ready state before timeout.")),
          EXTERNAL_RELAY_QR_READY_TIMEOUT_MS,
        );
        const transport = createTransport({
          relayWsUrl,
          deviceMid: dependencies.deviceMid,
          meta: {
            platform: process.platform,
            version: dependencies.appVersion,
            name: dependencies.deviceName,
          },
          getToken: async (transportSignal) => {
            const current = await currentLogin();
            const token = await http.token(current.jwt, AbortSignal.any([signal, transportSignal]));
            await currentLogin();
            dependencies.logger.info("[web-remote-control] V2 device token acquired");
            return token;
          },
          resolveDeviceSid: async (transportSignal, forceRegistration) => {
            deviceSid = await register(forceRegistration, transportSignal);
            if (state.runtimes.get(windowId) === runtime) {
              runtime.deviceSid = deviceSid;
              runtime.qrUrl = runtime.connectUrl = "";
            }
            return deviceSid;
          },
          logger: dependencies.logger,
          onStateChange: (transportState) => {
            if (state.runtimes.get(windowId) !== runtime) return;
            if (transportState === "waiting_terminal" || transportState === "paired") {
              runtime.qrUrl = runtime.connectUrl = createQrUrl(deviceSid, mobileRemoteControlUrl);
            }
            services.mapTransportState(runtime, transportState);
            if (transportState === "waiting_terminal" || transportState === "paired") {
              // 首个调用超时不撤销后台恢复；首次真正 ready 时仍须保存启用意图。
              persistEnabled ??= dependencies.startupRestoreStorageProvider.save({
                workspacePath: context.workspacePath,
                workspaceIdentity: context.workspaceIdentity,
                initialTaskId: context.initialTaskId,
              });
              void persistEnabled.then(
                () => finish(),
                (error: unknown) => {
                  finish(error instanceof Error ? error : new Error(String(error)));
                  if (state.runtimes.get(windowId) === runtime)
                    void services.stopWindowRuntime(windowId, "startup-restore-persist-failed");
                },
              );
            }
            if (transportState === "kicked") finish(new Error("session-conflict"));
          },
          onPayload: (payload) => services.routePayload(runtime, payload),
          onRawTransportPayload: (payload) => services.routeRawTransportCandidate(runtime, payload),
          onRawTransportFault: (reasonCode) =>
            runtime.currentBridge?.relayProtocol?.markDegraded(reasonCode),
          onSendReady: (event) => {
            services.flushPendingOutboundPayloads(runtime);
            const isFirstSendReadyForPairing = !runtime.hasObservedSendReadyForPairing;
            runtime.hasObservedSendReadyForPairing = true;
            if (event.kind === "reconnected-socket" || isFirstSendReadyForPairing) {
              // Bug 原因：same-socket 心跳 ACK 每约 10 秒都会触发 send-ready；若每次都补发
              // degraded latch，Web 会反复重建同一恢复 generation，破坏 1s/2s/5s 有界退避。
              services.sendPendingBridgeInvalidation(runtime);
              services.requestMobileTaskView(runtime);
            }
            const relayProtocol = runtime.currentBridge?.relayProtocol;
            // 同 bridge 未 ACK 批次仍由 adapter 独占；重连后重放，不刷新 queued age。
            if (relayProtocol && !relayProtocol.isDegraded()) relayProtocol.replayUnacknowledged();
          },
          onError: (error) => {
            if (state.runtimes.get(windowId) !== runtime) return;
            const failure = createFailure(
              error instanceof WebRemoteControlV2ConnectionError
                ? error.reason
                : "relay-unavailable",
              error.message,
            );
            finish(error);
            if (failure.reason === "auth-required") services.requireAuthentication(windowId);
            else
              services.preserveWindowRuntimeFailure(windowId, runtime, "v2-auth-failed", failure);
          },
        });
        runtime = {
          windowId,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          remoteSessionId: context.remoteSessionId,
          initialTaskId: context.initialTaskId,
          theme: context.theme,
          status: "starting",
          deviceSid,
          deviceMid: dependencies.deviceMid,
          connectUrl: "",
          qrUrl: "",
          transport,
          mobileConnected: false,
          hasEverPaired: false,
          hasObservedSendReadyForPairing: false,
          pendingOutboundPayloads: [],
        };
        state.runtimes.set(windowId, runtime);
        services.emitRuntimeStatus(runtime);
        transport.start();
      });
      await readyPromise;
      assertActive();
      return {
        status: runtime!.status === "active" ? "active" : "running",
        sessionId: deviceSid,
        windowControlSessionId: deviceSid,
        qrUrl: runtime!.qrUrl,
        connectUrl: runtime!.connectUrl,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        remoteSessionId: context.remoteSessionId,
        initialTaskId: context.initialTaskId,
      };
    } catch (error) {
      if (
        !signal.aborted &&
        error instanceof WebRemoteControlV2ConnectionError &&
        error.reason === "auth-required"
      ) {
        services.requireAuthentication(windowId);
      }
      throw error;
    }
  }

  return { start };
}
