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
import type { InputId, QueryId, TaskRealtimeReason, TaskStreamWatermark, TraceId, ZCodeAgentThoughtChunk, ZCodeApiRetryStatus, ZCodeAssistantCheckpointReason, ZCodeAssistantCheckpointState, ZCodeAssistantMessageFeedback, ZCodeConfigOption, ZCodeContextCacheUsage, ZCodeContextCompactionTimelineMeta, ZCodeElicitationOption, ZCodeElicitationQuestion, ZCodeElicitationResponse, ZCodeGlmAgentModelStateUpdatePayload, ZCodeGoalIterationStarted, ZCodeGoalVerification, ZCodeGoalVerificationTimelineMeta, ZCodePermissionRequest, ZCodePersistedMessagePart, ZCodePersistedTurnCheckpoint, ZCodePlan, ZCodePlanStep, ZCodePromptAttachment, ZCodeProvider, ZCodeSessionForkTimelineMeta, ZCodeSlashCommand, ZCodeTaskChangeSummary, ZCodeTaskComplete, ZCodeTaskError, ZCodeTaskGoal, ZCodeTaskGoalStats, ZCodeTaskLastError, ZCodeTaskMigrationSource, ZCodeTaskMode, ZCodeTaskModeInfo, ZCodeTaskNetworkDebugStatusType, ZCodeTaskPendingInteraction, ZCodeTaskPermissionResponse, ZCodeTaskPersistStatus, ZCodeTaskRepairState, ZCodeTaskRunStarted, ZCodeTaskRuntimeCommandStatus, ZCodeTaskSnapshotBodyField, ZCodeTaskSnapshotFileContentField, ZCodeTaskSnapshotHistory, ZCodeTaskSnapshotToolField, ZCodeTaskSnapshotToolSlice, ZCodeTaskTargetChangedAction, ZCodeTaskTargetChangedSource, ZCodeTaskTokenUsageDelta, ZCodeTaskWarning, ZCodeTodoGroup, ZCodeToolCall, ZCodeToolCallUpdate, ZCodeTurnFileState, ZCodeTurnSteerQueued, ZCodeTurnSteerStatus } from "./zcode-task-types-part1.js";

// Часть 2/2 модуля zcode-task-types: вынесено по лимиту строк.

/** Agent 模型网络状态调试事件；只携带元信息和脱敏 header，不携带 response body/data。 */
export interface ZCodeTaskNetworkDebugStatus {
  type: "task_network_debug_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  eventKey: string;
  eventId?: string;
  statusType: ZCodeTaskNetworkDebugStatusType;
  requestId?: string;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: string;
  baseURL?: string;
  querySource?: string;
  attempt?: number;
  maxAttempts?: number;
  nextAttempt?: number;
  retryable?: boolean;
  statusCode?: number;
  durationMs?: number;
  delayMs?: number;
  idleMs?: number;
  timeoutMs?: number;
  reason?: string;
  message?: string;
  timestamp?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestHeaderCount: number;
  responseHeaderCount: number;
}

/** Agent 推送可用的 slash commands 列表 */
export interface ZCodeAvailableCommandsUpdate {
  type: "available_commands_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  commands: ZCodeSlashCommand[];
}

/** Agent 推送模式变更（如从 architect 自动切到 code） */
export interface ZCodeModeUpdate {
  type: "mode_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  currentModeId: string;
  availableModes: ZCodeTaskModeInfo[];
}

export interface ZCodeGoalVerificationUpdate {
  type: "goal_verification_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  verification: ZCodeGoalVerification;
}

/** Agent 推送实时上下文窗口使用情况 */
export interface ZCodeUsageUpdate {
  type: "usage_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** 上下文窗口总大小（token 数） */
  size: number;
  /** 当前已使用的 token 数 */
  used: number;
  /** 累计费用 */
  cost?: { amount: number; currency: string } | null;
  /** 当前主轮 provider usage 暴露的缓存命中信息。 */
  cache?: ZCodeContextCacheUsage;
  /** Agent 按来源估算的上下文字符量，用于 UI 展示比例，不作为 token 账本。 */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}

/** Agent runtime 上报的后台任务控制项；只表示当前 host 内存态，不写入 session 文件。 */
export interface ZCodeBackgroundTaskControlItemsUpdate {
  type: "background_bash_jobs_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  jobs: ZCodeBackgroundTaskControlItem[];
}

