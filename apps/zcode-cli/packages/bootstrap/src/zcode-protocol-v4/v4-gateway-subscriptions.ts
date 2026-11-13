// V4 conversation gateway 的领域模块（从 v4-gateway 拆出）：updateSharedContextImport / setConnectionFlowState / clearConnectionFlushTimers 等。
// 状态与宿主出口一律经 GatewayContext 显式传入，模块自身不持有状态。

import {
  DELIVERY_PROFILES,
  localTtftFactsSchema,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4ConnectionFlowParamsSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationSubscribeParamsSchema,
  v4ConversationUnsubscribeParamsSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type RoutedTopicFrame,
  type SubscribeAck,
} from "@zcode/shared/zcode-protocol-v4";
import { V4SubscribeSessionUnavailableError } from "./cold-session-resume.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import {
  subscriptionRouteKey,
  type FlushState,
  type GatewayContext,
  type V4SubscribeDispatchResult,
} from "./v4-gateway-context.js";
import { encodeReservedTopicFrame } from "./v4-gateway-frames.js";

/** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */
export function updateSharedContextImport(
  ctx: GatewayContext,
  sessionId: string,
  source: ConversationSnapshot["sharedContextImport"],
): void {
  const publisher = ctx.publishers.get(sessionId);
  if (!publisher) return;
  publisher.seedSharedContextImport(source);
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.sessionId === sessionId) ctx.scheduleFlush(routeKey, state, publisher);
  }
}

export function setConnectionFlowState(ctx: GatewayContext, rawParams: unknown): void {
  const params = v4ConnectionFlowParamsSchema.parse(rawParams);
  if (params.state === "closed") {
    ctx.pausedConnections.delete(params.connectionId);
    ctx.clearConnectionFlushTimers(params.connectionId);
    ctx.attachmentUploads.clearConnection(params.connectionId);
    return;
  }
  if (params.state === "saturated") {
    if (ctx.pausedConnections.has(params.connectionId)) return;
    ctx.pausedConnections.add(params.connectionId);
    ctx.clearConnectionFlushTimers(params.connectionId);
    return;
  }
  if (!ctx.pausedConnections.delete(params.connectionId)) return;
  ctx.flushConnection(params.connectionId);
}

export function clearConnectionFlushTimers(ctx: GatewayContext, connectionId: string): void {
  for (const state of ctx.flushStates.values()) {
    if (state.connectionId !== connectionId || state.timer === null) continue;
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export function flushConnection(ctx: GatewayContext, connectionId: string): void {
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.connectionId !== connectionId) continue;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const publisher = ctx.publishers.get(state.sessionId);
    if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
      ctx.flushStates.delete(routeKey);
      continue;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      ctx.emitReservation(reservation);
    } catch (error) {
      ctx.host.onError?.("v4.frame.emit", error);
    }
  }
  for (const workspaceId of ctx.indexPublishers.keys()) {
    ctx.flushIndex(workspaceId, connectionId);
  }
  for (const workspaceId of ctx.configPublishers.keys()) {
    ctx.flushConfig(workspaceId, connectionId);
  }
}

