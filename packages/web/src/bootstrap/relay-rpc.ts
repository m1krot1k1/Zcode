import {
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWindowBootstrapResult,
} from "@zcode/shared";
import type { WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState } from "@zcode/ui";

import {
  collectWebRemoteControlMobileDeviceInfo,
  type createWebRemoteControlAppPayloadRequester,
  type createWebRemoteControlRelayRequestRecovery,
  type createWebRemoteControlVersionGuard,
  type WebRemoteControlTerminalTransport,
} from "#src/web-remote-control/index.js";

import { createWebRemoteControlRequestId } from "./relay-helpers.js";

type AppPayloadRequester = ReturnType<
  typeof createWebRemoteControlAppPayloadRequester
>;
type RelayRequestRecovery = ReturnType<
  typeof createWebRemoteControlRelayRequestRecovery
>;
type WebRemoteControlVersionGuard = ReturnType<
  typeof createWebRemoteControlVersionGuard
>;

export interface RelayRpcLayerDeps {
  requestAppPayload: AppPayloadRequester["requestAppPayload"];
  requestWithRelayRecovery: RelayRequestRecovery;
  versionGuard: WebRemoteControlVersionGuard;
  transport: WebRemoteControlTerminalTransport;
  getTerminalTransportState(): UiWebRemoteControlTerminalTransportState;
  isTerminated(): boolean;
  appVersion?: string;
  normalizeWorkspaceList(
    result: WebRemoteControlWorkspaceListResult,
  ): WebRemoteControlWorkspaceListResult;
  setActiveWorkspace(workspaceKey: string, taskId?: string): void;
  getCurrentWorkspaceKey(): string | undefined;
  isActiveRelayDegraded(): boolean;
  recoverVisibleSession(
    reason: string,
    stillRelevant?: () => boolean,
  ): Promise<void>;
}

export function createRelayRpcLayer(deps: RelayRpcLayerDeps) {
  const requestBootstrap =
    async (): Promise<WebRemoteControlWindowBootstrapResult> => {
      const requestId = createWebRemoteControlRequestId("bootstrap");
      const response = await deps.requestAppPayload(
        { zcode_type: "bootstrap-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "bootstrap-response" }
        > =>
          payload.zcode_type === "bootstrap-response" &&
          payload.requestId === requestId,
      );
      return response.result;
    };

  let pendingVersionCheck:
    | Promise<WebRemoteControlWindowBootstrapResult | undefined>
    | undefined;
  const checkDesktopVersion = (): Promise<
    WebRemoteControlWindowBootstrapResult | undefined
  > => {
    if (pendingVersionCheck) return pendingVersionCheck;
    const readCurrentVersion = async () => {
      let result = await deps.versionGuard.check();
      // 配对变化可能发生在旧 bootstrap 等待期间；旧响应失效后在当前连接重新读取。
      while (
        !result &&
        !deps.isTerminated() &&
        !deps.versionGuard.isBlocked() &&
        deps.getTerminalTransportState() === "paired"
      ) {
        result = await deps.versionGuard.check();
      }
      return result;
    };
    const request = deps
      .requestWithRelayRecovery(readCurrentVersion, {
        recoverTimeout: true,
      })
      .finally(() => {
        if (pendingVersionCheck === request) pendingVersionCheck = undefined;
      });
    pendingVersionCheck = request;
    return request;
  };

  const requestPlatformMethod = async <
    K extends WebRemoteControlPlatformMethod,
  >(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]> => {
    const response = await deps.requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("platform");
      const request = {
        zcode_type: "platform-request",
        requestId,
        method,
        args,
      } as WebRemoteControlPlatformRequestPayload;
      return deps.requestAppPayload(
        request,
        (
          payload,
        ): payload is Extract<
          WebRemoteControlPlatformResponsePayload,
          { zcode_type: "platform-response" }
        > =>
          payload.zcode_type === "platform-response" &&
          payload.requestId === requestId &&
          payload.method === method,
      );
    });
    const platformResponse =
      response as WebRemoteControlPlatformResponsePayload;
    if (!platformResponse.success) {
      throw new Error(platformResponse.error);
    }
    return platformResponse.result as WebRemoteControlPlatformMethodResultMap[K];
  };

  const listWorkspaces =
    async (): Promise<WebRemoteControlWorkspaceListResult> => {
      const requestWorkspaceList = async () => {
        const requestId = createWebRemoteControlRequestId("workspace-list");
        return deps.requestAppPayload(
          { zcode_type: "workspace-list-request", requestId },
          (
            payload,
          ): payload is Extract<
            WebRemoteControlAppPayload,
            { zcode_type: "workspace-list-response" }
          > =>
            payload.zcode_type === "workspace-list-response" &&
            payload.requestId === requestId,
        );
      };
      const response = await deps.requestWithRelayRecovery(
        () => requestWorkspaceList(),
        {
          // Bugfix: 外部 relay 偶发只保留手机到 desktop 的单向通路，或请求发生在重连/suspect 窗口导致未发送。
          // 首页列表是幂等请求，失败后重建 terminal socket 并重试一次，比直接展示 0 个任务更稳。
          recoverTimeout: true,
        },
      );
      return deps.normalizeWorkspaceList(response.result);
    };

  const updateMobileViewState = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    deps.setActiveWorkspace(workspaceKey, taskId);
    deps.transport.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
      },
      deviceInfo: collectWebRemoteControlMobileDeviceInfo({
        appVersion: deps.appVersion,
      }),
    });
  };

  const reconnectWorkspace = async (workspaceKey: string): Promise<void> => {
    const response = await deps.requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("workspace-reconnect");
      return deps.requestAppPayload(
        {
          zcode_type: "workspace-reconnect-request",
          requestId,
          workspaceKey,
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-reconnect-response" }
        > =>
          payload.zcode_type === "workspace-reconnect-response" &&
          payload.requestId === requestId &&
          payload.workspaceKey === workspaceKey,
        {
          // 远程重连会启动或部署 host，Docker/SSH 首连可能超过默认 10 秒；这里放宽等待，避免桌面端成功后手机端先误报超时。
          timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
        },
      );
    });
    if (!response.success) {
      throw new Error(response.error);
    }
    if (
      workspaceKey === deps.getCurrentWorkspaceKey() &&
      deps.isActiveRelayDegraded()
    ) {
      await deps.recoverVisibleSession(
        "workspace-reconnected",
        () =>
          workspaceKey === deps.getCurrentWorkspaceKey() &&
          deps.isActiveRelayDegraded() === true,
      );
    }
  };

  const hasPendingVersionCheck = (): boolean => Boolean(pendingVersionCheck);

  return {
    requestBootstrap,
    hasPendingVersionCheck,
    checkDesktopVersion,
    requestPlatformMethod,
    listWorkspaces,
    updateMobileViewState,
    reconnectWorkspace,
  };
}
