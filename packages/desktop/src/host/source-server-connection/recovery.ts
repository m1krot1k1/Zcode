import {
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  type ConnectionProfile,
  type RemoteTarget,
} from "@zcode/shared";
import type { ServerRemoteConnection } from "../serverRemoteConnection.js";
import { isSourceServerAutomaticRecoveryTerminalState } from "../sourceServerRecoveryPolicy.js";
import { connectForSource } from "./connect.js";
import { isAutomaticRecoveryUserActionCode, readErrorRetryable } from "./compatibility.js";
import { createConcurrencyGate } from "./concurrency.js";
import { profileIdsForSource, setState } from "./state.js";
import {
  SourceServerExplicitDisconnectError,
  SourceServerProfileRemovedError,
  type ManagerContext,
  type OnlineConnection,
  type StartupReconnectResult,
} from "./types.js";

export const ONLINE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
export const OFFLINE_PROBE_INTERVAL_MS = 2 * 60_000;

export async function reconnectOnStartup(
  ctx: ManagerContext,
  candidates: Array<{
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
  }>,
  options: { maxConcurrency?: number; timeoutMs?: number } = {},
): Promise<StartupReconnectResult[]> {
  if (candidates.length === 0) return [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const globalGate = createConcurrencyGate(Math.max(1, options.maxConcurrency ?? 3));
  // Bug 原因：多个 Docker Source 共用本机 Docker daemon、磁盘和 CPU。三条冷启动 probe
  // 同时校验大体积 release 时，单条手动连接只需约 4.6 秒，三条并发却会一起撞上 10 秒
  // 上限。Docker 冷启动在 transport 内串行，SSH 仍可占用其余全局槽位。
  const dockerGate = createConcurrencyGate(1);
  const reconnectCandidate = async (
    candidate: (typeof candidates)[number],
  ): Promise<StartupReconnectResult> => {
    const releaseTransport =
      candidate.target.kind === "docker" ? await dockerGate.acquire() : undefined;
    const releaseGlobal = await globalGate.acquire();
    const abortController = new AbortController();
    const startedAt = Date.now();
    let diagnosticPhase = "queued";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ctx.ports.connect({
          profile: candidate.profile,
          target: candidate.target,
          membershipIntent: "retain",
          context: { signal: abortController.signal },
          onDiagnosticPhase: (phase) => {
            diagnosticPhase = phase;
          },
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Source Server startup reconnect timed out after ${timeoutMs}ms`));
            abortController.abort();
          }, timeoutMs);
        }),
      ]);
      return { profileId: candidate.profile.profileId, status: "online" };
    } catch (error) {
      if (error instanceof Error && error.message.includes("startup reconnect timed out")) {
        ctx.options.logWarn?.(
          `Source Server startup reconnect timeout diagnostic profile=${
            candidate.profile.profileId
          } transport=${candidate.target.kind} phase=${diagnosticPhase} elapsedMs=${Date.now() - startedAt}`,
          error,
        );
      }
      return {
        profileId: candidate.profile.profileId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
      releaseGlobal();
      releaseTransport?.();
    }
  };
  // 最近在线的 Source 对应用户最可能仍在使用的 workspace。首个候选独占启动窗口，
  // 避免和其余 Source 同时 probe/握手而在应用冷启动峰值中耗尽 10 秒预算；完成后其余
  // Source 再按全局 3 并发继续，不改变单 Source 超时和只尝试一次的合同。
  const [firstCandidate, ...remainingCandidates] = candidates;
  const firstResult = await reconnectCandidate(firstCandidate!);
  return [firstResult, ...(await Promise.all(remainingCandidates.map(reconnectCandidate)))];
}

export function handleUnexpectedClose(
  ctx: ManagerContext,
  sourceServerId: string,
  reason: string,
  connection: ServerRemoteConnection,
): void {
  const online = ctx.onlineBySourceServerId.get(sourceServerId);
  // 只处理属于当前 online owner 的关闭；已被替换或从未发布的连接迟到的 close 不得拆掉后继者。
  if (!online || online.connection !== connection) return;
  if ([...ctx.updateFlights].some((flight) => flight.sourceServerId === sourceServerId)) {
    invalidateOnlineConnectionForUpdate(ctx, sourceServerId, online);
    return;
  }
  ctx.onlineBySourceServerId.delete(sourceServerId);
  // Bug 原因：意外断线后旧 RPC generation 只从在线表移除，却没有显式释放 protocol/socket；
  // 多次重连会让旧 generation 的 pending 状态依赖 GC。先摘 owner 再 dispose，重复 close 回调会
  // 因 online 表已无该 Source 而幂等返回。
  online.projectSubscription?.dispose();
  online.connection.dispose();
  for (const profileId of online.profileIds) {
    setState(ctx, profileId, {
      state: "retrying",
      sourceServerId,
      ...(reason ? { error: reason } : {}),
      recoveryAttempt: 1,
      recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
    });
  }
  scheduleOnlineRetry(ctx, sourceServerId, 0);
}

export function invalidateOnlineConnectionForUpdate(
  ctx: ManagerContext,
  sourceServerId: string,
  online: OnlineConnection,
): void {
  if (ctx.onlineBySourceServerId.get(sourceServerId) !== online) return;
  // Bug 原因：显式更新过去只替换 Manager 内的物理连接，没有先失效仍指向旧 services 的
  // logical workspace；更新成功后 UI 会看到 online，但 scoped RPC 仍命中已关闭 generation。
  // 先摘物理 owner 并发布一次 Source 级失效，再释放连接，Registry 才能 fail-closed 后换代。
  ctx.onlineBySourceServerId.delete(sourceServerId);
  for (const profileId of online.profileIds) {
    setState(ctx, profileId, { state: "updating", sourceServerId });
  }
  ctx.connectionInvalidatedEmitter.fire({
    sourceServerId,
    reason: "update",
  });
  online.projectSubscription?.dispose();
  online.connection.dispose();
}

export function scheduleOnlineRetry(
  ctx: ManagerContext,
  sourceServerId: string,
  attempt: number,
): void {
  const input = ctx.reconnectInputs.get(sourceServerId);
  const delay = ONLINE_RETRY_DELAYS_MS[attempt];
  if (!input || delay === undefined) {
    enterOfflineProbe(ctx, sourceServerId);
    return;
  }
  const existing = ctx.retryTimers.get(sourceServerId);
  if (existing) clearTimeout(existing);
  for (const profileId of profileIdsForSource(ctx, sourceServerId, input.profile.profileId)) {
    setState(ctx, profileId, {
      state: "retrying",
      sourceServerId,
      recoveryAttempt: attempt + 1,
      recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
    });
  }
  const timer = setTimeout(() => {
    ctx.retryTimers.delete(sourceServerId);
    void connectForSource(
      ctx,
      {
        profile: input.profile,
        target: input.target,
        context: input.context,
      },
      sourceServerId,
    ).catch((error) => {
      if (
        error instanceof SourceServerExplicitDisconnectError ||
        error instanceof SourceServerProfileRemovedError ||
        stopAutomaticRecoveryForTerminalFailure(ctx, sourceServerId, error)
      ) {
        return;
      }
      if (attempt + 1 < ONLINE_RETRY_DELAYS_MS.length) {
        scheduleOnlineRetry(ctx, sourceServerId, attempt + 1);
      } else {
        enterOfflineProbe(ctx, sourceServerId, error);
      }
    });
  }, delay);
  ctx.retryTimers.set(sourceServerId, timer);
}

export function enterOfflineProbe(
  ctx: ManagerContext,
  sourceServerId: string,
  error?: unknown,
): void {
  const input = ctx.reconnectInputs.get(sourceServerId);
  if (!input) return;
  const normalized = error === undefined ? undefined : normalizeRemoteConnectionError(error);
  if (normalized) {
    // Bug 原因：预算耗尽后的最终 cause 只留在 state.error，而 UI 按合同不展示裸 Host
    // 原文，导致诊断信息无稳定出口。终态每轮只记一条 warn，不按探测心跳刷盘。
    ctx.options.logWarn?.(
      `[source-server] recovery budget exhausted source=${sourceServerId}`,
      error instanceof Error ? error : new Error(normalized.message),
    );
  }
  const errorCode =
    normalized?.code &&
    normalized.code !== "remote-connection-unknown" &&
    isPublicZCodeErrorCode(normalized.code)
      ? normalized.code
      : REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE;
  for (const profileId of profileIdsForSource(ctx, sourceServerId, input.profile.profileId)) {
    setState(ctx, profileId, {
      state: "offline",
      sourceServerId,
      recoveryAttempt: ONLINE_RETRY_DELAYS_MS.length,
      recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      recoveryBudgetExhausted: true,
      retryable: true,
      ...(normalized ? { error: normalized.message } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  }
  const existing = ctx.offlineProbeTimers.get(sourceServerId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    ctx.offlineProbeTimers.delete(sourceServerId);
    void connectForSource(
      ctx,
      {
        profile: input.profile,
        target: input.target,
        context: input.context,
      },
      sourceServerId,
    ).catch((error) => {
      if (
        error instanceof SourceServerExplicitDisconnectError ||
        error instanceof SourceServerProfileRemovedError ||
        stopAutomaticRecoveryForTerminalFailure(ctx, sourceServerId, error)
      ) {
        return;
      }
      enterOfflineProbe(ctx, sourceServerId, error);
    });
  }, OFFLINE_PROBE_INTERVAL_MS);
  ctx.offlineProbeTimers.set(sourceServerId, timer);
}

export function stopAutomaticRecoveryForTerminalFailure(
  ctx: ManagerContext,
  sourceServerId: string,
  error: unknown,
): boolean {
  const input = ctx.reconnectInputs.get(sourceServerId);
  const ownerState = input ? ctx.states.get(input.profile.profileId) : undefined;
  const normalized = normalizeRemoteConnectionError(error);
  if (
    readErrorRetryable(error) !== false &&
    !isAutomaticRecoveryUserActionCode(normalized.code) &&
    !isSourceServerAutomaticRecoveryTerminalState(ownerState)
  ) {
    return false;
  }
  // Bug 原因：旧恢复调度只识别 UpgradeRequired，其他用户动作和 retryable:false
  // 会被下一次 retry/offline probe 覆盖。终态必须在创建后续 timer 前截断自动路径。
  clearRecoveryTimers(ctx, sourceServerId);
  if (input && !isSourceServerAutomaticRecoveryTerminalState(ownerState)) {
    setState(ctx, input.profile.profileId, {
      state: "failed",
      sourceServerId,
      ...ctx.compatibilityByProfileId.get(input.profile.profileId),
      error: normalized.message,
      ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
      retryable: false,
    });
  }
  if (input) {
    for (const profileId of profileIdsForSource(ctx, sourceServerId, input.profile.profileId)) {
      if (profileId === input.profile.profileId) continue;
      // Bug 原因：Source 级恢复停止后，sibling Profile 若遗留 retrying，聚合状态仍会显示
      // 连接中且其 logical wrapper 不会收到终态。只有真实 owner 保留可操作 pending 状态。
      setState(ctx, profileId, {
        state: "offline",
        sourceServerId,
        error: normalized.message,
        ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
        retryable: false,
      });
    }
  }
  return true;
}

export function clearRecoveryTimers(ctx: ManagerContext, sourceServerId: string): void {
  const retryTimer = ctx.retryTimers.get(sourceServerId);
  if (retryTimer) clearTimeout(retryTimer);
  ctx.retryTimers.delete(sourceServerId);
  const probeTimer = ctx.offlineProbeTimers.get(sourceServerId);
  if (probeTimer) clearTimeout(probeTimer);
  ctx.offlineProbeTimers.delete(sourceServerId);
}