/** 残余数据 flush 后通知 UI 重新拉取快照，确保迟到的流式数据能被渲染 */
export interface ZCodeTaskSnapshotUpdated {
  type: "task_snapshot_updated";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  reason?: TaskRealtimeReason;
  eventId?: string;
  runId?: string;
  streamWatermark?: TaskStreamWatermark;
}

export interface ZCodeTaskRuntimeCommandBase {
  commandId: string;
  taskId: string;
  traceId: TraceId;
  queryId?: QueryId;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  status: ZCodeTaskRuntimeCommandStatus;
  createdAt: number;
  updatedAt: number;
  clientId?: string;
  clientLabel?: string;
  error?: string;
}

export interface ZCodeTaskSnapshotBodyRef {
  field: ZCodeTaskSnapshotBodyField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}

export interface ZCodeTaskSnapshotToolFieldRef {
  field: ZCodeTaskSnapshotToolField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}

export interface ZCodeTaskSnapshotFileContentRef {
  field: ZCodeTaskSnapshotFileContentField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}

export interface ZCodeTaskGoalChangedPatch {
  action: ZCodeTaskTargetChangedAction;
  source: ZCodeTaskTargetChangedSource;
  target: ZCodeTaskGoal | null;
  previousTarget?: ZCodeTaskGoal | null;
}

export interface ZCodeTaskMeta {
  /** UI taskId 与 ZCode agent sessionId 保持一致，用于列表选择、日志关联和恢复会话。 */
  taskId: string;
  /** session/任务级观测 traceId，不用于区分单次用户输入 */
  traceId: TraceId;
  /** 任务标题（用户输入或从首条消息截取） */
  title: string;
  /**
   * 用户是否手动覆盖过任务标题。
   *
   * 运行中 agent 仍会继续推送自动生成标题；UI 需要知道当前标题是手动命名，
   * 才能在更新 status/target/updatedAt 时避免把手动标题短暂冲掉。
   */
  titleOverridden?: boolean;
  /** 关联的 workspace 绝对路径 */
  workspacePath: string;
  /**
   * 远程 workspace 的稳定身份（authority + canonicalPath）。
   *
   * 仅按 workspacePath 持久化时，“同路径不同远端主机”会写进同一目录，
   * 导致任务列表、快照和日志互相串读。这里补充 workspaceIdentity 参与隔离。
   */
  workspaceIdentity?: string;
  /** Controller/renderer 任务列表投影使用；不参与 workspace identity 或持久化 key。 */
  sourceServerId?: string;
  /** Source directory 的用户可读名称；缺失时 UI 回退 sourceServerId。 */
  serverDisplayName?: string;
  /** app-owned workspace 分类；缺省为 project，不参与 workspaceKey。 */
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
  createdAt: number;
  updatedAt: number;
  mode: ZCodeTaskMode;
  model?: string;
  /**
   * task 级推理强度。
   *
   * active task 内切换 effort 时，如果只写 workspace settings.json，
   * 同一 workspace 的其它 task 会被串改；如果只改 session，下一轮 prompt 又可能被
   * workspace 默认值回推覆盖。这里单独持久化 task-local thoughtLevel，发送前再重放到 session。
   */
  thoughtLevel?: string;
  /**
   * 该 task 最近一次确认与 workspace 运行时基线对齐的 epoch。
   *
   * 过去仅靠 workspacePreferredModel 判断“要不要覆盖当前 task 模型”，
   * 会把“同 supplier 的 task 内模型切换”误当成全局收敛，导致其它 task 被串改。
   * 这里记录 runtimeEpoch，用来区分“task 自身模型保持”与“runtime 基线确实变更后需要收敛”。
   */
  runtimeEpoch?: number;
  /** 创建此 task 时使用的 agent provider，缺省视为 "glm"（旧数据兼容） */
  provider?: ZCodeProvider;
  /** 迁移来源；普通新建任务为空，用于识别 Claude Code 原生历史导入。 */
  migrationSource?: ZCodeTaskMigrationSource;
  /**
   * cron 身份标记：该 session 属于哪条 automation。
   *
   * cron 身份必须定义在共享的 ZCodeTaskMeta 上，供持久化层、V4 UI 和服务契约
   * 共同使用，避免字段已持久化却无法经类型契约访问。
   */
  cronAutomationId?: string;
  /**
   * 闲时任务身份标记：该 session/幻影行属于哪条 off-peak 任务。
   * 与 cronAutomationId 是兄弟标记（闲时不复用 cron 标记）；行 id = 创建时
   * 预分配的 sessionId，标记从创建到运行恒定，供月亮图标与系统分组归属使用。
   */
  offPeakTaskId?: string;
  /** fork 产物保留来源 taskId，供 UI 做本地化标题兜底和后续追溯。 */
  forkedFromTaskId?: string;
  /** 未读任务记录最近一次标记/产生未读的时间，用于跨重启保留蓝点状态。 */
  unreadAt?: number;
  /** 持久化的任务状态，记录最后一次 prompt 的结果 */
  status?: ZCodeTaskPersistStatus;
  /** sessions-index 提供的队首阻塞交互摘要，供未打开的后台 task 渲染侧栏状态。 */
  pendingInteraction?: ZCodeTaskPendingInteraction;
  /**
   * 最后一次失败的可展示原因。
   *
   * 手机远控断连时实时 task_error 可能无法送达；恢复只能看到 meta.status=error，
   * 但拿不到错误正文，用户会以为发送没有触发。这里把失败原因随 task meta 一起持久化。
   */
  lastError?: ZCodeTaskLastError;
  /** task 级历史修复状态，用于避免读 snapshot 时重复执行一次性迁移逻辑。 */
  repairState?: ZCodeTaskRepairState;
  /** 任务级文件改动摘要，仅用于列表/标题展示，真实回滚仍以 fileChanges 为准 */
  changeSummary?: ZCodeTaskChangeSummary;
  /** zcode-cli /goal 会话目标；null 表示已显式清空。 */
  target?: ZCodeTaskGoal | null;
}

