import {
  applyStableWorkspaceIdentity,
  promoteOrJoinSourceOwner,
  removeEntryOwners,
  shouldKeepConnectionAlive,
  subscribeEntryHandle,
} from "./ownership.js";
import { failRecovery } from "./recovery.js";
import {
  WindowRemoteConnectCancelledError,
  WindowRemoteConnectionUnavailableError,
  type ConnectionEntry,
  type RegistryContext,
  type WindowRemoteEntryParams,
} from "./types.js";

export function clearIdleTimer<TServices, TCapabilities>(
  entry: ConnectionEntry<TServices, TCapabilities>,
): void {
  if (!entry.idleTimer) {
    return;
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
}

export function hasRunningTasks<TServices, TCapabilities>(
  entry: ConnectionEntry<TServices, TCapabilities>,
): boolean {
  return Array.from(entry.runningTaskCountByWorkspaceKey.values()).some((count) => count > 0);
}

export function scheduleWslIdleDispose<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  reason: string,
): void {
  clearIdleTimer(entry);
  entry.idleReason = reason;
  if (
    entry.target.kind !== "wsl" ||
    entry.disposed ||
    entry.sessions.size > 0 ||
    hasRunningTasks(entry)
  ) {
    return;
  }
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    if (
      ctx.entriesByKey.get(entry.key) !== entry ||
      entry.disposed ||
      entry.sessions.size > 0 ||
      hasRunningTasks(entry)
    ) {
      return;
    }
    void disposeEntry(ctx, entry);
  }, ctx.wslIdleTtlMs);
}

export async function disposeEntry<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
): Promise<void> {
  if (entry.disposePromise) {
    return entry.disposePromise;
  }
  entry.disposed = true;
  clearIdleTimer(entry);
  if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
  entry.replacementRetryTimer = undefined;
  failRecovery(entry, new WindowRemoteConnectCancelledError());
  entry.state = "closing";
  entry.abortController.abort();
  entry.closeSubscription?.dispose();
  entry.closeSubscription = undefined;
  entry.reconnectSubscription?.dispose();
  entry.reconnectSubscription = undefined;
  removeEntryOwners(ctx, entry);
  ctx.options.onConnectionChanged?.();
  entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
  return entry.disposePromise;
}

export async function disposeSupersededEntryTransport<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
): Promise<void> {
  if (entry.disposePromise) return entry.disposePromise;
  // Bug 原因：自动恢复的旧 entry 在手动重连抢占 connection key 后只是 return，
  // 旧 handle 上的 Manager state/reconnect 订阅永不释放。这里只回收失去 owner 的 transport
  // wrapper。旧 logical session 已经不可路由，必须在新 owner 接管时同步退休；否则每轮
  // 手动重连都会累积一份 disconnected session，下一次断开后 workspace scope 变成多解。
  for (const remoteSessionId of entry.sessions) {
    const session = ctx.sessionsById.get(remoteSessionId);
    if (
      !session ||
      session.entry !== entry ||
      session.state !== "disconnected" ||
      ctx.pendingSessionsByRequestId.get(session.requestId) === session
    ) {
      continue;
    }
    ctx.sessionsById.delete(remoteSessionId);
    entry.sessions.delete(remoteSessionId);
  }
  entry.disposed = true;
  clearIdleTimer(entry);
  if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
  entry.replacementRetryTimer = undefined;
  // Bug 原因：abort 只取消 transport，不能结束 connect 对 recoveryReady 的等待。
  // 旧 entry 被抢占后不再收到恢复事件，必须在释放订阅前主动拒绝其等待者。
  failRecovery(entry, new WindowRemoteConnectCancelledError());
  entry.abortController.abort();
  entry.closeSubscription?.dispose();
  entry.closeSubscription = undefined;
  entry.reconnectSubscription?.dispose();
  entry.reconnectSubscription = undefined;
  entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
  return entry.disposePromise;
}

