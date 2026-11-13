import {
  HostMessageTypes,
  HostResponseTypes,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
  buildRemoteHostWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  normalizeRemoteConnectionError,
  parseRemoteWorkspaceIdentity,
  sanitizeRemoteConnectionLog,
  type RemoteTarget,
} from "@zcode/shared";
import { IProjectService, IRemoteProjectService, IZCodeTaskService } from "@zcode/services";
import { createProjectWorkspaceNavigation } from "@zcode/services/node";
import {
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
} from "./sourceServerConnectionManager.js";
import { rejectUnavailableAttachedServicePort } from "./hostMessagePortGuard.js";
import type { HostIncomingMessage } from "./hostMessagePortGuard.js";
import { logger, remoteConnectionProgressContext } from "./hostProcessLogging.js";
import { attachmentRegistry, controllerRuntime, hostState, remoteRegistry } from "./hostState.js";
import { resolveBotProjectConnection } from "./hostSourceServices.js";
import { logWindowHostTopology } from "./hostWindowRuntime.js";

const { parentPort } = process;

type PrepareProjectWorkspaceMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.PrepareProjectWorkspace }
>;
type ConnectRemoteWorkspaceMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.ConnectRemoteWorkspace }
>;
type CancelRemoteWorkspaceConnectMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.CancelRemoteWorkspaceConnect }
>;
type CancelRemoteWorkspaceBindMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.CancelRemoteWorkspaceBind }
>;
type BindRemoteWorkspaceContextMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.BindRemoteWorkspaceContext }
>;
type DisposeRemoteWorkspaceSessionMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.DisposeRemoteWorkspaceSession }
>;
type AttachServicePortMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.AttachServicePort }
>;
type DetachServicePortMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.DetachServicePort }
>;

function formatRemoteTargetForLog(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `wsl:${distro}:${user}` : `wsl:${distro}`;
    }
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return `server:${target.name?.trim() || target.url}`;
  }
}

