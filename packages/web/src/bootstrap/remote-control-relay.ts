import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  connectViaProtocol,
} from "@zcode/client";
import {
  mobilePluginDiscoveryTelemetrySchema,
  sessionCreateTelemetrySchema,
  createWebRemoteControlConnectionRecoveryTimeoutFailure,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
  type RendererTelemetryEventPayload,
  type WebRemoteControlAppPayload,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceSwitchOptions,
  type WebRemoteControlWindowBootstrapResult,
} from "@zcode/shared";
import {
  setWebRemoteControlTerminalTransportState,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";

import {
  type WebRemoteControlEntry,
  WebRemoteControlTerminalTransport,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlBridgeRecoveryRunner,
  createWebRemoteControlLifecycleRecovery,
  createWebRemoteControlRelayRequestRecovery,
  createWebRemoteControlTaskViewPublisher,
  createWebRemoteControlVersionGuard,
  connectWebRemoteControlWorkspaceBridgeServices,
  getWebRemoteControlBridgeRecoveryRetryDelay,
  readKnownDevices,
  replayWebRemoteControlWorkspaceBridgeFrames,
  registerWebRemoteControlWorkspaceBridgeServices,
  type WebRemoteControlEntryConnection,
  type WebRemoteControlTerminalTransportDiagnostic,
  type WebRemoteControlWorkspaceBridgeServiceRegistration,
} from "#src/web-remote-control/index.js";
import {
  showWebRemoteControlVersionNotice,
  type WebRemoteControlConnectingDevice,
} from "#src/web-remote-control/views.js";

import {
  createWebRemoteControlRequestId,
  resolveExternalRelayWsUrl,
  seedStableWebRemoteControlClientId,
  toWebRemoteControlFailure,
} from "./relay-helpers.js";
import { createRelayRpcLayer } from "./relay-rpc.js";
import { createRelayRootView } from "./relay-root-view.js";
import { isPageUnloading, webRemoteControlStorage } from "./runtime.js";
import { renderWebRemoteControlLoading } from "./screens.js";
import { markOpenedWebRemoteControlBridgeTaskRead } from "./task-read.js";

type WebRemoteControlWorkspaceListUpdateListener = (
  result: WebRemoteControlWorkspaceListResult,
) => void;

function selectInitialWebRemoteControlWorkspace(
  snapshot: WebRemoteControlWindowBootstrapResult,
): ReturnType<typeof resolveWebRemoteControlInitialWorkspaceSelection> {
  return resolveWebRemoteControlInitialWorkspaceSelection(snapshot);
}

export async function bootstrapExternalRelayWebRemoteControl(
  connection: WebRemoteControlEntryConnection,
  entry: Pick<WebRemoteControlEntry, "chooseOtherDevice">,
): Promise<void> {
  if (connection.signal.aborted) return;
  const { params: relayParams, getToken } = connection;
  seedStableWebRemoteControlClientId(relayParams.deviceSid);
  // 平台只是展示偏好：取本机按 MID 记住的记录，扫码直连的陌生设备显示通用电脑图标。
  const connectingDevice: WebRemoteControlConnectingDevice = {
    name: relayParams.deviceName,
    platform: relayParams.deviceMid
      ? readKnownDevices(webRemoteControlStorage).get(relayParams.deviceMid)
          ?.platform
      : undefined,
  };
  // 只由入口 owner 负责取消连接并选设备；不能重启 start()，否则会自动连回最近设备。
  const deviceNavigation = {
    deviceName: relayParams.deviceName,
    devicePlatform: connectingDevice.platform,
    chooseOtherDevice: () => {
      if (!connection.signal.aborted) void entry.chooseOtherDevice();
    },
  };

  let bootstrapping = false;
  let ready = false;
  let terminated = false;
  let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let currentRecoveryId: string | undefined;
  let bridgeRecoveryRetryAttempt = 0;
  let bridgeRecoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let nextBridgeGeneration = 0;
  const checkVersionOnRecovery =
    window.location.pathname.replace(/\/+$/, "") === "/remote/v4";
  let disposeVersionNotice: (() => void) | undefined;
  const versionGuard = createWebRemoteControlVersionGuard({
    requestBootstrap: () => requestBootstrap(),
    onAccepted: (result) => {
      if (terminalTransportState === "paired")
        taskViewPublisher.seed(result.mobileTaskViewEpoch);
    },
    getUrl: () => window.location.href,
    isPageReady: () => ready,
    navigate: (url) => window.location.replace(url),
    onMismatch: (version) => {
      disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
        versionGuard.confirm(),
      );
    },
  });
  // 必须先于 Root 的全局捕获阶段快捷键注册；原生 modal 只能隔离背景元素，不能隔离 window listener。
  const blockVersionMismatchShortcuts = (event: KeyboardEvent) => {
    if (versionGuard.isBlocked()) event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", blockVersionMismatchShortcuts, true);
  const disposeVersionInputGuard = () =>
    window.removeEventListener("keydown", blockVersionMismatchShortcuts, true);
  let activeRelayProtocol:
    | ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>
    | undefined;
  let pendingRelayProtocol: typeof activeRelayProtocol;
  let pendingBridgeAbort: AbortController | undefined;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let sendMobileDiagnosticPayload:
    | ((
        payload: WebRemoteControlAppPayload & {
          zcode_type: "mobile-diagnostic";
        },
      ) => void)
    | undefined;
  const workspaceListUpdateListeners =
    new Set<WebRemoteControlWorkspaceListUpdateListener>();

  const subscribeWorkspaceListUpdates = (
    listener: WebRemoteControlWorkspaceListUpdateListener,
  ) => {
    workspaceListUpdateListeners.add(listener);
    return () => {
      workspaceListUpdateListeners.delete(listener);
    };
  };

  const normalizeWorkspaceListResult = (
    result: WebRemoteControlWorkspaceListResult,
  ): WebRemoteControlWorkspaceListResult => ({
    ...result,
    activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
    activeTaskId: result.activeTaskId ?? currentTaskId,
  });

  const applyWorkspaceListUpdated = (
    result: WebRemoteControlWorkspaceListResult,
  ) => {
    const normalized = normalizeWorkspaceListResult(result);
    for (const listener of workspaceListUpdateListeners) {
      listener(normalized);
    }
  };

  const sendMobileDiagnostic = (
    diagnostic: WebRemoteControlTerminalTransportDiagnostic,
  ) => {
    if (diagnostic.type === "socket-extensions") {
      return;
    }
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: diagnostic.type,
      timestamp: diagnostic.timestamp,
      state: diagnostic.state,
      previousState:
        "previousState" in diagnostic ? diagnostic.previousState : undefined,
      pairStatus:
        "pairStatus" in diagnostic ? diagnostic.pairStatus : undefined,
      closeCode: "code" in diagnostic ? diagnostic.code : undefined,
      closeReason: "reason" in diagnostic ? diagnostic.reason : undefined,
      wasClean: "wasClean" in diagnostic ? diagnostic.wasClean : undefined,
      wasPaired: "wasPaired" in diagnostic ? diagnostic.wasPaired : undefined,
      visibilityState: diagnostic.visibilityState,
      online: diagnostic.online,
      hiddenDurationMs: diagnostic.hiddenDurationMs,
    });
  };

  const sendMobileFailureDiagnostic = (failure: WebRemoteControlFailure) => {
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: "failure",
      timestamp: Date.now(),
      state: terminalTransportState,
      failureReason: failure.reason,
      failureMessage: failure.message,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
    });
  };

  const mapBootstrapUnknownErrorToFailure = (
    error: unknown,
  ): WebRemoteControlFailure => {
    if (error && typeof error === "object" && "reason" in error) {
      return error as WebRemoteControlFailure;
    }
    if (
      error instanceof Error &&
      error.message ===
        "Web remote control relay did not recover before timeout."
    ) {
      // Bugfix: 桌面端长时间休眠导致“假连接”时，手机端 recoverConnection 超时会先落入 unknown，
      // 随后 waiting timer 又触发 invalid-mobile，用户会看到前后冲突的两张错误页。
      // 这里把 recover 超时直接映射为 desktop-disconnected，并在失败后立即终止 transport，
      // 保证错误语义单一且稳定。
      return toWebRemoteControlFailure(
        "desktop-disconnected",
        "Desktop did not recover the Web remote control session in time.",
      );
    }
    return toWebRemoteControlFailure(
      "unexpected-error",
      error instanceof Error ? error.message : String(error),
    );
  };

  const disposeConnection = () => {
    if (terminated) return;
    terminated = true;
    if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
    bridgeRecoveryRetryTimer = undefined;
    versionGuard.dispose();
    disposeVersionInputGuard();
    disposeVersionNotice?.();
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    pendingBridgeAbort?.abort();
    pendingBridgeAbort = undefined;
    pendingRelayProtocol?.dispose();
    pendingRelayProtocol = undefined;
    requester.dispose();
    transport.dispose();
    lifecycle.dispose();
    window.removeEventListener("beforeunload", disposeConnection);
    connection.signal.removeEventListener("abort", disposeConnection);
  };

  const renderBootstrapFailure = (failure: WebRemoteControlFailure) => {
    if (terminated || versionGuard.isBlocked()) return;
    sendMobileFailureDiagnostic(failure);
    disposeConnection();
    connection.onFailure(failure);
  };

  const renderBootstrapError = (error: unknown) => {
    renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
  };

  let bootstrapPairedSession:
    | ((options?: {
        preferredWorkspaceKey?: string;
        preferredTaskId?: string;
      }) => Promise<void>)
    | undefined;

  const isLifecycleRecoveryReason = (reason: string): boolean =>
    reason === "visible" ||
    reason === "pageshow" ||
    reason === "online" ||
    reason === "resume";

  const clearBridgeRecoveryRetry = (): void => {
    if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
    bridgeRecoveryRetryTimer = undefined;
    bridgeRecoveryRetryAttempt = 0;
  };

  const scheduleBridgeRecoveryRetry = (): void => {
    if (
      bridgeRecoveryRetryTimer ||
      terminated ||
      isPageUnloading() ||
      versionGuard.isBlocked()
    )
      return;
    const delay = getWebRemoteControlBridgeRecoveryRetryDelay(
      bridgeRecoveryRetryAttempt,
    );
    if (delay === null) {
      // Bug 原因：旧逻辑把有界重试的 null 当成静默停止，导致已 degraded 的 protocol
      // 和旧 React Root 永久残留。预算耗尽必须进入既有终态边界，统一释放 bridge 资源并提供手动重试。
      renderBootstrapFailure(
        createWebRemoteControlConnectionRecoveryTimeoutFailure(
          "Mobile connection did not rebuild the workspace bridge within the retry budget.",
        ),
      );
      return;
    }
    bridgeRecoveryRetryAttempt += 1;
    bridgeRecoveryRetryTimer = setTimeout(() => {
      bridgeRecoveryRetryTimer = undefined;
      void recoverVisibleSession("bridge-rebuild-retry");
    }, delay);
  };

  const recoverVisibleSession = createWebRemoteControlBridgeRecoveryRunner(
    async (reason) => {
      if (isPageUnloading() || terminated || versionGuard.isBlocked()) {
        return;
      }
      const preferredWorkspaceKey = currentWorkspaceKey;
      const preferredTaskId = currentTaskId;
      const isBridgeRebuildRetry = reason === "bridge-rebuild-retry";
      if (!isBridgeRebuildRetry) {
        bridgeRecoveryRetryAttempt = 0;
        currentRecoveryId = createWebRemoteControlRequestId("recovery");
      } else {
        // 同一 degraded recovery flight 的 bridge open 每次换 bridge generation，但 recoveryId
        // 保持不变；这样迟到 response 仍能按 recovery 边界拒绝。
        currentRecoveryId ??= createWebRemoteControlRequestId("recovery");
      }
      const requiresBridgeRebuild =
        !isLifecycleRecoveryReason(reason) ||
        activeRelayProtocol?.isDegraded() === true;
      if (requiresBridgeRebuild) {
        activeRelayProtocol?.markDegraded();
      }
      bootstrapping = true;
      let transportRecovered = false;
      try {
        if (!import.meta.env.PROD) {
          console.info("[web-remote-control] recover terminal session", {
            reason,
            recoveryId: currentRecoveryId,
            currentWorkspaceKey: preferredWorkspaceKey,
            currentTaskId: preferredTaskId,
          });
        }
        await transport.recoverConnection();
        transportRecovered = true;
        if (
          !requiresBridgeRebuild &&
          activeRelayProtocol &&
          !activeRelayProtocol.isDegraded()
        ) {
          if (checkVersionOnRecovery) {
            try {
              await checkDesktopVersion();
            } catch (error) {
              // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
              if (!activeRelayProtocol.isDegraded()) throw error;
            }
          }
          // Bugfix: 手机短暂切后台只会暂停 JS/心跳，不代表 shared-host bridge 已经失效。
          // 原逻辑每次回前台都重建 bridge 和 Root，导致用户看到“已配对，正在加载工作区…”闪回。
          // bridge 是否需要重建以 desktop 发来的 bridge-degraded 或本地 frame gap 为准，避免只按后台时长误判。
          // 版本校验是异步的，完成后必须重新读取 bridge 状态，避免丢失并发的降级事件。
          if (!activeRelayProtocol.isDegraded()) {
            currentRecoveryId = undefined;
            return;
          }
        }
        await bootstrapPairedSession?.({
          preferredWorkspaceKey,
          preferredTaskId,
        });
        clearBridgeRecoveryRetry();
      } catch (error) {
        if (!import.meta.env.PROD) {
          console.warn(
            "[web-remote-control] terminal recover timed out, keeping current page for retry",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (
          !terminated &&
          !isPageUnloading() &&
          transportRecovered &&
          requiresBridgeRebuild
        ) {
          // Bug 原因：transport 已恢复但单次 bridge-open 失败时，旧逻辑只调用 transport
          // background recovery；旧 bridge 已 degraded，之后没有事件会再次发起 open。
          scheduleBridgeRecoveryRetry();
        } else if (!terminated && !isPageUnloading()) {
          // Bugfix: 手机长时间切到后台后，recoverConnection 可能超过单次等待窗口。
          // 这不代表桌面端离线，也不应该卸载当前 React 页面；否则输入框草稿会被错误页打断。
          // 这里保留原页面和输入状态，继续让 transport 的重连状态机自动恢复。
          transport.recoverInBackground();
        }
      } finally {
        bootstrapping = false;
      }
    },
  );

  renderWebRemoteControlLoading("connecting", connectingDevice);

  const taskViewPublisher = createWebRemoteControlTaskViewPublisher(
    (payload) =>
      !terminated &&
      !versionGuard.isBlocked() &&
      transport.sendPayload(payload),
  );
  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: resolveExternalRelayWsUrl(),
    deviceSid: relayParams.deviceSid,
    deviceMid: relayParams.deviceMid,
    appVersion: relayParams.appVersion,
    getToken,
    onRawTransportPayload: (payload) =>
      pendingRelayProtocol?.acceptPayload(payload) ||
      activeRelayProtocol?.acceptPayload(payload) ||
      false,
    onRawTransportFault: (reasonCode) => {
      pendingRelayProtocol?.markDegraded(reasonCode);
      activeRelayProtocol?.markDegraded(reasonCode);
    },
    onPayload: (payload) => {
      if (terminated) {
        return;
      }
      if (payload.zcode_type === "mobile-task-view-request") {
        taskViewPublisher.request(payload.epoch);
        return;
      }
      if (
        payload.zcode_type === "rpc-frame" ||
        payload.zcode_type === "rpc-frame-ack"
      ) {
        if (!pendingRelayProtocol?.acceptPayload(payload))
          activeRelayProtocol?.acceptPayload(payload);
        return;
      }
      if (requester.acceptPayload(payload)) {
        return;
      }
      if (payload.zcode_type === "workspace-list-updated") {
        applyWorkspaceListUpdated(payload.result);
        return;
      }
      if (payload.zcode_type === "bridge-degraded") {
        if (
          pendingRelayProtocol &&
          payload.bridgeSessionId === pendingRelayProtocol.getBridgeSessionId()
        )
          pendingRelayProtocol.markDegraded(payload.reason);
        if (
          payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()
        ) {
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "workspace-bridge-error") {
        if (
          pendingRelayProtocol &&
          payload.bridgeSessionId === pendingRelayProtocol.getBridgeSessionId()
        )
          pendingRelayProtocol.markDegraded(payload.reason);
        if (
          payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()
        ) {
          // 失效通知不对应 pending request；先关闭 workspace RPC 门禁，让既有会话
          // 显示断线横幅并保留草稿，不能让旧 services 继续被当作 ready。
          activeBridgeServiceRegistration?.dispose();
          activeBridgeServiceRegistration = undefined;
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "app-error") {
        renderBootstrapFailure(
          toWebRemoteControlFailure(payload.reason, payload.error),
        );
      }
    },
    onStateChange: (state) => {
      if (terminated || versionGuard.isBlocked()) {
        return;
      }
      taskViewPublisher.transportStateChanged(state, terminalTransportState);
      terminalTransportState = state;
      if (state !== "paired") versionGuard.invalidate();
      setWebRemoteControlTerminalTransportState(state);
      if (!ready) {
        renderWebRemoteControlLoading(state, connectingDevice);
      }
      if (state !== "paired") {
        return;
      }
      connection.onPaired();
      // 已有校验操作自行跨重连消费一次重试；配对事件不能启动另一个恢复 owner。
      if (bootstrapping && hasPendingVersionCheck()) return;
      // healthy bridge 与在途初始化都不能并发新建 bridge，但新配对仍必须检查桌面版本。
      if (
        (activeRelayProtocol && !activeRelayProtocol.isDegraded()) ||
        bootstrapping
      ) {
        if (!checkVersionOnRecovery) return;
        void checkDesktopVersion().catch((error) => {
          // 版本读取失败沿用恢复链路，不卸载已挂载页面和草稿。
          if (!terminated && !versionGuard.isBlocked()) {
            void recoverVisibleSession("visible");
            if (!import.meta.env.PROD)
              console.warn("[web-remote-control] version check failed", error);
          }
        });
        return;
      }
      if (!bootstrapPairedSession) {
        return;
      }
      bootstrapping = true;
      void bootstrapPairedSession()
        .catch((error) => {
          renderBootstrapError(error);
        })
        .finally(() => {
          bootstrapping = false;
        });
    },
    onFailure: (failure) => {
      renderBootstrapFailure(failure);
    },
    onError: (error) => {
      if (!import.meta.env.PROD) {
        console.warn(
          "[web-remote-control] terminal transport error",
          error.message,
        );
      }
    },
    onDiagnostic: (diagnostic) => {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] terminal diagnostic", diagnostic);
      }
      sendMobileDiagnostic(diagnostic);
    },
    onSendReady: () => {
      if (versionGuard.isBlocked()) return;
      taskViewPublisher.flush();
      replayWebRemoteControlWorkspaceBridgeFrames({
        activeRelayProtocol,
        pendingRelayProtocol,
      });
    },
    reloadPage: () => {
      window.location.reload();
    },
  });
  sendMobileDiagnosticPayload = (payload) => transport.sendPayload(payload);
  const reportTelemetryEvent = (event: RendererTelemetryEventPayload) => {
    // 手机只开放 session_create 和插件发现事件；管理结果仍由 Desktop Host 唯一上报。
    const parsed = sessionCreateTelemetrySchema
      .or(mobilePluginDiscoveryTelemetrySchema)
      .safeParse(event);
    if (parsed.success)
      transport.sendPayload({
        zcode_type: "telemetry-report",
        event: parsed.data,
      });
  };
  const requester = createWebRemoteControlAppPayloadRequester({
    sendPayload: (payload) =>
      !versionGuard.isBlocked() && transport.sendPayload(payload),
  });

  const requestAppPayload = requester.requestAppPayload;
  const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(
    () => transport.recoverConnection(),
  );

  const {
    requestBootstrap,
    hasPendingVersionCheck,
    checkDesktopVersion,
    requestPlatformMethod,
    listWorkspaces,
    updateMobileViewState,
    reconnectWorkspace,
  } = createRelayRpcLayer({
    requestAppPayload,
    requestWithRelayRecovery,
    versionGuard,
    transport,
    getTerminalTransportState: () => terminalTransportState,
    isTerminated: () => terminated,
    appVersion: relayParams.appVersion,
    normalizeWorkspaceList: normalizeWorkspaceListResult,
    setActiveWorkspace: (workspaceKey, taskId) => {
      currentWorkspaceKey = workspaceKey;
      currentTaskId = taskId;
    },
    getCurrentWorkspaceKey: () => currentWorkspaceKey,
    isActiveRelayDegraded: () => activeRelayProtocol?.isDegraded() === true,
    recoverVisibleSession,
  });

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions & {
      project?: Extract<
        WebRemoteControlAppPayload,
        { zcode_type: "workspace-bridge-open" }
      >["project"];
    },
  ): Promise<{
    bridge: WebRemoteControlExternalWorkspaceBridge;
    services: Awaited<ReturnType<typeof connectViaProtocol>>;
    relayProtocol: ReturnType<
      typeof createAcknowledgedWebRemoteControlRelayProtocol
    >;
  }> => {
    const bridgeSessionId = createWebRemoteControlRequestId("bridge");
    const bridgeGeneration = ++nextBridgeGeneration;
    pendingBridgeAbort?.abort();
    const bridgeAbort = new AbortController();
    pendingBridgeAbort = bridgeAbort;
    const isCurrent = () =>
      !terminated &&
      !versionGuard.isBlocked() &&
      bridgeGeneration === nextBridgeGeneration;
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        {
          zcode_type: "workspace-bridge-open",
          requestId: createWebRemoteControlRequestId("workspace-bridge"),
          bridgeSessionId,
          bridgeGeneration,
          ...(currentRecoveryId ? { recoveryId: currentRecoveryId } : {}),
          workspaceKey,
          ...(options?.taskId ? { taskId: options.taskId } : {}),
          ...(options?.taskHostId ? { taskHostId: options.taskHostId } : {}),
          ...(options?.fileTreeTaskId
            ? { fileTreeTaskId: options.fileTreeTaskId }
            : {}),
          ...(options?.project ? { project: options.project } : {}),
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-bridge-ready" }
        > =>
          payload.zcode_type === "workspace-bridge-ready" &&
          payload.bridgeSessionId === bridgeSessionId,
      ),
    );
    if (!isCurrent() || bridgeAbort.signal.aborted) {
      throw new Error(
        "Web remote control version changed before the workspace bridge was ready.",
      );
    }
    currentRecoveryId = undefined;
    const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: response.bridge.bridgeSessionId,
      bridgeGeneration: response.bridge.bridgeGeneration,
      recoveryId: response.bridge.recoveryId,
      measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
      sendFrame: (frame) => {
        if (versionGuard.isBlocked()) return false;
        const result = transport.sendPayloadResult(frame);
        if (result.kind === "oversize") {
          throw new Error("remote.rpcFrame.envelopeTooLarge");
        }
        return result.kind === "sent";
      },
    });
    relayProtocol.onDegraded((fault) => {
      if (activeRelayProtocol !== relayProtocol) return;
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] raw relay bridge degraded", {
          bridgeSessionId: relayProtocol.getBridgeSessionId(),
          reasonCode: fault.reasonCode,
        });
      }
      void recoverVisibleSession(fault.reasonCode);
    });
    const services = await connectWebRemoteControlWorkspaceBridgeServices({
      relayProtocol,
      windowProjectDirectory:
        response.bridge.kind === "remote" &&
        response.bridge.capabilities?.windowProjectDirectory === true,
      activateTransport: () => {
        // 能力 RPC 必须先有收帧目标；服务与 Root 仍等就绪后才切换。
        pendingRelayProtocol = relayProtocol;
        return () => {
          if (pendingRelayProtocol === relayProtocol)
            pendingRelayProtocol = undefined;
        };
      },
      isCurrent,
      signal: bridgeAbort.signal,
    });
    const bridgeServiceRegistration =
      registerWebRemoteControlWorkspaceBridgeServices({
        bridge: response.bridge,
        services,
      });
    // 已读写入是打开 task 的伴随动作，不等待它完成，避免慢磁盘/远程 IO 阻塞 bridge 切换。
    void markOpenedWebRemoteControlBridgeTaskRead({
      bridge: response.bridge,
      expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
      services,
    });
    const previousRelayProtocol = activeRelayProtocol;
    const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
    activeRelayProtocol = relayProtocol;
    taskViewPublisher.setBridge(response.bridge);
    if (pendingRelayProtocol === relayProtocol)
      pendingRelayProtocol = undefined;
    if (pendingBridgeAbort === bridgeAbort) pendingBridgeAbort = undefined;
    activeBridgeServiceRegistration = bridgeServiceRegistration;
    previousRelayProtocol?.dispose();
    previousBridgeServiceRegistration?.dispose();
    currentWorkspaceKey = response.bridge.workspaceKey;
    currentTaskId = response.bridge.initialTaskId;
    await updateMobileViewState(
      response.bridge.workspaceKey,
      response.bridge.initialTaskId,
    );
    if (!isCurrent())
      throw new Error("Workspace bridge request was superseded.");
    return { bridge: response.bridge, services, relayProtocol };
  };
  const relayRootView = createRelayRootView({
    getTerminalTransportState: () => terminalTransportState,
    getConnectingDevice: () => connectingDevice,
    isTerminated: () => terminated,
    isVersionBlocked: () => versionGuard.isBlocked(),
    markReady: () => {
      ready = true;
    },
    requestPlatformMethod,
    reportTelemetryEvent,
    relayParams: {
      deviceMid: relayParams.deviceMid,
      deviceSid: relayParams.deviceSid,
    },
    deviceNavigation,
    listWorkspaces,
    subscribeWorkspaceListUpdates,
    openWorkspaceBridge,
    updateMobileViewState,
    reconnectWorkspace,
    publishTaskView: (bridge, view) => {
      taskViewPublisher.update(bridge, view);
    },
    getCurrentWorkspaceKey: () => currentWorkspaceKey,
    getCurrentTaskId: () => currentTaskId,
  });

  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated || versionGuard.isBlocked()) return;
    const preferredWorkspace = options?.preferredWorkspaceKey
      ? bootstrapResult.workspaces.find(
          (workspace) =>
            resolveWebRemoteControlWorkspaceKey(workspace) ===
            options.preferredWorkspaceKey,
        )
      : undefined;
    const selectedWorkspace = preferredWorkspace
      ? {
          workspaceKey: resolveWebRemoteControlWorkspaceKey(preferredWorkspace),
          taskId: options?.preferredTaskId,
          canBridge:
            preferredWorkspace.kind !== "remote" ||
            Boolean(
              preferredWorkspace.workspaceIdentity &&
              preferredWorkspace.remoteSessionId,
            ),
        }
      : selectInitialWebRemoteControlWorkspace(bootstrapResult);
    if (!selectedWorkspace) {
      throw toWebRemoteControlFailure(
        "workspace-closed",
        "No opened desktop workspace is available for Web remote control.",
      );
    }
    if (!selectedWorkspace.canBridge) {
      // Source 断开后的 bootstrap 只确认离线，不替换当前 Root；内容与草稿仍由
      // 原会话 owner 持有。冷启动没有已加载 bridge，继续使用原 home-only 边界。
      if (
        activeRelayProtocol &&
        selectedWorkspace.workspaceKey === currentWorkspaceKey
      ) {
        activeBridgeServiceRegistration?.dispose();
        activeBridgeServiceRegistration = undefined;
        return;
      }
      await relayRootView.renderExternalRelayHomeOnlyRoot(
        selectedWorkspace.workspaceKey,
        selectedWorkspace.taskId,
      );
      return;
    }

    const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
    });
    relayRootView.renderExternalRelayRoot(result.services, result.bridge);
  };

  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: document,
    windowTarget: window,
    onSuspend: () => {
      // hidden/pagehide/freeze 后 JS 与 WebSocket 都可能暂停；先撤销查看，再关闭发送门。
      // 导航恢复位置保留，是否重建 bridge 仍由既有恢复流程决定。
      taskViewPublisher.suspend();
      transport.suspend();
    },
    onRecover: (reason) => {
      void recoverVisibleSession(reason);
    },
  });
  window.addEventListener("beforeunload", disposeConnection, { once: true });
  connection.signal.addEventListener("abort", disposeConnection, {
    once: true,
  });
  transport.start();
}
