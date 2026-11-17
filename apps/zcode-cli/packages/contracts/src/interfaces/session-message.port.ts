import type { MessageId, PartId, SessionId, TurnId } from "./shared.js";
import type {
  CompactBoundaryPayload,
  CompactPhase,
  CompactReason,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  CompactTrigger,
} from "../compact/index.js";
import type { ModelId, ModelProviderId, ModelSelection } from "../model/index.js";

import type { SubagentTaskStatus } from "./subagent.port.js";
import type { EnvInfo } from "./context-source.port.js";
import type {
  FileDiff,
  MessageProjectionAnchor,
  MessageSemantics,
  MessageVisibility,
  SyntheticUserMessageSource,
} from "./session-store.port.js";

/**
 * Сообщения, части и timeline-типы вынесены из session-store.port.ts: файл перешёл
 * порог 800 строк. Контракт чисто типовой; session-store ре-экспортирует его,
 * поэтому потребители не меняются.
 */
export type OutputFormat =
  | { type: "text" }
  | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };

export interface MessageSummary {
  title?: string;
  body?: string;
  diffs: FileDiff[];
}

export interface MessageContextSnapshot {
  envInfo?: EnvInfo;
}

export interface UserMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "user";
  time: {
    created: number;
  };
  format?: OutputFormat;
  summary?: MessageSummary;
  agent: string;
  /** 未绑定会话的合成消息、缺少模型信息的旧消息不伪造请求来源。 */
  modelSelection?: ModelSelection;
  system?: string;
  tools?: Record<string, boolean>;
  contextSnapshot?: MessageContextSnapshot;
  synthetic?: boolean;
  source?: SyntheticUserMessageSource;
  visibility?: MessageVisibility;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  metadata?: Record<string, unknown>;
}

export interface AssistantErrorInfo {
  name: string;
  data?: Record<string, unknown>;
}

export interface TokenUsageInfo {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export type PersistedFinishReasonKind =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "other"
  | "unknown";

export interface PersistedStateTransition {
  from: string;
  to: string;
  reason?: string;
  atMs: number;
}

export interface PersistedStepDiagnostics {
  finishReason: PersistedFinishReasonKind;
  rawFinishReason?: string;
  rawTruncatedInputPreview?: string;
  repairAttempts?: PersistedToolRepairAttemptRecord[];
  effectiveMaxOutputTokens?: number;
  thinkingBudgetTokens?: number;
  cacheHitRatio?: number;
  stateTransitions: PersistedStateTransition[];
}

export type PersistedToolRepairStage =
  | "strip_markdown_fences"
  | "fix_trailing_commas"
  | "escape_unescaped_control_chars"
  | "unwrap_nested_arguments_key"
  | "coerce_scalar_types_by_schema"
  | "trim_parameter_keys"
  | "alias_known_field_names";

export interface PersistedToolRepairAttemptRecord {
  attemptIndex: number;
  appliedStages: PersistedToolRepairStage[];
  repairedSuccessfully: boolean;
  originalRawByteLength: number;
  remainingValidationErrors?: string[];
  durationMs: number;
}

export type PersistedToolFailureKind =
  | "truncated_by_max_tokens"
  | "invalid_json"
  | "schema_validation_failed"
  | "lock_timeout"
  | "syntax_validation_failed"
  | "execution_error";

export interface PersistedToolFailureDiagnostics {
  failureKind: PersistedToolFailureKind;
  rawTruncatedInputPreview?: string;
  rawTruncatedInputTotalBytes?: number;
  repairAttempts?: PersistedToolRepairAttemptRecord[];
}

export interface AssistantMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?: AssistantErrorInfo;
  parentID: MessageId;
  /** 真正模型输出应携带来源；历史恢复的合成时间线允许没有执行模型。 */
  modelId?: ModelId;
  providerId?: ModelProviderId;
  mode: string;
  /** 当前输出对应的 Plan 状态；旧记录缺失时按旧 mode 解释，不回填历史。 */
  planEnabled?: boolean;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  /** 模型价格目录能确定成本时才写入；未知价格省略，不能用 0 伪装。 */
  cost?: number;
  tokens: TokenUsageInfo;
  structured?: unknown;
  reasoningLevel?: string;
  finish?: string;
  /** Нормализованная причина завершения шага LLM (F-06). */
  finishReason?: PersistedFinishReasonKind | string;
  /** Сырая причина завершения от провайдера (например max_tokens / max_output_tokens). */
  rawFinishReason?: string;
  /** Превью усечённого аргумента tool call при finishReason === "length" (F-01 / F-06). */
  rawTruncatedInputPreview?: string;
  /** История попыток самовосстановления аргументов инструментов на этом шаге (F-01 / F-06). */
  repairAttempts?: PersistedToolRepairAttemptRecord[];
  /** Детерминированная трасса переходов конечного автомата хода (F-06). */
  stateTransitions?: PersistedStateTransition[];
  /** Полный диагностический снимок шага и переходов автомата хода (F-06). */
  stepDiagnostics?: PersistedStepDiagnostics;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  /** 附加领域语义（fork copy 的 forkOrigin provenance 等）。 */
  metadata?: Record<string, unknown>;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

export interface TextPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ReasoningPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "reasoning";
  text: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end?: number;
  };
}

export type FilePartSource =
  | {
      type: "file";
      path: string;
      text: { value: string; start: number; end: number };
    }
  | {
      type: "symbol";
      path: string;
      range: unknown;
      name: string;
      kind: number;
      text: { value: string; start: number; end: number };
    }
  | {
      type: "resource";
      clientName: string;
      uri: string;
      text: { value: string; start: number; end: number };
    };

