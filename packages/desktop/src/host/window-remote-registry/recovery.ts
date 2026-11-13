import { toSessionSnapshot } from "./connectionKeys.js";
import { clearIdleTimer, disposeSupersededEntryTransport } from "./entryLifecycle.js";
import { shouldKeepConnectionAlive } from "./ownership.js";
import { prepareWorkspaceRuntime } from "./workspaceRuntime.js";
import {
  WindowRemoteConnectionTransitionStaleError,
  type ConnectionEntry,
  type LogicalSession,
  type RegistryContext,
  type WindowRemoteConnectionCloseEvent,
} from "./types.js";

export function beginRecovery<TServices, TCapabilities>(
  entry: ConnectionEntry<TServices, TCapabilities>,
): void {
  if (entry.recoveryReady) return;
  entry.recoveryFailure = undefined;
  entry.recoveryReady = new Promise<void>((resolve, reject) => {
    entry.resolveRecovery = resolve;
    entry.rejectRecovery = reject;
  });
  // 无手动 waiter 时终态拒绝也不得变成 unhandled rejection。
  void entry.recoveryReady.catch(() => undefined);
}

export function completeRecovery<TServices, TCapabilities>(
  entry: ConnectionEntry<TServices, TCapabilities>,
): void {
  entry.resolveRecovery?.();
  entry.recoveryReady = undefined;
  entry.resolveRecovery = undefined;
  entry.rejectRecovery = undefined;
  entry.closePhase = "none";
  entry.lastRecoveryAttemptNotified = undefined;
  entry.recoveryFailure = undefined;
}

export function notifyEntrySessionsClosed<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  event: WindowRemoteConnectionCloseEvent,
): void {
  for (const remoteSessionId of entry.sessions) {
    const session = ctx.sessionsById.get(remoteSessionId);
    if (!session || ctx.pendingSessionsByRequestId.get(session.requestId) === session) continue;
    ctx.options.onSessionClosed?.({ remoteSessionId, ...event });
  }
}

export function failRecovery<TServices, TCapabilities>(
  entry: ConnectionEntry<TServices, TCapabilities>,
  error: Error,
): void {
  entry.recoveryFailure = error;
  entry.rejectRecovery?.(error);
  entry.recoveryReady = undefined;
  entry.resolveRecovery = undefined;
  entry.rejectRecovery = undefined;
}

export function createRecoveryFailure<TServices, TCapabilities>(
  entry: ConnectionEntry<TServices, TCapabilities>,
  event: WindowRemoteConnectionCloseEvent,
): Error {
  const error = new Error(event.error || `Remote connection recovery exhausted: ${entry.key}`);
  if (event.reasonCode) Object.assign(error, { code: event.reasonCode });
  if (event.retryable !== undefined) Object.assign(error, { retryable: event.retryable });
  if (event.recoveryAttempt !== undefined) {
    Object.assign(error, { recoveryAttempt: event.recoveryAttempt });
  }
  if (event.recoveryLimit !== undefined) {
    Object.assign(error, { recoveryLimit: event.recoveryLimit });
  }
  return error;
}

export function rollbackRecoveryReplacements<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
): void {
  const replacements = entry.recoveryReplacements;
  if (!replacements) return;
  entry.recoveryReplacements = undefined;
  for (const { previous, current } of replacements) {
    if (ctx.sessionsById.get(current.remoteSessionId) === current) {
      ctx.sessionsById.delete(current.remoteSessionId);
    }
    entry.sessions.delete(current.remoteSessionId);
    previous.state = "disconnected";
    previous.sourceAvailability = "offline";
    ctx.sessionsById.set(previous.remoteSessionId, previous);
    entry.sessions.add(previous.remoteSessionId);
  }
}

