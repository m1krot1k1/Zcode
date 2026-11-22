import { buildRemoteHostWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ServiceCollection } from "@zcode/services";
import {
  IBotsService,
  IBroadcastService,
  IModelSelectionService,
  IRemoteProjectService,
  ISettingService,
  IZCodeAgentService,
  IZCodeTaskService,
} from "@zcode/services";
import type { BotProjectConnection, HostApiNetworkTransport } from "@zcode/services/node";
import { createRemoteProjectConnectionAdmission } from "@zcode/services/node";
import { connectDesktopSourceServer } from "./connectDesktopSourceServer.js";
import { createControllerRoutedTaskService } from "./hostAttachmentRuntime.js";
import { logger } from "./hostProcessLogging.js";
import { createHostResourceUsageResponder } from "./hostResourceUsage.js";
import { registerHostServiceResourceTelemetry } from "./hostServiceResourceTelemetry.js";
import { hostState, remoteRegistry } from "./hostState.js";
import { SourceServerConnectionManager } from "./sourceServerConnectionManager.js";

const { parentPort } = process;

export function notifyProjectChange(): void {
  void hostState.activeServices
    ?.get(IBroadcastService)
    .send({ channel: "state:projects", payload: {} })
    .catch((error) => logger.warn("failed to notify project change", error));
}

/** Bot 只取得当前 Source 代际，不拥有连接，也不创建 logical tab。 */
export function resolveBotProjectConnection(hostId: string): BotProjectConnection | undefined {
  const serverId = parseRemoteWorkspaceIdentity(
    buildRemoteHostWorkspaceIdentity(hostId, "/"),
  )?.sourceServerId;
  if (!serverId) return undefined;
  const registered = remoteRegistry().getOnlineSource(serverId);
  if (registered) {
    const services = registered.services;
    return {
      owner: registered.capabilities?.physicalOwner?.() ?? services,
      taskService: createControllerRoutedTaskService(services.get(IZCodeTaskService), {
        kind: "local",
      }),
      modelSelectionService: services.get(IModelSelectionService),
      agentService: services.get(IZCodeAgentService),
      bindWorkspace: async (target) => {
        await registered.capabilities?.bindWorkspaceIdentity?.({
          workspacePath: target.workspacePath,
          stableWorkspaceIdentity: target.workspaceIdentity,
          legacyRouteHint: target.workspaceIdentity,
        });
      },
    };
  }
  const connection = hostState.sourceServerConnectionManager?.getOnlineConnection(serverId);
  if (!connection) return undefined;
  return {
    owner: connection.services,
    taskService: createControllerRoutedTaskService(connection.services.zcodeTaskService, {
      kind: "local",
    }),
    modelSelectionService: connection.services.modelSelectionService,
    agentService: connection.services.zcodeAgentService,
    bindWorkspace: async (target) => {
      await connection.services.sourceServerWorkspaceService.resolveWorkspace({
        workspacePath: target.workspacePath,
        legacyRouteHint: target.workspaceIdentity,
      });
    },
  };
}

export function requireActiveHostApiNetworkTransport(): HostApiNetworkTransport {
  if (!hostState.activeHostApiNetworkTransport) {
    // Bug 原因：Source Server release 下载若在 Host 网络策略之外回退 global fetch，会绕过设置页代理。
    throw new Error("Window Host network transport is not initialized");
  }
  return hostState.activeHostApiNetworkTransport;
}

export async function ensureSourceServerConnectionManager(): Promise<SourceServerConnectionManager> {
  if (hostState.sourceServerConnectionManager) return hostState.sourceServerConnectionManager;
  if (!hostState.sourceServerDirectory) throw new Error("Source Server directory 尚未初始化");
  if (!hostState.activeServices) throw new Error("Host services 尚未初始化");
  const directory = hostState.sourceServerDirectory;
  const remoteProjects = hostState.activeServices.get(IRemoteProjectService);
  hostState.sourceServerRuntimeInitializeFlight ??= (async () => {
    await directory.initialize();
    if (hostState.hasDisposedHostResources || hostState.sourceServerDirectory !== directory) {
      throw new Error("Source Server directory 初始化期间 Host 已释放");
    }
    const manager = new SourceServerConnectionManager({
      directory,
      admitConnection: createRemoteProjectConnectionAdmission(remoteProjects),
      onProjectChange: notifyProjectChange,
      logWarn: (message, error) => logger.warn(message, error),
      sourceServerArtifactPolicy: hostState.sourceServerArtifactPolicy,
      connectServer: (options) =>
        connectDesktopSourceServer(options, {
          resolveServices: (scope) => remoteRegistry().resolveScopedServices(scope),
          getBots: () => hostState.activeServices?.getOptional(IBotsService),
          readDynamicWorkflowMode: async () =>
            (await hostState.activeServices?.get(ISettingService).get())?.dynamicWorkflowMode,
          onModeSyncError: (error) =>
            logger.warn("remote dynamic workflow user mode push failed", error),
        }),
    });
    hostState.sourceServerConnectionManager = manager;
    return manager;
  })().finally(() => {
    hostState.sourceServerRuntimeInitializeFlight = null;
  });
  return await hostState.sourceServerRuntimeInitializeFlight;
}

export const hostResourceUsageResponder: ReturnType<typeof createHostResourceUsageResponder> =
  createHostResourceUsageResponder({
    getAgentService: () => hostState.activeServices?.getOptional(IZCodeAgentService),
    postMessage: (message) => parentPort?.postMessage(message),
  });

export function wireLocalResourceTelemetry(services: ServiceCollection): void {
  hostState.activeLocalResourceTelemetry?.dispose();
  hostState.activeLocalResourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "local",
    onError: (error) => logger.warn("local resource telemetry subscription failed", error),
  });
}

export function disposeLocalResourceTelemetry(): void {
  try {
    hostState.activeLocalResourceTelemetry?.dispose();
  } catch {
    // 资源遥测释放失败不能阻塞 Host 的既有 shutdown barrier。
  } finally {
    hostState.activeLocalResourceTelemetry = null;
  }
}
