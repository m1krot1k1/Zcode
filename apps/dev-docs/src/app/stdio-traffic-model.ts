import type {
  StdioTrafficDirection,
  StdioTrafficFrame,
  StdioTrafficKind,
} from "@/data/protocolDocs.js";

export type DirectionFilter = StdioTrafficDirection | "all";
export type TrafficSourceMode = "real" | "mock";
export type RealTrafficStatus = "loading" | "ready" | "empty" | "missing" | "error";

export interface StdioTrafficApiRecordEnvelope {
  index: number;
  record: StdioTrafficTapRecord;
}

export interface StdioTrafficApiResponse {
  status: RealTrafficStatus;
  logDir: string;
  records: StdioTrafficApiRecordEnvelope[];
  error?: string;
  filePath?: string;
  updatedAt?: string;
  workspaceHash?: string;
}

export interface StdioTrafficTapRecord {
  ts?: string;
  workspaceKey?: string;
  proxyPid?: number;
  pid?: number | null;
  direction?: StdioTrafficDirection;
  bytes?: number;
  raw?: string;
  message?: unknown;
  parseError?: string | null;
  id?: unknown;
  method?: unknown;
  sessionId?: unknown;
  inputId?: unknown;
}

export interface RealTrafficState {
  status: RealTrafficStatus;
  logDir: string;
  records: StdioTrafficApiRecordEnvelope[];
  error?: string;
  filePath?: string;
  updatedAt?: string;
  workspaceHash?: string;
}

export const directionLabel: Record<StdioTrafficDirection, string> = {
  "agent-stderr": "stderr",
  "agent-to-app": "agent -> app",
  "app-to-agent": "app -> agent",
};

export const directionClassName: Record<StdioTrafficDirection, string> = {
  "agent-stderr": "border-command-node-hover bg-command-node text-command-node-foreground",
  "agent-to-app": "border-skill-node-hover bg-skill-node text-skill-node-foreground",
  "app-to-agent": "border-file-node-hover bg-file-node text-file-node-foreground",
};