export async function handlePrepareProjectWorkspace(
  msg: PrepareProjectWorkspaceMessage,
): Promise<void> {
  const controller = new AbortController();
  if (hostState.projectNavigationAbortControllers.has(msg.requestId)) {
    parentPort.postMessage({
      type: HostResponseTypes.ProjectWorkspacePrepared,
      requestId: msg.requestId,
      result: { ok: false, error: "项目导航 requestId 重复" },
    });
    return;
  }
  hostState.projectNavigationAbortControllers.set(msg.requestId, controller);
  try {
    const services = hostState.activeServices;
    if (!services || hostState.hasDisposedHostResources)
      throw new Error("Window Host is unavailable");
    const assertHost = () => {
      controller.signal.throwIfAborted();
      if (hostState.activeServices !== services || hostState.hasDisposedHostResources)
        throw new Error("Window Host changed during project navigation");
    };
    const navigation = createProjectWorkspaceNavigation({
      projectService: services.get(IProjectService),
      remoteProjectService: services.get(IRemoteProjectService),
      readConnectionOwner: (hostId) => resolveBotProjectConnection(hostId)?.owner,
      openRemoteWorkspace: async ({ host, directories, owner, assertCurrent }) => {
        assertHost();
        const serverId = parseRemoteWorkspaceIdentity(
          buildRemoteHostWorkspaceIdentity(host.id, directories.workspacePath),
        )?.sourceServerId;
        if (!serverId || !host.target) throw new Error("project.host-offline");
        // 对 Manager-only Source 仅登记现有连接的 wrapper；URL Source 必须已经在 Registry 在线。
        const registered = await remoteRegistry().connectSource({
          target: host.target,
          remoteAssets: {},
          membershipIntent: "retain",
          existingSourceServerId: serverId,
        });
        assertHost();
        if (
          (registered.handle.capabilities?.physicalOwner?.() ?? registered.handle.services) !==
          owner
        )
          throw new Error("project.navigation-stale");
        return remoteRegistry().openWorkspaceOnSource({
          requestId: msg.requestId,
          sourceServerId: serverId,
          workspacePath: directories.workspacePath,
          workspaceIdentity: directories.workspaceIdentity,
          workspacePurpose: directories.projectId ? "project" : "conversation",
          assertCurrent: async () => {
            assertHost();
            await assertCurrent();
            assertHost();
          },
        });
      },
    });
    const value = await navigation.prepare({
      projectId: msg.projectId,
      hostId: msg.hostId,
      draftId: msg.draftId,
      reuseDraft: msg.reuseDraft,
      ...(msg.task ? { task: msg.task } : {}),
    });
    assertHost();
    parentPort.postMessage({
      type: HostResponseTypes.ProjectWorkspacePrepared,
      requestId: msg.requestId,
      result: { ok: true, value },
    });
  } catch (error) {
    parentPort.postMessage({
      type: HostResponseTypes.ProjectWorkspacePrepared,
      requestId: msg.requestId,
      result: { ok: false, error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    if (hostState.projectNavigationAbortControllers.get(msg.requestId) === controller)
      hostState.projectNavigationAbortControllers.delete(msg.requestId);
  }
  return;
}

export function handleConnectRemoteWorkspace(msg: ConnectRemoteWorkspaceMessage): void {
  const workspacePath =
    msg.workspacePath ??
    (msg.target.kind === "server" ? msg.target.workspacePath?.trim() || "/" : "/");
  const workspaceIdentity =
    msg.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, msg.target);
  logger.info(
    `connecting window-scoped remote source, requestId=${msg.requestId}, target=${formatRemoteTargetForLog(msg.target)}`,
  );
  void remoteConnectionProgressContext
    .run(msg.requestId, () =>
      remoteRegistry().connect({
        requestId: msg.requestId,
        target: msg.target,
        remoteAssets: msg.remoteAssets,
        workspacePath,
        workspaceIdentity,
        ...(msg.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      }),
    )
    .then(async (descriptor) => {
      const replacedOfflineSessions = remoteRegistry()
        .listSessions()
        .filter(
          (session) =>
            session.remoteSessionId !== descriptor.remoteSessionId &&
            session.state === "disconnected" &&
            session.workspacePath === descriptor.workspacePath &&
            session.workspaceIdentity === descriptor.workspaceIdentity,
        );
      for (const replaced of replacedOfflineSessions) {
        if (replaced.workspacePath && replaced.workspaceIdentity) {
          const previousScope = {
            kind: "remote",
            ...(replaced.sourceServerId ? { sourceServerId: replaced.sourceServerId } : {}),
            remoteSessionId: replaced.remoteSessionId,
            workspacePath: replaced.workspacePath,
            workspaceIdentity: replaced.workspaceIdentity,
          } as const;
          const nextScope = {
            kind: "remote",
            ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
            remoteSessionId: descriptor.remoteSessionId,
            workspacePath: replaced.workspacePath,
            workspaceIdentity: replaced.workspaceIdentity,
          } as const;
          try {
            const services = remoteRegistry().resolveScopedServices(nextScope);
            await controllerRuntime().replaceDisconnectedSource(previousScope, {
              scope: nextScope,
              taskService: services.get(IZCodeTaskService),
              sourceAvailability: "online",
            });
          } catch (error) {
            // source 已连接但 task-index 暂时不可读时不能回滚 transport，也不能删除上一代
            // 离线可信投影。Controller 会保留 pending replacement，后续 query 成功后原子替换。
            logger.warn("failed to atomically replace disconnected Controller source", error);
          }
        }
        attachmentRegistry().detachRemoteSessionAttachments(replaced.remoteSessionId);
        await remoteRegistry().disposeSession(replaced.remoteSessionId);
        // 重连替换后旧 remoteSessionId 已不再可 attachment；同步清理 Main 的端口请求关联，
        // 但不向 Renderer 伪报一次新的 transport failure。
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: replaced.remoteSessionId,
          reason: "disposed",
        });
      }
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnected,
        requestId: msg.requestId,
        descriptor,
      });
      logWindowHostTopology("remote-connected");
    })
    .catch((error) => {
      const failure = normalizeRemoteConnectionError(error);
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnectFailed,
        requestId: msg.requestId,
        error: sanitizeRemoteConnectionLog(failure.message) || "Remote connection failed",
        reasonCode: failure.code,
        ...(error instanceof SourceServerUpgradeRequiredError ||
        error instanceof SourceServerInstallRequiredError
          ? { profileId: error.profileId }
          : {}),
        // 安装和升级等待固定 Main 解析后的 WSL 身份，不能从可编辑 Profile 重建。
        // 身份来自同一请求，独立于附加安装预览；只回传 WSL 的非敏感连接参数。
        ...((error instanceof SourceServerInstallRequiredError ||
          error instanceof SourceServerUpgradeRequiredError) &&
        msg.target.kind === "wsl"
          ? { resolvedWslTarget: msg.target }
          : {}),
        ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
      });
    });
  return;
}

