import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import { handleConnectionClosed, handleConnectionReconnected } from "./recovery.js";
import { disposeSupersededEntryTransport } from "./entryLifecycle.js";
import type {
  ConnectionEntry,
  LogicalSession,
  RegistryContext,
  WindowRemoteConnectionHandle,
} from "./types.js";

export function shouldKeepConnectionAlive<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
): boolean {
  return Boolean(entry.handle && ctx.options.shouldKeepConnectionAlive?.(entry.handle));
}

export function removeEntryOwners<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
): void {
  for (const [key, owner] of ctx.entriesByKey) {
    if (owner === entry) ctx.entriesByKey.delete(key);
  }
  if (entry.sourceServerId && ctx.entriesBySourceServerId.get(entry.sourceServerId) === entry) {
    ctx.entriesBySourceServerId.delete(entry.sourceServerId);
  }
}

export function canOwnManagedSource<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
): boolean {
  return (
    !entry.disposed &&
    !entry.abortController.signal.aborted &&
    (entry.state === "connecting" ||
      entry.state === "online" ||
      (entry.state === "disconnected" &&
        entry.closePhase === "recovering" &&
        shouldKeepConnectionAlive(ctx, entry)))
  );
}

export function assignSessionToSourceOwner<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  session: LogicalSession<TServices, TCapabilities>,
  owner: ConnectionEntry<TServices, TCapabilities>,
  sourceServerId: string,
): void {
  session.entry = owner;
  session.target = owner.target;
  session.state = owner.state === "online" ? "online" : owner.state;
  session.sourceAvailability = owner.state === "online" ? "online" : "offline";
  applyStableWorkspaceIdentity(session, sourceServerId);
}

/**
 * Source 身份已知后，logical session 的 workspace identity/workspaceKey 只允许是
 * `remote:server:<sourceServerId>:<path>`；调用方传入的 route identity 只保留为 legacyRouteHint。
 * 握手上线、Source owner 转交、在线 entry 直接 join 三条路径必须共用这一处规则。
 */
export function applyStableWorkspaceIdentity<TServices, TCapabilities>(
  session: LogicalSession<TServices, TCapabilities>,
  sourceServerId: string,
): void {
  session.sourceServerId = sourceServerId;
  if (!session.workspacePath) return;
  session.legacyWorkspaceIdentity ??= session.workspaceIdentity;
  session.workspaceIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: sourceServerId,
    workspacePath: session.workspacePath,
  });
  session.workspaceKey = session.workspaceIdentity;
  session.entry.workspaceKeys.add(session.workspaceIdentity);
}

export function subscribeEntryHandle<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
): void {
  entry.handle = handle;
  entry.closeSubscription = handle.onDidClose?.((event) => {
    handleConnectionClosed(ctx, entry, event);
  });
  entry.reconnectSubscription = handle.onDidReconnect?.(() => {
    handleConnectionReconnected(ctx, entry);
  });
}

export async function takeOverRecoveringSourceOwner<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  provisional: ConnectionEntry<TServices, TCapabilities>,
  owner: ConnectionEntry<TServices, TCapabilities>,
  handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  sourceServerId: string,
): Promise<void> {
  const previousHandle = owner.handle;
  owner.closeSubscription?.dispose();
  owner.closeSubscription = undefined;
  owner.reconnectSubscription?.dispose();
  owner.reconnectSubscription = undefined;
  if (owner.replacementRetryTimer) {
    clearTimeout(owner.replacementRetryTimer);
    owner.replacementRetryTimer = undefined;
  }
  owner.target = provisional.target;
  subscribeEntryHandle(ctx, owner, handle);

  for (const remoteSessionId of Array.from(provisional.sessions)) {
    const session = ctx.sessionsById.get(remoteSessionId);
    if (!session || session.entry !== provisional) continue;
    provisional.sessions.delete(remoteSessionId);
    owner.sessions.add(remoteSessionId);
    assignSessionToSourceOwner(ctx, session, owner, sourceServerId);
    // 当前 request 只是 recovery waiter，不能被 replaceDisconnectedSessions 当成上一代
    // logical owner 再换代一次；恢复完成后它会 join 真正的 replacement session。
    session.state = "connecting";
  }
  removeEntryOwners(ctx, provisional);
  ctx.entriesByKey.set(provisional.key, owner);
  provisional.handle = undefined;
  await disposeSupersededEntryTransport(ctx, provisional);
  await Promise.resolve(previousHandle?.dispose());
  handleConnectionReconnected(ctx, owner);
}

export async function promoteOrJoinSourceOwner<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  sourceServerId: string,
): Promise<ConnectionEntry<TServices, TCapabilities>> {
  entry.sourceServerId = sourceServerId;
  const existing = ctx.entriesBySourceServerId.get(sourceServerId);
  if (!existing || existing === entry || !canOwnManagedSource(ctx, existing)) {
    ctx.entriesBySourceServerId.set(sourceServerId, entry);
    return entry;
  }

  if (
    existing.state === "disconnected" &&
    existing.closePhase === "recovering" &&
    !existing.reconnectFlight
  ) {
    // 不同 Profile 的手动连接已经拿到同一 Source 的新 handle，而旧 wrapper 尚未收到
    // reconnect（Manager 在发布点统一 fire，通常旧 wrapper 会先换代并把 entry 置回 online；
    // 只有它仍停在 recovering 且没有换代 flight 时才由新 handle 直接接管，避免 join 挂起）。
    await takeOverRecoveringSourceOwner(ctx, entry, existing, handle, sourceServerId);
    return existing;
  }

  // Bug 根因：route entry 在握手后曾直接成为 online owner，导致同一 Source 的多个
  // Profile 各自持有 logical wrapper。握手得到稳定身份后，竞争失败的 provisional
  // entry 必须在发布 online 前把 waiter/session 转交给 canonical Source entry。
  for (const remoteSessionId of Array.from(entry.sessions)) {
    const session = ctx.sessionsById.get(remoteSessionId);
    if (!session || session.entry !== entry) continue;
    entry.sessions.delete(remoteSessionId);
    existing.sessions.add(remoteSessionId);
    assignSessionToSourceOwner(ctx, session, existing, sourceServerId);
  }
  removeEntryOwners(ctx, entry);
  ctx.entriesByKey.set(entry.key, existing);
  await disposeSupersededEntryTransport(ctx, entry);
  return existing;
}