export function listDisconnectedSessions<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
): LogicalSession<TServices, TCapabilities>[] {
  return [...entry.sessions]
    .map((remoteSessionId) => ctx.sessionsById.get(remoteSessionId))
    .filter(
      (session): session is LogicalSession<TServices, TCapabilities> =>
        Boolean(session) &&
        session?.state === "disconnected" &&
        ctx.pendingSessionsByRequestId.get(session.requestId) !== session,
    );
}

export function isCurrentRecoveryReplacement<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  current: LogicalSession<TServices, TCapabilities>,
  transitionEpoch: number,
): boolean {
  return (
    !entry.disposed &&
    ctx.entriesByKey.get(entry.key) === entry &&
    entry.transitionEpoch === transitionEpoch &&
    entry.state === "online" &&
    ctx.sessionsById.get(current.remoteSessionId) === current &&
    entry.recoveryReplacements?.some((replacement) => replacement.current === current) === true
  );
}

export function handleConnectionClosed<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  event: WindowRemoteConnectionCloseEvent,
): void {
  // Bug 原因：逻辑替换重试曾跨物理断线存活，定时器会冒充重连把 entry 标回 online，
  // 耗尽预算后还会提前放行 recovery waiter。close 必须撤销旧 transport 的逻辑重试。
  if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
  entry.replacementRetryTimer = undefined;
  if (entry.disposed || entry.state === "closing") return;
  if (entry.state === "disconnected") {
    if (entry.closePhase === "recovering" && event.recoverable !== false) {
      if (
        event.recoveryAttempt !== undefined &&
        event.recoveryAttempt !== entry.lastRecoveryAttemptNotified
      ) {
        // Bug 原因：Manager 会发布 1/3、2/3、3/3，但 registry 曾把 disconnected 后的
        // recoverable close 全部丢弃，Renderer 永远停在首轮。只按 attempt 去重并继续投影。
        entry.lastRecoveryAttemptNotified = event.recoveryAttempt;
        notifyEntrySessionsClosed(ctx, entry, event);
      }
      return;
    }
    if (entry.closePhase !== "recovering" || event.recoverable !== false) return;
    entry.transitionEpoch += 1;
    entry.closePhase = "terminal";
    failRecovery(entry, createRecoveryFailure(entry, event));
    notifyEntrySessionsClosed(ctx, entry, event);
    return;
  }
  entry.transitionEpoch += 1;
  const hadRecoveryReplacement = Boolean(entry.recoveryReplacements?.length);
  if (hadRecoveryReplacement) {
    rollbackRecoveryReplacements(ctx, entry);
  }
  if (
    (entry.state === "connecting" || hadRecoveryReplacement || Boolean(entry.recoveryReady)) &&
    event.recoverable === false
  ) {
    // Bug 原因：恢复换代已经先发布了 provisional session id，终态 close 若直接沿用它，
    // Renderer 会收到一个从未完成连接的幽灵 id；同时 recoveryReady 无人 reject，join 永久等待。
    // 终态到达时先恢复上一代 logical session，再拒绝 recovery flight 并广播真实离线 owner。
    failRecovery(entry, createRecoveryFailure(entry, event));
  }
  entry.state = "disconnected";
  ctx.options.onConnectionChanged?.();
  entry.closePhase = event.recoverable === true ? "recovering" : "terminal";
  entry.lastRecoveryAttemptNotified = event.recoveryAttempt;
  if (entry.closePhase === "recovering") beginRecovery(entry);
  clearIdleTimer(entry);
  if (!shouldKeepConnectionAlive(ctx, entry) && ctx.entriesByKey.get(entry.key) === entry) {
    ctx.entriesByKey.delete(entry.key);
  }
  for (const remoteSessionId of entry.sessions) {
    const session = ctx.sessionsById.get(remoteSessionId);
    if (!session || ctx.pendingSessionsByRequestId.get(session.requestId) === session) continue;
    session.state = "disconnected";
    session.sourceAvailability = "offline";
    ctx.options.onSessionClosed?.({ remoteSessionId, ...event });
  }
}

