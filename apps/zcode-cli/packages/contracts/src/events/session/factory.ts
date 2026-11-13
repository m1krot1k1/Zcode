import type { EventId, SessionId, TurnId, TraceId } from "../../interfaces/shared.js";
import {
  createModelUsageSummary,
  type ModelNetworkStatusEvent,
  type ModelUsage,
  type ModelUsageSummary,
} from "../../model/index.js";
import { SessionEventType, type SessionEvent } from "./base.js";
import type { ModelCompletePayload } from "./model.js";

// -----------------------------------------------
// Event Factory
// -----------------------------------------------

export function createSessionEvent<T>(
  type: SessionEventType,
  sessionId: SessionId,
  payload: T,
  options?: {
    turnId?: TurnId;
    traceId?: TraceId;
    sequenceNumber?: number;
  },
): SessionEvent {
  return {
    id: crypto.randomUUID() as EventId,
    sessionId,
    turnId: options?.turnId,
    type,
    timestamp: new Date(),
    traceId: options?.traceId ?? (crypto.randomUUID() as TraceId),
    sequenceNumber: options?.sequenceNumber ?? 0,
    payload,
  };
}

export function createModelUsageSummaryFromEvents(
  events: readonly SessionEvent[],
): ModelUsageSummary | undefined {
  const usages: ModelUsage[] = [];

  for (const event of events) {
    if (event.type === SessionEventType.ModelNetworkStatus) {
      const payload = event.payload as ModelNetworkStatusEvent;
      // 成功请求由 ModelComplete 计入；只补充失败请求的已报告用量，避免双计。
      if (payload.type === "model_request_failed" && payload.usage) usages.push(payload.usage);
    }
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}
