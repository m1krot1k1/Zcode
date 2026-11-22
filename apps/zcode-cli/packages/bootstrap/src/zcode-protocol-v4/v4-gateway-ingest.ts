// V4 conversation gateway 的领域模块（从 v4-gateway 拆出）：ingest / emitLiveTelemetryFact / waitForProjectionEventCommit 等。
// 状态与宿主出口一律经 GatewayContext 显式传入，模块自身不持有状态。

import { SessionEventType, type SessionEvent, type TargetChangedPayload } from "@zcode/contracts";
import { pluginUiToolResultNotificationSchema } from "@zcode/shared/mcp-apps";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { ProjectionPayloadTooLargeError } from "./conversation-topic-publisher.js";
import type {
  GatewayContext,
  ProjectionEventCommitWaiter,
  RawSequenceState,
} from "./v4-gateway-context.js";
import {
  MAX_TELEMETRY_EVENT_IDS,
  PROJECTION_EVENT_COMMIT_TIMEOUT_MS,
  ProjectionEventCommitWaitError,
} from "./v4-gateway-errors.js";

/** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */
export function ingest(ctx: GatewayContext, sessionId: string, event: SessionEvent): void {
  if (ctx.disposed) return;
  const hydrationBuffer = ctx.hydrationBuffers.get(sessionId);
  if (hydrationBuffer) {
    const eventId = String(event.id);
    if (hydrationBuffer.eventIds.has(eventId)) return;
    // 先记 raw fact；它可能因前序尚未到而暂时不进 publisher。
    hydrationBuffer.eventIds.add(eventId);
    hydrationBuffer.rawEvents.push(event);
  }
  ctx.emitLiveTelemetryFact(sessionId, event);
  for (const normalizedEvent of ctx.normalizeRuntimeEventSequence(sessionId, event)) {
    try {
      ctx.localTtft.event(sessionId, normalizedEvent);
    } catch (error) {
      try {
        ctx.host.onError?.("v4.localTtft.observe", error);
      } catch {
        /* 诊断回调也不能阻断实际内容。 */
      }
    }
    ctx.ingestNormalizedEvent(sessionId, normalizedEvent);
  }
}

export function emitLiveTelemetryFact(
  ctx: GatewayContext,
  sessionId: string,
  event: SessionEvent,
): void {
  const eventId = String(event.id);
  // 主 session 与 detached child 各自维护事件序列，eventId 不能假设跨
  // session 全局唯一。旧去重只用 eventId，会把 child 的同号事件误判成主会话重放，
  // 导致前台 Subagent 的真实轮次事实被静默丢弃。
  const telemetryEventKey = `${sessionId}\0${eventId}`;
  if (ctx.telemetryEventIds.has(telemetryEventKey)) return;
  ctx.telemetryEventIds.add(telemetryEventKey);
  if (ctx.telemetryEventIds.size > MAX_TELEMETRY_EVENT_IDS) {
    const oldest = ctx.telemetryEventIds.values().next().value;
    if (typeof oldest === "string") ctx.telemetryEventIds.delete(oldest);
  }
  try {
    const config =
      ctx.publishers.get(sessionId)?.getSnapshot().config ??
      ctx.host.getSessionConfigSeed?.(sessionId) ??
      undefined;
    const fact = ctx.telemetryNormalizer.normalize(sessionId, event, {
      memoryEnabled: ctx.host.getSessionMemoryEnabled?.(sessionId),
      modelName: config?.model,
      modelProvider: config?.provider,
    });
    if (fact) {
      ctx.host.emitConversationTelemetryFact?.(fact);
    }
  } catch (error) {
    // 轮次事实绝不能反向阻断 conversation 投影；严格 schema 失败只记录诊断。
    ctx.host.onError?.("v4.telemetry.normalize", error);
  }
  try {
    const observation = ctx.cuaPermissionNormalizer.normalize(sessionId, event);
    if (observation) ctx.host.emitCuaPermissionObservation?.(observation);
  } catch (error) {
    // 权限观察只是 live UI 提示，schema 或投影异常不能阻断 conversation 主链路。
    ctx.host.onError?.("v4.cuaPermissionObservation.normalize", error);
  }
}

/** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */
export function waitForProjectionEventCommit(
  ctx: GatewayContext,
  sessionId: string,
  eventId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (ctx.disposed) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway is disposed",
      ),
    );
  }
  const state = ctx.getOrCreateRawSequenceState(sessionId);
  if (state.appliedEventIds.has(eventId)) return Promise.resolve();
  const failed = state.failedEventById.get(eventId);
  if (failed) return Promise.reject(failed);
  if (options.signal?.aborted) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.aborted",
        `projection event commit wait aborted: ${eventId}`,
        { cause: options.signal.reason },
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const byEvent = ctx.projectionEventCommitWaiters.get(sessionId) ?? new Map();
    ctx.projectionEventCommitWaiters.set(sessionId, byEvent);
    const waiters = byEvent.get(eventId) ?? new Set();
    byEvent.set(eventId, waiters);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      waiters.delete(waiter);
      if (waiters.size === 0) byEvent.delete(eventId);
      if (byEvent.size === 0) ctx.projectionEventCommitWaiters.delete(sessionId);
    };
    const waiter: ProjectionEventCommitWaiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    };
    const onAbort = () => {
      // 只 reject 当前 waiter 会让 raw gap 中的 TurnStarted 继续存活；
      // command 已 cancelled 后补齐 gap，迟到事件仍会进入 canonical projection。
      // event failure 必须固化到 sequence state，后续 drain 只推进 cursor、不再 apply。
      ctx.rejectProjectionEventCommit(
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal?.reason },
        ),
      );
    };
    const timeout = setTimeout(() => {
      ctx.rejectProjectionEventCommit(
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.timeout",
          `projection event commit wait timed out: ${eventId}`,
        ),
      );
    }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
    timeout.unref?.();
    waiters.add(waiter);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */
export async function waitForPermissionGrantCommit(
  ctx: GatewayContext,
  sessionId: string,
  eventId: string,
): Promise<void> {
  const state = ctx.getOrCreateRawSequenceState(sessionId);
  if (state.failedEventById.has(eventId)) {
    const event = state.recentRawEventsById.get(eventId);
    if (
      event?.type !== SessionEventType.SessionModeChanged ||
      !(event.payload as { permissionGrant?: unknown }).permissionGrant
    ) {
      throw new Error("Permission grant event unavailable for recovery");
    }
    await ctx.hydrationInFlight.get(sessionId);
    ctx.hydratedSessions.delete(sessionId);
    await ctx.hydratePublisher(sessionId, undefined, true);
  }
  await ctx.waitForProjectionEventCommit(sessionId, eventId);
}

