// re-home 迁移产物（为删除旧协议树铺路）。
// 本文件承载旧 task 投影中仍被存活栈消费的明星承重类型：ZCodeTaskMeta / ZCodeProvider /
// ZCodeStreamEvent / TraceId/InputId/QueryId / ZCodePersistedMessage(Part) / ZCodeTaskSnapshot /
// ZCodePlanStep / ZCodePermissionRequest 及其依赖闭包（含 realtime 传输基础类型）。
// zcode-task-types.ts / task-realtime.ts 仍保留旧协议兼容面，共用本文件中的核心类型。

import type { ZCodeBackgroundTaskControlItem } from "./background-task-controls.js";
import type { ToolCallDisplay } from "./zcode-protocol-v4/toolDisplay.js";
import type {
  ZCodeContextUsageBreakdownItem,
  ZCodeInteractionRequestOrigin,
  ZCodePermissionResponse,
  ZCodeSessionActiveTurnKind,
} from "./zcode-protocol-legacy-types.js";
import type { ErrorAttribution } from "./zcode-protocol-v4/snapshot.js";

// Часть 1/2 модуля zcode-task-types: вынесено по лимиту строк.

/**
 * ZCode task/session 投影共享类型定义
 *
 * 跨 renderer、host process、ZCode agent service 使用的类型。
 */

// ---- 可观测性 ----

/** 全链路追踪 ID，用于日志和观测链路。 */
export type TraceId = string;

/** 每次用户输入的归属 ID，用于 stop/队列/终态收口。 */
export type InputId = string;

/** 每条真实用户 query 的语义归因 ID，用于模型请求 header 和用户问题级观测。 */
export type QueryId = string;

// ---- ZCode Provider ----

/** 支持的 ZCode agent 提供方；当前仅保留 glm。 */
export type ZCodeProvider = "glm";

export type ZCodeGlmAgentModelStateUpdateReason =
  | "session_initialized"
  | "model_changed"
  | "thought_level_changed";

export interface ZCodeGlmAgentModelStateOption {
  value: string;
  name: string;
}

/** 外部历史迁移来源。当前只落 Claude Code，后续其它来源继续在这里扩展。 */
export type ZCodeTaskMigrationSource = "claudeCode";

export type ZCodeTaskGoalStatus = "active" | "paused" | "budget_limited" | "complete";

export type ZCodeTaskTargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

export type ZCodeTaskTargetChangedSource = "command" | "tool" | "runtime";

export interface ZCodeTaskGoalStats {
  /** goal 运行累计秒数；来自 agent 的 session_target 或历史 turn 投影。 */
  timeUsedSeconds: number;
  /** goal 累计 token；优先使用 goal 记账，必要时由 agent 按历史 turn 兜底。 */
  tokensUsed: number;
  /** 用户显式设置的 goal token budget；为空时 UI 可展示 context window。 */
  tokenBudget: number | null;
  /** 当前 session 上下文窗口已使用 token。 */
  contextUsed: number;
  /** 当前 session 上下文窗口容量。 */
  contextWindow: number;
  /** goal 相关历史 tool calls 数。 */
  toolCallCount: number;
  /** 已触发的 goal verifier 生命周期轮次，不等同于普通 runtime turn 或用户继续次数。 */
  iterationCount: number;
}

export interface ZCodeGoalVerification {
  nextAction?: string | null;
  passed: boolean;
  reason: string;
}

export type ZCodeGoalVerificationTimelineStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

// ---- ZCode task 模式 ----

export type ZCodeTaskMode =
  | "default"
  | "yolo"
  | "guarded"
  | "plan"
  | "edit"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | "autoEdit"
  | "build";

export type ZCodeOffPeakRunType = "init" | "resume";

/** 当前 workspace 下任务的运行时状态 */
export type ZCodeTaskRuntimeStatus =
  | "idle"
  | "creating"
  | "notReady"
  | "restoring"
  | "ready"
  | "streaming"
  | "completed"
  | "failed";

/** 持久化的任务状态，记录最后一次 prompt 的结果 */
export type ZCodeTaskPersistStatus = "running" | "completed" | "error";

/**
 * 当前 prompt 支持的附件类型。
 * 图片小文件走 agent image block；本地文件/大图片优先走 localPath，让 agent 按自己的阈值读取。
 */
export interface ZCodePromptImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** agent ImageContent 已经单独携带 mimeType，所以这里只保留纯 base64 正文。 */
  dataBase64?: string;
  /** 桌面端真实本地路径；大图片不再塞进协议正文，由 agent 侧按路径处理。 */
  localPath?: string;
}

