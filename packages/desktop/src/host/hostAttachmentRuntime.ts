import { randomUUID } from "node:crypto";
import {
  MessagePortProtocol,
  ChannelServer,
  LoggingChannelServer,
  NetworkTelemetryChannelServer,
  type IChannelServer,
} from "@zcode/rpc";
import {
  IConversationShareService,
  IMediaPreviewService,
  IPromptAttachmentTransferService,
  IProjectService,
  IRemoteProjectService,
  ITaskGroupService,
  IWindowControllerService,
  IZCodeAgentService,
  IZCodeTaskService,
  createZCodeAgentConnectionScope,
  type ZCodeAgentV4ClientMode,
} from "@zcode/services";
import type { WindowHostAttachmentScope } from "@zcode/shared";
import { bindBotGroupTaskScope } from "./botGroupTaskScope.js";
import { scopeConversationShareServiceForAttachment } from "./conversationShareAttachmentService.js";
import { wrapElectronPort } from "./electronPort.js";
import {
  attachmentRegistry,
  controllerRuntime,
  hostState,
  remoteRegistry,
  type HostAttachmentRegistry,
} from "./hostState.js";
import { logRpc, logger } from "./hostProcessLogging.js";
import { createSourceSettingsServiceCollection } from "./sourceSettingsServiceCollection.js";
import { createWindowHostAttachmentRegistry } from "./windowHostAttachmentRegistry.js";
import { exposeWindowHostAttachmentServices } from "./windowHostAttachmentRpcPolicy.js";
import type { HostRemoteConnectionCapabilities } from "./hostRemoteConnection.js";
import type { ServiceCollection } from "@zcode/services";

type ExposedServicePortHandle = {
  server: IChannelServer & { ready(): void };
  dispose(): void;
};

