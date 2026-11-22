import type {
  SessionEvent,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type { ZCodeSessionSubagentsResult } from "@zcode/shared";
import type { SessionTranscriptMessage } from "../../session-transcript.js";

export interface SubagentObservationDeps {
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  runtime: AgentRuntime;
}

export interface SubagentTranscriptSnapshot {
  sessionId: string;
  sequenceNumber: number;
  messages: Array<SessionTranscriptMessage & { id?: string }>;
  events: SessionEvent[];
  replayMessageIds: string[];
}

export interface SubagentObservation {
  /** Reads a read-only directory projection; it never restores ended tasks into runtime state. */
  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<ZCodeSessionSubagentsResult>;
  /** Reads the selected child's persisted transcript and live event tail without merging them twice. */
  readSubagentTranscript(childSessionId: string): Promise<SubagentTranscriptSnapshot>;
}
