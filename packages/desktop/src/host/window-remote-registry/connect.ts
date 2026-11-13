import {
  buildServerRemoteWorkspaceIdentity,
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type WindowHostRemoteWorkspaceDescriptor,
  type WorkspacePurpose,
} from "@zcode/shared";
import { buildConnectionKey } from "./connectionKeys.js";
import {
  clearIdleTimer,
  disposeEntry,
  resolveEntry,
  scheduleWslIdleDispose,
} from "./entryLifecycle.js";
import { applyStableWorkspaceIdentity, shouldKeepConnectionAlive } from "./ownership.js";
import { prepareWorkspaceRuntime, requestWorkspaceRelease } from "./workspaceRuntime.js";
import {
  WindowRemoteConnectCancelledError,
  WindowRemoteConnectionUnavailableError,
  type ConnectionEntry,
  type LogicalSession,
  type RegistryContext,
  type WindowRemoteAssetDirs,
} from "./types.js";

export interface WindowRemoteConnectParams {
  requestId: string;
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  confirmSourceServerInstall?: boolean;
}

export async function connect<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  params: WindowRemoteConnectParams,
  admission?: {
    entry: ConnectionEntry<TServices, TCapabilities>;
    services: TServices;
    assertCurrent(): Promise<void>;
  },
): Promise<WindowHostRemoteWorkspaceDescriptor> {
  if (ctx.runtime.disposed) {
    throw new Error("窗口 Host 的远程连接 registry 已释放");
  }
  if (ctx.pendingSessionsByRequestId.has(params.requestId)) {
    throw new Error(`远程连接 requestId 重复，requestId=${params.requestId}`);
  }

  const remoteSessionId = ctx.options.createId();
  const key = buildConnectionKey(params.target);
  const previousEntry = ctx.entriesByKey.get(key);
  const initialEntry =
    admission?.entry ??
    resolveEntry(ctx, {
      key,
      target: params.target,
      remoteAssets: params.remoteAssets,
      ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
    });
  let reusedConnectionTarget =
    initialEntry.state === "online" ? stripRemoteTargetSecrets(initialEntry.target) : undefined;
  let rejectCancellation!: (error: WindowRemoteConnectCancelledError) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const sourceServerId = initialEntry.handle
    ? ctx.options.resolveSourceServerId?.(initialEntry.handle)
    : undefined;
  // 复用已在线的 Host 时不会再触发握手回调，仍须先绑定稳定 workspace 身份。
  const workspaceIdentity =
    sourceServerId && params.workspacePath
      ? buildServerRemoteWorkspaceIdentity({
          serverId: sourceServerId,
          workspacePath: params.workspacePath,
        })
      : params.workspaceIdentity;
  const session: LogicalSession<TServices, TCapabilities> = {
    ...(sourceServerId ? { sourceServerId } : {}),
    remoteSessionId,
    requestId: params.requestId,
    target: initialEntry.target,
    ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(params.workspacePurpose ? { workspacePurpose: params.workspacePurpose } : {}),
    ...(params.workspaceIdentity ? { legacyWorkspaceIdentity: params.workspaceIdentity } : {}),
    generation: 1,
    state: initialEntry.state === "online" ? "online" : "connecting",
    sourceAvailability: initialEntry.state === "online" ? "online" : "offline",
    entry: initialEntry,
    workspaceReady: Promise.resolve(),
    workspaceReadyState: "pending",
    cancelled: false,
    rejectCancellation,
    cancellation,
  };
  initialEntry.sessions.add(remoteSessionId);
  if (sourceServerId) {
    // Bug 原因：entry 已在线时 connect 能直接拿到 sourceServerId，却没有像握手上线、Source owner
    // 转交和 bindWorkspaceContext 那样把 identity 归一成 remote:server:*。Renderer 对未换代的
    // legacy 条目手动重连、或 Host 为无 context 的 connect 补 route identity 时，owner 去重按原值
    // 比对必然不命中，会为同一 workspace 发布第二个 online logical session，并把 legacy identity
    // 当权威值返回；随后 bind 把它改写成 stable，两条 session 同 key，findSessionForWorkspace 多解。
    applyStableWorkspaceIdentity(session, sourceServerId);
  }
  if (!session.workspaceKey) {
    const initialWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
    if (initialWorkspaceKey) {
      initialEntry.workspaceKeys.add(initialWorkspaceKey);
      session.workspaceKey = initialWorkspaceKey;
    }
  }
  ctx.sessionsById.set(remoteSessionId, session);
  ctx.pendingSessionsByRequestId.set(params.requestId, session);
  const preparationController = new AbortController();

  try {
    const initialTransitionEpoch = initialEntry.transitionEpoch;
    const readyHandle = await Promise.race([initialEntry.ready, cancellation]);
    reusedConnectionTarget ??= readyHandle.reusedConnectionTarget;
    // 加入别人的 connecting entry 也没有使用本次凭据；以最终 owner 的实际目标投影结果。
    if (previousEntry === initialEntry) {
      reusedConnectionTarget = stripRemoteTargetSecrets(session.entry.target);
    }
    const entry = session.entry;
    const transitionEpoch = entry === initialEntry ? initialTransitionEpoch : entry.transitionEpoch;
    if (entry.recoveryFailure) throw entry.recoveryFailure;
    if (entry.recoveryReady) {
      await Promise.race([entry.recoveryReady, cancellation]);
    }
    if (entry.recoveryFailure) throw entry.recoveryFailure;
    await Promise.race([
      prepareWorkspaceRuntime(ctx, session, preparationController.signal),
      cancellation,
    ]);
    if (admission) await Promise.race([admission.assertCurrent(), cancellation]);
    if (
      session.cancelled ||
      ctx.sessionsById.get(remoteSessionId) !== session ||
      entry.disposed ||
      ctx.entriesByKey.get(entry.key) !== entry ||
      entry.transitionEpoch !== transitionEpoch ||
      entry.state !== "online" ||
      (admission && entry.handle?.services !== admission.services)
    ) {
      if (!session.cancelled && ctx.sessionsById.get(remoteSessionId) === session) {
        throw new WindowRemoteConnectionUnavailableError(remoteSessionId);
      }
      throw new WindowRemoteConnectCancelledError();
    }
    const existingWorkspaceOwner =
      session.workspaceKey && session.workspacePath && session.workspaceIdentity
        ? Array.from(ctx.sessionsById.values()).find(
            (candidate) =>
              candidate !== session &&
              // Bug 根因：Manager 已按 sourceServerId 复用物理连接，但 Registry 曾只在
              // 同 route entry 内查找 workspace owner。不同 Profile 握手到同一 Source 后
              // 必须按稳定 Source 身份收敛；未识别 Source 仍只允许同 entry 复用。
              (candidate.entry === entry ||
                (session.sourceServerId !== undefined &&
                  candidate.sourceServerId === session.sourceServerId)) &&
              candidate.workspaceKey === session.workspaceKey &&
              candidate.workspacePath === session.workspacePath &&
              candidate.workspaceIdentity === session.workspaceIdentity &&
              candidate.state === "online" &&
              candidate.sourceAvailability === "online" &&
              // Bug 原因：entry online 会先把 logical session 标成 online，但 workspace identity
              // preparation 可能仍在运行。join 只能复用已经可安全暴露 scoped services 的 owner。
              candidate.workspaceReadyState === "ready",
          )
        : undefined;
    if (existingWorkspaceOwner) {
      // Bug 原因：recovery replacement 与 Bot/手动 join 曾各创建一个 online logical
      // session。workspace owner 已恢复时，join caller 复用唯一 owner，不发布第二份 session。
      ctx.sessionsById.delete(remoteSessionId);
      entry.sessions.delete(remoteSessionId);
      if (existingWorkspaceOwner.entry !== entry && entry.sessions.size === 0) {
        // 不同 Profile 创建的 provisional wrapper 已失去最后一个 logical owner；只回收
        // wrapper/Manager 订阅，handle.dispose 不会断开 Manager 持有的物理 Source connection。
        await disposeEntry(ctx, entry);
      }
      return {
        ...(existingWorkspaceOwner.sourceServerId
          ? { sourceServerId: existingWorkspaceOwner.sourceServerId }
          : {}),
        ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
        remoteSessionId: existingWorkspaceOwner.remoteSessionId,
        target: stripRemoteTargetSecrets(existingWorkspaceOwner.target),
        workspacePath: existingWorkspaceOwner.workspacePath,
        workspaceIdentity: existingWorkspaceOwner.workspaceIdentity,
        ...(existingWorkspaceOwner.workspacePurpose
          ? { workspacePurpose: existingWorkspaceOwner.workspacePurpose }
          : {}),
        generation: existingWorkspaceOwner.generation,
      };
    }
    session.state = "online";
    session.sourceAvailability = "online";
    return {
      ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
      ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
      remoteSessionId,
      target: stripRemoteTargetSecrets(session.target),
      ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
      ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
      ...(session.workspacePurpose ? { workspacePurpose: session.workspacePurpose } : {}),
      generation: session.generation,
    };
  } catch (error) {
    const entry = session.entry;
    if (ctx.sessionsById.get(remoteSessionId) === session) {
      ctx.sessionsById.delete(remoteSessionId);
      entry.sessions.delete(remoteSessionId);
      session.state = "failed";
      session.sourceAvailability = "offline";
      if (
        entry.sessions.size === 0 &&
        !shouldKeepConnectionAlive(ctx, entry) &&
        (entry.target.kind === "docker" || entry.target.kind === "server")
      ) {
        await disposeEntry(ctx, entry);
      }
    }
    throw error;
  } finally {
    // logical caller 取消或已结束后，迟到的远端 stat 不得再进入身份绑定；信号只属于
    // 这次 preparation，不能 abort 同 Source 其他工作区共用的物理连接。
    preparationController.abort();
    if (ctx.pendingSessionsByRequestId.get(params.requestId) === session) {
      ctx.pendingSessionsByRequestId.delete(params.requestId);
    }
  }
}