export function handleCancelRemoteWorkspaceConnect(msg: CancelRemoteWorkspaceConnectMessage): void {
  hostState.projectNavigationAbortControllers.get(msg.requestId)?.abort();
  remoteRegistry().cancelConnect(msg.requestId);
  return;
}

export function handleCancelRemoteWorkspaceBind(msg: CancelRemoteWorkspaceBindMessage): void {
  hostState.cancelledWorkspaceBindRequestIds.add(msg.requestId);
  hostState.workspaceBindAbortControllers.get(msg.requestId)?.abort();
  // Bug 原因：bind 可能 join 到已有 Source logical session；取消一个选择目录请求不代表
  // 该 session 的其他 attachment/owner 都已释放。这里只取消 request，不再连坐 dispose。
  if (!hostState.activeWorkspaceBindRequestIds.has(msg.requestId)) {
    parentPort.postMessage({
      type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
      requestId: msg.requestId,
      error: "Remote workspace bind was canceled",
      reasonCode: REMOTE_BIND_CANCELED_ERROR_CODE,
      retryable: false,
    });
    hostState.cancelledWorkspaceBindRequestIds.delete(msg.requestId);
    hostState.workspaceBindAbortControllers.delete(msg.requestId);
  }
  return;
}

export function handleBindRemoteWorkspaceContext(msg: BindRemoteWorkspaceContextMessage): void {
  hostState.activeWorkspaceBindRequestIds.add(msg.requestId);
  const bindAbortController = new AbortController();
  hostState.workspaceBindAbortControllers.set(msg.requestId, bindAbortController);
  if (hostState.cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
    bindAbortController.abort();
    parentPort.postMessage({
      type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
      requestId: msg.requestId,
      error: "Remote workspace bind was canceled",
      reasonCode: REMOTE_BIND_CANCELED_ERROR_CODE,
      retryable: false,
    });
    hostState.activeWorkspaceBindRequestIds.delete(msg.requestId);
    hostState.cancelledWorkspaceBindRequestIds.delete(msg.requestId);
    hostState.workspaceBindAbortControllers.delete(msg.requestId);
    return;
  }
  const previous = remoteRegistry().getSession(msg.remoteSessionId);
  let workspaceReady: Promise<void>;
  try {
    workspaceReady = remoteRegistry().bindWorkspaceContext({
      remoteSessionId: msg.remoteSessionId,
      workspacePath: msg.workspacePath,
      workspaceIdentity: msg.workspaceIdentity,
      ...(msg.workspacePurpose ? { workspacePurpose: msg.workspacePurpose } : {}),
      ...(msg.legacyRouteHint ? { legacyWorkspaceIdentity: msg.legacyRouteHint } : {}),
      signal: bindAbortController.signal,
    });
  } catch (error) {
    logger.warn(
      `failed to bind remote workspace context, remoteSessionId=${msg.remoteSessionId}`,
      error,
    );
    parentPort.postMessage({
      type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
      requestId: msg.requestId,
      error: error instanceof Error ? error.message : String(error),
      ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? { reasonCode: error.code }
        : {}),
      ...(error &&
      typeof error === "object" &&
      "retryable" in error &&
      typeof error.retryable === "boolean"
        ? { retryable: error.retryable }
        : {}),
    });
    hostState.activeWorkspaceBindRequestIds.delete(msg.requestId);
    hostState.cancelledWorkspaceBindRequestIds.delete(msg.requestId);
    hostState.workspaceBindAbortControllers.delete(msg.requestId);
    return;
  }
  const current = remoteRegistry().getSession(msg.remoteSessionId);
  if (current) {
    // scope generation 换代后，旧 Renderer/手机 attachment 不得继续持有远端 IO facade。
    attachmentRegistry().detachStaleRemoteSessionAttachments(
      msg.remoteSessionId,
      current.generation,
    );
  }
  void workspaceReady
    .then(async () => {
      if (hostState.cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
        throw Object.assign(new Error("Remote workspace bind was canceled"), {
          code: REMOTE_BIND_CANCELED_ERROR_CODE,
          retryable: false,
        });
      }
      const currentSession = remoteRegistry().getSession(msg.remoteSessionId);
      if (!currentSession?.workspaceIdentity) {
        // Bug 原因：bind 完成前 logical session 可能被并发释放；旧实现直接 return，Main
        // 永远收不到 ACK。抛入统一失败链，确保每个 requestId 恰好 settle 一次。
        throw Object.assign(
          new Error(`远程 workspace bind 完成时 session 已失效: ${msg.remoteSessionId}`),
          {
            code: REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
            retryable: true,
          },
        );
      }
      const scope = {
        kind: "remote" as const,
        ...(currentSession.sourceServerId ? { sourceServerId: currentSession.sourceServerId } : {}),
        remoteSessionId: msg.remoteSessionId,
        workspacePath: msg.workspacePath,
        workspaceIdentity: currentSession.workspaceIdentity,
      };
      await remoteRegistry()
        .resolveScopedCapabilities(scope)
        ?.recordWorkspaceOpen?.({
          workspacePath: msg.workspacePath,
          workspaceIdentity: currentSession.workspaceIdentity,
          ...(msg.workspacePurpose ? { workspacePurpose: msg.workspacePurpose } : {}),
          ...(msg.legacyRouteHint ? { legacyWorkspaceIdentity: msg.legacyRouteHint } : {}),
          signal: bindAbortController.signal,
        });
      if (hostState.cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
        throw Object.assign(new Error("Remote workspace bind was canceled"), {
          code: REMOTE_BIND_CANCELED_ERROR_CODE,
          retryable: false,
        });
      }
      if (previous?.workspacePath && previous.workspaceIdentity) {
        controllerRuntime().removeSource({
          kind: "remote",
          ...(previous.sourceServerId ? { sourceServerId: previous.sourceServerId } : {}),
          remoteSessionId: msg.remoteSessionId,
          workspacePath: previous.workspacePath,
          workspaceIdentity: previous.workspaceIdentity,
        });
      }
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBound,
        requestId: msg.requestId,
        // Bug 原因：首次从旧 route tab 打开 Source workspace 时，Renderer 只拿到 stable
        // identity 会误认为没有旧 tab，随后 addTab 产生第二个 workspace。把本次 bind
        // 使用的旧 route 作为一次性 tab rekey 提示返回；它不是任务路由身份，手机端忽略。
        ...(msg.legacyRouteHint && msg.legacyRouteHint !== currentSession.workspaceIdentity
          ? { previousWorkspaceIdentity: msg.legacyRouteHint }
          : {}),
      });
      logger.info(
        `bound remote workspace context, remoteSessionId=${msg.remoteSessionId}, workspacePath=${msg.workspacePath}`,
      );
      hostState.activeWorkspaceBindRequestIds.delete(msg.requestId);
      hostState.cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      hostState.workspaceBindAbortControllers.delete(msg.requestId);
    })
    .catch((error) => {
      logger.warn(
        `failed to prepare bound remote workspace, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
      const normalizedError = hostState.cancelledWorkspaceBindRequestIds.has(msg.requestId)
        ? Object.assign(new Error("Remote workspace bind was canceled"), {
            code: REMOTE_BIND_CANCELED_ERROR_CODE,
            retryable: false,
          })
        : error;
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
        ...(normalizedError &&
        typeof normalizedError === "object" &&
        "code" in normalizedError &&
        typeof normalizedError.code === "string"
          ? { reasonCode: normalizedError.code }
          : {}),
        ...(normalizedError &&
        typeof normalizedError === "object" &&
        "retryable" in normalizedError &&
        typeof normalizedError.retryable === "boolean"
          ? { retryable: normalizedError.retryable }
          : {}),
      });
      hostState.activeWorkspaceBindRequestIds.delete(msg.requestId);
      hostState.cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      hostState.workspaceBindAbortControllers.delete(msg.requestId);
    });
  return;
}

export function handleDisposeRemoteWorkspaceSession(
  msg: DisposeRemoteWorkspaceSessionMessage,
): void {
  const disposedSession = remoteRegistry().getSession(msg.remoteSessionId);
  attachmentRegistry().detachRemoteSessionAttachments(msg.remoteSessionId);
  void remoteRegistry()
    .disposeSession(msg.remoteSessionId)
    .then(() => {
      if (disposedSession?.workspacePath && disposedSession.workspaceIdentity) {
        controllerRuntime().removeSource({
          kind: "remote",
          ...(disposedSession.sourceServerId
            ? { sourceServerId: disposedSession.sourceServerId }
            : {}),
          remoteSessionId: msg.remoteSessionId,
          workspacePath: disposedSession.workspacePath,
          workspaceIdentity: disposedSession.workspaceIdentity,
        });
      }
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceClosed,
        remoteSessionId: msg.remoteSessionId,
        reason: "disposed",
      });
      logWindowHostTopology("remote-session-disposed");
    })
    .catch((error) => {
      logger.warn(
        `failed to dispose remote logical session, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
    });
}

