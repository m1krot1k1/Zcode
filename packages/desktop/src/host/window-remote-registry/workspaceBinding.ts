import {
  buildServerRemoteWorkspaceIdentity,
  type WorkspacePurpose,
  type WindowHostAttachmentScope,
} from "@zcode/shared";
import { clearIdleTimer, disposeEntry, scheduleWslIdleDispose } from "./entryLifecycle.js";
import { shouldKeepConnectionAlive } from "./ownership.js";
import { prepareWorkspaceRuntime, requestWorkspaceRelease } from "./workspaceRuntime.js";
import {
  WindowRemoteConnectionUnavailableError,
  type ConnectionEntry,
  type RegistryContext,
  type WindowRemoteConnectionHandle,
} from "./types.js";

export function bindWorkspaceContext<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  params: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: WorkspacePurpose;
    legacyWorkspaceIdentity?: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  const session = ctx.sessionsById.get(params.remoteSessionId);
  if (!session) {
    throw new Error(`未找到远程 logical session，remoteSessionId=${params.remoteSessionId}`);
  }
  const previousOwnership = {
    entry: session.entry,
    remoteSessionId: session.remoteSessionId,
    workspaceKey: session.workspaceKey,
    workspaceGeneration: session.workspaceGeneration,
  };
  const previousSession = {
    workspacePath: session.workspacePath,
    legacyWorkspaceIdentity: session.legacyWorkspaceIdentity,
    workspaceIdentity: session.workspaceIdentity,
    workspacePurpose: session.workspacePurpose,
    generation: session.generation,
    workspaceKey: session.workspaceKey,
    workspaceGeneration: session.workspaceGeneration,
    workspaceReady: session.workspaceReady,
    workspaceReadyState: session.workspaceReadyState,
  };
  session.workspacePath = params.workspacePath;
  session.legacyWorkspaceIdentity = params.legacyWorkspaceIdentity ?? params.workspaceIdentity;
  session.workspaceIdentity = session.sourceServerId
    ? buildServerRemoteWorkspaceIdentity({
        serverId: session.sourceServerId,
        workspacePath: params.workspacePath,
      })
    : params.workspaceIdentity;
  session.workspacePurpose = params.workspacePurpose ?? session.workspacePurpose;
  session.generation += 1;
  // Bug 原因：managed Source 会把 params 中的 route identity 换成 stable identity，
  // workspaceKey 若仍从原参数取值，session 就会同时持有两个身份源。
  session.workspaceKey = session.workspaceIdentity.trim() || params.workspacePath;
  session.entry.workspaceKeys.add(session.workspaceKey);
  const nextWorkspaceKey = session.workspaceKey;
  const ready = prepareWorkspaceRuntime(ctx, session, params.signal);
  return ready.then(
    () => {
      if (previousOwnership.workspaceKey !== nextWorkspaceKey) {
        const release = requestWorkspaceRelease(ctx, previousOwnership);
        void release?.catch(() => undefined);
      }
    },
    (error) => {
      const failedOwnership = {
        entry: session.entry,
        remoteSessionId: session.remoteSessionId,
        workspaceKey: nextWorkspaceKey,
        workspaceGeneration: session.workspaceGeneration,
      };
      session.workspacePath = previousSession.workspacePath;
      session.legacyWorkspaceIdentity = previousSession.legacyWorkspaceIdentity;
      session.workspaceIdentity = previousSession.workspaceIdentity;
      session.workspacePurpose = previousSession.workspacePurpose;
      session.generation = previousSession.generation;
      session.workspaceKey = previousSession.workspaceKey;
      session.workspaceGeneration = previousSession.workspaceGeneration;
      session.workspaceReady = previousSession.workspaceReady;
      session.workspaceReadyState = previousSession.workspaceReadyState;
      if (
        nextWorkspaceKey &&
        !Array.from(ctx.sessionsById.values()).some(
          (candidate) => candidate !== session && candidate.workspaceKey === nextWorkspaceKey,
        )
      ) {
        session.entry.workspaceKeys.delete(nextWorkspaceKey);
      }
      const release = requestWorkspaceRelease(ctx, failedOwnership);
      void release?.catch(() => undefined);
      throw error;
    },
  );
}

export function resolveScopedHandle<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  scope: WindowHostAttachmentScope,
): WindowRemoteConnectionHandle<TServices, TCapabilities> {
  if (scope.kind !== "remote") {
    throw new Error("远程连接 registry 不能解析 local attachment scope");
  }
  const session = ctx.sessionsById.get(scope.remoteSessionId);
  if (!session) {
    throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
  }
  if (
    session.workspacePath !== scope.workspacePath ||
    session.workspaceIdentity !== scope.workspaceIdentity
  ) {
    throw new Error(
      `远程 attachment scope 与 logical session 不匹配，remoteSessionId=${scope.remoteSessionId}`,
    );
  }
  if (
    session.state !== "online" ||
    session.sourceAvailability !== "online" ||
    session.workspaceReadyState !== "ready" ||
    !session.entry.handle
  ) {
    throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
  }
  return session.entry.handle;
}

export function resolveScopedServices<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  scope: WindowHostAttachmentScope,
): TServices {
  return resolveScopedHandle(ctx, scope).services;
}

export function resolveScopedCapabilities<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  scope: WindowHostAttachmentScope,
): TCapabilities | undefined {
  return resolveScopedHandle(ctx, scope).capabilities;
}

export async function disposeSession<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  remoteSessionId: string,
): Promise<void> {
  const session = ctx.sessionsById.get(remoteSessionId);
  if (!session) {
    return;
  }
  ctx.sessionsById.delete(remoteSessionId);
  ctx.pendingSessionsByRequestId.delete(session.requestId);
  session.entry.sessions.delete(remoteSessionId);
  const workspaceRelease = requestWorkspaceRelease(ctx, {
    entry: session.entry,
    remoteSessionId,
    workspaceKey: session.workspaceKey,
    workspaceGeneration: session.workspaceGeneration,
  });
  if (session.entry.sessions.size === 0) {
    if (shouldKeepConnectionAlive(ctx, session.entry)) {
      // Bug 原因：把“物理 Source 常驻”误当成“logical wrapper 常驻”，关最后 tab
      // 后 close/reconnect 订阅会永久残留。handle.dispose 不会断开 Manager 物理连接。
      await disposeEntry(ctx, session.entry);
    } else if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
      scheduleWslIdleDispose(ctx, session.entry, "last-logical-session-disposed");
    } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
      // R1 只迁移 SSH pool 的 owner：ready connection 继续保持 window-scoped cache，
      // logical session 清空不等于连接退出；真实窗口 Host shutdown 时统一释放。
      clearIdleTimer(session.entry);
    } else {
      await disposeEntry(ctx, session.entry);
    }
  }
  await workspaceRelease?.catch(() => undefined);
}

export function getOnlineSource<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  sourceServerId: string,
): WindowRemoteConnectionHandle<TServices, TCapabilities> | undefined {
  const entry: ConnectionEntry<TServices, TCapabilities> | undefined =
    ctx.entriesBySourceServerId.get(sourceServerId);
  return entry && !entry.disposed && entry.state === "online" ? entry.handle : undefined;
}
