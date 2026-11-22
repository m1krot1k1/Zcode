import type {
  ConversationTelemetryFact,
  ConversationTopicWireCandidate,
  SessionsIndexTopicWireCandidate,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type { V4SubscriptionRoute, ZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  MAX_TRACKED_SESSION_EVENT_IDS,
  logger,
  type PendingProviderRuntimeHeadersRequest,
  type SessionEventSequenceState,
} from "./zcodeAgentServiceSupport.js";
import {
  readTrustedZCodeAgentV4Connection,
  readTrustedZCodeAgentV4UnsubscribeRoute,
  type ZCodeAgentV4ConnectionContext,
} from "./zcodeAgentConnectionScope.js";
import {
  resolveWorkspaceKey,
  type OffPeakLifecycleNotification,
  type ZCodePluginOperationProgressNotification,
  type ZCodeProviderRuntimeHeadersRequestParams,
  type ZCodeSessionEvent,
  type ZCodeStateUpdatedNotification,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { rememberBoundedEventId, sessionEventKey } from "./zcodeAgentServiceParams.js";

export function createSessionHelpers(ctx: ZCodeAgentServiceState) {
  const {
    activeClientsByWorkspaceKey,
    clientDisposables,
    conversationFrameEmitters,
    conversationTelemetryFactEmitters,
    interactionPreferenceSyncByWorkspaceKey,
    offPeakLifecycleEmitters,
    pendingPermissions,
    pendingProviderRuntimeHeaders,
    pendingSessionRuntimePreferences,
    pendingUserInputs,
    pluginOperationProgressEmitters,
    providerRuntimeHeadersCancelledEmitters,
    providerRuntimeHeadersWorkspaceEmitters,
    sessionEmitters,
    sessionEventSequenceStates,
    sessionTraceIdBySessionKey,
    sessionsIndexFrameEmitters,
    v4ConnectionId,
    v4RouteKeyByOwnership,
    v4SubscriptionRoutes,
    waitingWorkspaceStartups,
    workspaceConfigFrameEmitters,
  } = ctx;
  function cancelProviderRuntimeHeaders(
    key: string,
    pending: PendingProviderRuntimeHeadersRequest,
  ): void {
    pendingProviderRuntimeHeaders.delete(key);
    const { requestId, sessionId, workspace } = pending.request;
    // 先删除再投递，确保晚订阅不会重新启动已取消的请求校验。
    providerRuntimeHeadersCancelledEmitters
      .get(resolveWorkspaceKey(workspace))
      ?.fire({ requestId, sessionId, workspace });
    logger.info(undefined, "请求校验已取消", {
      requestId,
      sessionId,
      workspaceKey: resolveWorkspaceKey(workspace),
    });
  }
  function cancelWaitingWorkspaceStartup(workspaceKey: string): void {
    const waiting = waitingWorkspaceStartups.get(workspaceKey);
    if (waiting) {
      waiting.cancelled = true;
      waitingWorkspaceStartups.delete(workspaceKey);
    }
  }
  function cancelAllWaitingWorkspaceStartups(): void {
    for (const waiting of waitingWorkspaceStartups.values()) {
      waiting.cancelled = true;
    }
    waitingWorkspaceStartups.clear();
  }
  function invalidateWorkspaceClient(workspaceKey: string, client: ZCodeProtocolClient): void {
    for (const [key, pending] of pendingPermissions) {
      if (pending.client === client) {
        pendingPermissions.delete(key);
      }
    }
    for (const [key, pending] of pendingUserInputs) {
      if (pending.client === client) {
        pendingUserInputs.delete(key);
      }
    }
    for (const [key, pending] of pendingProviderRuntimeHeaders) {
      if (pending.client === client) {
        cancelProviderRuntimeHeaders(key, pending);
      }
    }
    for (const [key, pending] of pendingSessionRuntimePreferences) {
      if (pending.client === client) {
        clearTimeout(pending.timeout);
        pendingSessionRuntimePreferences.delete(key);
      }
    }
    for (const disposable of clientDisposables.get(client) ?? []) {
      disposable.dispose();
    }
    clientDisposables.delete(client);

    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.client !== client) {
      // Runtime lifecycle 事件可能与下一代启动交错；旧 client 的迟到清理只能释放
      // 自身绑定，绝不能删除同 workspace 已登记的新 client 与新 runtime 状态。
      return;
    }
    activeClientsByWorkspaceKey.delete(workspaceKey);
    // Interaction preference 是 CLI 进程内存态；runtime 换代后即使 app revision
    // 未变化也必须重新同步，不能沿用旧 client 的完成 Promise。
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
  }

  function getSessionEmitter(params: ZCodeAgentSessionTarget) {
    const key = sessionEventKey(params);
    const existing = sessionEmitters.get(key);
    if (existing) {
      return existing;
    }
    // Bug 原因：旧实现只增不删，已关闭/已删除会话的 emitter 永久留在 Host 内存。
    // 与 plugin operation progress 同策略：最后一个订阅者离开后自行摘除并 dispose。
    // 有活跃订阅时不能强制销毁，否则 UI 的 conversation/task 订阅会被静默断流。
    let created: Emitter<ZCodeAgentServiceEvent>;
    created = new Emitter({
      onDidRemoveLastListener: () => {
        if (sessionEmitters.get(key) !== created) return;
        sessionEmitters.delete(key);
        created.dispose();
      },
    });
    sessionEmitters.set(key, created);
    return created;
  }

  /**
   * 释放单个会话的 Host 内存镜像。会话关闭/删除、或它所属的 Agent runtime 退出后调用。
   *
   * 只清理“会话已不存在”后没有意义的状态；emitter 必须保留给仍在渲染的订阅者，
   * 由最后一个订阅者离开时经 onDidRemoveLastListener 回收。否则关闭一个会话会把
   * UI 正在等待终态的流直接掐断。
   */
  function forgetSession(params: ZCodeAgentSessionTarget): void {
    const key = sessionEventKey(params);
    sessionEventSequenceStates.delete(key);
    sessionTraceIdBySessionKey.delete(key);
    const emitter = sessionEmitters.get(key);
    if (emitter && emitter.listenerCount === 0) {
      sessionEmitters.delete(key);
      emitter.dispose();
    }
  }

  /** runtime 退出会一次性废弃该 workspace 下全部会话的进程内事实，按 key 前缀回收。 */
  function forgetWorkspaceSessions(workspaceKey: string): void {
    const prefix = `${workspaceKey}\u0000`;
    // Map 迭代器允许删除当前项；这里按前缀回收，避免为一次性清理复制整张表。
    for (const key of sessionEventSequenceStates.keys()) {
      if (key.startsWith(prefix)) sessionEventSequenceStates.delete(key);
    }
    for (const key of sessionTraceIdBySessionKey.keys()) {
      if (key.startsWith(prefix)) sessionTraceIdBySessionKey.delete(key);
    }
    for (const [key, emitter] of sessionEmitters) {
      if (!key.startsWith(prefix) || emitter.listenerCount > 0) continue;
      sessionEmitters.delete(key);
      emitter.dispose();
    }
    const frameEmitter = conversationFrameEmitters.get(workspaceKey);
    if (frameEmitter && frameEmitter.listenerCount === 0) {
      conversationFrameEmitters.delete(workspaceKey);
      frameEmitter.dispose();
    }
  }

  function getPluginOperationProgressEmitter(operationId: string) {
    const existing = pluginOperationProgressEmitters.get(operationId);
    if (existing) return existing;
    let created: Emitter<ZCodePluginOperationProgressNotification>;
    created = new Emitter({
      onDidRemoveLastListener: () => {
        if (pluginOperationProgressEmitters.get(operationId) !== created) return;
        pluginOperationProgressEmitters.delete(operationId);
        created.dispose();
      },
    });
    pluginOperationProgressEmitters.set(operationId, created);
    return created;
  }

  function getConversationFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    // workspace 级帧流同样按最后订阅者回收：面板全部关闭后不再常驻空 emitter。
    // 重订阅会重新创建并拿最新事件流，不能把旧 event 引用跨 dispose 复用。
    let created: Emitter<ConversationTopicWireCandidate>;
    created = new Emitter({
      onDidRemoveLastListener: () => {
        if (conversationFrameEmitters.get(key) !== created) return;
        conversationFrameEmitters.delete(key);
        created.dispose();
      },
    });
    conversationFrameEmitters.set(key, created);
    return created;
  }

  function getProviderRuntimeHeadersWorkspaceEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = providerRuntimeHeadersWorkspaceEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ZCodeProviderRuntimeHeadersRequestParams>();
    providerRuntimeHeadersWorkspaceEmitters.set(key, created);
    return created;
  }

  function getConversationTelemetryFactEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationTelemetryFactEmitters.get(key);
    if (existing) return existing;
    const created = new Emitter<ConversationTelemetryFact>();
    conversationTelemetryFactEmitters.set(key, created);
    return created;
  }

  function getOffPeakLifecycleEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    let emitter = offPeakLifecycleEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<OffPeakLifecycleNotification>();
      offPeakLifecycleEmitters.set(key, emitter);
    }
    return emitter;
  }

  function getSessionsIndexFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = sessionsIndexFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<SessionsIndexTopicWireCandidate>();
    sessionsIndexFrameEmitters.set(key, created);
    return created;
  }

  function getWorkspaceConfigFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = workspaceConfigFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<WorkspaceConfigTopicWireCandidate>();
    workspaceConfigFrameEmitters.set(key, created);
    return created;
  }

  /** v4 订阅 connectionId：同 host 进程内多个独立消费者（renderer/syncer）用 scope 后缀区分。 */
  function v4ConnectionIdFor(subscriberScope?: string): string {
    return subscriberScope ? `${v4ConnectionId}#${subscriberScope}` : v4ConnectionId;
  }

  function resolveV4Connection(
    params: unknown,
    fallbackConnectionId: string = v4ConnectionId,
  ): ZCodeAgentV4ConnectionContext {
    return (
      readTrustedZCodeAgentV4Connection(params) ?? {
        // 没有可信 carrier 就是宿主内部直调：按旧消费者订阅（整键 patch），不猜能力。
        connectionId: fallbackConnectionId,
        clientMode: "desktop-continuous" as const,
      }
    );
  }

  function v4SubscriptionRouteKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.subscriptionId}\0${route.connectionId}`;
  }

  function v4SubscriptionOwnershipKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.connectionId}`;
  }

  function rememberV4SubscriptionRoute(
    workspace: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ): void {
    const route: V4SubscriptionRoute = {
      workspaceKey: resolveWorkspaceKey(workspace),
      topic,
      subscriptionId,
      connectionId,
    };
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    const previous = v4RouteKeyByOwnership.get(ownershipKey);
    if (previous) v4SubscriptionRoutes.delete(previous);
    const routeKey = v4SubscriptionRouteKey(route);
    v4RouteKeyByOwnership.set(ownershipKey, routeKey);
    v4SubscriptionRoutes.set(routeKey, route);
  }

  function forgetV4SubscriptionRoute(route: V4SubscriptionRoute): void {
    const routeKey = v4SubscriptionRouteKey(route);
    v4SubscriptionRoutes.delete(routeKey);
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    if (v4RouteKeyByOwnership.get(ownershipKey) === routeKey) {
      v4RouteKeyByOwnership.delete(ownershipKey);
    }
  }

  function isCurrentV4SubscriptionRoute(route: V4SubscriptionRoute): boolean {
    return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) === route;
  }

  function clearV4SubscriptionRoutes(workspaceKey?: string): void {
    for (const route of v4SubscriptionRoutes.values()) {
      if (workspaceKey !== undefined && route.workspaceKey !== workspaceKey) {
        continue;
      }
      forgetV4SubscriptionRoute(route);
    }
  }

  function resolveV4UnsubscribeRoute(
    params: ZCodeAgentConversationUnsubscribeParams | ZCodeAgentConversationResyncParams,
    topicPrefix: string,
  ): V4SubscriptionRoute | null {
    const expectedWorkspaceKey = resolveWorkspaceKey(params);
    const trusted = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (trusted) {
      if (!trusted.topic.startsWith(topicPrefix)) return null;
      const route: V4SubscriptionRoute = {
        workspaceKey: expectedWorkspaceKey,
        topic: trusted.topic,
        subscriptionId: params.subscriptionId,
        connectionId: trusted.connectionId,
      };
      return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) ?? null;
    }
    // base service 的内部直连消费者没有 facade carrier；只在 method topic 域内唯一
    // 命中时兼容，碰撞则拒绝猜测，更不能多 publisher 广播删除。
    const matches = [...v4SubscriptionRoutes.values()].filter(
      (route) =>
        route.workspaceKey === expectedWorkspaceKey &&
        route.subscriptionId === params.subscriptionId &&
        route.topic.startsWith(topicPrefix),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  function emitSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
    event: ZCodeAgentServiceEvent,
  ): void {
    sessionEmitters.get(sessionEventKey({ ...workspace, sessionId }))?.fire(event);
  }

  function emitWorkspaceEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeAgentServiceEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    for (const [key, emitter] of sessionEmitters) {
      if (key.startsWith(`${workspaceKey}\u0000`)) {
        emitter.fire(event);
      }
    }
  }

  function getSessionEventSequenceState(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): SessionEventSequenceState {
    const key = sessionEventKey({ ...workspace, sessionId });
    const existing = sessionEventSequenceStates.get(key);
    if (existing) {
      return existing;
    }
    const created: SessionEventSequenceState = {
      assignedSeqByEventId: new Map<string, number>(),
      assignedSeqEventIds: [],
      liveEventIds: new Set<string>(),
      liveEventIdOrder: [],
      lastAssignedSeq: 0,
    };
    sessionEventSequenceStates.set(key, created);
    return created;
  }

  function normalizeSessionEventSeq(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): ZCodeSessionEvent {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    if (event.seq > 0) {
      state.lastAssignedSeq = Math.max(state.lastAssignedSeq, event.seq);
      return event;
    }

    const assignedSeq = state.assignedSeqByEventId.get(event.eventId);
    if (assignedSeq !== undefined) {
      return { ...event, seq: assignedSeq };
    }

    const nextSeq = state.lastAssignedSeq + 1;
    state.lastAssignedSeq = nextSeq;
    state.assignedSeqByEventId.set(event.eventId, nextSeq);
    state.assignedSeqEventIds.push(event.eventId);
    while (state.assignedSeqEventIds.length > MAX_TRACKED_SESSION_EVENT_IDS) {
      const removed = state.assignedSeqEventIds.shift();
      if (removed) {
        state.assignedSeqByEventId.delete(removed);
      }
    }
    // 旧 agent live sink 会把 createSessionEvent 默认 seq=0 直接发给 app，
    // 而 replay/read 走 event store 后才补号。这里只做旧版本兼容；新 runtime 的顺序事实源仍是 event store。
    return { ...event, seq: nextSeq };
  }

  function shouldDeliverLiveSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): boolean {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    return rememberBoundedEventId(state.liveEventIds, state.liveEventIdOrder, event.eventId);
  }

  function handleSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): void {
    const normalizedEvent = normalizeSessionEventSeq(workspace, event);
    if (!shouldDeliverLiveSessionEvent(workspace, normalizedEvent)) {
      return;
    }
    emitSessionEvent(workspace, normalizedEvent.sessionId, {
      type: "session.event",
      event: normalizedEvent,
    });
  }

  function handleStateUpdated(
    workspace: ZCodeAgentWorkspaceTarget,
    notification: ZCodeStateUpdatedNotification,
  ): void {
    if (notification.sessionId) {
      emitSessionEvent(workspace, notification.sessionId, {
        type: "state.updated",
        notification,
      });
      return;
    }
    emitWorkspaceEvent(workspace, { type: "state.updated", notification });
  }

  return {
    cancelProviderRuntimeHeaders,
    cancelWaitingWorkspaceStartup,
    cancelAllWaitingWorkspaceStartups,
    invalidateWorkspaceClient,
    getSessionEmitter,
    forgetSession,
    forgetWorkspaceSessions,
    getPluginOperationProgressEmitter,
    getConversationFrameEmitter,
    getProviderRuntimeHeadersWorkspaceEmitter,
    getConversationTelemetryFactEmitter,
    getOffPeakLifecycleEmitter,
    getSessionsIndexFrameEmitter,
    getWorkspaceConfigFrameEmitter,
    v4ConnectionIdFor,
    resolveV4Connection,
    v4SubscriptionRouteKey,
    v4SubscriptionOwnershipKey,
    rememberV4SubscriptionRoute,
    forgetV4SubscriptionRoute,
    isCurrentV4SubscriptionRoute,
    clearV4SubscriptionRoutes,
    resolveV4UnsubscribeRoute,
    emitSessionEvent,
    emitWorkspaceEvent,
    getSessionEventSequenceState,
    normalizeSessionEventSeq,
    shouldDeliverLiveSessionEvent,
    handleSessionEvent,
    handleStateUpdated,
  };
}

export type ZCodeAgentServiceSessionHelpers = ReturnType<typeof createSessionHelpers>;