export async function handleAttachServicePort(
  msg: AttachServicePortMessage,
  port: Electron.MessagePortMain | undefined,
): Promise<void> {
  if (!port) {
    logger.error("attach-service-port message missing MessagePort");
    return;
  }
  if (
    msg.scope.kind === "local" &&
    hostState.databaseStartup?.coordinator.snapshot.phase !== "ready"
  ) {
    // 刷新/手机 attachment 复用同一 Host，等待现有准备，不启动第二个执行者。
    hostState.pendingStartupAttachments.set(msg.attachmentId, () => {
      attachmentRegistry().attach({ ...msg, port });
    });
    port.once("close", () => hostState.pendingStartupAttachments.delete(msg.attachmentId));
    return;
  }
  try {
    if (msg.clientMode === "web-remote-replayable" && msg.scope.kind === "source-settings") {
      throw new Error("Source settings attachments are Desktop-only");
    }
    if (msg.scope.kind === "remote") {
      // Bind 与 Attach 共用 parentPort，但 WSL 上一代 workspace release 可能仍在途。
      // 持有已转移 port 等待 Host 内 generation barrier，避免新 attachment 踩过旧 runtime 清理。
      await remoteRegistry().waitForScopedServices(msg.scope);
    }
    attachmentRegistry().attach({
      requestId: msg.requestId,
      attachmentId: msg.attachmentId,
      clientMode: msg.clientMode,
      scope: msg.scope,
      port,
    });
    logger.info(
      `attached scoped service port, attachmentId=${msg.attachmentId}, scope=${msg.scope.kind}, clientMode=${msg.clientMode}`,
    );
    logWindowHostTopology("attachment-added");
  } catch (error) {
    // 跨 logical session 或旧 identity 的 port 若继续暴露，会把远端请求路由到错误 source。
    // scope 校验失败必须关闭已转移端口并明确记录，禁止回退 active local services。
    rejectUnavailableAttachedServicePort(port, false);
    logger.warn(`failed to attach scoped service port, attachmentId=${msg.attachmentId}`, error);
  }
  return;
}

export function handleDetachServicePort(msg: DetachServicePortMessage): void {
  hostState.pendingStartupAttachments.delete(msg.attachmentId);
  attachmentRegistry().detach(msg.attachmentId);
  logger.info(`detached service port, attachmentId=${msg.attachmentId}`);
  logWindowHostTopology("attachment-removed");
  return;
}