/** v4/conversation/subscribe：裁决 + server 内部 initial frame，公共响应由 server 只取 ACK。 */
export async function subscribe(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
  const dispatch = await ctx.subscribeReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeReserved(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId === null) {
    throw new Error(`Unsupported topic: ${params.topic}`);
  }
  const isLiveConversation = ctx.hasLiveConversation(sessionId);
  ctx.host.onDebug?.(
    `subscribe conversation session=${sessionId} coldResume=${String(!isLiveConversation)}`,
  );
  // Hydration：首次订阅时从权威来源重建投影。
  // - 无 publisher（cold）→ 建 + 重放。
  // - 有 publisher 但事件日志覆盖不了 transcript（fork child：resume 的 ingest 抢先
  //   建了个只含 fork 事件的 cold publisher）→ 用 transcript 合成**重建**。
  // - 有 publisher 且事件日志完整（流式 live）→ 保留，重放会双计且打断流。
  const restoreStartedAt = performance.now();
  const existingReady = ctx.readyFlights.get(sessionId);
  const historyFirst = params.historyFirst === true && Boolean(ctx.host.loadPersistedMessages);
  const initialState = ctx.publishers.get(sessionId)?.getSnapshot().runtimeInitialization;
  if (!historyFirst && initialState?.status === "failed") {
    throw new V4SubscribeSessionUnavailableError(
      sessionId,
      "fault.subscribe.resumeFailed",
      initialState.message,
    );
  }
  const publisher =
    historyFirst &&
    (ctx.historyOpenings.has(sessionId) ||
      initialState?.status === "failed" ||
      (!isLiveConversation && !existingReady))
      ? await ctx.ensureHistoryReadyPublisher(
          sessionId,
          params.resumeThoughtLevel,
          params.workspace,
          params.additionalDirectories,
          params.retryInitialization,
        )
      : existingReady
        ? await existingReady
        : !isLiveConversation
          ? await ctx.ensureColdReadyPublisher(
              sessionId,
              params.resumeThoughtLevel,
              params.workspace,
              params.additionalDirectories,
            )
          : await ctx.hydratePublisher(sessionId);
  const cliSessionRestoreMs = !isLiveConversation
    ? Math.max(0, Math.round(performance.now() - restoreStartedAt))
    : undefined;
  // 旧入口允许 UI 自选 deliveryProfile，桌面调用遗漏时还会默认成
  // replayable。现在只认 host attachment 注入的可信 clientMode。
  const profileName = params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
  // subscribeReserved 已构建 wire projection；若在它之后才开始计时，大会话的
  // 行过滤/窗口截断会落在 restore 与 encode 两段之外。起点必须覆盖构建与 physical encode。
  const initialFrameEncodeStartedAt = performance.now();
  const result = publisher.subscribeReserved({
    connectionId: params.connectionId,
    base: params.base,
    deliveryProfile: profileName,
    // 与 clientMode 同族的可信注入：能力位来自该连接的 clientHello，缺席一律按旧消费者办
    // （整键 patch + 旧界裁剪）。resync / rehydrate 沿用订阅上已记下的这一位，不再重取。
    workflowRunDeltas: params.workflowRunDeltas === true,
  });
  const routeKey = subscriptionRouteKey(
    params.topic,
    result.ack.subscriptionId,
    params.connectionId,
  );
  let dispatch: V4SubscribeDispatchResult<ConversationTopicFrame>;
  try {
    dispatch = ctx.subscribeDispatch(result.ack, result.reservation, () => {
      const state = ctx.flushStates.get(routeKey);
      if (state) ctx.scheduleFlush(routeKey, state, publisher);
      ctx.historyOpenings.get(sessionId)?.start();
    });
    dispatch.ack = {
      ...dispatch.ack,
      openTiming: {
        version: 1,
        ...(cliSessionRestoreMs !== undefined
          ? historyFirst
            ? { historyReadyMs: cliSessionRestoreMs }
            : { cliSessionRestoreMs }
          : {}),
        initialFrameEncodeMs: Math.max(
          0,
          Math.round(performance.now() - initialFrameEncodeStartedAt),
        ),
        sessionRuntimeState: isLiveConversation ? "warm" : "cold",
        snapshotRowCount: publisher.getSnapshot().rows.window.length,
      },
    };
  } catch (error) {
    // 重订 initial encode 失败时客户端仍持有旧 subId；replacement 必须
    // 原子 rollback，旧 publisher subscription 与 flush timer 都继续有效。
    result.rollback();
    throw error;
  }
  // encode 成功后 replacement 才 admission；此时再清旧调度状态，失败路径不碰旧 owner。
  for (const [staleRouteKey, staleState] of ctx.flushStates) {
    if (staleState.sessionId !== sessionId) continue;
    if (publisher.hasSubscription(staleState.subscriptionId, staleState.connectionId)) {
      continue;
    }
    if (staleState.timer) clearTimeout(staleState.timer);
    ctx.flushStates.delete(staleRouteKey);
  }
  ctx.flushStates.set(routeKey, {
    sessionId,
    topic: params.topic,
    subscriptionId: result.ack.subscriptionId,
    connectionId: params.connectionId,
    deliveryProfile: profileName,
    flushWindowMs: DELIVERY_PROFILES[profileName].flushWindowMs,
    timer: null,
  });
  return dispatch;
}