export function createControllerRoutedTaskService(
  base: IZCodeTaskService,
  attachmentScope: WindowHostAttachmentScope,
): IZCodeTaskService {
  const route = async (
    params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
    mutation:
      | { kind: "pin"; pinned: boolean }
      | { kind: "archive"; archived: boolean }
      | { kind: "delete" }
      | { kind: "mark-read"; expectedUnreadAt?: number }
      | { kind: "mark-unread" },
  ) =>
    controllerRuntime().service.mutateTask({
      address: await controllerRuntime().resolveTaskAddress({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        attachmentScope,
      }),
      mutation,
    });

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "setTaskPinned") {
        return async (params: Parameters<IZCodeTaskService["setTaskPinned"]>[0]) => {
          const meta = await route(params, {
            kind: "pin",
            pinned: params.pinned,
          });
          if (!meta) throw new Error("pin mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "archiveTask" || property === "unarchiveTask") {
        return async (
          params:
            | Parameters<IZCodeTaskService["archiveTask"]>[0]
            | Parameters<IZCodeTaskService["unarchiveTask"]>[0],
        ) => {
          const meta = await route(params, {
            kind: "archive",
            archived: property === "archiveTask",
          });
          if (!meta) throw new Error("archive mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "deleteTask") {
        return async (params: Parameters<IZCodeTaskService["deleteTask"]>[0]) => {
          await route(params, { kind: "delete" });
        };
      }
      if (property === "deleteArchivedTasks") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTasks"]>[0]) => {
          if (params.taskIds.length === 0) {
            return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
          }
          return controllerRuntime().service.deleteArchivedTasks({
            address: await controllerRuntime().resolveTaskAddress({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              taskId: params.taskIds[0]!,
              attachmentScope,
              allowMissingTask: true,
            }),
            taskIds: params.taskIds,
          });
        };
      }
      if (property === "deleteArchivedTask") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTask"]>[0]) =>
          controllerRuntime().service.deleteArchivedTask({
            address: await controllerRuntime().resolveTaskAddress({
              ...params,
              attachmentScope,
              allowMissingTask: true,
            }),
          });
      }
      if (property === "setTaskUnread") {
        return async (params: Parameters<IZCodeTaskService["setTaskUnread"]>[0]) => {
          const meta = await route(
            params,
            params.unread
              ? { kind: "mark-unread" }
              : {
                  kind: "mark-read",
                  ...(params.expectedUnreadAt != null
                    ? { expectedUnreadAt: params.expectedUnreadAt }
                    : {}),
                },
          );
          if (!meta) throw new Error("unread mutation 后 task 投影缺失");
          return meta;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof value === "function" &&
        [
          "getBotGroupTaskBlockReason",
          "cancelBotGroupInput",
          "submitBotGroupInput",
          "readBotTopicSummaries",
        ].includes(String(property))
      ) {
        return (params: Record<string, unknown>) =>
          value.call(target, bindBotGroupTaskScope(params, attachmentScope));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function exposeServicesOnMessagePort(
  port: Electron.MessagePortMain,
  services: ServiceCollection,
  deferInit: boolean,
  clientMode: ZCodeAgentV4ClientMode = "desktop-continuous",
  attachmentScope: WindowHostAttachmentScope = { kind: "local" },
  capabilities?: HostRemoteConnectionCapabilities,
): ExposedServicePortHandle {
  const wrappedPort = wrapElectronPort(port);
  const protocol = new MessagePortProtocol(wrappedPort);
  // remote 模式延迟发送 Initialize：远程建连需要时间，如果构造时就发 Initialize，
  // renderer 会立即发请求但 channel 还没注册，导致 "Unknown channel" 超时错误。
  // attach 模式复用已就绪服务，必须立即初始化新的 RPC MessagePort。
  logger.info(`creating ChannelServer (deferInit=${deferInit})`);
  const rawServer = new ChannelServer(protocol, "host", 1000, deferInit);
  const loggedServer = new LoggingChannelServer(rawServer, logRpc);
  const server = new NetworkTelemetryChannelServer(loggedServer);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionContext = { connectionId: `host-rpc-${randomUUID()}`, clientMode };
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, connectionContext)
    : undefined;
  services.register(IWindowControllerService, controllerRuntime().service);
  // 未读自动写入只归窗口 base renderer；手机和 remote facade 不能重复消费同一完成信号。
  const controllerAttachment = controllerRuntime().createAttachmentService(
    clientMode === "desktop-continuous" && attachmentScope.kind === "local",
  );
  const overrides = new Map<string, unknown>([
    [IWindowControllerService.channelName, controllerAttachment],
  ]);
  // 手机可从任意远端 workspace 重建 Root；侧栏组织服务仍归控制端，不能随当前执行 attachment 换库。
  if (
    clientMode === "web-remote-replayable" &&
    attachmentScope.kind === "remote" &&
    hostState.activeServices
  ) {
    overrides.set(IProjectService.channelName, hostState.activeServices.get(IProjectService));
    overrides.set(
      IRemoteProjectService.channelName,
      hostState.activeServices.get(IRemoteProjectService),
    );
    services.register(ITaskGroupService, hostState.activeServices.get(ITaskGroupService));
  }
  // 远端媒体必须按 attachment 的 clientMode 选择数据面：桌面使用 Host loopback Range，手机保持 inline。
  const remoteMediaPreviewProxy =
    attachmentScope.kind === "remote" && clientMode === "desktop-continuous"
      ? capabilities?.remoteMediaPreviewFactory?.(attachmentScope)
      : undefined;
  if (remoteMediaPreviewProxy) {
    overrides.set(IMediaPreviewService.channelName, remoteMediaPreviewProxy.service);
  }
  // R3 的 Source 本地 transfer 无法读取 Desktop localPath；跨机 staging 必须在 owning
  // Window Host attachment 注入，复用当前 transport。桌面/手机不另建 runtime 或业务队列。
  const remotePromptAttachmentTransfer =
    attachmentScope.kind === "remote"
      ? capabilities?.promptAttachmentTransferFactory?.(attachmentScope)
      : undefined;
  const { dispose: disposePromptAttachmentTransfer, ...promptAttachmentService } =
    remotePromptAttachmentTransfer ?? {};
  if (remotePromptAttachmentTransfer) {
    // dispose 只属于 Host attachment 生命周期，不暴露为 Renderer RPC。
    overrides.set(IPromptAttachmentTransferService.channelName, promptAttachmentService);
  }
  const taskService = services.getOptional(IZCodeTaskService);
  if (taskService) {
    overrides.set(
      IZCodeTaskService.channelName,
      createControllerRoutedTaskService(taskService, attachmentScope),
    );
  }
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  const conversationShareService = services.getOptional(IConversationShareService);
  if (conversationShareService) {
    // Share service 若继续持有 raw Agent，会绕过当前 MessagePort 已握手的 trusted carrier，
    // rowsRange 会以 connection untrusted 拒绝。必须复用同一 attachment connection scope。
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        conversationShareService,
        clientMode,
        connectionScope?.service,
        connectionContext,
      ),
    );
  }
  exposeWindowHostAttachmentServices({
    server,
    services,
    overrides,
    clientMode,
    attachmentScope,
    windowServices: hostState.activeServices ?? undefined,
  });
  let disposed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardFlowState = (state: "saturated" | "drained" | "closed") => {
    if (!connectionScope) return Promise.resolve();
    const update = flowUpdateChain.then(() => connectionScope.setTransportFlowState(state));
    flowUpdateChain = update.catch((error) => {
      logger.warn("failed to forward attachment connection flow state", {
        state,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return update;
  };
  const flowStateDisposable = protocol.onFlowState((state) => {
    if (disposed) return;
    // MessagePort sideband 已在 protocol 层与 Uint8Array 分流；这里只把 owning scope
    // 的 edge 串行送往 CLI，不能由 control object 指定 connectionId。
    void forwardFlowState(state).catch(() => {});
  });
  const handle: ExposedServicePortHandle = {
    server,
    dispose() {
      if (disposed) return;
      disposed = true;
      flowStateDisposable.dispose();
      controllerAttachment.dispose();
      void disposePromptAttachmentTransfer?.().catch((error: unknown) => {
        logger.warn("failed to dispose remote attachment transfer", error);
      });
      void remoteMediaPreviewProxy?.dispose().catch((error: unknown) => {
        logger.warn("failed to dispose remote media preview proxy", error);
      });
      // close 排在所有已接收 SAT/DRN 之后；scope.dispose 自身会再次幂等确保 closed，
      // 但绝不让迟到 saturated 在 close 后复活 CLI pause state。
      void forwardFlowState("closed")
        .catch(() => {})
        .then(() => connectionScope?.dispose());
      rawServer.dispose();
      protocol.disconnect();
    },
  };
  port.once("close", () => handle.dispose());
  logger.info(`service connection ready mode=${clientMode}`);
  return handle;
}

const createdAttachmentRegistry: HostAttachmentRegistry = createWindowHostAttachmentRegistry<
  ServiceCollection,
  Electron.MessagePortMain,
  HostRemoteConnectionCapabilities
>({
  resolveScope: (scope: WindowHostAttachmentScope) => {
    if (scope.kind === "local") {
      if (!hostState.activeServices) {
        throw new Error("local services 尚未初始化");
      }
      return { services: hostState.activeServices, generation: 1 };
    }
    if (scope.kind === "source-settings") {
      const connection = hostState.sourceServerConnectionManager?.getOnlineConnection(
        scope.sourceServerId,
      );
      const registered = remoteRegistry().getOnlineSource(scope.sourceServerId);
      const configServices = connection?.services ?? registered?.services;
      if (!configServices) {
        throw new Error(`Source Server is offline: ${scope.sourceServerId}`);
      }
      return {
        services: createSourceSettingsServiceCollection(configServices),
        generation:
          hostState.sourceServerConnectionManager
            ?.listStates()
            .find((state) => state.sourceServerId === scope.sourceServerId)?.updatedAt ?? 1,
      };
    }
    const session = remoteRegistry().getSession(scope.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${scope.remoteSessionId}`);
    }
    return {
      services: remoteRegistry().resolveScopedServices(scope),
      generation: session.generation,
      capabilities: remoteRegistry().resolveScopedCapabilities(scope),
    };
  },
  expose: ({ port, services, clientMode, scope, capabilities }) =>
    exposeServicesOnMessagePort(port, services, false, clientMode, scope, capabilities),
});

/** 建立窗口 Host attachment Registry；resolveScope 依赖已就绪的远端 Registry 与 Source Manager。 */
export function createHostAttachmentRuntime(): void {
  hostState.windowHostAttachmentRegistry = createdAttachmentRegistry;
}

export function disposeAttachedServicePorts(): void {
  attachmentRegistry().dispose();
}