export function createEntry<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  params: WindowRemoteEntryParams,
): ConnectionEntry<TServices, TCapabilities> {
  const abortController = new AbortController();
  const entry: ConnectionEntry<TServices, TCapabilities> = {
    key: params.key,
    target: params.target,
    state: "connecting" as const,
    abortController,
    sessions: new Set<string>(),
    ready: Promise.resolve(undefined as never),
    disposed: false,
    transitionEpoch: 0,
    closePhase: "none",
    idleReason: "wsl-host-idle",
    workspaceKeys: new Set(),
    runningTaskCountByWorkspaceKey: new Map(),
    workspaceRuntimeByKey: new Map(),
  };
  entry.ready = ctx.options
    .connect({
      target: params.target,
      membershipIntent: params.membershipIntent,
      existingSourceServerId: params.existingSourceServerId,
      remoteAssets: params.remoteAssets,
      signal: abortController.signal,
      ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
    })
    .then(async (handle) => {
      // 关闭可能早于不可中断的握手返回；disposePromise 已完成时仍必须释放迟到的 socket。
      if (entry.disposed) {
        await handle.dispose();
        return handle;
      }
      entry.handle = handle;
      if (entry.disposed || (entry.sessions.size === 0 && !shouldKeepConnectionAlive(ctx, entry))) {
        // 修复原因：底层 SSH/WSL connector 可能无法中断认证或部署。
        // 最后一个 logical owner 取消后，迟到的成功结果必须立即释放，不能复活旧连接。
        await disposeEntry(ctx, entry);
        return handle;
      }
      const sourceServerId = ctx.options.resolveSourceServerId?.(handle);
      if (params.existingSourceServerId && sourceServerId !== params.existingSourceServerId) {
        await disposeEntry(ctx, entry);
        throw new WindowRemoteConnectionUnavailableError(params.existingSourceServerId);
      }
      const sourceOwner = sourceServerId
        ? await promoteOrJoinSourceOwner(ctx, entry, handle, sourceServerId)
        : entry;
      if (sourceOwner !== entry) return handle;
      entry.target = handle.reusedConnectionTarget ?? entry.target;
      entry.state = "online";
      subscribeEntryHandle(ctx, entry, handle);
      ctx.options.onConnectionChanged?.();
      for (const remoteSessionId of entry.sessions) {
        const session = ctx.sessionsById.get(remoteSessionId);
        if (!session || session.cancelled) {
          continue;
        }
        session.target = entry.target;
        session.state = "online";
        session.sourceAvailability = "online";
        if (sourceServerId) {
          applyStableWorkspaceIdentity(session, sourceServerId);
        }
      }
      return handle;
    })
    .catch((error) => {
      entry.state = "failed";
      removeEntryOwners(ctx, entry);
      ctx.options.onConnectionChanged?.();
      for (const remoteSessionId of Array.from(entry.sessions)) {
        const session = ctx.sessionsById.get(remoteSessionId);
        if (!session) {
          continue;
        }
        session.state = "failed";
        session.sourceAvailability = "offline";
        ctx.sessionsById.delete(remoteSessionId);
        ctx.pendingSessionsByRequestId.delete(session.requestId);
      }
      entry.sessions.clear();
      throw error;
    });
  ctx.entriesByKey.set(entry.key, entry);
  ctx.options.onConnectionChanged?.();
  return entry;
}

export function resolveEntry<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  params: WindowRemoteEntryParams,
): ConnectionEntry<TServices, TCapabilities> {
  const existing = ctx.entriesByKey.get(params.key);
  if (
    existing &&
    !existing.disposed &&
    !existing.abortController.signal.aborted &&
    (existing.state !== "disconnected" ||
      (existing.closePhase === "recovering" && shouldKeepConnectionAlive(ctx, existing)))
  ) {
    clearIdleTimer(existing);
    return existing;
  }
  const created = createEntry(ctx, params);
  if (existing && existing !== created) {
    // Bug 原因：terminal entry 被新 owner 覆盖后仍保留 Manager close/reconnect 订阅，
    // 每次手动重连都会泄漏一代 wrapper。物理 Source 仍由 Manager 持有，只回收 wrapper。
    void disposeSupersededEntryTransport(ctx, existing);
  }
  return created;
}
