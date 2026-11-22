import type { Attributes, Context, Link, SpanKind, Tracer } from "@opentelemetry/api";
import type {
  AgentTelemetryAbandonReason,
  AgentTelemetryExecutionContext,
  TelemetryIdentitySnapshot,
} from "@zcode/contracts/telemetry";
import type { AgentTelemetryMetricRecorder } from "../agent-metrics.js";
import type { ActiveWriterContext, BaseSpanWriter, WriterHealth } from "../agent-trace-support.js";

export interface AgentTraceRuntimeOptions extends WriterHealth {
  identity?: TelemetryIdentitySnapshot;
  maxActiveWriters?: number;
  metrics?: AgentTelemetryMetricRecorder;
  tracer: Tracer;
}

export interface StartWriterOptions {
  attributes?: Attributes;
  context?: Context;
  correlation?: AgentTelemetryExecutionContext;
  kind?: SpanKind;
  links?: Link[];
  parent?: ActiveWriterContext;
  spanName: string;
  toolCallId?: string;
}

export type TrackedWriter = BaseSpanWriter & {
  abandon(reason: AgentTelemetryAbandonReason): void;
  readonly state: ActiveWriterContext;
};
