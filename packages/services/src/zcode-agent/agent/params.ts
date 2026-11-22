import type {
  ZCodeSessionContentProfile,
  AppUsageRange,
  ZCodeStorageStartupState,
  ZCodeDeliveryKind,
  ZCodeAgentMcpServer,
  ZCodeBackgroundTurnAttribution,
  TraceId,
  ZCodeSessionGoalAction,
  ModelSelection,
  ZCodeSessionImportHistory,
  ZCodePermissionRequestParams,
  ZCodeProcessChildProcess,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeProviderTestModelConnectivityParams,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
  ZCodeSessionEvent,
  ZCodeSessionMode,
  ZCodeSessionPersistence,
  ZCodeSessionRequestRuntimePreferencesParams,
  ZCodeSessionRuntimePreferencesResult,
  ZCodeSessionStateSnapshot,
  ZCodeStateUpdatedNotification,
  ZCodeTaskClientMode,
  ZCodeBrowserAmbientContext,
  ZCodeWorkspaceGenerateTextParams,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type {
  CommandEnvelope,
  CommandKey,
  CuaPermissionObservation,
  ConversationRowTarget,
  V4ConnectionFlowState,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentWorkspaceTarget } from "../zcodeAgentPluginParams.js";

export interface ZCodeAgentSessionTarget extends ZCodeAgentWorkspaceTarget {
  sessionId: string;
}

export interface ZCodeAgentResumeSessionParams extends ZCodeAgentSessionTarget {
  additionalDirectories?: string[];
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  // 冷恢复会重建 runtime，工具面隔离必须和 create 保持同一安全边界（CUA 只放行 zcode-cua 工具、
  // 禁 Bash 等）。否则 resume 后模型可见工具面/执行权限会比创建时更宽。
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface ZCodeAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ZCodeAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface ZCodeAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE = "ZCODE_AGENT_RUNTIME_UNAVAILABLE";

export type ZCodeAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface ZCodeAgentRuntimeLifecycleEvent extends ZCodeAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type ZCodeAgentCuaPermissionObservation = CuaPermissionObservation &
  ZCodeAgentWorkspaceTarget;

export interface ZCodeAgentCreateSessionParams extends ZCodeAgentWorkspaceTarget {
  projectId?: string | null;
  additionalDirectories?: string[];
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZCodeSessionMode;
  model?: ModelSelection;
  persistence?: ZCodeSessionPersistence;
  thoughtLevel?: string;
  /** automation 执行会话关闭模型二次命名，保持首条用户 query 作为稳定标题。 */
  titleGenerationEnabled?: boolean;
  mcpServers?: ZCodeAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: ZCodeSessionImportHistory;
}

export interface ZCodeAgentListSessionsParams extends ZCodeAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: ZCodeAgentRuntimePolicy;
  limit?: number;
}

export interface ZCodeAgentListSessionSubagentsParams extends ZCodeAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** 远程 workspace 的宿主连接身份；只用于选择现有 Host，不进入 CLI wire query。 */
  remoteSessionId?: string;
}

export interface ZCodeAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
}

export interface ZCodeAgentTaskTokenUsageParams extends ZCodeAgentSessionTarget {}

export interface ZCodeAgentReadSessionParams extends ZCodeAgentSessionTarget {
  deliveryKind?: ZCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** 被动索引/观察者只能读取现有 runtime，禁止为了读快照拉起 session。 */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
  /** "index" 仅供 task index：返回剥离大载荷的同结构 snapshot，禁止回写 UI 状态。 */
  contentProfile?: ZCodeSessionContentProfile;
}

export interface ZCodeAgentReadSessionMessagesParams extends ZCodeAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZCodeAgentReadSessionEventsParams extends ZCodeAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type ZCodeAgentReadWorkspacePresentationParams = ZCodeAgentWorkspaceTarget;

export interface ZCodeAgentGrantWorkspaceHookTrustParams extends ZCodeAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface ZCodeAgentSendPromptParamsBase extends ZCodeAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** provider-only 的当前 IAB 状态；UI/session persistence 仍使用 content 原文。 */
  browserAmbientContext?: ZCodeBrowserAmbientContext;
  clientMode?: ZCodeTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
  /** Bot 来源 turn 的稳定回推地址；只在当前 turn 内供 CronCreate 读取。 */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