export interface ZCodePromptFileAttachment {
  kind: "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** 附件来源；clipboard-text 表示由长文本粘贴落盘生成，agent 只应按临时文件引用处理。 */
  sourceKind?: "clipboard-text" | "topic-history";
  messageCount?: number;
  /** 旧版/无路径环境的兼容回退；新桌面 GUI 不再为普通文件发送 base64。 */
  dataBase64?: string;
  /** 无本地路径时的小文本回退；有 localPath 时由 agent 自行读取。 */
  textContent?: string;
  localPath?: string;
}

export interface ZCodePromptAudioAttachment {
  kind: "audio";
  filename: string;
  mimeType: string;
  /** agent AudioContent 已经单独携带 mimeType，所以这里只保留纯 base64 正文。 */
  dataBase64?: string;
  localPath?: string;
}

/** 视频附件：Web 小视频走 dataBase64，桌面端优先 localPath 零拷贝。 */
export interface ZCodePromptVideoAttachment {
  kind: "video";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** 纯 base64 正文；mimeType 由字段单独携带。 */
  dataBase64?: string;
  /** 桌面端真实本地路径；agent 侧按路径读取并做大小校验。 */
  localPath?: string;
}

export interface ZCodePromptPdfAttachment {
  kind: "pdf";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  localPath?: string;
}

// ---- Task 元数据 ----

export type ZCodeTaskInteractionAutoResolution =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface ZCodeTaskRepairState {
  /** Claude 原生日志补齐历史 snapshot assistant 正文的修复版本。 */
  claudeNativeSnapshotAssistantContentVersion?: number;
  /** Codex 原生日志补齐历史 snapshot 子 agent 工具块的修复版本。 */
  codexNativeSnapshotSubagentToolsVersion?: number;
}

export interface ZCodeTaskChangedFileSummary {
  path: string;
  added: number;
  removed: number;
  /** 同一任务内该文件被写入的总次数 */
  writeCount: number;
  /** 最后一次写入发生在第几轮，后续回滚按钮可直接复用 */
  lastTurnIndex: number;
}

export interface ZCodeConfigSelectValue {
  value: string;
  name: string;
  description?: string;
  /** 值来源：原生模型列表或会话侧注入项（用于 UI 去重与展示控制） */
  origin?: "native" | "injected";
  /** 模型选项所属供应商/分组 id，用于 provider -> model 分组选择 */
  modelProviderId?: string;
  /** 模型选项所属供应商/分组展示名 */
  modelProviderName?: string;
  /** 缺失表示能力未知，空数组表示已知没有可选 reasoning 档位 */
  modelThoughtLevels?: string[];
  /** 模型目录声明的默认 reasoning 档位，不代表用户显式选择 */
  modelDefaultThoughtLevel?: string;
}

export interface ZCodeSlashCommand {
  name: string;
  description: string;
  inputHint?: string;
  /** 命令来源；旧协议可能为空，客户端应按 builtin 兼容处理。 */
  source?: "builtin" | "custom";
}

export interface ZCodeTaskModeInfo {
  id: string;
  name: string;
  description?: string;
}

export type ZCodeTurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

export type ZCodeTurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";

export type ZCodeTimelineStatus =
  | "started"
  | "retrying"
  | "skipped"
  | "completed"
  | "failed"
  | "interrupted";

export type ZCodeTimelineTrigger = "manual" | "auto" | "reactive" | "partial" | "session_memory";

export type ZCodeContextCompactionTimelinePhase =
  | "standalone_turn"
  | "pre_request"
  | "mid_turn"
  | "reactive";

export interface ZCodeSessionForkTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "session_fork";
  display: "separator";
  parentSessionId: string;
  targetMessageId: string;
  /** 纯对话 fork 没有 workspace checkpoint；UI 跳回父消息只依赖 targetMessageId。 */
  targetCheckpointId?: string;
  restoredFileCount?: number;
}

export interface ZCodePlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ZCodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: ZCodePermissionResponse;
}

/** ZCode Elicitation 选项 */
export interface ZCodeElicitationOption {
  value: string;
  label: string;
  description?: string;
}

export interface ZCodeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 推理/思考消耗的 token 数；对齐 agent `thoughtTokens`。 */
  reasoningTokens?: number;
  /** 命中缓存的 input token 数 */
  cachedInputTokens?: number;
  /** 写入缓存的 input token 数 */
  cachedWriteInputTokens?: number;
}