export function trafficTimestampToMs(timestamp: string) {
  const [timePart = "00:00:00", millisecondPart = "0"] = timestamp.split(".");
  const [hours = 0, minutes = 0, seconds = 0] = timePart
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  const milliseconds = Number.parseInt(millisecondPart.padEnd(3, "0").slice(0, 3), 10) || 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

export function sortTrafficFramesByNewest(frames: StdioTrafficFrame[]) {
  return [...frames].sort(
    (first, second) =>
      trafficTimestampToMs(second.timestamp) - trafficTimestampToMs(first.timestamp),
  );
}

export function formatTrafficTimestamp(date: Date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

export function formatIsoTrafficTimestamp(value: string | undefined) {
  if (!value) {
    return "--:--:--.---";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return formatTrafficTimestamp(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function readMessageId(value: unknown) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function getMessagePayload(message: unknown) {
  if (!isRecord(message) || !isRecord(message.params)) {
    return undefined;
  }
  return isRecord(message.params.payload) ? message.params.payload : undefined;
}

function getTrafficRecordKind(record: StdioTrafficTapRecord): StdioTrafficKind {
  if (record.direction === "agent-stderr") {
    return "stderr";
  }

  if (record.method) {
    return typeof record.id === "undefined" ? "notification" : "request";
  }

  if (typeof record.id !== "undefined") {
    return "response";
  }

  return "notification";
}

function getTrafficRecordSummary(record: StdioTrafficTapRecord, kind: StdioTrafficKind) {
  if (kind === "stderr") {
    return (record.raw ?? "stderr").slice(0, 160);
  }

  if (record.parseError) {
    return `parse error: ${record.parseError}`;
  }

  const payload = getMessagePayload(record.message);
  const payloadType = readString(payload?.type);
  if (payloadType) {
    return payloadType;
  }

  if (kind === "response") {
    if (isRecord(record.message) && isRecord(record.message.error)) {
      return readString(record.message.error.message) ?? "response error";
    }
    return "response result";
  }

  return readString(record.method) ?? (record.raw ?? "traffic record").slice(0, 160);
}

export function formatRawLine(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

function mapTapRecordToFrame(
  envelope: StdioTrafficApiRecordEnvelope,
  workspaceHash: string | undefined,
): StdioTrafficFrame | null {
  const record = envelope.record;
  if (!record.direction) {
    return null;
  }

  const kind = getTrafficRecordKind(record);
  return {
    id: `real-${workspaceHash ?? "workspace"}-${envelope.index}-${record.ts ?? ""}`,
    timestamp: formatIsoTrafficTimestamp(record.ts),
    direction: record.direction,
    kind,
    method: readString(record.method),
    messageId: readMessageId(record.id),
    sessionId: readString(record.sessionId),
    inputId: readString(record.inputId),
    summary: getTrafficRecordSummary(record, kind),
    bytes: typeof record.bytes === "number" ? record.bytes : (record.raw ?? "").length,
    raw: record.raw ?? JSON.stringify(record.message ?? record),
  };
}

function linkTrafficFrames(frames: StdioTrafficFrame[]) {
  const requestByMessageId = new Map<string, StdioTrafficFrame>();
  const responseByMessageId = new Map<string, StdioTrafficFrame>();

  for (const frame of frames) {
    if (!frame.messageId) {
      continue;
    }
    if (frame.kind === "request") {
      requestByMessageId.set(frame.messageId, frame);
    } else if (frame.kind === "response") {
      responseByMessageId.set(frame.messageId, frame);
    }
  }

  return frames.map((frame) => {
    if (!frame.messageId) {
      return frame;
    }
    const linkedFrame =
      frame.kind === "request"
        ? responseByMessageId.get(frame.messageId)
        : frame.kind === "response"
          ? requestByMessageId.get(frame.messageId)
          : undefined;
    return linkedFrame ? { ...frame, linkedId: linkedFrame.id } : frame;
  });
}

export function mapRealTrafficFrames(realTraffic: RealTrafficState) {
  return linkTrafficFrames(
    realTraffic.records
      .map((envelope) => mapTapRecordToFrame(envelope, realTraffic.workspaceHash))
      .filter((frame): frame is StdioTrafficFrame => frame !== null),
  );
}

export function createLiveStdioTrafficFrame(
  sequence: number,
  timestamp: string,
): StdioTrafficFrame {
  const inputId = `inp_live_${String(sequence % 100).padStart(2, "0")}`;
  const messageId = String(20 + sequence);
  const eventSeq = 20 + sequence;

  if (sequence % 7 === 4) {
    return {
      id: `live-stderr-${sequence}`,
      timestamp,
      direction: "agent-stderr",
      kind: "stderr",
      sessionId: "sess_6b6a",
      summary: "provider heartbeat",
      bytes: 96,
      raw: `[zcode-agent] provider heartbeat seq=${eventSeq} status=streaming`,
    };
  }

  if (sequence % 5 === 1) {
    return {
      id: `live-send-${sequence}`,
      timestamp,
      direction: "app-to-agent",
      kind: "request",
      method: "session/send",
      messageId,
      sessionId: "sess_6b6a",
      inputId,
      summary: "new user input",
      bytes: 586,
      raw: `{
  "id": ${messageId},
  "method": "session/send",
  "params": {
    "sessionId": "sess_6b6a",
    "inputId": "${inputId}",
    "content": "debug live stdio frame ${sequence}"
  }
}`,
    };
  }

  if (sequence % 5 === 2) {
    return {
      id: `live-ack-${sequence}`,
      timestamp,
      direction: "agent-to-app",
      kind: "response",
      messageId,
      sessionId: "sess_6b6a",
      inputId,
      summary: "session/send accepted",
      bytes: 104,
      latencyMs: 8,
      raw: `{
  "id": ${messageId},
  "result": {
    "accepted": true,
    "inputId": "${inputId}"
  }
}`,
    };
  }

  return {
    id: `live-event-${sequence}`,
    timestamp,
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId,
    summary: sequence % 3 === 0 ? "message.part.delta" : "turn.progress",
    bytes: 520 + (sequence % 6) * 24,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": ${eventSeq},
    "payload": {
      "type": "${sequence % 3 === 0 ? "message.part.delta" : "turn.progress"}",
      "inputId": "${inputId}"
    }
  }
}`,
  };
}