export function ingestNormalizedEvent(
  ctx: GatewayContext,
  sessionId: string,
  event: SessionEvent,
): void {
  const publisher = ctx.ensurePublisher(sessionId);
  const promotedQueueRemoval =
    event.type === SessionEventType.TurnSteerDiscarded &&
    (event.payload as { reason?: string }).reason === "promoted";
  const removedQueueItems =
    event.type === SessionEventType.TurnSteerDrained ||
    event.type === SessionEventType.TurnSteerDiscarded
      ? ((event.payload as { pendingInputIds?: string[] }).pendingInputIds ?? []).flatMap(
          (queueItemId) => {
            const item = publisher
              .getSnapshot()
              .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
            return item ? [item] : [];
          },
        )
      : [];
  try {
    publisher.ingest(event);
  } catch (error) {
    const commitError =
      error instanceof ProjectionEventCommitWaitError
        ? error
        : new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply event ${String(event.id)}`,
            { cause: error },
          );
    ctx.rejectProjectionEventCommit(sessionId, String(event.id), commitError);
    if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
    ctx.host.onError?.("v4.projection.payloadTooLarge", error);
    if (!ctx.projectionFaultedSessions.has(sessionId)) {
      ctx.projectionFaultedSessions.add(sessionId);
      void Promise.resolve(
        ctx.host.terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
      ).catch((terminateError) => {
        ctx.host.onError?.("v4.projection.terminate", terminateError);
      });
    }
    return;
  }
  ctx.resolveProjectionEventCommit(sessionId, String(event.id));
  // 原因：后台会话没有卡片/订阅时无法创建 guest。只在 live 投影提交后投递，
  // 从同一权威工具行取输入和 UI 描述；历史 hydration 直接写 publisher，不走此入口。
  if (event.type === SessionEventType.ToolCallResult && ctx.host.emitPluginUiToolResult) {
    const toolCallId = (event.payload as { toolCallId: string }).toolCallId;
    const row = publisher
      .getSnapshot()
      .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId);
    if (row?.kind === "toolCall" && row.status === "success" && row.display?.kind === "mcp_tool") {
      const result = pluginUiToolResultNotificationSchema.safeParse({
        sessionId,
        toolCallId,
        serverName: row.display.serverName,
        ui: row.display.ui,
        ...(row.input && typeof row.input === "object" && !Array.isArray(row.input)
          ? { input: row.input }
          : {}),
      });
      if (result.success) ctx.host.emitPluginUiToolResult(result.data);
    }
  }
  if (
    !ctx.hydrationBuffers.has(sessionId) &&
    (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError)
  ) {
    try {
      ctx.host.onHighspeedTurnTerminal?.(sessionId, event, publisher.getSnapshot());
    } catch (error) {
      ctx.host.onError?.("v4.projection.highspeedMetrics", error);
    }
  }
  if (
    event.type === SessionEventType.TargetChanged &&
    (event.payload as TargetChangedPayload).target?.status === "complete"
  ) {
    try {
      ctx.host.onTargetCompleted?.(sessionId, event);
    } catch (error) {
      ctx.host.onError?.("v4.projection.targetCompleted", error);
    }
  }
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    ctx.projectionFaultedSessions.delete(sessionId);
  }
  if (event.type === SessionEventType.TurnSteerQueued) {
    const queueItemId = (event.payload as { pendingInputId?: string }).pendingInputId;
    const item = queueItemId
      ? publisher
          .getSnapshot()
          .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
      : undefined;
    if (item) ctx.inbox.pinLiveInput(sessionId, item);
  }
  if (!promotedQueueRemoval) {
    if (removedQueueItems.length > 0) {
      // delete/clear 已先把 durable session_input 写成 cancelled，但本 session
      // 的 persistent command index 可能缓存过旧空结果。必须先失效再解除 live pin，
      // 否则 LRU 淘汰后同 commandId 查询仍可能 unknown 并被重复执行。
      ctx.host.invalidatePersistentCommandFacts?.(sessionId);
    }
    for (const item of removedQueueItems) {
      ctx.inbox.releaseLiveInput({
        sessionId,
        commandId: item.sourceCommandId,
      });
    }
  }
  if (event.type === SessionEventType.SessionInputPromoted) {
    const sourceCommandId = (event.payload as { sourceCommandId?: string }).sourceCommandId;
    if (sourceCommandId) {
      // persistent index 可能早于本条 user message 被 query 过；先失效再解 pin，
      // 后续 LRU 淘汰回源时才能重读刚提交的 transcript，而不是命中旧空 seed。
      ctx.host.invalidatePersistentCommandFacts?.(sessionId);
      ctx.inbox.releaseLiveInput({ sessionId, commandId: sourceCommandId });
    }
  }
  // assistant 守恒：投影拒收了正文流（订阅中途建 publisher、错过
  // TurnStarted 的典型形态）→ 撤销 hydrated 标记，下次订阅强制从持久事实重新
  // hydration 补齐缺段——静默丢会让内容缺失直到用户手动刷新才恢复。
  if (publisher.getDroppedContentStreamEventCount() > 0 && ctx.hydratedSessions.has(sessionId)) {
    ctx.hydratedSessions.delete(sessionId);
    ctx.host.onError?.(
      "v4.assistantConservation",
      new Error(
        `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
      ),
    );
  }
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.sessionId !== sessionId) continue;
    ctx.scheduleFlush(routeKey, state, publisher);
  }
  // sessions-index fan-out（防御式：任何异常都不能打断 conversation 主路径）。
  ctx.fanOutToIndex(sessionId, event);
}

/**
 * cold 合成会把事件重新编号为 1..N，而 runtime 仍沿用 eventStore raw seq。这里用
 * source cursor 建立 N-C 偏移；raw seq=0（live-only child）则顺延，并同步校正后续偏移。
 * eventId 兜住 snapshot/buffer 同时看见同一事件的竞态，cursor 兜住已入 snapshot 的事件。
 */