export interface ZCodeContextCacheUsage {
  /** Provider 上报的最近一次主轮输入 token 数。 */
  inputTokens: number;
  /** Provider 上报的最近一次主轮缓存命中 token 数。 */
  cacheReadTokens: number;
  /** Provider 上报的最近一次主轮缓存写入 token 数。 */
  cacheWriteTokens: number;
  /** 最近一次主轮 provider usage 的缓存命中率；未知时为 null。 */
  latestHitRate?: number | null;
  /** 参与累计平均的主轮请求数量。 */
  hitRateRequestCount?: number;
  /** 参与累计平均的主轮 input token 总量。 */
  totalInputTokens?: number;
  /** 参与累计平均的主轮 cache read token 总量。 */
  totalCacheReadTokens?: number;
  /** 参与累计平均的主轮 cache write token 总量。 */
  totalCacheWriteTokens?: number;
  /** Agent 归一化后返回给 app 的主轮累计平均缓存命中率；未知时为 null。 */
  hitRate: number | null;
}

export type ZCodeTaskNetworkDebugStatusType =
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_retry_scheduled"
  | "model_stream_stalled";

/** Agent API 遇到可重试错误时的临时状态；只用于内存 UI，不写入任务持久化。
 * attempt 表示当前正在进行的“第几次重试”，从 1 开始，不是总尝试次数。
 */
export interface ZCodeApiRetryStatus {
  kind: "api_retry";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
}

export type ZCodeTaskClientMode = "desktop-continuous" | "web-remote-replayable";

export type ZCodeTaskRuntimeCommandStatus = "accepted" | "running" | "failed";

export interface ZCodeTaskSnapshotHistory {
  /** 响应态历史窗口是否裁掉了更早消息；只由 getTaskSnapshot 返回，不写入 session JSON。 */
  truncatedBefore: boolean;
  /** 裁剪前可见消息总数，用于 UI 判断是否还能补拉更早历史。 */
  totalMessages: number;
}

export type ZCodeTurnFileState = "applied" | "reverted";

/** 持久化的轮次文件 checkpoint 元信息 */
export interface ZCodePersistedTurnCheckpoint {
  turnIndex: number;
  /** 该轮开始前的文件状态 checkpoint */
  baseFileCheckpointId: string;
  /** 该轮结束后的文件状态 checkpoint；未完成时允许为空 */
  resultFileCheckpointId?: string;
}

/** 持久化消息的 parts 元素，记录 content / thought / tool-call 的交错顺序。
 *  恢复历史时用它还原 UI 侧的 parts 数组，避免所有文字堆到上面、工具调用排到下面。 */
export type ZCodePersistedMessagePart =
  | { type: "content"; content: string }
  | { type: "thought"; content: string }
  | { type: "tool-call"; toolIndex: number };

export type ZCodeAssistantMessageFeedback = "like" | "dislike";

export type ZCodeAssistantCheckpointState = "partial";

export type ZCodeAssistantCheckpointReason = "tool_completed" | "part_boundary" | "periodic";

export type ZCodeTaskSnapshotBodyField = "content" | "thought";

export type ZCodeTaskSnapshotToolField = "input" | "output" | "raw";

export type ZCodeTaskSnapshotFileContentField = "beforeContent" | "afterContent";

export interface ZCodeTaskSnapshotToolSlice {
  persistedMessageIndex: number;
  totalTools: number;
  startToolIndex: number;
  endToolIndexExclusive: number;
}

export type TaskRealtimeReason =
  | "task_created"
  | "user_message_saved"
  | "assistant_message_saved"
  | "task_status_changed"
  | "task_meta_changed"
  // 切模型这类纯配置变更过去混在 task_meta_changed 里广播，UI 无法区分
  // "归属相关 meta 变更（rename/unread）"和"与列表归属无关的配置变更"，
  // 导致每次切模型都触发全局 membership 重拉 + 整表刷新。单独一个 reason 让策略层精确降级。
  | "task_model_changed"
  // 标题更新（首条消息写 title / 收口后自动标题生成）同样与归属无关且高频，
  // 混在 task_meta_changed 里会让每次发送/收口都触发全局 membership 重拉。
  | "task_title_changed"
  | "task_pinned"
  | "task_unpinned"
  | "task_archived"
  | "task_unarchived"
  | "task_deleted"
  | "stream_mirror_gap"
  | "stream_mirror_owner_lost";

export interface TaskStreamWatermark {
  runId: string;
  opSeq: number;
}