export function cancelConnect<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  requestId: string,
): void {
  const session = ctx.pendingSessionsByRequestId.get(requestId);
  if (!session || session.cancelled) {
    return;
  }
  session.cancelled = true;
  ctx.pendingSessionsByRequestId.delete(requestId);
  ctx.sessionsById.delete(session.remoteSessionId);
  session.entry.sessions.delete(session.remoteSessionId);
  const workspaceRelease = requestWorkspaceRelease(ctx, {
    entry: session.entry,
    remoteSessionId: session.remoteSessionId,
    workspaceKey: session.workspaceKey,
    workspaceGeneration: session.workspaceGeneration,
  });
  void workspaceRelease?.catch(() => undefined);
  session.rejectCancellation(new WindowRemoteConnectCancelledError());
  if (session.entry.sessions.size === 0) {
    if (session.entry.target.kind === "ssh" && session.entry.state === "connecting") {
      // Bug 根因：最后一个 waiter 取消后，旧 entry 仍以 connecting 留在复用表；立即重连会
      // 继续等待已经 aborted 的 readiness，并沿用上一次凭据。先按对象身份退休旧 entry，
      // 再触发底层取消；迟到的旧 completion 不能删除或复活同 key 的新连接。
      if (ctx.entriesByKey.get(session.entry.key) === session.entry) {
        ctx.entriesByKey.delete(session.entry.key);
      }
      session.entry.state = "closing";
      session.entry.abortController.abort();
    } else if (
      (session.entry.target.kind === "docker" || session.entry.target.kind === "server") &&
      session.entry.state === "connecting"
    ) {
      // Bug 根因：Docker/Server 的 pending transport 不可被 logical cancel 中断，但也不能继续
      // 占用 connection key，否则下一次 dedicated connect 会错误复用已经没有 waiter 的旧 flight。
      if (ctx.entriesByKey.get(session.entry.key) === session.entry) {
        ctx.entriesByKey.delete(session.entry.key);
      }
    } else if (shouldKeepConnectionAlive(ctx, session.entry)) {
      // Managed Source 的物理连接归 Manager；registry handle 只持有 logical wrapper/订阅。
      void disposeEntry(ctx, session.entry);
    } else if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
      scheduleWslIdleDispose(ctx, session.entry, "cancelled-logical-connect");
    } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
      // ready SSH connection 是窗口 cache；取消一次 logical attach 不应把后续 workspace 的
      // 复用连接一并销毁，真实窗口 Host shutdown 时统一释放。
      clearIdleTimer(session.entry);
    } else if (session.entry.handle) {
      void disposeEntry(ctx, session.entry);
    }
  }
}
