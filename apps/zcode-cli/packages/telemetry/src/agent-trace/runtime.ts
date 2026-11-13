import { context, ROOT_CONTEXT, SpanKind, trace, type Span, type Tracer } from "@opentelemetry/api";
import type {
  AgentExecutionTelemetryPort,
  AgentStepSpanWriter,
  AgentStepTraceStart,
  AgentTelemetryExecutionContext,
  AgentTurnSpanWriter,
  AgentTurnTraceStart,
  CommandExecutionSpanWriter,
  CommandTraceStart,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
  ModelAttemptSpanWriter,
  ModelAttemptTraceStart,
  ModelCallSpanWriter,
  ModelCallTraceStart,
  ModelExecutionTelemetryPort,
  TelemetryIdentitySnapshot,
  ToolExecutionSpanWriter,
  ToolTraceStart,
} from "@zcode/contracts/telemetry";
import {
  NOOP_AGENT_TELEMETRY_METRICS,
  type AgentMetricSpanName,
  type AgentTelemetryMetricRecorder,
} from "../agent-metrics.js";
import {
  activeWriterContext,
  compactAttributes,
  contextFromCausation,
  executionProjection,
  finiteNonNegative,
  integer,
  safeEnum,
  safeId,
  safeString,
  type WriterHealth,
} from "../agent-trace-support.js";
import {
  modelAttemptCompatibilityAttributes,
  toolCompatibilityAttributes,
} from "../compatibility-adapters.js";
import {
  causationLink,
  commandMetricLabels,
  compactionMetricLabels,
  detachedMetricLabels,
  modelAttemptMetricLabels,
  modelCallMetricLabels,
  stepMetricLabels,
  toolMetricLabels,
  turnMetricLabels,
} from "./attributes.js";
import {
  NOOP_COMMAND_WRITER,
  NOOP_COMPACTION_WRITER,
  NOOP_DETACHED_WRITER,
  NOOP_MODEL_ATTEMPT_WRITER,
  NOOP_MODEL_CALL_WRITER,
  NOOP_STEP_WRITER,
  NOOP_TOOL_WRITER,
  NOOP_TURN_WRITER,
} from "./noop.js";
import type { AgentTraceRuntimeOptions, StartWriterOptions, TrackedWriter } from "./types.js";
import {
  CommandWriter,
  CompactionWriter,
  DetachedWriter,
  StepWriter,
  ToolWriter,
  TurnWriter,
} from "./writers/agent-writers.js";
import { ModelAttemptWriter, ModelCallWriter } from "./writers/model-writers.js";
import { inheritedMetadata, positiveLimit } from "./writer-support.js";

