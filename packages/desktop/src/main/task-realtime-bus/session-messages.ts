import { HostMessageTypes } from "@zcode/shared";
import type { TaskRealtimeBusState } from "./state.js";
import type {
  RegisteredRealtimeHost,
  SessionMessageDeliveryResult,
  SessionMessageRequest,
} from "./types.js";
import { SESSION_MESSAGE_DELIVERY_TIMEOUT_MS } from "./types.js";

export function handleSessionMessageSendRequested(
  state: TaskRealtimeBusState,
  source: RegisteredRealtimeHost,
  request: SessionMessageRequest,
): void {
  const targetHostId = state.sessionRoutes.get(request.toSessionId);
  if (!targetHostId) {
    postSessionMessageDeliveryResult(state, source.hostId, {
      error: `target session not found: ${request.toSessionId}`,
      messageId: request.messageId,
      requestId: request.requestId,
      sessionId: request.fromSessionId,
      status: "failed",
    });
    return;
  }

  const target = state.hosts.get(targetHostId);
  if (!target) {
    state.sessionRoutes.delete(request.toSessionId);
    postSessionMessageDeliveryResult(state, source.hostId, {
      error: `target host not found for session: ${request.toSessionId}`,
      messageId: request.messageId,
      requestId: request.requestId,
      sessionId: request.fromSessionId,
      status: "failed",
    });
    return;
  }

  const existing = state.pendingSessionMessageDeliveries.get(request.requestId);
  if (existing) {
    clearTimeout(existing.timeout);
    state.pendingSessionMessageDeliveries.delete(request.requestId);
  }

  const timeout = setTimeout(() => {
    state.pendingSessionMessageDeliveries.delete(request.requestId);
    postSessionMessageDeliveryResult(state, source.hostId, {
      error: "Session message delivery timed out.",
      messageId: request.messageId,
      requestId: request.requestId,
      sessionId: request.fromSessionId,
      status: "failed",
    });
  }, SESSION_MESSAGE_DELIVERY_TIMEOUT_MS);
  state.pendingSessionMessageDeliveries.set(request.requestId, {
    request,
    sourceHostId: source.hostId,
    targetHostId: target.hostId,
    timeout,
  });

  target.child.postMessage({
    type: HostMessageTypes.SessionMessageDeliver,
    request,
  });
}

export function handleSessionMessageDeliverResult(
  state: TaskRealtimeBusState,
  target: RegisteredRealtimeHost,
  result: SessionMessageDeliveryResult,
): void {
  const pending = state.pendingSessionMessageDeliveries.get(result.requestId);
  if (!pending || pending.targetHostId !== target.hostId) {
    return;
  }
  clearTimeout(pending.timeout);
  state.pendingSessionMessageDeliveries.delete(result.requestId);
  postSessionMessageDeliveryResult(state, pending.sourceHostId, result);
}

export function unregisterSessionRoutesForHost(state: TaskRealtimeBusState, hostId: string): void {
  for (const [sessionId, routeHostId] of state.sessionRoutes) {
    if (routeHostId === hostId) {
      state.sessionRoutes.delete(sessionId);
    }
  }
}

export function failPendingSessionMessagesForHost(
  state: TaskRealtimeBusState,
  hostId: string,
  error: string,
): void {
  const pendingDeliveries = Array.from(state.pendingSessionMessageDeliveries);
  for (const [requestId, pending] of pendingDeliveries) {
    if (pending.sourceHostId !== hostId && pending.targetHostId !== hostId) {
      continue;
    }
    clearTimeout(pending.timeout);
    state.pendingSessionMessageDeliveries.delete(requestId);
    if (pending.sourceHostId !== hostId) {
      postSessionMessageDeliveryResult(state, pending.sourceHostId, {
        error,
        messageId: pending.request.messageId,
        requestId,
        sessionId: pending.request.fromSessionId,
        status: "failed",
      });
    }
  }
}

function postSessionMessageDeliveryResult(
  state: TaskRealtimeBusState,
  hostId: string,
  result: SessionMessageDeliveryResult,
): void {
  state.hosts.get(hostId)?.child.postMessage({
    type: HostMessageTypes.SessionMessageDeliveryResult,
    result,
  });
}
