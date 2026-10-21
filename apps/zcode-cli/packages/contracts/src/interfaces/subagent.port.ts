// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================

import type { AgentBackgroundedOutput, AgentOutput, AgentTaskGraph } from "../tools/agent.js";
import type { Model, ModelSelection } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export const PRISM_TASK_CONTRACT_SCHEMA = "zcode.prism.task-contract.v2" as const;
export const PRISM_HOST_EVIDENCE_RECEIPT_SCHEMA = "zcode.prism.evidence-receipt.v2" as const;
export const PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA = "zcode.prism.bash-evidence.v1" as const;
export const PRISM_TASK_CONTRACT_MAX_CRITERIA = 16;
export const PRISM_TASK_CONTRACT_MAX_CRITERION_DESCRIPTION_BYTES = 500;
export const PRISM_EVIDENCE_RECEIPT_MAX_BYTES = 32 * 1024;
export const PRISM_BASH_EXIT_CODE_EVALUATOR_ID = "zcode.bash-exit-code" as const;
export const PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION = "1" as const;

/** Caller request is deliberately narrower than Host evaluator registration. */
export interface PrismTaskAcceptanceRequestCriterion {
  id: string;
  description: string;
  check: {
    kind: "bash_exit_code";
    command: string;
    expectedExitCode: 0;
  };
}

/** Критерий задачи. `evaluatorId/version` задаются Host-контрактом, а не выводятся из ответа агента. */
export interface PrismTaskAcceptanceCriterion {
  id: string;
  description: string;
  evaluatorId: string;
  evaluatorVersion: string;
  check: {
    kind: "bash_exit_code";
    /** SHA-256 of the exact request command; raw text is not copied to the persisted contract. */
    commandSha256: string;
    expectedExitCode: 0;
  };
}

/** Small, self-contained evidence snapshot; source events can be unavailable after process restart. */
export interface PrismBashEvidenceArtifact {
  schema: typeof PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA;
  childSessionId: SessionId;
  commandSha256: string;
  scheduledEventId: string;
  scheduledSequence: number;
  resultEventId: string;
  resultSequence: number;
  toolCallId: string;
  turnId?: string;
  status: "completed";
  exitCode: number;
}

/** Неизменяемый Host-контракт одной попытки узла в конкретном поколении ветки. */
export interface PrismTaskContract {
  schema: typeof PRISM_TASK_CONTRACT_SCHEMA;
  rootRunId: string;
  taskId: string;
  parentTaskId?: string;
  attemptId: string;
  branchGeneration: number;
  description: string;
  criteria: readonly PrismTaskAcceptanceCriterion[];
  /** SHA-256 нормализованного контракта без самого поля hash. */
  contractSha256: string;
}

/**
 * Receipt выпускается только Host verifier после собственной проверки artifact.
 * Эта структура не запускает verifier и не делает claim агента доказательством.
 */
export interface PrismHostEvidenceReceipt {
  schema: typeof PRISM_HOST_EVIDENCE_RECEIPT_SCHEMA;
  receiptId: string;
  issuer: "host_evaluator";
  rootRunId: string;
  taskId: string;
  parentTaskId?: string;
  attemptId: string;
  branchGeneration: number;
  criterionId: string;
  contractSha256: string;
  evaluatorId: string;
  evaluatorVersion: string;
  verifierInvocationId: string;
  result: "pass" | "fail";
  artifact: {
    /** Trace locator only. The inline artifact snapshot is the replay-verification source. */
    uri: string;
    sha256: string;
    bytes: number;
    evidence: PrismBashEvidenceArtifact;
  };
  observedAt: number;
}

export interface PrismTaskAcceptanceLineage {
  rootRunId: string;
  taskId: string;
  parentTaskId?: string;
  attemptId: string;
  branchGeneration: number;
}

export interface PrismTaskAcceptanceDecision {
  status: "unknown" | "verified" | "rejected";
  passedCriterionIds: string[];
  failedCriterionIds: string[];
  missingCriterionIds: string[];
}

export interface SubagentRunRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  callerCanReadOutputFile?: boolean;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
  /** Explicit machine-checkable criteria; absent criteria must remain acceptance=unknown. */
  acceptanceCriteria?: readonly PrismTaskAcceptanceRequestCriterion[];
}

/** Foreground DAG request; individual nodes own their prompts, agent types, and evidence criteria. */
export type SubagentTaskDagRequest = Omit<SubagentRunRequest, "acceptanceCriteria"> & {
  nodes: AgentTaskGraph["nodes"];
  maxParallel?: number;
};

export interface SubagentRunOptions {
  signal?: AbortSignal;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny" | "allow";
  };
}

export interface SubagentLaunchRequest extends SubagentRunRequest {
  runInBackground?: boolean;
}

export type SubagentLaunchOptions = SubagentRunOptions;

export type SubagentStartRequest = SubagentRunRequest;

export type SubagentStartOptions = SubagentRunOptions;

export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

export interface SubagentStopOptions {
  signal?: AbortSignal;
}

export interface SubagentSendMessageRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  summary: string;
  message: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

export type SubagentSendMessageOptions = SubagentRunOptions;

export type SubagentSendMessageDelivery = "queued" | "steered" | "resumed_background";

export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
}

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";

export interface SubagentTaskSnapshot {
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  notified?: boolean;
}

export interface SubagentPort {
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  runTaskDag?(request: SubagentTaskDagRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
}
