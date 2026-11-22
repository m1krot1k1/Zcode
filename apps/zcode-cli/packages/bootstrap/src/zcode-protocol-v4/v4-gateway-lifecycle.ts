// V4 conversation gateway 的领域模块（从 v4-gateway 拆出）：cleanupSessionRuntime / dispose / disposeSession 等。
// 状态与宿主出口一律经 GatewayContext 显式传入，模块自身不持有状态。

import type { GatewayContext } from "./v4-gateway-context.js";
import { ProjectionEventCommitWaitError } from "./v4-gateway-errors.js";

export function cleanupSessionRuntime(
  ctx: GatewayContext,
  sessionId: string,
  options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
): void {
  if (options.clearCommandInbox) {
    // 清掉 in-flight/live 命令会破坏幂等与 FIFO。resident facts 已在回收前
    // 拦截；若这里仍命中，必须在拆 publisher 之前失败，不能留下半清状态。
    ctx.assertSessionRuntimeDeactivatable(sessionId);
  }
  ctx.rejectProjectionEventWaiters(
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.disposed",
      `conversation session disposed while waiting for projection event commit: ${sessionId}`,
    ),
  );
  ctx.attachmentUploads.clearSession(sessionId);
  for (const [key, entry] of ctx.binaryReadCache) {
    if (entry.sessionId === sessionId) ctx.deleteBinaryReadCacheEntry(key);
  }
  if (options.notifyIndexRemoved) {
    // 先取 workspaceId（会话 record 还在时），把 session.removed 推给列表订阅者。
    try {
      const workspaceId = ctx.host.getSessionWorkspaceId?.(sessionId) ?? null;
      if (workspaceId !== null) {
        const indexPublisher = ctx.indexPublishers.get(workspaceId);
        // 无订阅者时也必须先更新 projection，避免已有 publisher 在下次
        // subscribe 的 snapshot 中复活已删除会话；flushIndex 对空订阅自然 no-op。
        if (indexPublisher?.removeSession(sessionId)) {
          ctx.flushIndex(workspaceId);
        }
      }
    } catch (error) {
      ctx.host.onError?.("v4.sessionsIndex.remove", error);
    }
  }
  ctx.indexFanoutThrottle.clearSession(sessionId);
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.sessionId !== sessionId) continue;
    if (state.timer) clearTimeout(state.timer);
    ctx.flushStates.delete(routeKey);
  }
  ctx.publishers.delete(sessionId);
  ctx.hydratedSessions.delete(sessionId);
  const hydrationBuffer = ctx.hydrationBuffers.get(sessionId);
  if (hydrationBuffer) hydrationBuffer.cancelled = true;
  ctx.hydrationBuffers.delete(sessionId);
  ctx.hydrationInFlight.delete(sessionId);
  ctx.readyFlights.delete(sessionId);
  ctx.historyOpenings.get(sessionId)?.cancel();
  ctx.rawSequenceStates.delete(sessionId);
  if (options.clearCommandInbox) ctx.inbox.clearSession(sessionId);
  ctx.telemetryNormalizer.clearSession(sessionId);
  ctx.detachedLiveSessions.delete(sessionId);
  ctx.projectionFaultedSessions.delete(sessionId);
  // detached child 归属清理：自己作为 child 从父表摘除；作为父则连带释放没有 record 的 child。
  ctx.detachedTerminalAt.delete(sessionId);
  const parentId = ctx.detachedChildParent.get(sessionId);
  if (parentId !== undefined) {
    ctx.detachedChildParent.delete(sessionId);
    const siblings = ctx.detachedChildrenByParent.get(parentId);
    siblings?.delete(sessionId);
    if (siblings && siblings.size === 0) ctx.detachedChildrenByParent.delete(parentId);
  }
  const children = ctx.detachedChildrenByParent.get(sessionId);
  if (children) {
    ctx.detachedChildrenByParent.delete(sessionId);
    for (const childId of children) {
      ctx.detachedChildParent.delete(childId);
      if (ctx.host.sessionExists(childId)) continue;
      ctx.releaseDetachedChild(childId);
    }
  }
}

export function dispose(ctx: GatewayContext): void {
  ctx.disposed = true;
  ctx.localTtft.clear();
  for (const sessionId of ctx.projectionEventCommitWaiters.keys()) {
    ctx.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway disposed while waiting for projection event commit",
      ),
    );
  }
  clearInterval(ctx.attachmentPruneTimer);
  ctx.indexFanoutThrottle.clear();
  ctx.attachmentUploads.clear();
  ctx.binaryReadCache.clear();
  ctx.binaryReadCacheBytes = 0;
  for (const state of ctx.flushStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  ctx.flushStates.clear();
  ctx.publishers.clear();
  ctx.hydratedSessions.clear();
  for (const buffer of ctx.hydrationBuffers.values()) buffer.cancelled = true;
  ctx.hydrationBuffers.clear();
  ctx.hydrationInFlight.clear();
  ctx.readyFlights.clear();
  for (const opening of ctx.historyOpenings.values()) opening.cancel();
  ctx.historyOpenings.clear();
  ctx.rawSequenceStates.clear();
  ctx.telemetryEventIds.clear();
  ctx.detachedLiveSessions.clear();
  ctx.detachedChildParent.clear();
  ctx.detachedChildrenByParent.clear();
  ctx.detachedTerminalAt.clear();
  ctx.projectionFaultedSessions.clear();
  ctx.coldResume.clear();
  ctx.indexPublishers.dispose();
  ctx.configPublishers.clear();
  ctx.pausedConnections.clear();
}

/** 关闭只释放运行态；只有 CLI 已持久化软删除时才向列表发 session.removed。
 * 修复原因：Host 将 removed 视为删除事实，普通 tab 关闭不能删除持久化会话。 */
export function disposeSession(
  ctx: GatewayContext,
  sessionId: string,
  options: { deleted?: boolean } = {},
): void {
  ctx.cleanupSessionRuntime(sessionId, {
    clearCommandInbox: false,
    notifyIndexRemoved: options.deleted === true,
  });
}

/**
 * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
 * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
 * 保留，再次订阅经冷恢复透明重建。
 */
export function deactivateSession(ctx: GatewayContext, sessionId: string): void {
  ctx.cleanupSessionRuntime(sessionId, {
    clearCommandInbox: true,
    notifyIndexRemoved: false,
  });
}

/**
 * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
 * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
 */
export function assertSessionRuntimeDeactivatable(ctx: GatewayContext, sessionId: string): void {
  if (!ctx.inbox.hasPinnedSessionState(sessionId)) return;
  throw new Error(`Session command inbox is still pinned: ${sessionId}`);
}

/** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */
export function hasConversationSubscribers(ctx: GatewayContext, sessionId: string): boolean {
  return ctx.publishers.get(sessionId)?.hasSubscribers() ?? false;
}

/**
 * 内存诊断计数器。只读 size，不触碰状态。
 * detachedLive 用于观察子 session publisher 是否随父 session 释放。
 */
export function collectMemoryDiagnostics(ctx: GatewayContext): Record<string, number> {
  return {
    publishers: ctx.publishers.size,
    detachedLive: ctx.detachedLiveSessions.size,
    detachedTerminal: ctx.detachedTerminalAt.size,
    rawSeqStates: ctx.rawSequenceStates.size,
  };
}