export type ZCodeTimelineMeta =
  | ZCodeContextCompactionTimelineMeta
  | ZCodeGoalVerificationTimelineMeta
  | ZCodeSessionForkTimelineMeta;

/** ZCode Elicitation 请求事件，用于 AskUserQuestion 等需要用户交互的工具 */
export interface ZCodeElicitationRequest {
  type: "elicitation_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  message: string;
  header?: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
  /** AskUserQuestion 的多题结构；存在时 UI 以 tab 形式一次性收集全部答案。 */
  questions?: ZCodeElicitationQuestion[];
  /** remote 控制链路同步的当前题号，用于跨端保持 AskUserQuestion 进度。 */
  currentQuestionIndex?: number;
  /** remote 控制链路同步的草稿答案，key 为 answer_0 / answer_1。 */
  answerDrafts?: Record<string, string[]>;
  origin?: ZCodeInteractionRequestOrigin;
  /** ElicitationSchema 原始 payload */
  schema?: unknown;
}

// ---- 新增流式事件类型 ----

/** Agent 主动推送配置变更（如 rate limit 降级模型、模式联动变化） */
export interface ZCodeConfigOptionUpdate {
  type: "config_option_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  configOptions: ZCodeConfigOption[];
}

/** zcode-cli/GLM agent 专属：模型变化后同步思考等级选项和上下文窗口。 */
export interface ZCodeGlmAgentModelStateUpdate extends ZCodeGlmAgentModelStateUpdatePayload {
  type: "glm_agent_model_state_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
}

export interface ZCodeTaskSendPromptCommand extends ZCodeTaskRuntimeCommandBase {
  type: "send_prompt";
  content: string;
  attachments?: ZCodePromptAttachment[];
  /** 定时任务派发的 host command 必须保留 automation 上下文，避免队列 drain 后重新暴露 CronCreate。 */
  automationId?: string;
}

/** 持久化的文件快照 */
export interface ZCodePersistedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
  /** 仅用于响应态快照：表示文件快照正文已被首屏预算裁剪，可按 ref 拉取完整内容。 */
  contentRefs?: ZCodeTaskSnapshotFileContentRef[];
}

export interface ZCodePersistedToolCall {
  /** ZCode 固定工具名；旧快照里可能曾把 title 落在这里，读取侧需兼容。 */
  toolName?: string;
  title?: string;
  kind?: string;
  status?: "completed" | "failed" | "denied" | "stopped";
  input: unknown;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** 仅用于响应态快照：表示工具大字段已被首屏预算裁剪，可按 ref 拉取完整内容。 */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[];
}

export interface TaskStreamMirrorUserMessageOp {
  kind: "user_message";
  messageId: string;
  content: string;
  attachments?: ZCodePromptAttachment[];
  timestamp: number;
}