export interface ZCodeGlmAgentModelStateUpdatePayload {
  version: 1;
  sessionId: string;
  reason: ZCodeGlmAgentModelStateUpdateReason;
  model: {
    currentValue: string;
  };
  thoughtLevel: {
    enabled: boolean;
    currentValue?: string;
    options: ZCodeGlmAgentModelStateOption[];
  };
  contextWindow: {
    tokens: number;
  };
}

export interface ZCodeTaskGoal {
  sessionID: string;
  targetID: string;
  objective: string;
  summaryTitle: string | null;
  status: ZCodeTaskGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeInputId?: string | null;
  activeRunStartedAtMs?: number | null;
  activeRunLastSeenAtMs?: number | null;
  time: {
    created: number;
    updated: number;
  };
}

export interface ZCodeGoalVerificationTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "goal_verification";
  display: "separator";
  targetId: string;
  verificationId: string;
  status: ZCodeGoalVerificationTimelineStatus;
  verification?: ZCodeGoalVerification;
  goalIteration?: number;
  /** verifier divider 应锚定到完成本轮输出的 assistant message，而不是按时间漂移。 */
  anchorAssistantMessageId?: string;
  /** 辅助恢复同一 turn 的边界语义；旧历史可能缺失。 */
  anchorTurnId?: string;
  startedAt?: number;
  updatedAt: number;
}

export interface ZCodeTodoGroup {
  id: string;
  source: "goal_iteration" | "session";
  goalIteration?: number;
  targetId?: string;
  startedAt?: number;
  updatedAt?: number;
  todos: ZCodePlanStep[];
}

/** 单个自动输入轮的来源归因；两种后台业务身份禁止同时存在。 */
export type ZCodeBackgroundTurnAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: ZCodeOffPeakRunType;
      automationId?: never;
    }
  | { automationId?: undefined; offPeakTaskId?: undefined; offPeakRunType?: never };

export interface ZCodeTaskLastError {
  attribution?: ErrorAttribution;
  code?: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}

export type ZCodePromptAttachment =
  | ZCodePromptImageAttachment
  | ZCodePromptAudioAttachment
  | ZCodePromptVideoAttachment
  | ZCodePromptPdfAttachment
  | ZCodePromptFileAttachment;

export interface ZCodeTaskPendingInteraction {
  interactionId: string;
  kind: "permission" | "userInput";
  /** sessions-index 下发的轻量工具身份；旧摘要缺失时保持兼容。 */
  toolName?: string;
  autoResolution?: ZCodeTaskInteractionAutoResolution;
}

export interface ZCodeTaskChangeSummary {
  /** 整个任务里涉及过的唯一文件数 */
  fileCount: number;
  /** 按最终文件结果聚合后的新增行数 */
  added: number;
  /** 按最终文件结果聚合后的删除行数 */
  removed: number;
  /** 任务涉及的文件摘要 */
  files: ZCodeTaskChangedFileSummary[];
}

// ---- ZCode 配置与命令类型 ----

/** ZCode configOptions 的 UI 投影（从 session/new 响应中提取） */
export interface ZCodeConfigOption {
  id: string;
  name: string;
  description?: string;
  /** mode | model | thought_level | 自定义 */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  /** type === "select" 时的选项列表 */
  options?: ZCodeConfigSelectValue[];
}

export interface ZCodeTurnSteerQueued {
  type: "turn_steer_queued";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  pendingInputId: string;
  messageId?: string;
  commandKind?: ZCodeTurnSteerCommandKind;
  source?: ZCodeTurnSteerSource;
  targetTurnId?: string;
  content: string;
  raw?: unknown;
}

export interface ZCodeTurnSteerStatus {
  type: "turn_steer_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryIds?: QueryId[];
  status: "drained" | "discarded" | "rejected";
  pendingInputIds?: string[];
  injectedMessageIds?: string[];
  targetTurnId?: string;
  reason?: string;
  raw?: unknown;
}

export interface ZCodeAgentThoughtChunk {
  type: "agent_thought_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** 上级 toolCallId；null 表示主 agent 思考。 */
  parentToolUseId?: string | null;
  content: string;
}