export function normalizeRuntimeEventSequence(
  ctx: GatewayContext,
  sessionId: string,
  event: SessionEvent,
): SessionEvent[] {
  const state = ctx.getOrCreateRawSequenceState(sessionId);
  const eventId = String(event.id);
  if (state.seenEventIds.has(eventId)) return [];

  const rawSeq = event.sequenceNumber;
  state.recentRawEventsById.set(eventId, event);
  while (state.recentRawEventsById.size > PROTOCOL_V4_LIMITS.eventRetentionPerSession) {
    const oldestEventId = state.recentRawEventsById.keys().next().value;
    if (oldestEventId === undefined) break;
    state.recentRawEventsById.delete(oldestEventId);
  }
  if (rawSeq <= 0) {
    state.seenEventIds.add(eventId);
    state.lastTransportSeq += 1;
    return [{ ...event, sequenceNumber: state.lastTransportSeq }];
  }
  if (event.type === SessionEventType.SessionResumed) {
    // 旧 runtime 在 unsubscribe/重建窗口时可能遗漏尾部 raw event。新 runtime
    // 延续持久 eventStore 高水位时，SessionResumed 的 raw seq 会大于旧 cursor；
    // 若只处理 seq 回退，resume 和后续 TurnStarted 就会永久等待无法补齐的旧 gap。
    // SessionResumed 是明确 epoch 边界：丢弃边界前的旧 pending，同时保留可能乱序先到的
    // 新 epoch 后续事件，再从 resume 自身连续 drain。
    for (const pendingSeq of state.pendingByRawSeq.keys()) {
      if (pendingSeq <= rawSeq) state.pendingByRawSeq.delete(pendingSeq);
    }
    state.sourceEventSeq = rawSeq - 1;
    state.offset = state.lastTransportSeq - state.sourceEventSeq;
  }
  if (rawSeq <= state.sourceEventSeq) {
    state.seenEventIds.add(eventId);
    ctx.resolveProjectionEventCommit(sessionId, eventId);
    return [];
  }

  state.seenEventIds.add(eventId);
  if (!state.pendingByRawSeq.has(rawSeq)) state.pendingByRawSeq.set(rawSeq, event);
  const ready: SessionEvent[] = [];
  // eventStore 先编号，各事件各自 await 持久化后再 notify，
  // 因此 N+1 可以先于 N 到达。高水位过滤会把迟到 N 错判成 duplicate；
  // 必须按 raw seq 暂存，只连续 drain，才能保住 queue/stream 总序。
  for (;;) {
    const nextRawSeq = state.sourceEventSeq + 1;
    const next = state.pendingByRawSeq.get(nextRawSeq);
    if (!next) break;
    state.pendingByRawSeq.delete(nextRawSeq);
    let transportSeq = nextRawSeq + state.offset;
    if (transportSeq <= state.lastTransportSeq) {
      transportSeq = state.lastTransportSeq + 1;
      state.offset = transportSeq - nextRawSeq;
    }
    state.sourceEventSeq = nextRawSeq;
    state.lastTransportSeq = transportSeq;
    // waiter timeout/abort 只清 listener 是不够的，还要终止已在 raw gap 中的
    // event。command 返回 failed 后，缺失 seq 一到仍会把同一 TurnStarted 投影出来。
    // 失败事件仍消费 raw 序号以解除后续事件阻塞，但绝不能再成为 canonical fact。
    if (state.failedEventById.has(String(next.id))) {
      continue;
    }
    ready.push(
      transportSeq === next.sequenceNumber ? next : { ...next, sequenceNumber: transportSeq },
    );
  }
  return ready;
}

export function getOrCreateRawSequenceState(
  ctx: GatewayContext,
  sessionId: string,
): RawSequenceState {
  const existing = ctx.rawSequenceStates.get(sessionId);
  if (existing) return existing;
  const created: RawSequenceState = {
    sourceEventSeq: 0,
    offset: 0,
    lastTransportSeq: 0,
    seenEventIds: new Set(),
    appliedEventIds: new Set(),
    failedEventById: new Map(),
    pendingByRawSeq: new Map(),
    recentRawEventsById: new Map(),
  };
  ctx.rawSequenceStates.set(sessionId, created);
  return created;
}

export function resolveProjectionEventCommit(
  ctx: GatewayContext,
  sessionId: string,
  eventId: string,
): void {
  const state = ctx.getOrCreateRawSequenceState(sessionId);
  state.failedEventById.delete(eventId);
  state.appliedEventIds.add(eventId);
  const waiters = ctx.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
  if (!waiters) return;
  for (const waiter of Array.from(waiters)) waiter.resolve();
}

export function rejectProjectionEventCommit(
  ctx: GatewayContext,
  sessionId: string,
  eventId: string,
  error: Error,
): void {
  const state = ctx.getOrCreateRawSequenceState(sessionId);
  state.failedEventById.set(eventId, error);
  const waiters = ctx.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
  if (!waiters) return;
  for (const waiter of Array.from(waiters)) waiter.reject(error);
}

export function rejectProjectionEventWaiters(
  ctx: GatewayContext,
  sessionId: string,
  error: Error,
): void {
  const byEvent = ctx.projectionEventCommitWaiters.get(sessionId);
  if (!byEvent) return;
  for (const waiters of byEvent.values()) {
    for (const waiter of Array.from(waiters)) waiter.reject(error);
  }
  ctx.projectionEventCommitWaiters.delete(sessionId);
}

/**
 * 运行中 subagent 没有独立 bootstrap record，但 raw child events 会先建立 publisher。
 * publisher 已存在就代表 conversation live 可订阅，不能再把同一 child cold resume 成
 * 第二个 runtime；真正的历史 session 仍由 host record / persisted resume 负责。
 */
export function hasLiveConversation(ctx: GatewayContext, sessionId: string): boolean {
  return ctx.host.sessionExists(sessionId) || ctx.detachedLiveSessions.has(sessionId);
}
