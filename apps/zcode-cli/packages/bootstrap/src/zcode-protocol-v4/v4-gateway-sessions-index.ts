// V4 conversation gateway 的领域模块（从 v4-gateway 拆出）：fanOutToIndex / publishCurrentSummaryToIndex / resolveIndexMeta 等。
// 状态与宿主出口一律经 GatewayContext 显式传入，模块自身不持有状态。

import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  parseSessionsIndexTopic,
  sessionsIndexReconcileParamsSchema,
  sessionsIndexReconcileResultSchema,
  v4ConversationSubscribeParamsSchema,
  type SessionSummary,
  type SessionsIndexReconcileResult,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import type { GatewayContext, V4SubscribeDispatchResult } from "./v4-gateway-context.js";
import { DETACHED_CHILD_PUBLISHER_GRACE_MS } from "./v4-gateway-errors.js";

/**
 * 把某会话的最新摘要推进到其 workspace 的 sessions-index publisher，并 flush 给列表订阅者。
 * projection 必须在无列表订阅者时也继续推进，保证下一次 snapshot 读取权威当前态；
 * 高频流式增量（ModelStreaming）不触发列表重算，避免抖动（预览在 turn 收口/其他事件时更新）。
 * 旧宿主无 getSessionWorkspaceId → 整体 no-op。
 */
export function fanOutToIndex(ctx: GatewayContext, sessionId: string, event: SessionEvent): void {
  if (event.type === SessionEventType.ModelStreaming) return;
  // 工作流进度同样是高频流（实测 8s 4000 条），但列表要继续动，所以不是丢弃而是
  // leading + trailing 窗口节流：窗内合并为窗末一帧，终态仍在一个窗口内送达。
  if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
    ctx.indexFanoutThrottle.request(sessionId);
    return;
  }
  ctx.publishCurrentSummaryToIndex(sessionId);
}

/**
 * 把当前完整 projection 发布到 sessions-index。
 *
 * fork child 的 resume 会先用少量 live event 建出暂态 draft publisher，
 * 随后的 synthesized hydration 才补齐继承历史。只在 ingest(event) 时 fan-out 的话，
 * hydration 完成后若没有下一条 runtime event，child 就永远停在 draft 基线，
 * task-index syncer 无法观察到 draft→visible，也就不会创建侧栏 task row。
 */
export function publishCurrentSummaryToIndex(ctx: GatewayContext, sessionId: string): void {
  // 这一次发布带的就是窗内合并后的当前摘要：待发的 trailing 到此被满足，不重复发帧。
  ctx.indexFanoutThrottle.notePublished(sessionId);
  const getWorkspaceId = ctx.host.getSessionWorkspaceId;
  if (!getWorkspaceId) return;
  try {
    const workspaceId = getWorkspaceId.call(ctx.host, sessionId);
    if (!workspaceId) return;
    if (ctx.host.isDraftSession?.(sessionId)) return;
    const indexPublisher = ctx.indexPublishers.get(workspaceId);
    if (!indexPublisher) return;
    const conversationPublisher = ctx.publishers.get(sessionId);
    if (!conversationPublisher) return;
    const changed = indexPublisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      ctx.resolveIndexMeta(sessionId),
    );
    if (changed) ctx.flushIndex(workspaceId);
  } catch (error) {
    ctx.host.onError?.("v4.sessionsIndex.ingest", error);
  }
}

/** 会话列表元信息（宿主 hook 缺省时的兜底：createdAt=0，lastActivityAt=now）。 */
export function resolveIndexMeta(
  ctx: GatewayContext,
  sessionId: string,
): {
  createdAt: number;
  lastActivityAt: number;
  lastOutcome?: SessionSummary["lastOutcome"];
  parentSessionId?: string;
} {
  const meta = ctx.host.getSessionIndexMeta?.(sessionId);
  return {
    createdAt: meta?.createdAt ?? 0,
    lastActivityAt: meta?.lastActivityAt ?? ctx.now(),
    ...(meta?.lastOutcome ? { lastOutcome: meta.lastOutcome } : {}),
    ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
  };
}

/** 把某 workspace index publisher 的未发增量帧推给所有列表订阅者。 */
export function flushIndex(
  ctx: GatewayContext,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = ctx.indexPublishers.get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      ctx.pausedConnections.has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      ctx.emitReservation(reservation);
    } catch (error) {
      ctx.host.onError?.("v4.sessionsIndex.emit", error);
    }
  }
}

/**
 * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
 * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
 */