export type ZCodeAgentSendPromptParams = ZCodeAgentSendPromptParamsBase &
  ZCodeBackgroundTurnAttribution;

export interface ZCodeAgentCompactParams extends ZCodeAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface ZCodeAgentGoalParams extends ZCodeAgentSessionTarget {
  inputId?: string;
  action: ZCodeSessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface ZCodeAgentSetModelParams extends ZCodeAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeAgentSetThoughtLevelParams extends ZCodeAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeAgentSetModeParams extends ZCodeAgentSessionTarget {
  mode: ZCodeSessionMode;
  expectedRevision?: number;
}

export interface ZCodeAgentGenerateWorkspaceTextParams extends ZCodeAgentWorkspaceTarget {
  selection: ZCodeWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: ZCodeWorkspaceGenerateTextParams["messages"];
  tools?: ZCodeWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * 协议层 RPC 超时。thinking 模型的长请求会超过协议 client 默认的
   * 3 分钟；调用方必须把自身 deadline 透传到这里，否则默认超时先触发、
   * 还会被 onRequestTimeout 误判 stale 杀进程。
   */
  requestTimeoutMs?: number;
}

export interface ZCodeAgentTestModelConnectivityParams extends ZCodeAgentWorkspaceTarget {
  selection: ZCodeProviderTestModelConnectivityParams["selection"];
  signal?: AbortSignal;
}

// 合并时曾混用 Agent 完整鉴权响应；UI 只能回传请求校验，账号鉴权必须由 Host 合成。
export type ProviderRuntimeHeadersUiResponse =
  | { headersApplied: true; runtimeProviderHeaders: Record<string, string>; errorMessage?: string }
  | { headersApplied: false; errorMessage?: string };

export interface ZCodeAgentRespondProviderRuntimeHeadersParams extends ZCodeAgentSessionTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface ZCodeAgentSessionRuntimePreferencesRequest extends ZCodeSessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface ZCodeAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface ZCodeAgentSessionSubscribeParams extends ZCodeAgentSessionTarget {
  deliveryKind: ZCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// ── v4 conversation 通道（竖切）──
// host 只做转发：subscribe/unsubscribe/command 透传给 CLI v4 gateway，
// v4/conversation/frame 通知按 workspace fan-out 给 renderer。

export interface ZCodeAgentConversationSubscribeParams extends ZCodeAgentSessionTarget {
  retryInitialization?: string;
  /** 水位不变量：仅当客户端真持有该时刻一致状态才允许带。 */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface ZCodeAgentConversationUnsubscribeParams extends ZCodeAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export interface ZCodeAgentConversationResyncParams extends ZCodeAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

/** 行分页 query（rows/range）：按游标向上取一窗历史行。 */
export interface ZCodeAgentConversationRowsRangeParams extends ZCodeAgentSessionTarget {
  /** 取 rowId < beforeRowId 的行；缺省 = 从当前尾部向前。 */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit（200）。 */
  limit: number;
}

/** 当前有效分支里的终态 ExitPlanMode 目录。 */
export type ZCodeAgentConversationPlansParams = ZCodeAgentSessionTarget;

/** workflow run 的事件日志分页（详情页审计面）；cursor = journal sequence。 */
export interface ZCodeAgentConversationWorkflowRunEventsParams extends ZCodeAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** dwf run 的枚举（重启后的发现查询）。 */
export interface ZCodeAgentConversationWorkflowRunsParams extends ZCodeAgentSessionTarget {
  limit?: number;
}

// ── dwf 用户面产物──
// ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给**用户**看的产出（文件 / markdown / 预置看板），
// 不是 run 的顶层返回值（引擎内部对后者的同名叫法）。

/** 产物清单；UI 冷恢复与中枢详情的 durable 读法。 */
export interface ZCodeAgentConversationWorkflowRunArtifactsParams extends ZCodeAgentSessionTarget {
  runId: string;
}

/** 预置看板的取数面；cursor = journal sequence（严格大于）。 */
export interface ZCodeAgentConversationWorkflowRunArtifactDataParams extends ZCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** 内容产物的字节，一次一块（≤ 512 KiB，形状逐字照 attachmentRead）。 */
export interface ZCodeAgentConversationWorkflowRunArtifactReadParams extends ZCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// ── dwf 工作区 transcript──
/** 轻行清单：一个 run 的 files.* / git.* / world.run 行，不带正文。 */
export interface ZCodeAgentConversationWorkflowRunWorkspaceParams extends ZCodeAgentSessionTarget {
  runId: string;
}

/** 一个工作区节点的正文，按 maxBytes 保形有界化（缺省与上限在 CLI 网关侧）。 */
export interface ZCodeAgentConversationWorkflowRunNodeResultParams extends ZCodeAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface ZCodeAgentBackgroundBashOutputParams extends ZCodeAgentSessionTarget {
  workId: string;
}

export interface ZCodeAgentConversationFileChangesParams extends ZCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZCodeAgentConversationFileRewindPreviewParams extends ZCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZCodeAgentConversationCommandParams extends ZCodeAgentWorkspaceTarget {
  /** 仅 Host 消费；显式 NULL 表示全局任务，不向 CLI 发送项目概念。 */
  projectId?: string | null;
  envelope: CommandEnvelope;
  /** 仅 host 内部用于 Browser Use runtime 边界，不进入 v4 wire envelope。 */
  clientMode?: ZCodeTaskClientMode;
}

export interface ZCodeAgentCommandsQueryParams extends ZCodeAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** UI 不携带 connectionId；connection scope 以 trusted carrier 注入 wire identity。 */
export interface ZCodeAgentAttachmentBeginParams extends ZCodeAgentSessionTarget {
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface ZCodeAgentAttachmentChunkParams extends ZCodeAgentSessionTarget {
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface ZCodeAgentAttachmentTerminalParams extends ZCodeAgentSessionTarget {
  uploadId: string;
}

export interface ZCodeAgentAttachmentReadParams extends ZCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface ZCodeAgentConversationAttachmentReadParams extends ZCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface ZCodeAgentConversationAttachmentStatParams extends ZCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface ZCodeAgentAttachmentPreviewSourceParams extends ZCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** host scope 内部 transport 控制面；connectionId 只能经 trusted carrier 注入。 */
export interface ZCodeAgentConnectionFlowParams extends ZCodeAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index：workspace 级列表订阅（无 sessionId 维度）。 */
export interface ZCodeAgentSessionsIndexSubscribeParams extends ZCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * 订阅者作用域后缀：CLI 侧重订阅替换按 (connectionId, topic) 判定，
   * host 进程内多个独立消费者（renderer 侧栏 / task-index syncer）订阅同一 topic 时
   * 必须用不同 connectionId，否则互相替换对方的订阅代际。缺省共享 host 连接 id。
   */
  subscriberScope?: string;
  /**
   * task-list 等被动观察者必须使用 existing-only；runtime 不存在时返回稳定 unavailable，
   * 禁止为了建立列表订阅而启动 Agent。缺省保持显式会话入口的旧行为。
   */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

/** workspace-config：workspace 级配置目录订阅（config options + slash 目录）。 */
export interface ZCodeAgentWorkspaceConfigSubscribeParams extends ZCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export type ZCodeAgentServiceEvent =
  | { type: "session.event"; event: ZCodeSessionEvent }
  | { type: "state.updated"; notification: ZCodeStateUpdatedNotification }
  | { type: "permission.request"; request: ZCodePermissionRequestParams }
  | { type: "userInput.request"; request: ZCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: ZCodeUserInputResponse;
    }
  | { type: "providerRuntimeHeaders.request"; request: ZCodeProviderRuntimeHeadersRequestParams }
  | { type: "snapshot"; snapshot: ZCodeSessionStateSnapshot };

export interface ZCodeAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface ZCodeAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: ZCodeProcessChildProcess[];
}

export interface ZCodeAgentStorageStartupSnapshot {
  generation: number;
  state: ZCodeStorageStartupState | null;
}