export class AgentExecutionTelemetryRuntime
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  private readonly activeWriters = new Set<TrackedWriter>();
  private capacityWarningActive = false;
  private identity: TelemetryIdentitySnapshot;
  private readonly maxActiveWriters: number;
  private readonly tracer: Tracer;
  private readonly health: WriterHealth;
  private readonly metrics: AgentTelemetryMetricRecorder;

  constructor(options: AgentTraceRuntimeOptions) {
    this.tracer = options.tracer;
    this.maxActiveWriters = positiveLimit(options.maxActiveWriters, 5_000);
    this.health = { onWarning: options.onWarning };
    this.metrics = options.metrics ?? NOOP_AGENT_TELEMETRY_METRICS;
    this.identity = options.identity ?? { identityState: "unknown" };
  }

  updateIdentity(snapshot: TelemetryIdentitySnapshot): void {
    this.identity = {
      identityState: snapshot.identityState,
      ...(safeId(snapshot.userSubjectId) ? { userSubjectId: safeId(snapshot.userSubjectId) } : {}),
    };
  }

  captureCausation() {
    const active = activeWriterContext();
    if (!active) return undefined;
    const spanContext = active.span.spanContext();
    if (!trace.isSpanContextValid(spanContext)) return undefined;
    return {
      isRemote: spanContext.isRemote ?? false,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceId: spanContext.traceId,
      ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
      sessionId: active.correlation?.sessionId,
      turnId: active.correlation?.turnId,
      toolCallId: active.toolCallId,
    };
  }

  startTurn(input: AgentTurnTraceStart): AgentTurnSpanWriter {
    const correlation: AgentTelemetryExecutionContext = {
      ...input.context,
      identityState: this.identity.identityState,
      ...(this.identity.userSubjectId ? { userSubjectId: this.identity.userSubjectId } : {}),
    };
    const linkedRoot = input.causationMode !== "child";
    const links =
      input.causation && linkedRoot ? [causationLink(input.causation, "spawned_by")] : undefined;
    return this.safeCreate(
      "agent_turn",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(correlation, {
              includeActor: true,
              includeAgent: true,
              includeIdentity: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.agent_turn.turn_number": integer(input.turnNumber),
            "zcode.agent_turn.input_source": safeEnum(input.inputSource),
          }),
          context: parentContext,
          correlation,
          links,
          spanName: "agent_turn",
        });
        return this.track(
          new TurnWriter(
            span,
            parentContext,
            {
              correlation,
              spanName: "agent_turn",
            },
            this.health,
            this.metrics,
            turnMetricLabels(correlation, input.inputSource),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_TURN_WRITER,
    );
  }

  startStep(input: AgentStepTraceStart): AgentStepSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "agent_step",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation),
            "zcode.agent_step.step_id": safeId(input.stepId),
            "zcode.agent_step.step_index": integer(input.stepIndex),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "agent_step",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new StepWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "agent_step"),
            this.health,
            this.metrics,
            stepMetricLabels(parent?.correlation),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_STEP_WRITER,
    );
  }

  startTool(input: ToolTraceStart): ToolExecutionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "tool_execution",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const toolName = safeString(input.registeredToolName, 128);
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation, { includeActor: true }),
            "zcode.execution.tool_call_id": safeId(input.toolCallId),
            "zcode.tool_execution.tool_name": toolName,
            ...toolCompatibilityAttributes({
              toolCallId: input.toolCallId,
              toolName: input.registeredToolName,
            }),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "tool_execution",
          toolCallId: safeId(input.toolCallId),
        });
        return this.track(
          new ToolWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "tool_execution"),
              toolCallId: safeId(input.toolCallId),
            },
            this.health,
            this.metrics,
            toolMetricLabels(input.registeredToolName),
            (writer) => this.activeWriters.delete(writer),
            (command) => this.startCommand(command),
          ),
        );
      },
      NOOP_TOOL_WRITER,
    );
  }

  startCompaction(input: CompactionTraceStart): ContextCompactionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "context_compaction",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation),
            "zcode.context_compaction.trigger": safeEnum(input.trigger),
            "zcode.context_compaction.phase": safeEnum(input.phase),
            "zcode.context_compaction.model_mode": safeEnum(input.modelMode),
            "zcode.context_compaction.outer_attempt": integer(input.outerAttempt),
            "zcode.context_compaction.max_attempts": integer(input.maxAttempts),
            "zcode.context_compaction.triggering_step_index": integer(input.triggeringStepIndex),
            "zcode.context_compaction.policy_context_window_tokens": finiteNonNegative(
              input.policyContextWindowTokens,
            ),
            "zcode.context_compaction.threshold_tokens": finiteNonNegative(input.thresholdTokens),
            "zcode.context_compaction.token_source": safeEnum(input.tokenSource),
            "zcode.context_compaction.recovered_from_logical_call_id": safeId(
              input.recoveredFromLogicalCallId,
            ),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "context_compaction",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new CompactionWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "context_compaction"),
            this.health,
            this.metrics,
            compactionMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMPACTION_WRITER,
    );
  }

  startDetachedOperation(input: DetachedOperationTraceStart): DetachedOperationSpanWriter {
    const linkedRoot = input.executionKind !== "foreground";
    const links =
      input.causation && linkedRoot
        ? [
            causationLink(
              input.causation,
              input.trigger === "recovery" ? "resumed_from" : "triggered_by",
            ),
          ]
        : undefined;
    return this.safeCreate(
      "detached_operation",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(input.context, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.detached_operation.operation": safeEnum(input.operation),
            "zcode.detached_operation.execution_kind": safeEnum(input.executionKind),
            "zcode.detached_operation.trigger": safeEnum(input.trigger),
            "zcode.detached_operation.target_kind": safeEnum(input.targetKind),
            "zcode.detached_operation.goal_iteration": integer(input.goalIteration),
            "zcode.detached_operation.chunk_index": integer(input.chunkIndex),
            "zcode.detached_operation.chunk_count": integer(input.chunkCount),
          }),
          context: parentContext,
          correlation: input.context,
          links,
          spanName: "detached_operation",
        });
        return this.track(
          new DetachedWriter(
            span,
            parentContext,
            {
              correlation: input.context,
              spanName: "detached_operation",
            },
            this.health,
            this.metrics,
            detachedMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_DETACHED_WRITER,
    );
  }

  startCall(input: ModelCallTraceStart): ModelCallSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "model_call",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.execution.logical_call_id": safeId(input.logicalCallId),
            "zcode.model_call.operation": safeEnum(input.operation),
            "zcode.model_call.streaming": input.streaming,
            "zcode.model_call.model_role": safeEnum(input.modelRole),
            "zcode.model_call.requested_provider_id": safeString(input.requested.providerId, 128),
            "zcode.model_call.requested_model": safeString(input.requested.requestedModel, 128),
            "zcode.model_call.reasoning_capability": safeEnum(input.requested.reasoning.capability),
            "zcode.model_call.reasoning_requested_state": safeEnum(
              input.requested.reasoning.requestedState,
            ),
            "zcode.model_call.reasoning_requested_control": safeEnum(
              input.requested.reasoning.requestedControl,
            ),
            "zcode.model_call.reasoning_requested_level": safeString(
              input.requested.reasoning.requestedLevel,
              128,
            ),
            "zcode.model_call.reasoning_requested_budget_tokens": integer(
              input.requested.reasoning.requestedBudgetTokens,
            ),
            "zcode.model_call.call_cause": safeEnum(input.callCause),
            "zcode.model_call.previous_logical_call_id": safeId(input.previousLogicalCallId),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "model_call",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new ModelCallWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "model_call"),
            },
            this.health,
            this.metrics,
            modelCallMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
            (writer, attempt) => this.startAttempt(writer, attempt),
            safeId(input.logicalCallId),
            safeEnum(input.operation),
            safeEnum(input.modelRole),
          ),
        );
      },
      NOOP_MODEL_CALL_WRITER,
    );
  }

  abandonSession(sessionId: string): void {
    for (const writer of this.activeWriters) {
      if (writer.state.correlation?.sessionId === sessionId) {
        writer.abandon("session_shutdown");
      }
    }
  }

  abandonProcess(): void {
    for (const writer of this.activeWriters) writer.abandon("process_shutdown");
  }

  private startCommand(
    input: CommandTraceStart & { parent: ToolWriter },
  ): CommandExecutionSpanWriter {
    const parent = input.parent.state;
    return this.safeCreate(
      "command_execution",
      () => {
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent.correlation),
            "zcode.execution.tool_call_id": safeId(parent.toolCallId),
            "zcode.command_execution.safe_name": safeString(input.safeName, 128),
            "zcode.command_execution.category": safeEnum(input.category),
            "zcode.command_execution.command_count": integer(input.commandCount),
            "zcode.command_execution.shell_kind": safeEnum(input.shellKind),
            "zcode.command_execution.sandboxed": input.sandboxed,
          }),
          context: parent.activeContext,
          correlation: parent.correlation,
          parent,
          spanName: "command_execution",
          toolCallId: parent.toolCallId,
        });
        return this.track(
          new CommandWriter(
            span,
            parent.activeContext,
            inheritedMetadata(parent, "command_execution"),
            this.health,
            this.metrics,
            commandMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMMAND_WRITER,
    );
  }

  private startAttempt(
    parentWriter: ModelCallWriter,
    input: ModelAttemptTraceStart,
  ): ModelAttemptSpanWriter {
    const parent = parentWriter.state;
    return this.safeCreate(
      "model_attempt",
      () => {
        const target = input.target;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent.correlation, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.execution.tool_call_id": safeId(parent.toolCallId),
            "zcode.execution.logical_call_id": parentWriter.logicalCallId,
            "zcode.execution.model_operation": parentWriter.operation,
            "zcode.execution.model_role": parentWriter.modelRole,
            "zcode.model_attempt.request_id": safeId(input.requestId),
            "zcode.model_attempt.attempt_number": integer(input.attemptNumber),
            "zcode.model_attempt.max_attempts": integer(input.maxAttempts),
            "zcode.model_attempt.attempt_cause": safeEnum(input.attemptCause),
            "zcode.model_attempt.previous_request_id": safeId(input.previousRequestId),
            "zcode.model_attempt.retry_delay_ms": finiteNonNegative(input.retryDelayMs),
            "zcode.model_attempt.provider_id": safeString(target.providerId, 128),
            "zcode.model_attempt.provider_kind": safeEnum(target.providerKind),
            "zcode.model_attempt.provider_origin": safeString(target.providerOrigin),
            "zcode.model_attempt.provider_route": safeString(target.providerRoute),
            "zcode.model_attempt.requested_model": safeString(target.requestedModel, 128),
            "zcode.model_attempt.transport": safeEnum(input.transport),
            "zcode.model_attempt.api_operation": safeEnum(input.apiOperation),
            "zcode.model_attempt.reasoning_capability": safeEnum(target.reasoning.capability),
            "zcode.model_attempt.reasoning_requested_state": safeEnum(
              target.reasoning.requestedState,
            ),
            "zcode.model_attempt.reasoning_requested_control": safeEnum(
              target.reasoning.requestedControl,
            ),
            "zcode.model_attempt.reasoning_requested_level": safeString(
              target.reasoning.requestedLevel,
              128,
            ),
            "zcode.model_attempt.reasoning_requested_budget_tokens": integer(
              target.reasoning.requestedBudgetTokens,
            ),
            ...modelAttemptCompatibilityAttributes(target),
          }),
          context: parent.activeContext,
          correlation: parent.correlation,
          kind: SpanKind.CLIENT,
          parent,
          spanName: "model_attempt",
          toolCallId: parent.toolCallId,
        });
        return this.track(
          new ModelAttemptWriter(
            span,
            parent.activeContext,
            inheritedMetadata(parent, "model_attempt"),
            this.health,
            this.metrics,
            modelAttemptMetricLabels(input, parentWriter),
            () => parentWriter.recordAttemptFailed(),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_MODEL_ATTEMPT_WRITER,
    );
  }

  private startSpan(options: StartWriterOptions): Span {
    return this.tracer.startSpan(
      options.spanName,
      {
        attributes: options.attributes,
        kind: options.kind ?? SpanKind.INTERNAL,
        links: options.links,
      },
      options.context ?? context.active(),
    );
  }

  private track<T extends TrackedWriter>(writer: T): T {
    this.activeWriters.add(writer);
    return writer;
  }

  private safeCreate<T>(spanName: string, create: () => T, fallback: T): T {
    if (this.activeWriters.size >= this.maxActiveWriters) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "process_capacity"),
      );
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        try {
          this.health.onWarning?.("Telemetry active writer capacity was reached", {
            activeWriterCount: this.activeWriters.size,
            maxActiveWriters: this.maxActiveWriters,
            spanName,
          });
        } catch {
          // 健康回调同样属于旁路。
        }
      }
      return fallback;
    }
    this.capacityWarningActive = false;
    try {
      return create();
    } catch (error) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "unknown"),
      );
      try {
        this.health.onWarning?.("Telemetry writer creation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          spanName,
        });
      } catch {
        // 健康回调同样属于旁路。
      }
      return fallback;
    }
  }

  private safeMetric(record: () => void): void {
    try {
      record();
    } catch (error) {
      try {
        this.health.onWarning?.("Telemetry metric operation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Metric 与健康回调都属于旁路。
      }
    }
  }
}