/**
 * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
 * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
 */
export function resyncReserved(
  ctx: GatewayContext,
  rawParams: unknown,
): V4SubscribeDispatchResult<RoutedTopicFrame> {
  const params = v4ConversationResyncParamsSchema.parse(rawParams);
  const request = {
    base: params.base,
    ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
  };
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId !== null) {
    const publisher = ctx.publishers.get(sessionId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const flushState = ctx.flushStates.get(routeKey);
    if (flushState?.timer) {
      clearTimeout(flushState.timer);
      flushState.timer = null;
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return ctx.subscribeDispatch(result.ack, result.reservation, () => {
        const state = ctx.flushStates.get(routeKey);
        if (state) ctx.scheduleFlush(routeKey, state, publisher);
      });
    } catch (error) {
      // physical encode 在 ACK admission 前失败时，same-sub recovery
      // 不能留下新的 inFlight 或取消旧 online flush；原子恢复旧状态后重挂 timer。
      result.rollback();
      if (flushState) ctx.scheduleFlush(routeKey, flushState, publisher);
      throw error;
    }
  }

  const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
  if (indexWorkspaceId !== null) {
    const publisher = ctx.indexPublishers.get(indexWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return ctx.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => ctx.flushIndex(indexWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }

  const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
  if (configWorkspaceId !== null) {
    const publisher = ctx.configPublishers.get(configWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return ctx.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => ctx.flushConfig(configWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }
  throw new Error(`Unsupported topic: ${params.topic}`);
}

/** v4/conversation/unsubscribe。 */
export function unsubscribe(ctx: GatewayContext, rawParams: unknown): void {
  const params = v4ConversationUnsubscribeParamsSchema.parse(rawParams);
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId === null) {
    const workspaceId = parseSessionsIndexTopic(params.topic);
    if (workspaceId !== null) {
      ctx.indexPublishers.get(workspaceId)?.unsubscribe(params.subscriptionId, params.connectionId);
      return;
    }
    const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
    if (configWorkspaceId !== null) {
      ctx.configPublishers
        .get(configWorkspaceId)
        ?.unsubscribe(params.subscriptionId, params.connectionId);
    }
    return;
  }
  const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
  const state = ctx.flushStates.get(routeKey);
  if (!state) return;
  if (state?.timer) clearTimeout(state.timer);
  ctx.flushStates.delete(routeKey);
  // 裸 subscriptionId 在不同 topic/connection 可碰撞；旧网关先按 subId
  // 反查再对三类 publisher 广撒网，会删掉别的连接。topic + connection 必须同时命中。
  ctx.publishers.get(sessionId)?.unsubscribe(params.subscriptionId, params.connectionId);
}

/** 测试探针：立即排空某订阅（绕过定时器）。 */
export function flushNow(
  ctx: GatewayContext,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const match = [...ctx.flushStates.entries()].find(
    ([, state]) => state.subscriptionId === subscriptionId,
  );
  const state = match?.[1];
  if (!state) return null;
  if (ctx.pausedConnections.has(state.connectionId)) return null;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const publisher = ctx.publishers.get(state.sessionId);
  if (!publisher) return null;
  const reservation = publisher.reserveFlush(state.subscriptionId);
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}

export function scheduleFlush(
  ctx: GatewayContext,
  routeKey: string,
  state: FlushState,
  publisher: ConversationTopicPublisher,
): void {
  if (ctx.pausedConnections.has(state.connectionId)) return;
  if (state.timer !== null) return;
  const timer = setTimeout(() => {
    state.timer = null;
    // timer 排队后可能收到 SAT；reserve 前必须二次检查，不能产生竞态帧。
    if (ctx.pausedConnections.has(state.connectionId)) return;
    // 惰性清理：订阅已被替换/退订→ 删调度状态，不产帧。
    if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) {
      ctx.flushStates.delete(routeKey);
      return;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) return;
    try {
      ctx.emitReservation(reservation);
    } catch (error) {
      ctx.host.onError?.("v4.frame.emit", error);
    }
  }, state.flushWindowMs);
  // CLI 进程退出不被 flush 定时器挂住。
  timer.unref?.();
  state.timer = timer;
}

export function emitReservation<F extends RoutedTopicFrame>(
  ctx: GatewayContext,
  reservation: TopicFrameReservation<F>,
): boolean {
  // resync/subscribe recovery 已进入 request-scoped outbox 时，online
  // flush 若复用同一 inFlight 会让 physical wire 抢在 ACK response 前出站。
  if (ctx.controlReservations.has(reservation)) return false;
  const sessionId = parseConversationTopic(reservation.frame.topic);
  const route = ctx.flushStates.get(
    subscriptionRouteKey(
      reservation.frame.topic,
      reservation.frame.subscriptionId,
      sessionId
        ? (ctx.publishers
            .get(sessionId)
            ?.connectionIdForSubscription(reservation.frame.subscriptionId) ?? "")
        : "",
    ),
  );
  if (
    sessionId &&
    route?.deliveryProfile === "continuous" &&
    reservation.deliveryKind === "online" &&
    reservation.frame.payload.kind === "deltas" &&
    ctx.localTtft.forSession(sessionId)
  ) {
    const rows = ctx.publishers.get(sessionId)?.getSnapshot().rows.window ?? [];
    const turns = new Set<string>();
    for (const delta of reservation.frame.payload.deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") turns.add(delta.row.turnId);
      else if (delta.op === "row.delta") {
        const row = rows.find((item) => item.rowId === delta.rowId);
        if (row) turns.add(row.turnId);
      }
    }
    const related = rows
      .filter((row) => row.kind === "turnHeader" && turns.has(row.turnId))
      .flatMap((header) =>
        header.kind === "turnHeader" && header.sourceCommandId
          ? [ctx.localTtft.forSession(sessionId, header.sourceCommandId)]
          : [],
      )
      .filter((facts) => facts !== undefined);
    const candidates = related.length ? related : [ctx.localTtft.forSession(sessionId)];
    const observations: import("@zcode/shared").LocalTtftFacts[] = [];
    for (const facts of candidates) {
      if (!facts || observations.some((item) => item.observationId === facts.observationId))
        continue;
      const header = rows.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === facts.commandId,
      );
      const observation = localTtftFactsSchema.safeParse({
        ...facts,
        ...(ctx.host.cliVersion ? { cliVersion: ctx.host.cliVersion } : {}),
        ...(header ? { productTurnId: header.turnId } : {}),
      });
      // 转正前后的内容可能被同批发送；按实际 row 所属原输入携带事实，不能取最新队列项。
      if (observation.success) observations.push(observation.data);
    }
    if (observations.length) {
      (reservation.frame as ConversationTopicFrame).ttft = observations[0];
      if (observations.length > 1)
        (reservation.frame as ConversationTopicFrame).ttftRelated = observations.slice(1, 17);
    }
  }
  const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
  for (const wire of wires) ctx.host.emitWireFrame(wire);
  return reservation.commit();
}

export function subscribeDispatch<F extends RoutedTopicFrame>(
  ctx: GatewayContext,
  ack: SubscribeAck,
  reservation: TopicFrameReservation<F> | null,
  afterCommit?: () => void,
): V4SubscribeDispatchResult<F> {
  const initialWires = reservation
    ? encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>)
    : [];
  if (reservation) ctx.controlReservations.add(reservation);
  let afterCommitRan = false;
  return {
    ack,
    initialFrame: reservation?.frame ?? null,
    initialWires,
    commit: () => {
      if (!reservation) return true;
      ctx.controlReservations.delete(reservation);
      const committed = reservation.commit();
      if (committed && !afterCommitRan) {
        afterCommitRan = true;
        // control reservation 等 ACK/outbox admission 时，既有 flush timer
        // 可能已触发并因同一 inFlight 被抑制。commit 后必须主动重驱动 publisher，
        // 否则期间积累的 delta 会一直等到下一次 ingest/publish 才可见。
        afterCommit?.();
      }
      return committed;
    },
  };
}