export interface AttachmentStorageMetadata {
  sizeBytes?: number;
  sha256?: string;
  image?: {
    maxDimension?: number;
    originalWidth?: number;
    originalHeight?: number;
    width?: number;
    height?: number;
    resized?: boolean;
    transformedSizeBytes?: number;
  };
  storageKind?: "inline" | "artifact" | "local_ref" | "remote_ref" | "metadata_only";
  artifactUri?: string;
  originalUrl?: string;
  /** 路径引用首次发送的完整说明；恢复时原样复用，不能用文件内容 preview 代替。 */
  pathReferenceText?: string;
  recoverability?: "provider_ready" | "rebuildable" | "preview_only" | "metadata_only" | "missing";
  preview?: {
    text?: string;
    truncated?: boolean;
    originalBytes?: number;
    startLine?: number;
    totalLines?: number;
    truncatedByTokenCap?: boolean;
    partialViewNotice?: string;
  };
  errorCode?: string;
}

export interface FilePart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
  metadata?: AttachmentStorageMetadata;
}

export interface AgentPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
}

export interface CompactionPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "compaction";
  auto: boolean;
  trigger?: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  overflow?: boolean;
  tail_start_id?: MessageId;
  compactBoundary?: CompactBoundaryPayload;
  operationId?: string;
  timelineStatus?: CompactTimelineStatus;
  timelineDisplay?: CompactTimelineDisplay;
  timelineText?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  time?: {
    start?: number;
    end?: number;
  };
}

export type TimelinePartDisplay = "separator" | "worklog";

export type TimelinePartStatus =
  | "started"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | string;

export interface TimelineModelSelection extends ModelSelection {
  label?: string;
}

export interface TimelinePartBase {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "timeline";
  display: TimelinePartDisplay;
  status?: TimelinePartStatus;
  anchorMessageId?: MessageId;
  anchorTurnId?: TurnId;
  /** 用户命令产生的 marker 查重锚点；auto/system marker 缺省。 */
  sourceCommandId?: string;
  /**
   * fork copy 降级 provenance：anchor 指向未被复制的消息/父轮时，
   * 本地 anchor 必须清空（不得参与 child 落位），原引用降级到 origin* 仅供溯源。
   */
  originAnchorMessageId?: MessageId;
  originAnchorTurnId?: TurnId;
  time?: {
    start?: number;
    end?: number;
  };
}

export interface ContextCompactionTimelinePart extends TimelinePartBase {
  timelineType: "context_compaction";
  operationId: string;
  trigger: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
}

export interface GoalVerificationTimelinePart extends TimelinePartBase {
  timelineType: "goal_verification";
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  verification?: {
    passed: boolean;
    reason: string;
    nextAction?: string | null;
  };
}

export interface SessionForkTimelinePart extends TimelinePartBase {
  timelineType: "session_fork";
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFileCount?: number;
}

export interface ModelChangeTimelinePart extends TimelinePartBase {
  timelineType: "model_change";
  fromModel?: TimelineModelSelection;
  /** 回滚再升级后模型配置可缺失；不能因此丢掉整条历史内容。 */
  toModel?: TimelineModelSelection & { label: string };
}

export type TimelinePart =
  | ContextCompactionTimelinePart
  | GoalVerificationTimelinePart
  | SessionForkTimelinePart
  | ModelChangeTimelinePart;

export type TimelinePartDraft = TimelinePart extends infer Part
  ? Part extends TimelinePart
    ? Omit<Part, "id" | "messageID" | "sessionID" | "type">
    : never
  : never;

export interface SubtaskPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerId: ModelProviderId;
    modelId: ModelId;
  };
  command?: string;
}

export interface RetryPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "retry";
  attempt: number;
  error: AssistantErrorInfo;
  time: {
    created: number;
  };
}

export interface StepStartPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-finish";
  reason: string;
  rawReason?: string;
  snapshot?: string;
  /** 未知价格时省略；0 只表示真实零成本。 */
  cost?: number;
  tokens: TokenUsageInfo;
  stepDiagnostics?: PersistedStepDiagnostics;
}

export interface SnapshotPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "snapshot";
  snapshot: string;
}

export interface PatchPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "patch";
  hash: string;
  files: string[];
}

export interface ToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
  };
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: FilePart[];
  repairAttempts?: PersistedToolRepairAttemptRecord[];
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
  repairAttempts?: PersistedToolRepairAttemptRecord[];
  failureDiagnostics?: PersistedToolFailureDiagnostics;
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export interface ToolPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "tool";
  callID: string;
  /** 同一 assistant 内本地工具的声明序号；旧记录可缺失，不能用落盘顺序代替。 */
  declarationIndex?: number;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | FilePart
  | AgentPart
  | CompactionPart
  | TimelinePart
  | SubtaskPart
  | RetryPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | ToolPart;

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

/** 分享导入的单事务载荷：新 session、唯一 model-only 上下文和 provenance 全有或全无。 */

export type SharedContextImportStatus = "pending" | "reserved" | "attached" | "discarded";

export interface SharedContextImportTransition {
  sessionID: SessionId;
  contextId: string;
  expectedStatus: SharedContextImportStatus | readonly SharedContextImportStatus[];
  status: SharedContextImportStatus;
  /** queue/input identity or accepted user message identity for audit/recovery. */
  sourceId?: string;
}

export interface RuntimeTaskTerminalCatalogRecord {
  schema: "zcode.runtime.task-terminal.v1";
  taskId: string;
  attemptId: string;
  taskType: "local_agent";
  agentId: string;
  agentType: string;
  childSessionId?: SessionId;
  parentToolCallId?: string;
  pid?: number;
  status: SubagentTaskStatus;
  description: string;
  error?: string;
  exitCode?: number;
  startedAt: number;
  completedAt: number;
}
