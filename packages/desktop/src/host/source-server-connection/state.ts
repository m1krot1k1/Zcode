import type { SourceServerConnectionStateSnapshot } from "@zcode/shared";
import { preserveCompatibilityState } from "./compatibility.js";
import type { ManagerContext } from "./types.js";

export function getStateByProfile(
  ctx: ManagerContext,
  profileId: string,
): SourceServerConnectionStateSnapshot {
  return (
    ctx.states.get(profileId) ?? {
      profileId,
      state: "absent",
      updatedAt: ctx.now(),
    }
  );
}

export function listStates(ctx: ManagerContext): SourceServerConnectionStateSnapshot[] {
  return [...ctx.states.values()];
}

export function profileIdsForSource(
  ctx: ManagerContext,
  sourceServerId: string,
  fallbackProfileId: string,
): string[] {
  const remembered = ctx.profileIdsBySourceServerId.get(sourceServerId);
  return remembered && remembered.size > 0 ? [...remembered] : [fallbackProfileId];
}

export function rememberSourceProfiles(
  ctx: ManagerContext,
  sourceServerId: string,
  profileIds: Iterable<string>,
): void {
  const remembered = ctx.profileIdsBySourceServerId.get(sourceServerId) ?? new Set<string>();
  for (const profileId of profileIds) remembered.add(profileId);
  ctx.profileIdsBySourceServerId.set(sourceServerId, remembered);
}

export function setState(
  ctx: ManagerContext,
  profileId: string,
  patch: Omit<SourceServerConnectionStateSnapshot, "profileId" | "updatedAt">,
): void {
  const previous = ctx.states.get(profileId);
  const inheritedCompatibility =
    patch.state === "retrying" || patch.state === "offline" || patch.state === "updating"
      ? (ctx.compatibilityByProfileId.get(profileId) ??
        (previous ? preserveCompatibilityState(previous) : {}))
      : {};
  const snapshot: SourceServerConnectionStateSnapshot = {
    profileId,
    // 恢复/离线/更新是连接生命周期状态，不会产生新的版本兼容事实；保留最后一次
    // Host 握手判定，避免 UI 在状态跃迁时丢失当前/可用/最低版本字段。
    ...inheritedCompatibility,
    ...patch,
    updatedAt: ctx.now(),
  };
  if (snapshot.currentVersion || snapshot.updateAvailability) {
    ctx.compatibilityByProfileId.set(profileId, preserveCompatibilityState(snapshot));
  }
  ctx.states.set(profileId, snapshot);
  if (previous?.state === "online" && snapshot.state !== "online" && previous.sourceServerId) {
    // 最近在线是最后在线时刻，不是握手开始时间；失败重试不能把离线设备伪装成刚在线。
    void ctx.options.directory
      .recordLastOnline?.(previous.sourceServerId, snapshot.updatedAt)
      .catch((error: unknown) =>
        ctx.options.logWarn?.(
          "Failed to persist Source Server last online time",
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
  }
  ctx.stateEmitter.fire(snapshot);
}

export function clearRecoveryTimers(ctx: ManagerContext, sourceServerId: string): void {
  const retryTimer = ctx.retryTimers.get(sourceServerId);
  if (retryTimer) clearTimeout(retryTimer);
  ctx.retryTimers.delete(sourceServerId);
  const probeTimer = ctx.offlineProbeTimers.get(sourceServerId);
  if (probeTimer) clearTimeout(probeTimer);
  ctx.offlineProbeTimers.delete(sourceServerId);
}
