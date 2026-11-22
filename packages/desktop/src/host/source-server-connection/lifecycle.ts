import { scheduleOnlineRetry } from "./recovery.js";
import { clearRecoveryTimers } from "./state.js";
import { getStateByProfile, setState } from "./state.js";
import {
  SourceServerExplicitDisconnectError,
  SourceServerProfileRemovedError,
  type ManagerContext,
} from "./types.js";

export function disconnect(ctx: ManagerContext, sourceServerId: string): void {
  disconnectSource(ctx, sourceServerId);
}

export function removeProfile(ctx: ManagerContext, profileId: string): void {
  ctx.operationLogs.removeProfile(profileId);
  const canceledUpdateSources = new Set<string>();
  for (const flight of ctx.updateFlights) {
    if (flight.profileId !== profileId) continue;
    if (flight.sourceServerId) canceledUpdateSources.add(flight.sourceServerId);
    ctx.updateFlights.delete(flight);
    flight.controller.abort(new SourceServerProfileRemovedError(profileId));
  }
  const connectingSourceServerId = ctx.connectFlights.get(profileId)?.sourceServerId;
  const sourceOwnedOnlyByConnectingProfile =
    connectingSourceServerId &&
    !ctx.reconnectInputs.has(connectingSourceServerId) &&
    !ctx.onlineBySourceServerId.has(connectingSourceServerId)
      ? connectingSourceServerId
      : undefined;
  const currentSourceServerId =
    [...ctx.reconnectInputs].find(([, input]) => input.profile.profileId === profileId)?.[0] ??
    [...ctx.onlineBySourceServerId].find(([, online]) => online.profileId === profileId)?.[0] ??
    sourceOwnedOnlyByConnectingProfile;
  if (currentSourceServerId) {
    // Bug 原因：Directory 删除当前线路后，旧实现只删展示状态，恢复 owner、timer 和
    // 已解析的 secret 仍存活，断线后会继续使用已删除线路。删除当前线路等价于显式
    // 断开整个 Source；其他线路只能由用户后续手动选择，不能在这里静默接管。
    disconnectSource(ctx, currentSourceServerId, profileId);
    return;
  }

  const flight = ctx.connectFlights.get(profileId);
  if (flight) {
    ctx.connectFlights.delete(profileId);
    flight.controller.abort(new SourceServerProfileRemovedError(profileId));
  }
  for (const online of ctx.onlineBySourceServerId.values()) {
    online.profileIds.delete(profileId);
  }
  ctx.states.delete(profileId);
  ctx.compatibilityByProfileId.delete(profileId);
  for (const [sourceServerId, profileIds] of ctx.profileIdsBySourceServerId) {
    if (!profileIds.delete(profileId)) continue;
    if (profileIds.size === 0) ctx.profileIdsBySourceServerId.delete(sourceServerId);
  }
  // Bug 原因：非当前线路的更新可能已移除旧物理连接；取消后跳过更新收尾，原 owner
  // 会永久停在 updating。删除操作接回仍保留的恢复意图，不依赖已取消更新的迟到结果。
  for (const sourceServerId of canceledUpdateSources) {
    const input = ctx.reconnectInputs.get(sourceServerId);
    if (
      input &&
      !ctx.onlineBySourceServerId.has(sourceServerId) &&
      getStateByProfile(ctx, input.profile.profileId).state === "updating" &&
      ![...ctx.updateFlights].some((flight) => flight.sourceServerId === sourceServerId)
    )
      scheduleOnlineRetry(ctx, sourceServerId, 0);
  }
}

function disconnectSource(
  ctx: ManagerContext,
  sourceServerId: string,
  removedProfileId?: string,
): void {
  const online = ctx.onlineBySourceServerId.get(sourceServerId);
  const reconnectInput = ctx.reconnectInputs.get(sourceServerId);
  const profileIds = new Set(ctx.profileIdsBySourceServerId.get(sourceServerId) ?? []);
  for (const profileId of online?.profileIds ?? []) profileIds.add(profileId);
  if (reconnectInput) profileIds.add(reconnectInput.profile.profileId);
  for (const flight of ctx.updateFlights) {
    if (flight.sourceServerId !== sourceServerId) continue;
    ctx.updateFlights.delete(flight);
    flight.controller.abort(new SourceServerExplicitDisconnectError(sourceServerId));
    profileIds.add(flight.profileId);
  }

  // Bug 原因：意外断线会先摘除 online owner；显式断开若再用 online 是否存在判断生命周期，
  // 就只会清掉 timer 而永久遗留 retrying。必须在删除恢复索引前捕获 Source 的全部 Profile，
  // 中止仍在执行的 Source flight，并且无论当前是否还有物理连接都发布 offline 终态；否则
  // 已进入 bootstrapping 的迟到成功还会覆盖用户刚刚提交的 offline 意图。
  clearRecoveryTimers(ctx, sourceServerId);
  for (const [profileId, flight] of ctx.connectFlights) {
    if (flight.sourceServerId !== sourceServerId) continue;
    if (ctx.connectFlights.get(profileId) === flight) {
      ctx.connectFlights.delete(profileId);
    }
    flight.controller.abort(
      profileId === removedProfileId
        ? new SourceServerProfileRemovedError(profileId)
        : new SourceServerExplicitDisconnectError(sourceServerId),
    );
    profileIds.add(profileId);
  }
  if (removedProfileId) profileIds.delete(removedProfileId);
  ctx.reconnectInputs.delete(sourceServerId);
  ctx.profileIdsBySourceServerId.delete(sourceServerId);
  if (online) ctx.onlineBySourceServerId.delete(sourceServerId);
  if (removedProfileId) {
    ctx.connectionInvalidatedEmitter.fire({
      sourceServerId,
      reason: "profile-removed",
      recoverable: false,
    });
  }
  online?.projectSubscription?.dispose();
  online?.connection.dispose();
  for (const profileId of profileIds) {
    setState(ctx, profileId, { state: "offline", sourceServerId });
  }
  if (removedProfileId) {
    ctx.states.delete(removedProfileId);
    ctx.compatibilityByProfileId.delete(removedProfileId);
  }
}

export function dispose(ctx: ManagerContext): void {
  const reason = Object.assign(new Error("Source Server manager disposed"), {
    code: "remote-connection-canceled",
  });
  for (const flight of ctx.updateFlights) flight.controller.abort(reason);
  ctx.updateFlights.clear();
  // 更新的重握手可能尚无 online owner，不能只遍历 online 表来回收在途连接。
  for (const flight of ctx.connectFlights.values()) flight.controller.abort(reason);
  ctx.connectFlights.clear();
  for (const sourceServerId of ctx.retryTimers.keys()) clearRecoveryTimers(ctx, sourceServerId);
  for (const sourceServerId of ctx.offlineProbeTimers.keys())
    clearRecoveryTimers(ctx, sourceServerId);
  // 离线恢复也持有连接意图；只清 online 会让被中止 flight 的迟到 catch 重新排重试。
  for (const sourceServerId of new Set([
    ...ctx.reconnectInputs.keys(),
    ...ctx.onlineBySourceServerId.keys(),
  ])) {
    ctx.ports.disconnect(sourceServerId);
  }
  for (const adapter of ctx.adapters.values()) adapter.dispose?.();
  ctx.adapters.clear();
  ctx.stateEmitter.dispose();
  ctx.reconnectEmitter.dispose();
  ctx.connectionInvalidatedEmitter.dispose();
  ctx.operationLogs.dispose();
}