export interface ZCodeContextCompactionTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "context_compaction";
  operationId: string;
  status: ZCodeTimelineStatus;
  trigger: ZCodeTimelineTrigger;
  display: "separator";
  /**
   * `/compact` 本地会先渲染 optimistic 横条，agent lifecycle 事件稍后才到。
   * 用 inputId 把两者合并，避免同一次压缩先显示“正在压缩”再额外追加一条“已压缩”。
   */
  inputId?: InputId;
  /** 失败后重试需要保留用户原本输入的 `/compact ...` 指令。 */
  command?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: string;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  /** compact 阶段用于区分 mid_turn / pre_request 等真实压缩边界，避免 UI 和 e2e 只能按文案猜。 */
  phase?: ZCodeContextCompactionTimelinePhase;
  startedAt?: number;
  endedAt?: number;
}

export interface ZCodeToolCall {
  type: "tool_call";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** 上级 toolCallId；null 表示主 agent 直接发起的工具调用。 */
  parentToolUseId?: string | null;
  input: unknown;
  /** ZCode 固定工具名；新增字段用于把工具身份和历史 kind 分类拆开。 */
  toolName?: string;
  /** 兼容历史分类；当前 ZCode 流通常等于 toolName。 */
  kind: string;
  /** agent ToolCall.title，描述当前工具动作的人类可读标题 */
  title: string;
  /** agent ToolCall 原始 payload，调试协议字段时以此为准 */
  raw: unknown;
  pluginMetadata?: { pluginId: string; component: "mcp" };
  /** Skill resolved metadata；只用于 telemetry attribution。 */
  skillMetadata?: {
    name?: string;
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "cursor" | "zcode" | "bundled" | "plugin" | "remote";
  };
}

export interface ZCodeToolCallUpdate {
  type: "tool_call_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** 上级 toolCallId；null 表示主 agent 直接发起的工具调用。 */
  parentToolUseId?: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  /**
   * agent ToolCallUpdate.title，可选；如果 Agent 没更新标题，这里可能为空。
   */
  title?: string;
  /** ZCode 固定工具名；ToolCallResult 可能只带 toolId，服务层会从前序调用缓存补齐。 */
  toolName?: string;
  /** 兼容历史分类；当前 ZCode 流通常等于 toolName。 */
  kind?: string;
  input?: unknown;
  content?: unknown;
  error?: string;
  /** agent ToolCallUpdate 原始 payload，调试协议字段时以此为准 */
  raw: unknown;
  pluginMetadata?: { pluginId: string; component: "mcp" };
  /** Skill resolved metadata；只用于 telemetry attribution。 */
  skillMetadata?: {
    name?: string;
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "cursor" | "zcode" | "bundled" | "plugin" | "remote";
  };
}

export interface ZCodePlan {
  type: "plan";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  steps: ZCodePlanStep[];
}

export interface ZCodePermissionRequest {
  type: "permission_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  description: string;
  kind: string;
  title?: string;
  options: ZCodePermissionOption[];
  /** V4 permission 是否允许在 Deny 时附带用户反馈。 */
  freeText?: boolean;
  origin?: ZCodeInteractionRequestOrigin;
  /**
   * 工具自报的确认预览，复用 tool call row 的 display 投影（同一有界形状）。
   * 缺省 = 纯文本 ask（legacy v3 链路会显式剥离该字段）。
   */
  display?: ToolCallDisplay;
  /** agent RequestPermissionRequest.toolCall 原始 payload */
  raw: unknown;
}

export interface ZCodeTaskPermissionResponse {
  type: "permission_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  optionId: string;
  response: ZCodePermissionResponse;
}

/** ZCode Elicitation 单个问题 */
export interface ZCodeElicitationQuestion {
  question: string;
  header: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
}

/** ZCode Elicitation 响应事件 */
export interface ZCodeElicitationResponse {
  type: "elicitation_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface ZCodeTaskComplete {
  type: "task_complete";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  stopReason: string;
  usage?: ZCodeUsage;
}

export interface ZCodeTaskRunStarted {
  inputOrigin?: "desktop" | "mobile";
  type: "task_run_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  startedAt: number;
}

export interface ZCodeGoalIterationStarted {
  type: "goal_iteration_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  targetId?: string;
  startedAt: number;
}

export interface ZCodeTaskError {
  type: "task_error";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  error: string;
  code?: string;
  detail?: string;
  attribution?: ErrorAttribution;
}

export interface ZCodeTaskWarning {
  type: "task_warning";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  warning: string;
  code?: string;
  detail?: string;
}

/** Agent 每次模型请求完成后推送的 task 累计 token 增量。 */
export interface ZCodeTaskTokenUsageDelta {
  type: "task_token_usage_delta";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  /** 稳定去重键，通常来自 ZCode Protocol eventId。 */
  eventKey: string;
  eventId?: string;
  querySource?: string;
  usage: ZCodeUsage;
}