export async function subscribeSessionsIndex(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const dispatch = await ctx.subscribeSessionsIndexReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function reconcileSessions(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<SessionsIndexReconcileResult> {
  const params = sessionsIndexReconcileParamsSchema.parse(rawParams);
  if (!ctx.host.reconcileSessions) throw new Error("sessionsIndex/reconcile is unavailable");
  return sessionsIndexReconcileResultSchema.parse(await ctx.host.reconcileSessions(params));
}

export async function subscribeSessionsIndexReserved(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseSessionsIndexTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a sessions-index topic: ${params.topic}`);
  }
  const publisher = await ctx.ensureIndexPublisher(workspaceId, params.legacyTaskIds);
  // ensure 内部可能跨异步 store/claim；dispose 发生在 await 返回前时禁止继续登记订阅。
  ctx.indexPublishers.ensureActive();
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return ctx.subscribeDispatch(
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => ctx.flushIndex(workspaceId),
    );
  } catch (error) {
    // initial logical frame 在 physical encode 阶段即可因 16MiB 上限失败；
    // 已登记订阅/in-flight reservation 后失败必须 rollback，否则会留下永远无法退订的幽灵 owner。
    result.rollback();
    throw error;
  }
}

/** 建/取某 workspace 的 index publisher；建时 store 摘要种子 + live 投影覆盖。 */
export async function ensureIndexPublisher(
  ctx: GatewayContext,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const existing = ctx.indexPublishers.get(workspaceId);
  const shouldRefreshLegacy =
    Boolean(legacyTaskIds?.length) && Boolean(ctx.host.refreshLegacySessionSummaries);
  if (existing && !shouldRefreshLegacy) return existing;

  return ctx.indexPublishers.runExclusive(workspaceId, () =>
    ctx.ensureIndexPublisherExclusive(workspaceId, legacyTaskIds),
  );
}

/** 同 workspace 串行区：可重试 claim/重读与 publisher 构造必须观察同一份最终快照。 */
export async function ensureIndexPublisherExclusive(
  ctx: GatewayContext,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const refreshed =
    legacyTaskIds && legacyTaskIds.length > 0
      ? ((await ctx.host.refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
      : null;
  const existing = ctx.indexPublishers.get(workspaceId);
  if (existing) {
    // claim 不能绑定到首次构造：空种子一旦进 Map 就永久挡住重试。
    // 重读只补缺失项，避免冷存储默认态覆盖已有 live projection。
    if (refreshed && existing.mergeMissingStoredSummaries(refreshed)) {
      ctx.flushIndex(workspaceId);
    }
    return existing;
  }
  const publisher = new SessionsIndexPublisher(
    workspaceId,
    ctx.createLogEpoch(`sessions-index/${workspaceId}`),
    ctx.now,
  );
  // 种子 1：store 里全部会话的轻量摘要（未加载的靠它进列表）。
  const stored = refreshed ?? (await ctx.host.getStoredSessionSummaries?.(workspaceId)) ?? [];
  for (const summary of stored) publisher.seed(summary);
  // 种子 2：已加载会话用 live 投影覆盖（更准的 phase/preview/backgroundWork）。
  const liveIds = ctx.host.listWorkspaceSessionIds?.(workspaceId) ?? Array.from(ctx.publishers.keys());
  for (const sessionId of liveIds) {
    const conversationPublisher = ctx.publishers.get(sessionId);
    if (!conversationPublisher) continue;
    // draft（deferred 未发首条）不进冷启动种子，与 fanOutToIndex 的过滤一致。
    if (ctx.host.isDraftSession?.(sessionId)) continue;
    publisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      ctx.resolveIndexMeta(sessionId),
    );
  }
  ctx.indexPublishers.set(workspaceId, publisher);
  return publisher;
}

/**
 * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
 * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
 */
export function ingestDetachedLiveSession(
  ctx: GatewayContext,
  sessionId: string,
  event: SessionEvent,
  parentSessionId?: string,
): void {
  if (!ctx.detachedLiveSessions.has(sessionId)) {
    ctx.host.onDebug?.(`register detached live child publisher session=${sessionId}`);
  }
  ctx.detachedLiveSessions.add(sessionId);
  if (parentSessionId && parentSessionId !== sessionId) {
    ctx.detachedChildParent.set(sessionId, parentSessionId);
    let children = ctx.detachedChildrenByParent.get(parentSessionId);
    if (!children) {
      children = new Set();
      ctx.detachedChildrenByParent.set(parentSessionId, children);
    }
    children.add(sessionId);
  }
  // child 是一次性 session，没有 record 也没有后继 turn，publisher 曾驻留到进程退出。
  // 记下终态时间，供 pruneDetachedChildPublishers 在 grace 后释放；child 再次开 turn 则撤销。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    ctx.detachedTerminalAt.set(sessionId, Date.now());
  } else if (event.type === SessionEventType.TurnStarted) {
    ctx.detachedTerminalAt.delete(sessionId);
  }
  ctx.ingest(sessionId, event);
}

/**
 * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
 * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
 */
export function pruneDetachedChildPublishers(
  ctx: GatewayContext,
  nowMs: number = Date.now(),
  graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
): number {
  let released = 0;
  for (const [childId, terminalAt] of Array.from(ctx.detachedTerminalAt)) {
    if (nowMs - terminalAt < graceMs) continue;
    if (ctx.host.sessionExists(childId)) continue;
    if (ctx.publishers.get(childId)?.hasSubscribers()) continue;
    ctx.releaseDetachedChild(childId);
    released += 1;
  }
  return released;
}

export function releaseDetachedChild(ctx: GatewayContext, childId: string): void {
  ctx.host.onDebug?.(`release detached live child publisher session=${childId}`);
  ctx.cleanupSessionRuntime(childId, { clearCommandInbox: false, notifyIndexRemoved: false });
}
