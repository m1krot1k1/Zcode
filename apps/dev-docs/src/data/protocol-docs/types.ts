export type ConceptKind = "id" | "state" | "protocol" | "runtime" | "compat";

export interface Concept {
  id: string;
  name: string;
  kind: ConceptKind;
  summary: string;
  lifecycle: string;
  owner: string;
  source: string;
  aliases?: string[];
  related: string[];
}

export interface FieldDoc {
  name: string;
  type: string;
  required: "required" | "optional" | "legacy";
  meaning: string;
  owner: string;
  source: string;
  conceptIds: string[];
  oldName?: string;
  notes?: string;
}

export interface StructureDoc {
  id: string;
  title: string;
  path: string;
  purpose: string;
  oldShape?: string;
  newShape: string;
  migration: string;
  fields: FieldDoc[];
}

export interface FlowStep {
  id: string;
  title: string;
  actor: string;
  detail: string;
  conceptIds: string[];
}

export type StdioTrafficDirection = "app-to-agent" | "agent-to-app" | "agent-stderr";

export type StdioTrafficKind = "request" | "response" | "notification" | "stderr";

export interface StdioTrafficFrame {
  id: string;
  timestamp: string;
  direction: StdioTrafficDirection;
  kind: StdioTrafficKind;
  method?: string;
  messageId?: string;
  sessionId?: string;
  inputId?: string;
  summary: string;
  bytes: number;
  latencyMs?: number;
  linkedId?: string;
  raw: string;
}

export interface StdioTrafficLogField {
  name: string;
  type: string;
  meaning: string;
}
