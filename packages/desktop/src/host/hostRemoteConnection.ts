import type { WindowHostAttachmentScope } from "@zcode/shared";
import { buildRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote";
import type { IDisposable } from "@zcode/rpc";
import {
  IClientConfigService,
  ICredentialService,
  IFileService,
  IRemoteProjectService,
  IBotsService,
  type ServiceCollection,
} from "@zcode/services";
import { prepareRemoteServerConnection } from "@zcode/services/node";
import { connectSourceServerTarget } from "./connectSourceServerTarget.js";
import { createSourceServerRecoveryCloseEvent } from "./sourceServerRecoveryPolicy.js";
import { connectServerRemote, type ServerRemoteConnection } from "./serverRemoteConnection.js";
import { createServerRemoteWorkspaceServiceCollection } from "./remoteWorkspaceServiceCollection.js";
import {
  createRemoteMediaPreviewProxy,
  type RemoteMediaPreviewProxy,
} from "./remoteMediaPreviewProxy.js";
import {
  createRemotePromptAttachmentTransferService,
  type RemotePromptAttachmentTransferService,
} from "./promptAttachmentTransferService.js";
import { createWindowTopicResourceRelay } from "./windowTopicResourceRelay.js";
import type {
  WindowRemoteConnectionCloseEvent,
  WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";
import { resolveResourceTelemetryEnvironmentKey } from "./hostResourceTelemetryEnvironment.js";
import { registerHostServiceResourceTelemetry } from "./hostServiceResourceTelemetry.js";
import { resolveSourceServerReleaseAsset } from "./sourceServerReleaseResolver.js";
import { logger, remoteConnectionProgressContext } from "./hostProcessLogging.js";
import { attachmentRegistry, hostState, remoteRegistry } from "./hostState.js";
import {
  ensureSourceServerConnectionManager,
  notifyProjectChange,
  requireActiveHostApiNetworkTransport,
} from "./hostSourceServices.js";

const { parentPort } = process;

type HostRemoteConnection = ServerRemoteConnection;
export interface HostRemoteConnectionCapabilities {
  promptAttachmentTransferFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemotePromptAttachmentTransferService;
  browserRecordingUploader?: Pick<IRemoteBackend, "upload">;
  remoteMediaPreviewFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemoteMediaPreviewProxy;
  sourceServerId?: string;
  persistentSourceConnection?: boolean;
  /** underlying 服务实例标识，创建 logical wrapper 不代表物理连接换代。 */
  physicalOwner?: () => object;
  profileId?: string;
  recordWorkspaceOpen?: (input: {
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    legacyWorkspaceIdentity?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  bindWorkspaceIdentity?: (input: {
    workspacePath: string;
    stableWorkspaceIdentity: string;
    legacyRouteHint?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
}

let activeRemoteMediaRequests = 0;
const hostRemoteMediaRequestLimiter = {
  tryAcquire: () => {
    if (activeRemoteMediaRequests >= 4) return false;
    activeRemoteMediaRequests += 1;
    return true;
  },
  release: () => {
    activeRemoteMediaRequests = Math.max(0, activeRemoteMediaRequests - 1);
  },
  getState: () => ({ active: activeRemoteMediaRequests, limit: 4 }),
};
const remoteMediaRangePreviewEnabled =
  process.env["ZCODE_REMOTE_MEDIA_RANGE_PREVIEW_ENABLED"] !== "0";

type RemoteAssetDirs = import("./windowRemoteConnectionRegistry.js").WindowRemoteAssetDirs;
async function disposeHostRemoteConnection(connection: HostRemoteConnection): Promise<void> {
  connection.dispose();
}
export async function createWindowRemoteConnectionHandle(params: {
  target: RemoteTarget;
  membershipIntent?: "add" | "retain";
  existingSourceServerId?: string;
  remoteAssets: RemoteAssetDirs;
  signal: AbortSignal;
  confirmSourceServerInstall?: boolean;
}): Promise<WindowRemoteConnectionHandle<ServiceCollection, HostRemoteConnectionCapabilities>> {
  if (!hostState.activeServices) throw new Error("Local Host services are not initialized.");
  const clientConfigService = hostState.activeServices.get(IClientConfigService);
  if (params.signal.aborted) {
    throw new Error("远程连接已取消");
  }
  const closeListeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  let topicResourceRelay: ReturnType<typeof createWindowTopicResourceRelay> | undefined;
  const notifyClose = (event: WindowRemoteConnectionCloseEvent) => {
    topicResourceRelay?.dispose();
    for (const listener of closeListeners) {
      listener(event);
    }
  };
  let connection: HostRemoteConnection;
  let managedProfile: import("@zcode/shared").ConnectionProfile | undefined;
  let reusedConnectionTarget: RemoteTarget | undefined;
  let managerStateSubscription: { dispose(): void } | undefined;
  let managerConnectionInvalidatedSubscription: { dispose(): void } | undefined;
  let managerReconnectSubscription: { dispose(): void } | undefined;
  let services: ServiceCollection;
  let resourceTelemetry: IDisposable | undefined;
  const refreshResourceTelemetry = () => {
    resourceTelemetry?.dispose();
    // Source 重连会替换 services；遥测也必须释放旧订阅并挂到新一代代理，避免重连后静默丢样本。
    resourceTelemetry = registerHostServiceResourceTelemetry({
      services,
      postMessage: (message) => parentPort?.postMessage(message),
      runtimeSurface: "remote",
      // SSH/WSL/Docker 也会复用兼容的旧 Source；所有 Server 都须声明能力才订阅新增事件。
      telemetrySupported: connection.serverInfo.capabilities.processResourceTelemetry === true,
      environmentKey: resolveResourceTelemetryEnvironmentKey(
        params.target,
        connection.serverInfo.serverId,
      ),
      onError: (error) => logger.warn("remote resource telemetry subscription failed", error),
    });
  };
  let lastNotifiedRecoveryAttempt = 0;
  let disposed = false;
  let sourceClosed = false;
  let projectSubscription: { dispose(): void } | undefined;
  const detachOwnSourceSettings = () => {
    const sourceId = connection?.serverInfo.serverId;
    if (!sourceId || params.target.kind !== "server") return;
    const current = remoteRegistry().getOnlineSource(sourceId);
    if (!current || current.services === services)
      attachmentRegistry().detachSourceSettingsAttachments(sourceId);
  };
  if (params.target.kind === "server") {
    if (params.existingSourceServerId) throw new Error("project.host-offline");
    if (!hostState.activeServices) throw new Error("Host services 尚未初始化");
    const admission = await prepareRemoteServerConnection({
      service: hostState.activeServices.get(IRemoteProjectService),
      credentials: hostState.activeServices.get(ICredentialService),
      target: params.target,
      intent: params.membershipIntent ?? "add",
    });
    params.signal.throwIfAborted();
    topicResourceRelay = createWindowTopicResourceRelay({
      getPeerAgentService: () => connection?.services.zcodeAgentService,
      resolveServices: (scope) => remoteRegistry().resolveScopedServices(scope),
      getBots: () => hostState.activeServices?.getOptional(IBotsService),
    });
    try {
      connection = await connectServerRemote(admission.target, {
        signal: params.signal,
        fetchImpl: requireActiveHostApiNetworkTransport().fetch,
        commitMembership: admission.commit,
        topicResourceChannel: topicResourceRelay.channel,
        onClose: ({ code, reason }) => {
          sourceClosed = true;
          detachOwnSourceSettings();
          notifyClose({ exitCode: code, signal: null, ...(reason ? { error: reason } : {}) });
        },
      });
    } catch (error) {
      topicResourceRelay.dispose();
      throw error;
    }
  } else {
    if (!hostState.sourceServerDirectory) {
      throw new Error("Source Server manager 尚未初始化");
    }
    const manager = await ensureSourceServerConnectionManager();
    const existingProfile = params.existingSourceServerId
      ? (await hostState.sourceServerDirectory.snapshot()).profiles.find(
          (item) => item.sourceServerId === params.existingSourceServerId,
        )
      : undefined;
    const existingConnection = params.existingSourceServerId
      ? manager.getOnlineConnection(params.existingSourceServerId)
      : undefined;
    if (params.existingSourceServerId && (!existingProfile || !existingConnection))
      throw new Error("project.host-offline");
    const { profile, connection: managed } =
      existingProfile && existingConnection
        ? { profile: existingProfile, connection: existingConnection }
        : await connectSourceServerTarget(hostState.sourceServerDirectory, manager, {
            membershipIntent: params.membershipIntent,
            target: params.target,
            allowInstall: params.confirmSourceServerInstall === true,
            resolveRelease: async (probe, target, options) =>
              await resolveSourceServerReleaseAsset(
                probe,
                params.remoteAssets,
                target,
                {
                  fetch: requireActiveHostApiNetworkTransport().fetch,
                },
                options,
              ),
            context: {
              signal: params.signal,
              onLog: (event) => {
                const progress =
                  event.progress == null
                    ? ""
                    : ` ${(Math.max(0, Math.min(1, event.progress)) * 100).toFixed(1)}%`;
                const message =
                  event.progress == null || event.message.startsWith("upload progress:")
                    ? `[source-server:${event.phase}] ${event.message}`
                    : `[source-server:${event.phase}] upload progress (${event.message}):${progress}`;
                remoteConnectionProgressContext.report(event.level ?? "info", [message]);
              },
            },
          });
    managedProfile = profile;
    reusedConnectionTarget = managed.reusedConnectionTarget;
    const sourceDirectorySnapshot = await hostState.sourceServerDirectory.snapshot();
    for (const server of sourceDirectorySnapshot.servers) {
      hostState.sourceServerDisplayNameById.set(server.sourceServerId, server.displayName);
    }
    managerStateSubscription = manager.onDidChangeState((state) => {
      if (state.profileId !== profile.profileId) return;
      if (state.state === "online") {
        lastNotifiedRecoveryAttempt = 0;
        return;
      }
      const closeEvent = createSourceServerRecoveryCloseEvent(state);
      if (!closeEvent) return;
      if (state.state === "retrying" && state.recoveryAttempt === lastNotifiedRecoveryAttempt) {
        return;
      }
      if (state.state === "retrying") {
        lastNotifiedRecoveryAttempt = state.recoveryAttempt ?? lastNotifiedRecoveryAttempt;
      }
      notifyClose(closeEvent);
    });
    connection = {
      serverInfo: managed.serverInfo,
      services: managed.services,
      dispose() {
        // Bug 原因：Window registry handle 是 logical/attachment lease，不是 Source connection owner。
        // 旧 entry 取消或迟到恢复时若调用 manager.disconnect，会拆掉新 entry 正在共享的
        // Source。真实物理连接由 SourceServerConnectionManager 在显式断开或 Host shutdown 回收。
      },
    };
    managerConnectionInvalidatedSubscription = manager.onDidInvalidateConnection((event) => {
      if (event.sourceServerId !== managed.sourceServerId || disposed) return;
      // Bug 原因：物理 Source connection 被更新或其当前 Profile 被删除时，若不先按
      // Source 通知 Registry，已有 logical workspace 会继续以 online 状态持有失效 services。
      // 更新允许恢复；删除当前 Profile 属于用户显式断开，必须发布 terminal close。
      notifyClose({
        exitCode: null,
        signal: null,
        recoverable: event.reason === "update",
      });
    });
    managerReconnectSubscription = manager.onDidReconnect((reconnected) => {
      if (reconnected.sourceServerId !== managed.sourceServerId || disposed) return;
      connection = {
        serverInfo: reconnected.serverInfo,
        services: reconnected.services,
        dispose() {
          // 同上：只释放当前 wrapper 的订阅，不跨 lease 关闭共享 Source。
        },
      };
      services = createServerRemoteWorkspaceServiceCollection({
        clientConfigService,
        connectionServices: reconnected.services,
        virtualProjects: reconnected.serverInfo.capabilities.virtualProjects,
        serverId: reconnected.serverInfo.serverId,
        sourceServices: hostState.activeServices ?? undefined,
        targetKind: params.target.kind,
      });
      refreshResourceTelemetry();
      lastNotifiedRecoveryAttempt = 0;
      for (const listener of reconnectListeners) listener();
    });
  }

  if (params.signal.aborted) {
    topicResourceRelay?.dispose();
    await disposeHostRemoteConnection(connection);
    throw new Error("远程连接已取消");
  }

  services = createServerRemoteWorkspaceServiceCollection({
    clientConfigService,
    connectionServices: connection.services,
    virtualProjects: connection.serverInfo.capabilities.virtualProjects,
    serverId: connection.serverInfo.serverId,
    targetKind: params.target.kind,
    sourceServices: hostState.activeServices ?? undefined,
  });
  if (params.target.kind === "server") {
    projectSubscription = connection.services.broadcastService.onMessage((event) => {
      if (!disposed && !sourceClosed && event.channel === "state:projects") notifyProjectChange();
    });
  }
  refreshResourceTelemetry();
  // 桌面 attachment 对远端媒体走 Host loopback Range 数据面；services 会随 Source 重连换代，
  // 工厂在调用时再取当前 file service。server 直连保持 renderer inline 读取。
  const remoteMediaPreviewFactory =
    params.target.kind === "server" || !remoteMediaRangePreviewEnabled
      ? undefined
      : (scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>) =>
          createRemoteMediaPreviewProxy({
            fileService: services.get(IFileService),
            logger: {
              debug: (message, metadata) => {
                if (process.env.NODE_ENV !== "production") logger.info(message, metadata);
              },
              warn: (message, metadata) => logger.warn(message, metadata),
            },
            scope,
            requestLimiter: hostRemoteMediaRequestLimiter,
          });

  return {
    ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
    get services() {
      return services;
    },
    capabilities: {
      sourceServerId: connection.serverInfo.serverId,
      physicalOwner: () => connection.services,
      ...(remoteMediaPreviewFactory ? { remoteMediaPreviewFactory } : {}),
      persistentSourceConnection: true,
      ...(managedProfile ? { profileId: managedProfile.profileId } : {}),
      ...(managedProfile
        ? {
            promptAttachmentTransferFactory: (
              scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
            ) => {
              if (!hostState.sourceServerConnectionManager)
                throw new Error("Source Server is unavailable");
              return createRemotePromptAttachmentTransferService(
                hostState.sourceServerConnectionManager.getFileTransfer(
                  connection.serverInfo.serverId,
                ),
                {
                  scope,
                  onJanitorError: (error) => logger.warn("remote attachment janitor failed", error),
                },
              );
            },
          }
        : {}),
      ...(managedProfile && hostState.sourceServerDirectory
        ? {
            bindWorkspaceIdentity: async (input) => {
              input.signal?.throwIfAborted();
              const currentRouteHint = buildRemoteWorkspaceIdentity(
                input.workspacePath,
                params.target,
              );
              const legacyRouteHint =
                await hostState.sourceServerDirectory!.resolveLegacyWorkspaceIdentity({
                  profileId: managedProfile!.profileId,
                  workspacePath: input.workspacePath,
                  fallback: input.legacyRouteHint ?? currentRouteHint,
                });
              input.signal?.throwIfAborted();
              await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                workspacePath: input.workspacePath,
                legacyRouteHint,
              });
            },
          }
        : {
            bindWorkspaceIdentity: async (input) => {
              await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                workspacePath: input.workspacePath,
              });
            },
          }),
      ...(managedProfile && hostState.sourceServerDirectory
        ? {
            recordWorkspaceOpen: async (input) => {
              await hostState.sourceServerDirectory?.recordWorkspaceOpen({
                profileId: managedProfile!.profileId,
                sourceServerId: connection.serverInfo.serverId,
                ...input,
              });
            },
          }
        : {}),
    },
    onDidClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    onDidReconnect(listener) {
      reconnectListeners.add(listener);
      return { dispose: () => reconnectListeners.delete(listener) };
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      detachOwnSourceSettings();
      topicResourceRelay?.dispose();
      closeListeners.clear();
      reconnectListeners.clear();
      managerStateSubscription?.dispose();
      managerConnectionInvalidatedSubscription?.dispose();
      managerReconnectSubscription?.dispose();
      projectSubscription?.dispose();
      resourceTelemetry?.dispose();
      await disposeHostRemoteConnection(connection);
    },
  };
}
