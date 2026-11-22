import {
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type WindowHostAttachmentScope,
  type WindowHostRemoteWorkspaceDescriptor,
  type WorkspacePurpose,
} from "@zcode/shared";
import { buildConnectionKey, toSessionSnapshot } from "./connectionKeys.js";
import { cancelConnect, connect } from "./connect.js";
import {
  clearIdleTimer,
  disposeEntry,
  resolveEntry,
  scheduleWslIdleDispose,
} from "./entryLifecycle.js";
import { startWorkspaceRelease } from "./workspaceRuntime.js";
import {
  bindWorkspaceContext,
  disposeSession,
  getOnlineSource,
  resolveScopedCapabilities,
  resolveScopedServices,
} from "./workspaceBinding.js";
import {
  WindowRemoteConnectCancelledError,
  WindowRemoteConnectionUnavailableError,
  type RegistryContext,
  type WindowRemoteAssetDirs,
  type WindowRemoteConnectionRegistryOptions,
  type WindowRemoteLogicalSessionSnapshot,
} from "./types.js";

export function createWindowRemoteConnectionRegistry<TServices, TCapabilities = never>(
  options: WindowRemoteConnectionRegistryOptions<TServices, TCapabilities>,
) {
  const ctx: RegistryContext<TServices, TCapabilities> = {
    options,
    entriesByKey: new Map(),
    entriesBySourceServerId: new Map(),
    sessionsById: new Map(),
    pendingSessionsByRequestId: new Map(),
    runtime: { disposed: false, disposePromise: null },
    wslIdleTtlMs: options.wslIdleTtlMs ?? 60_000,
    logicalReplacementRetryDelaysMs:
      options.logicalReplacementRetryDelaysMs ?? ([500, 1_000, 2_000] as const),
  };

  return {
    async connectSource(params: {
      target: RemoteTarget;
      remoteAssets: WindowRemoteAssetDirs;
      membershipIntent?: "add" | "retain";
      existingSourceServerId?: string;
    }) {
      if (ctx.runtime.disposed) throw new WindowRemoteConnectCancelledError();
      if (params.existingSourceServerId) {
        const current = getOnlineSource(ctx, params.existingSourceServerId);
        if (current) return { sourceServerId: params.existingSourceServerId, handle: current };
      }
      const entry = resolveEntry(ctx, { ...params, key: buildConnectionKey(params.target) });
      await entry.ready;
      const owner = entry.sourceServerId
        ? ctx.entriesBySourceServerId.get(entry.sourceServerId)
        : entry;
      if (
        !owner ||
        owner.disposed ||
        owner.state !== "online" ||
        !owner.sourceServerId ||
        !owner.handle
      )
        throw new WindowRemoteConnectionUnavailableError("host-connection");
      return { sourceServerId: owner.sourceServerId, handle: owner.handle };
    },
    getOnlineSource: (sourceServerId: string) => getOnlineSource(ctx, sourceServerId),
    listConnections() {
      return Array.from(new Set(ctx.entriesByKey.values()), (entry) => ({
        sourceServerId: entry.sourceServerId,
        target: stripRemoteTargetSecrets(entry.target),
        state: entry.state,
      }));
    },
    connect: (params: Parameters<typeof connect<TServices, TCapabilities>>[1]) =>
      connect(ctx, params),
    async openWorkspaceOnSource(params: {
      requestId: string;
      sourceServerId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      workspacePurpose?: WorkspacePurpose;
      assertCurrent(): Promise<void>;
    }): Promise<WindowHostRemoteWorkspaceDescriptor> {
      const entry = ctx.entriesBySourceServerId.get(params.sourceServerId);
      // 手机项目导航只取得已在线连接，不走 resolveEntry/connector，也不等待后台恢复。
      if (!entry || entry.disposed || entry.state !== "online" || !entry.handle)
        throw new WindowRemoteConnectionUnavailableError(params.sourceServerId);
      return connect(
        ctx,
        { ...params, target: entry.target, remoteAssets: {} },
        {
          entry,
          services: entry.handle.services,
          assertCurrent: params.assertCurrent,
        },
      );
    },
    cancelConnect: (requestId: string) => cancelConnect(ctx, requestId),
    bindWorkspaceContext: (
      params: Parameters<typeof bindWorkspaceContext<TServices, TCapabilities>>[1],
    ) => bindWorkspaceContext(ctx, params),
    resolveScopedServices: (scope: WindowHostAttachmentScope) => resolveScopedServices(ctx, scope),
    resolveScopedCapabilities: (scope: WindowHostAttachmentScope) =>
      resolveScopedCapabilities(ctx, scope),
    getSession(remoteSessionId: string): WindowRemoteLogicalSessionSnapshot | null {
      const session = ctx.sessionsById.get(remoteSessionId);
      return session ? toSessionSnapshot(session) : null;
    },
    listSessions(): WindowRemoteLogicalSessionSnapshot[] {
      return Array.from(ctx.sessionsById.values(), toSessionSnapshot);
    },
    /**
     * 已就绪、未释放的连接（按连接去重，同一 SSH 连接上的多个 logical session 只出现一次）。
     * 供窗口级事实广播给每个远程 Host，例如动态工作流的用户选择（launch.md「The user's choice」）。
     */
    listReadyConnections(): Array<{ target: RemoteTarget; services: TServices }> {
      return Array.from(ctx.entriesByKey.values()).flatMap((entry) =>
        entry.handle && !entry.disposed
          ? [{ target: entry.target, services: entry.handle.services }]
          : [],
      );
    },
    findSessionForWorkspace(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): WindowRemoteLogicalSessionSnapshot | null {
      const matches = Array.from(ctx.sessionsById.values()).filter(
        (session) =>
          session.workspacePath === params.workspacePath &&
          session.workspaceIdentity === params.workspaceIdentity,
      );
      const onlineMatches = matches.filter(
        (session) => session.state === "online" && session.sourceAvailability === "online",
      );
      if (onlineMatches.length > 1 || (onlineMatches.length === 0 && matches.length > 1)) {
        throw new Error(
          `远程 workspace scope 匹配到多个 logical session，workspacePath=${params.workspacePath}`,
        );
      }
      const match = onlineMatches[0] ?? matches[0];
      return match ? toSessionSnapshot(match) : null;
    },
    getStats(): { connectionCount: number; logicalSessionCount: number } {
      return {
        connectionCount: new Set(ctx.entriesByKey.values()).size,
        logicalSessionCount: ctx.sessionsById.size,
      };
    },
    setWorkspaceRunningTaskCount(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      runningTaskCount: number;
    }): void {
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      // 同一 Source entry 可能被多条 route alias 引用；workspace 生命周期副作用只执行一次。
      for (const entry of new Set(ctx.entriesByKey.values())) {
        if (entry.target.kind !== "wsl" || !entry.workspaceKeys.has(workspaceKey)) {
          continue;
        }
        if (params.runningTaskCount > 0) {
          entry.runningTaskCountByWorkspaceKey.set(workspaceKey, params.runningTaskCount);
          clearIdleTimer(entry);
        } else {
          entry.runningTaskCountByWorkspaceKey.delete(workspaceKey);
          const state = entry.workspaceRuntimeByKey.get(workspaceKey);
          if (state?.pendingReleaseGeneration) {
            void startWorkspaceRelease(
              ctx,
              entry,
              workspaceKey,
              state,
              state.pendingReleaseGeneration,
            )?.catch(() => undefined);
          }
          scheduleWslIdleDispose(ctx, entry, entry.idleReason);
        }
      }
    },
    async waitForScopedServices(scope: WindowHostAttachmentScope): Promise<TServices> {
      if (scope.kind !== "remote") {
        throw new Error("远程连接 registry 不能解析 local attachment scope");
      }
      const session = ctx.sessionsById.get(scope.remoteSessionId);
      if (!session) {
        throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
      }
      await session.workspaceReady;
      return resolveScopedServices(ctx, scope);
    },
    disposeSession: (remoteSessionId: string) => disposeSession(ctx, remoteSessionId),
    async dispose(): Promise<void> {
      if (ctx.runtime.disposePromise) {
        return ctx.runtime.disposePromise;
      }
      ctx.runtime.disposed = true;
      for (const requestId of Array.from(ctx.pendingSessionsByRequestId.keys())) {
        cancelConnect(ctx, requestId);
      }
      const entries = new Set(Array.from(ctx.sessionsById.values(), (session) => session.entry));
      for (const entry of ctx.entriesByKey.values()) {
        entries.add(entry);
      }
      ctx.sessionsById.clear();
      ctx.pendingSessionsByRequestId.clear();
      ctx.runtime.disposePromise = Promise.all(
        Array.from(entries, (entry) => disposeEntry(ctx, entry)),
      ).then(() => undefined);
      return ctx.runtime.disposePromise;
    },
  };
}