export interface ZCodeAgentMessageChunk {
  type: "agent_message_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** 上级 toolCallId；null 表示主 agent 正文。 */
  parentToolUseId?: string | null;
  /** agent messageId；ZCode synthetic timeline 消息用它做 upsert。 */
  messageId?: string;
  content: string;
  zcodeTimeline?: ZCodeTimelineMeta;
}

/** Agent 推送会话标题等元信息更新 */
export interface ZCodeSessionInfoUpdate {
  type: "session_info_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  title?: string | null;
  /**
   * 可选的 API 重试状态补丁。
   *
   * `undefined` 表示本次 session_info_update 没有碰这个字段；
   * `null` 表示显式清空重试状态；
   * 对象表示进入/更新重试中。
   */
  apiRetry?: ZCodeApiRetryStatus | null;
  /**
   * zcode-cli 通过兼容 session_info_update._meta.zcode.target 投影的 /goal 状态补丁。
   * `undefined` 表示本次没有 target 变化；`target: null` 表示清空。
   */
  target?: ZCodeTaskGoalChangedPatch;
}

export type ZCodeTaskRuntimeCommand = ZCodeTaskSendPromptCommand;

/** 持久化的轮次文件变更 */
export interface ZCodePersistedFileChange {
  turnIndex: number;
  snapshots: ZCodePersistedFileSnapshot[];
  /** 当前这轮文件变更是否仍应用在 workspace 上 */
  fileState?: ZCodeTurnFileState;
}

export interface ZCodePersistedMessage {
  /** 协议侧原始 messageId；用于让实时消息和 snapshot 恢复后的 timeline divider 保持同一身份。 */
  id?: string;
  /** 投影合并 assistant 后保留的原始 messageId 集合，用于 timeline anchor 仍能命中被合并的子消息。 */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** assistant 归属的 legacy goal 展示迭代；仅用于 UI 历史区状态行，不参与 verifier 轮次判定。 */
  goalIteration?: number;
  /** 发送该消息时所归属的模型；历史旧数据缺失时由读取侧回退到 task.meta.model。 */
  model?: string;
  /** 纯文本字符数快照；估算 token 时统一按常量除数换算，后续改口径时可重算。 */
  characterCount?: number;
  /** assistant 历史区最终耗时；仅在本轮结束后落盘，避免历史恢复时再用 timestamp 反推导致时长失真 */
  durationMs?: number;
  /** assistant 是否以用户主动停止或异常中断结束；用于抑制 latest 回复区的提升。 */
  interrupted?: boolean;
  /** 用户对 assistant 回复的本地反馈；仅用于 ZCode 展示/统计，不注入 Agent 上下文。 */
  feedback?: ZCodeAssistantMessageFeedback;
  attachments?: ZCodePromptAttachment[];
  tools?: ZCodePersistedToolCall[];
  thought?: string;
  /** 消息各部分的交错顺序，用于历史恢复时保持 content 和 tool-call 的原始排列 */
  parts?: ZCodePersistedMessagePart[];
  /** assistant 运行中快照；用于崩溃/重启后恢复到最近一次 parts 边界，不代表本轮自然完成。 */
  checkpointState?: ZCodeAssistantCheckpointState;
  checkpointReason?: ZCodeAssistantCheckpointReason;
  checkpointUpdatedAt?: number;
  /** 该消息所属的对话轮次，用于关联 per-turn 文件变更摘要和回滚 */
  turnIndex?: number;
  /** 仅用于响应态快照：表示大字段已被首屏预算裁剪，可按 ref 拉取完整正文。 */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[];
  /** 仅用于响应态快照：tools 被按条数裁剪时的切片信息，可用于补拉更多工具调用。 */
  toolSlice?: ZCodeTaskSnapshotToolSlice;
  /** synthetic divider 元数据（context_compaction / session_fork），随 snapshot 恢复用于 UI 渲染分隔条。 */
  syntheticTimeline?: ZCodeTimelineMeta;
}

// ---- ZCode 流式事件（Host → Renderer） ----

export type TaskStreamMirrorableEvent = (
  | ZCodeAgentMessageChunk
  | ZCodeAgentThoughtChunk
  | ZCodeToolCall
  | ZCodeToolCallUpdate
  | ZCodePlan
  | ZCodePermissionRequest
  | ZCodeTaskPermissionResponse
  | ZCodeElicitationRequest
  | ZCodeElicitationResponse
  | ZCodeTaskComplete
  | ZCodeTaskRunStarted
  | ZCodeTaskWarning
  | ZCodeTaskError
  | ZCodeConfigOptionUpdate
  | ZCodeAvailableCommandsUpdate
  | ZCodeModeUpdate
  | ZCodeSessionInfoUpdate
  | ZCodeGoalVerificationUpdate
  | ZCodeTaskTokenUsageDelta
  | ZCodeTaskNetworkDebugStatus
  | ZCodeUsageUpdate
  | ZCodeBackgroundTaskControlItemsUpdate
) & { inputId?: InputId };