export async function replaceDisconnectedSessions<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
): Promise<void> {
  if (
    entry.disposed ||
    !entry.handle ||
    (entry.state !== "disconnected" && entry.state !== "online")
  )
    return;
  const transitionEpoch = entry.transitionEpoch;
  // 物理 Source 已经恢复；logical replacement 的失败只属于对应 workspace，不能把
  // 已提交 sibling 的共享 transport 再标回 disconnected。
  entry.state = "online";
  ctx.entriesByKey.set(entry.key, entry);
  const disconnectedSessions = listDisconnectedSessions(ctx, entry);
  let firstReplacementError: unknown;
  let hasReplacementError = false;
  for (const previous of disconnectedSessions) {
    if (
      entry.disposed ||
      ctx.entriesByKey.get(entry.key) !== entry ||
      entry.transitionEpoch !== transitionEpoch ||
      entry.state !== "online"
    ) {
      throw new WindowRemoteConnectionTransitionStaleError();
    }
    if (
      ctx.sessionsById.get(previous.remoteSessionId) !== previous ||
      previous.state !== "disconnected"
    ) {
      continue;
    }
    const current: LogicalSession<TServices, TCapabilities> = {
      ...previous,
      remoteSessionId: ctx.options.createId(),
      target: entry.target,
      generation: previous.generation + 1,
      state: "connecting",
      sourceAvailability: "offline",
      sourceServerId: ctx.options.resolveSourceServerId?.(entry.handle) ?? previous.sourceServerId,
      workspaceReady: Promise.resolve(),
      workspaceReadyState: "pending",
      cancelled: false,
      rejectCancellation: () => undefined,
      cancellation: new Promise<never>(() => undefined),
    };
    entry.recoveryReplacements = [{ previous, current }];
    entry.sessions.delete(previous.remoteSessionId);
    ctx.sessionsById.delete(previous.remoteSessionId);
    ctx.sessionsById.set(current.remoteSessionId, current);
    entry.sessions.add(current.remoteSessionId);
    try {
      await prepareWorkspaceRuntime(ctx, current);
      if (!isCurrentRecoveryReplacement(ctx, entry, current, transitionEpoch)) {
        throw new WindowRemoteConnectionTransitionStaleError();
      }
      const commit = (): boolean => {
        if (!isCurrentRecoveryReplacement(ctx, entry, current, transitionEpoch)) {
          return false;
        }
        current.state = "online";
        current.sourceAvailability = "online";
        // 当前 workspace 的外部 owner 已提交；后续 sibling 失败不得再回滚本 generation。
        entry.recoveryReplacements = undefined;
        return true;
      };
      if (ctx.options.onSessionReconnected) {
        await ctx.options.onSessionReconnected({
          previous: toSessionSnapshot(previous),
          current: toSessionSnapshot(current),
          services: entry.handle.services,
          isCurrent: () => isCurrentRecoveryReplacement(ctx, entry, current, transitionEpoch),
          commit,
        });
      } else {
        commit();
      }
      if (
        ctx.sessionsById.get(current.remoteSessionId) !== current ||
        current.state !== "online" ||
        current.sourceAvailability !== "online" ||
        entry.recoveryReplacements !== undefined
      ) {
        throw new WindowRemoteConnectionTransitionStaleError();
      }
    } catch (error) {
      rollbackRecoveryReplacements(ctx, entry);
      if (
        ctx.sessionsById.get(current.remoteSessionId) === current &&
        current.state === "online" &&
        current.sourceAvailability === "online" &&
        entry.recoveryReplacements === undefined
      ) {
        // commit 是不可逆边界；提交后的旁路日志/通知异常只能上报，不能把已经对外发布的
        // generation 再塞回 rollback 路径。
        ctx.options.onSessionReconnectError?.(error);
        continue;
      }
      if (
        error instanceof WindowRemoteConnectionTransitionStaleError ||
        entry.disposed ||
        ctx.entriesByKey.get(entry.key) !== entry ||
        entry.transitionEpoch !== transitionEpoch ||
        entry.state !== "online"
      ) {
        throw new WindowRemoteConnectionTransitionStaleError();
      }
      // 单个 workspace 的 replacement 失败不能阻断同一 Source 上后续 sibling；继续提交
      // 其余 workspace，最后只为仍 disconnected 的 owner 安排下一轮 retry。
      if (!hasReplacementError) firstReplacementError = error;
      hasReplacementError = true;
    }
  }
  if (hasReplacementError) throw firstReplacementError;
  completeRecovery(entry);
}

