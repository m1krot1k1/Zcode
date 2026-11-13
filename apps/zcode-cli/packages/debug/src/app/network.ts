import type { NetworkRequestRecord, TraceSpan } from "../shared";
import { compareDateDesc, formatBytes, formatNetworkStatus } from "./format";

export function mergeNetworkRequest(
  current: NetworkRequestRecord[],
  next: NetworkRequestRecord,
): NetworkRequestRecord[] {
  const byId = new Map(current.map((request) => [request.id, request]));
  byId.set(next.id, next);
  return [...byId.values()]
    .toSorted((left, right) => compareDateDesc(left.startedAt, right.startedAt))
    .slice(0, 200);
}

export function mergeNetworkSpans(
  spans: TraceSpan[],
  requests: NetworkRequestRecord[],
  traceId: string,
): TraceSpan[] {
  if (!traceId) return spans;
  const networkSpans = requests
    .filter((request) => request.traceId === traceId)
    .map(networkRequestToSpan);
  return [...spans, ...networkSpans];
}

function networkRequestToSpan(request: NetworkRequestRecord): TraceSpan {
  return {
    id: `network:${request.id}`,
    traceId: request.traceId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    spanId: request.spanId,
    lane: "network",
    label: `${request.method} ${request.host}`,
    source: "network",
    startAt: request.startedAt,
    endAt: request.completedAt,
    status: request.status === "pending" ? "running" : request.status === "error" ? "error" : "ok",
    summary: `${request.method} ${request.url}\n${formatNetworkStatus(request)} · ${formatBytes(
      request.requestBodyBytes,
    )} up · ${formatBytes(request.responseBodyBytes)} down`,
    payload: request,
  };
}

export function filterNetworkRequests(
  requests: NetworkRequestRecord[],
  filter: string,
): NetworkRequestRecord[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return requests;
  return requests.filter((request) =>
    [
      request.traceId,
      request.sessionId,
      request.turnId,
      request.spanId,
      request.method,
      request.host,
      request.path,
      request.url,
      request.status,
      request.statusCode ? String(request.statusCode) : "",
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized)),
  );
}

export function networkRequestFromPayload(payload: unknown): NetworkRequestRecord | null {
  if (!isPlainObject(payload)) return null;
  if (typeof payload.id !== "string") return null;
  if (typeof payload.startedAt !== "string") return null;
  if (typeof payload.method !== "string") return null;
  if (typeof payload.url !== "string") return null;
  if (typeof payload.status !== "string") return null;
  return payload as unknown as NetworkRequestRecord;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
