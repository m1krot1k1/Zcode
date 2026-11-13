import { randomUUID } from "node:crypto";
import {
  HostResponseTypes,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";
import {
  IFileService,
  IZCodeAgentService,
  IZCodeTaskService,
  type ServiceCollection,
} from "@zcode/services";
import { logger } from "./hostProcessLogging.js";
import {
  createWindowRemoteConnectionHandle,
  type HostRemoteConnectionCapabilities,
} from "./hostRemoteConnection.js";
import {
  attachmentRegistry,
  controllerRuntime,
  hostState,
  remoteRegistry,
  type HostControllerRuntime,
  type HostRemoteRegistry,
} from "./hostState.js";
import { prepareRemoteWorkspaceIdentity } from "./remoteWorkspacePreparation.js";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";
import { notifyProjectChange } from "./hostSourceServices.js";

const { parentPort } = process;

/**
 * 建立窗口级远端 Registry 与 Controller Runtime；两者互相引用（Registry 关闭时清理
 * controller source，Controller 需要按 scope 解析远端 services），因此按固定顺序一次性装配。
 */
export function createHostWindowRuntime(): void {
  const createdRemoteRegistry: HostRemoteRegistry = createWindowRemoteConnectionRegistry<
    ServiceCollection,
    HostRemoteConnectionCapabilities
  >({
    connect: (request) => createWindowRemoteConnectionHandle(request),
    createId: randomUUID,
    onConnectionChanged: notifyProjectChange,
    resolveSourceServerId: (handle) => handle.capabilities?.sourceServerId,
    shouldKeepConnectionAlive: (handle) => handle.capabilities?.persistentSourceConnection === true,
    prepareWorkspaceIdentity: async (handle, input) => {
      await prepareRemoteWorkspaceIdentity(
        handle.services.get(IFileService),
        input,
        handle.capabilities?.bindWorkspaceIdentity,
      );
    },
    releaseWorkspace: async (services, context) => {
      await services.get(IZCodeTaskService).releaseWorkspacePreparation({
        workspacePath: context.workspacePath,
        ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
        provider: "glm",
      });
      logger.info(
        `released WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
      );
    },
    onWorkspaceReleaseError: (context, error) => {
      logger.warn(
        `failed to release WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
        error,
      );
    },
    onSessionClosed: (event) => {
      // logical session 已离线时 attachment 仍持有旧 services/订阅；后续 sessionId
      // 换代只释放 transport，无法按旧 ID 找回这些端口。Host 在失效源头统一关闭所有 clientMode。
      attachmentRegistry().detachRemoteSessionAttachments(event.remoteSessionId);
      const session = remoteRegistry().getSession(event.remoteSessionId);
      if (session?.workspacePath && session.workspaceIdentity) {
        controllerRuntime().disconnectSource({
          kind: "remote",
          ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
          remoteSessionId: event.remoteSessionId,
          workspacePath: session.workspacePath,
          workspaceIdentity: session.workspaceIdentity,
        });
      }
      parentPort?.postMessage({
        type: HostResponseTypes.RemoteWorkspaceClosed,
        remoteSessionId: event.remoteSessionId,
        reason: "connection-closed",
        exitCode: event.exitCode,
        signal: event.signal,
        ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}),
        ...(event.error ? { error: event.error } : {}),
        ...(event.recoveryAttempt ? { recoveryAttempt: event.recoveryAttempt } : {}),
        ...(event.recoveryLimit ? { recoveryLimit: event.recoveryLimit } : {}),
        ...(event.recoveryBudgetExhausted !== undefined
          ? { recoveryBudgetExhausted: event.recoveryBudgetExhausted }
          : {}),
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
      });
      logWindowHostTopology("remote-connection-closed");
    },
    onSessionReconnected: async ({
      previous,
      current,
      services: currentServices,
      isCurrent,
      commit,
    }) => {
      if (
        !previous.workspacePath ||
        !previous.workspaceIdentity ||
        !current.workspacePath ||
        !current.workspaceIdentity
      ) {
        throw new Error("Source 重连换代缺少 workspace scope");
      }
      const previousScope = {
        kind: "remote" as const,
        ...(previous.sourceServerId ? { sourceServerId: previous.sourceServerId } : {}),
        remoteSessionId: previous.remoteSessionId,
        workspacePath: previous.workspacePath,
        workspaceIdentity: previous.workspaceIdentity,
      };
      const currentScope = {
        kind: "remote" as const,
        ...(current.sourceServerId ? { sourceServerId: current.sourceServerId } : {}),
        ...(current.sourceServerId &&
        hostState.sourceServerDisplayNameById.get(current.sourceServerId)
          ? {
              serverDisplayName: hostState.sourceServerDisplayNameById.get(current.sourceServerId),
            }
          : {}),
        remoteSessionId: current.remoteSessionId,
        workspacePath: current.workspacePath,
        workspaceIdentity: current.workspaceIdentity,
      };
      await controllerRuntime().replaceDisconnectedSource(
        previousScope,
        {
          scope: currentScope,
          taskService: currentServices.get(IZCodeTaskService),
          agentService: currentServices.getOptional(IZCodeAgentService),
          sourceAvailability: "online",
        },
        {
          canCommit: isCurrent,
          rollbackOnFailure: true,
        },
      );
      if (!commit()) {
        throw new Error("Source 重连换代在 Controller 提交后失去 Registry owner");
      }
      try {
        parentPort?.postMessage({
          type: HostResponseTypes.RemoteWorkspaceReconnected,
          previousRemoteSessionId: previous.remoteSessionId,
          descriptor: {
            ...(current.sourceServerId ? { sourceServerId: current.sourceServerId } : {}),
            remoteSessionId: current.remoteSessionId,
            target: current.target,
            workspacePath: current.workspacePath,
            workspaceIdentity: current.workspaceIdentity,
            generation: current.generation,
          },
        });
      } catch (error) {
        // Controller 已提交新 generation 后不能再让 Registry 回滚；parentPort 失效意味着
        // Window Host 与 Main 的进程通道正在终止，交给既有 Host shutdown 回收全部 owner。
        logger.error("failed to publish committed remote workspace replacement", error);
      }
      logWindowHostTopology("remote-connection-reconnected");
    },
    onSessionReconnectError: (error) => {
      logger.warn("failed to replace Source Server logical sessions after reconnect", error);
    },
  });

  const createdControllerRuntime: HostControllerRuntime = createWindowHostControllerRuntime({
    createId: randomUUID,
    onSourceError: (scope, operation, error) => {
      logger.warn(
        `window Controller source ${operation} failed, scope=${scope.kind}, workspaceKey=${scope.workspaceIdentity?.trim() || scope.workspacePath}`,
        error,
      );
    },
    resolveSource: (scope) => {
      const remoteSession = remoteRegistry().findSessionForWorkspace(scope);
      if (remoteSession?.workspacePath && remoteSession.workspaceIdentity) {
        const controllerScope = {
          kind: "remote" as const,
          ...(remoteSession.sourceServerId ? { sourceServerId: remoteSession.sourceServerId } : {}),
          ...(remoteSession.sourceServerId &&
          hostState.sourceServerDisplayNameById.get(remoteSession.sourceServerId)
            ? {
                serverDisplayName: hostState.sourceServerDisplayNameById.get(
                  remoteSession.sourceServerId,
                ),
              }
            : {}),
          remoteSessionId: remoteSession.remoteSessionId,
          workspacePath: remoteSession.workspacePath,
          workspaceIdentity: remoteSession.workspaceIdentity,
        };
        if (remoteSession.sourceAvailability !== "online") {
          return {
            scope: controllerScope,
            sourceAvailability: "offline" as const,
          };
        }
        const services = remoteRegistry().resolveScopedServices(controllerScope);
        return {
          scope: controllerScope,
          taskService: services.get(IZCodeTaskService),
          agentService: services.getOptional(IZCodeAgentService),
          sourceAvailability: "online" as const,
        };
      }
      // 远程 history scope 未连接或已被移除时，绝不能落回本地 tasks-index。
      if (scope.workspaceIdentity && isRemoteWorkspaceIdentity(scope.workspaceIdentity)) {
        // 项目树不要求打开 workspace tab；列表命令可复用稳定 Source 的现有物理连接，不能伪造 logical session。
        const identity = parseRemoteWorkspaceIdentity(scope.workspaceIdentity);
        const connection =
          identity?.kind === "server" &&
          identity.sourceServerId &&
          identity.workspacePath === scope.workspacePath
            ? hostState.sourceServerConnectionManager?.getOnlineConnection(identity.sourceServerId)
            : undefined;
        const registered =
          identity?.kind === "server" &&
          identity.sourceServerId &&
          identity.workspacePath === scope.workspacePath
            ? remoteRegistry().getOnlineSource(identity.sourceServerId)
            : undefined;
        if (identity?.kind === "server" && identity.sourceServerId && (connection || registered))
          return {
            scope: {
              kind: "remote" as const,
              sourceServerId: identity.sourceServerId,
              workspacePath: scope.workspacePath,
              workspaceIdentity: scope.workspaceIdentity,
            },
            taskService:
              connection?.services.zcodeTaskService ?? registered!.services.get(IZCodeTaskService),
            agentService:
              connection?.services.zcodeAgentService ??
              registered!.services.getOptional(IZCodeAgentService),
            sourceAvailability: "online" as const,
          };
        return null;
      }
      const taskService = hostState.activeServices?.getOptional(IZCodeTaskService);
      if (!taskService) {
        return null;
      }
      return {
        scope: {
          kind: "local" as const,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        },
        taskService,
        agentService: hostState.activeServices?.getOptional(IZCodeAgentService),
        sourceAvailability: "online" as const,
      };
    },
  });
  hostState.windowRemoteConnectionRegistry = createdRemoteRegistry;
  hostState.windowHostControllerRuntime = createdControllerRuntime;
}

export function logWindowHostTopology(reason: string): void {
  const stats = remoteRegistry().getStats();
  logger.info(
    `window Host topology, reason=${reason}, pid=${process.pid}, connections=${stats.connectionCount}, logicalSessions=${stats.logicalSessionCount}, attachments=${attachmentRegistry().size()}`,
  );
}