export function scheduleLogicalReplacementRetry<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  attempt: number,
  error: unknown,
): void {
  const delay = ctx.logicalReplacementRetryDelaysMs[attempt];
  if (
    entry.disposed ||
    entry.state !== "online" ||
    listDisconnectedSessions(ctx, entry).length === 0
  )
    return;
  if (delay === undefined) {
    const terminalError = error instanceof Error ? error : new Error(String(error));
    for (const session of listDisconnectedSessions(ctx, entry)) {
      ctx.options.onSessionClosed?.({
        remoteSessionId: session.remoteSessionId,
        exitCode: null,
        signal: null,
        recoverable: false,
        error: terminalError.message,
        ...("code" in terminalError && typeof terminalError.code === "string"
          ? { reasonCode: terminalError.code }
          : {}),
        ...("retryable" in terminalError && typeof terminalError.retryable === "boolean"
          ? { retryable: terminalError.retryable }
          : {}),
      });
    }
    // logical replacement 预算耗尽不能污染仍在线的 Source entry；等待中的手动 join
    // 继续使用已恢复 transport，并由自身 workspace admission 决定结果。
    completeRecovery(entry);
    return;
  }
  if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
  const retryEpoch = entry.transitionEpoch;
  entry.replacementRetryTimer = setTimeout(() => {
    // 迟到回调只属于安排时仍在线的 transport；先校验，避免摘掉新 epoch 的 timer。
    if (entry.state !== "online" || entry.transitionEpoch !== retryEpoch) return;
    entry.replacementRetryTimer = undefined;
    handleConnectionReconnected(ctx, entry, attempt + 1);
  }, delay);
}

export function handleConnectionReconnected<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  attempt = 0,
): void {
  if (
    entry.reconnectFlight ||
    entry.disposed ||
    (entry.state !== "disconnected" && entry.state !== "online")
  )
    return;
  const currentOwner = ctx.entriesByKey.get(entry.key);
  if (currentOwner && currentOwner !== entry) {
    // Bug 原因：自动 retry 与用户手动重连可能共享 Manager 的新 connection。迟到的旧 entry
    // 曾无条件 set 回 connection key，制造两个 online logical session 并互相 dispose。
    // connection key 已有新 owner 时，旧恢复 flight 必须失效，交给 Host 清理离线 session。
    void disposeSupersededEntryTransport(ctx, entry);
    return;
  }
  if (entry.closePhase === "terminal") {
    // 新物理连接到达后，旧终态失败不能污染新线路的 join；挂回完成前用新屏障等待。
    entry.closePhase = "recovering";
    beginRecovery(entry);
  }
  let shouldRetry = false;
  let retryError: unknown;
  const flight = replaceDisconnectedSessions(ctx, entry)
    .catch((error) => {
      ctx.options.onSessionReconnectError?.(error);
      shouldRetry =
        !(error instanceof WindowRemoteConnectionTransitionStaleError) &&
        listDisconnectedSessions(ctx, entry).length > 0;
      retryError = error;
    })
    .finally(() => {
      if (entry.reconnectFlight === flight) entry.reconnectFlight = undefined;
      if (shouldRetry) scheduleLogicalReplacementRetry(ctx, entry, attempt, retryError);
    });
  entry.reconnectFlight = flight;
}
