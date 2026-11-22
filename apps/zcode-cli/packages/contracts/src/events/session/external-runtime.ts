// -----------------------------------------------
// Externally owned runtime payloads (OpenCode ACP, ZCode swarm)
// -----------------------------------------------

export interface OpenCodeAgentRunUpdatedPayload {
  runId: string;
  commandId: string;
  modelId?: string;
  promptText: string;
  outputText: string;
  tools: Array<{ toolCallId: string; title: string; status: string }>;
  status: "starting" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
  startedAt?: number;
  endedAt?: number;
  diagnosticCode?: string;
}

export interface SwarmRunUpdatedPayload {
  swarmRunId: string;
  status: "planning" | "running" | "completed" | "failed" | "cancelled";
  /** Host-derived PRISM aggregate; absent in legacy events means unknown, never execution success. */
  outcomeAcceptance?: "unknown" | "verified" | "rejected";
  taskCount?: number;
  childSessionIds?: string[];
  /** Runtime-reported profile ID keyed by child session ID; bounded by the child count. */
  childAgentTypes?: Record<string, string>;
  summary?: string;
}

/** Ephemeral ACP permission state. This payload is only sent through the live V4 gateway. */
export interface OpenCodeAgentPermissionUpdatedPayload {
  runId: string;
  commandId: string;
  opencodeSessionId: string;
  requestId: string;
  state: "requested" | "resolved";
  cancelled?: boolean;
  request?: {
    title: string;
    inputSummary?: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
  };
}