// ---- 持久化格式 ----

export interface ZCodeSessionFile {
  meta: ZCodeTaskMeta;
  messages: ZCodePersistedMessage[];
  /** 文件变更记录，按轮次存储 */
  fileChanges?: ZCodePersistedFileChange[];
  /** Git checkpoint 元信息，按轮次存储，仅用于撤销编排 */
  turnCheckpoints?: ZCodePersistedTurnCheckpoint[];
}

export interface ZCodeSessionRuntimeSnapshot {
  pendingPermissions?: ZCodePermissionRequest[];
  pendingElicitations?: ZCodeElicitationRequest[];
  /** 当前 session 的 active turn 类型；用于 UI 区分普通 streaming 与 compact 维护态。 */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  /** Agent API 网络重试是运行态提示，只随 snapshot 恢复，不写入 session JSON。 */
  apiRetry?: ZCodeApiRetryStatus | null;
  /** ZCode Protocol projection 中的上下文窗口用量，用于恢复旧 task UI 的右下角 context meter。 */
  contextUsage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
    cache?: ZCodeContextCacheUsage;
    breakdown?: ZCodeContextUsageBreakdownItem[];
  };
  streamWatermark?: TaskStreamWatermark;
  pendingCommands?: ZCodeTaskRuntimeCommand[];
  /**
   * 从 agent session store 的持久 todo 映射出的恢复态。
   * UI 只消费它恢复 todo 面板，不把该字段写回旧 session JSON。
   */
  plan?: ZCodePlanStep[] | null;
  /**
   * 目标摘要的运行态投影；从 agent DB / message tool parts 临时计算，不写入 task-index。
   */
  goalStats?: ZCodeTaskGoalStats | null;
  goalVerifications?: ZCodeGoalVerification[] | null;
  goalVerificationTimeline?: ZCodeGoalVerificationTimelineMeta[] | null;
  /**
   * session 历史 TodoWrite 投影出的分组 todo；用于恢复展示，不作为 todo 权威存储。
   */
  todoGroups?: ZCodeTodoGroup[] | null;
  /** 兼容字段：承载 host/runtime 运行态后台任务 control，可随 snapshot 恢复，但不持久化到 session JSON。 */
  backgroundBashJobs?: ZCodeBackgroundTaskControlItem[];
}

export type ZCodeTaskSnapshot = ZCodeSessionFile & {
  /** 非持久化运行态，只由 getTaskSnapshot 组装返回，禁止写入 session JSON。 */
  runtime?: ZCodeSessionRuntimeSnapshot;
  /** 非持久化历史窗口元数据，只描述本次 snapshot 响应是否为尾部窗口。 */
  history?: ZCodeTaskSnapshotHistory;
  /** Agent/app 通信返回的可见命令列表；用于恢复 `/` 面板，不写入 session JSON。 */
  slashCommands?: ZCodeSlashCommand[];
  /** 从 session settings 投影出的 UI 配置；只随 snapshot 返回，不写入 session JSON。 */
  configOptions?: ZCodeConfigOption[];
};

export interface TaskStreamMirrorStreamEventOp {
  kind: "stream_event";
  event: TaskStreamMirrorableEvent;
}

export type TaskStreamMirrorOp =
  | (TaskStreamMirrorUserMessageOp & { seq: number })
  | (TaskStreamMirrorStreamEventOp & { seq: number });

export interface TaskStreamMirrorBatch {
  type: "task_stream_mirror_batch";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  runId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  batchSeq: number;
  fromSeq: number;
  toSeq: number;
  ops: TaskStreamMirrorOp[];
  terminal: boolean;
}

export type ZCodeStreamEvent = (
  | TaskStreamMirrorableEvent
  | ZCodeGlmAgentModelStateUpdate
  | ZCodeGoalIterationStarted
  | ZCodeTurnSteerQueued
  | ZCodeTurnSteerStatus
  | TaskStreamMirrorBatch
  | ZCodeTaskSnapshotUpdated
) & { inputId?: InputId };
