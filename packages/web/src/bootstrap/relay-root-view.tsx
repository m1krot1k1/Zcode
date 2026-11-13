import type { ComponentProps } from "react";

import {
  type RendererTelemetryEventPayload,
  type WebRemoteControlAppPayload,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlMobileNavigationIntent,
  type WebRemoteControlMobileTaskView,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import {
  AppErrorBoundary,
  ensurePendingTaskDraft,
  Root,
  ZCodeIntlProvider,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import type { connectViaProtocol } from "@zcode/client";

import {
  WebRemoteControlLoadingScreen,
  type WebRemoteControlConnectingDevice,
  resolveWebRemoteControlScreenLocale,
} from "#src/web-remote-control/views.js";

import { createHomeOnlyWebRemoteControlServices } from "./home-only-services.js";
import {
  createWebPlatform,
  type WebRemoteControlPlatformProxy,
} from "./platform.js";
import { root } from "./runtime.js";
import { markCurrentWebRemoteControlBridgeTaskRead } from "./task-read.js";

type BridgeServices = Awaited<ReturnType<typeof connectViaProtocol>>;

type OpenWorkspaceBridgeOptions = WebRemoteControlWorkspaceSwitchOptions & {
  project?: Extract<
    WebRemoteControlAppPayload,
    { zcode_type: "workspace-bridge-open" }
  >["project"];
};

export interface OpenedRelayWorkspaceBridge {
  bridge: WebRemoteControlExternalWorkspaceBridge;
  services: BridgeServices;
}

export interface RelayRootViewDeps {
  getTerminalTransportState(): UiWebRemoteControlTerminalTransportState;
  getConnectingDevice(): WebRemoteControlConnectingDevice;
  isTerminated(): boolean;
  isVersionBlocked(): boolean;
  markReady(): void;
  requestPlatformMethod: WebRemoteControlPlatformProxy["requestPlatformMethod"];
  reportTelemetryEvent(event: RendererTelemetryEventPayload): void;
  relayParams: { deviceMid?: string; deviceSid: string };
  deviceNavigation: {
    deviceName?: string;
    devicePlatform?: string;
    chooseOtherDevice(): void;
  };
  listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult>;
  subscribeWorkspaceListUpdates(
    listener: (result: WebRemoteControlWorkspaceListResult) => void,
  ): () => void;
  openWorkspaceBridge(
    workspaceKey: string,
    options?: OpenWorkspaceBridgeOptions,
  ): Promise<OpenedRelayWorkspaceBridge>;
  updateMobileViewState(workspaceKey: string, taskId?: string): Promise<void>;
  reconnectWorkspace(workspaceKey: string): Promise<void>;
  publishTaskView(
    bridge: WebRemoteControlExternalWorkspaceBridge,
    view: WebRemoteControlMobileTaskView | null,
  ): void;
  getCurrentWorkspaceKey(): string | undefined;
  getCurrentTaskId(): string | undefined;
}

export function createRelayRootView(deps: RelayRootViewDeps) {
  const composerClientNamespace = `mobile:${deps.relayParams.deviceMid ?? deps.relayParams.deviceSid}`;

  const createPlatform = () =>
    createWebPlatform({
      externalWebRemoteControlProxy: {
        requestPlatformMethod: deps.requestPlatformMethod,
        reportTelemetryEvent: deps.reportTelemetryEvent,
      },
    });

  const renderExternalRelayRoot = (
    services: BridgeServices,
    bridge: WebRemoteControlExternalWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
    initialTaskDraft?: ComponentProps<typeof Root>["initialTaskDraft"],
    initialSidebarFileTreeOpen = false,
  ) => {
    if (deps.isTerminated() || deps.isVersionBlocked()) return;
    deps.markReady();
    document.title = "ZCode - Web Remote Control";
    root.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={createPlatform()}
            // Bug 原因：手机复用 Desktop Host 中已持久化的 Assistant row，但 Root 默认关闭
            // code-comment 投影，导致 replay hydration 暴露原始 directive。该开关只修正展示能力，
            // 不进入 relay、Host 或 replayable 状态。
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={
              bridge.kind === "remote" ? bridge.workspaceIdentity : undefined
            }
            initialTaskId={bridge.initialTaskId}
            initialTaskDraft={initialTaskDraft}
            composerClientNamespace={composerClientNamespace}
            initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
            initialWebRemoteControlMobileNavigationIntent={
              initialNavigationIntent
            }
            webRemoteControlTerminalTransportState={deps.getTerminalTransportState()}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen
                state="paired"
                locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                device={deps.getConnectingDevice()}
              />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              deviceNavigation: deps.deviceNavigation,
              listWorkspaces: deps.listWorkspaces,
              onWorkspaceListUpdated: deps.subscribeWorkspaceListUpdates,
              openProjectDraft,
              switchWorkspace: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await deps.openWorkspaceBridge(
                  workspaceKey,
                  options,
                );
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                  undefined,
                  Boolean(options?.fileTreeTaskId || options?.openFileManager),
                );
              },
              markTaskRead: (task: WebRemoteControlTaskTarget) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await deps.openWorkspaceBridge(
                  workspaceKey,
                  undefined,
                );
                await deps.updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                );
              },
              reconnectWorkspace: deps.reconnectWorkspace,
              updateMobileViewState: deps.updateMobileViewState,
              updateMobileTaskView: async (view) => {
                deps.publishTaskView(bridge, view);
              },
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  const openProjectDraft = async (
    request: NonNullable<ComponentProps<typeof Root>["initialTaskDraft"]>,
  ) => {
    const projectId = request.projectId ?? null;
    const pendingDraft =
      !projectId && (!request.hostId || request.hostId === "local")
        ? ensurePendingTaskDraft({
            clientNamespace: composerClientNamespace,
            hostId: "local",
            projectId: null,
          })
        : null;
    const result = await deps.openWorkspaceBridge(
      deps.getCurrentWorkspaceKey() ?? "project-navigation",
      {
        project: {
          projectId,
          ...(request.hostId ? { hostId: request.hostId } : {}),
          ...(pendingDraft
            ? {
                draftId: pendingDraft.draftId,
                reuseDraft: Boolean(pendingDraft.workspacePath),
              }
            : {}),
        },
      },
    );
    renderExternalRelayRoot(result.services, result.bridge, "chat", {
      ...request,
      projectId,
      ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
    });
  };

  const renderExternalRelayHomeOnlyRoot = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    if (deps.isTerminated() || deps.isVersionBlocked()) return;
    await deps.updateMobileViewState(workspaceKey, taskId);
    document.title = "ZCode - Web Remote Control";
    if (deps.isTerminated() || deps.isVersionBlocked()) return;
    // Bug 原因：staging 合并 a861a83cbc 丢了这里的 ready 标记，home-only 挂载后每次配对状态抖动
    // 都会被 onStateChange 当成首屏重渲染加载页，配对恢复后再整页重挂，引导与本地状态全部丢失。
    // 与 bridge Root 一致：Root 挂载后由其自身横幅展示断线状态。
    deps.markReady();
    root.render(
      <AppErrorBoundary key={`home-only-${workspaceKey}`}>
        <ZCodeIntlProvider>
          <Root
            composerClientNamespace={composerClientNamespace}
            services={createHomeOnlyWebRemoteControlServices()}
            platform={createPlatform()}
            initialWorkspaceAbsPath={workspaceKey}
            initialTaskId={taskId}
            initialWebRemoteControlMobileNavigationIntent={undefined}
            webRemoteControlTerminalTransportState={deps.getTerminalTransportState()}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen
                state="paired"
                locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                device={deps.getConnectingDevice()}
              />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              deviceNavigation: deps.deviceNavigation,
              listWorkspaces: async () => ({
                ...(await deps.listWorkspaces()),
                activeWorkspaceKey: deps.getCurrentWorkspaceKey(),
                activeTaskId: deps.getCurrentTaskId(),
              }),
              onWorkspaceListUpdated: deps.subscribeWorkspaceListUpdates,
              openProjectDraft,
              switchWorkspace: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await deps.openWorkspaceBridge(
                  nextWorkspaceKey,
                  options,
                );
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                  undefined,
                  Boolean(options?.fileTreeTaskId || options?.openFileManager),
                );
              },
              startDraft: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await deps.openWorkspaceBridge(
                  nextWorkspaceKey,
                  undefined,
                );
                await deps.updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                );
              },
              reconnectWorkspace: deps.reconnectWorkspace,
              updateMobileViewState: deps.updateMobileViewState,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  return { renderExternalRelayRoot, renderExternalRelayHomeOnlyRoot };
}
