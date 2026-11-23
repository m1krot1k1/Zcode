import type {
  CuaOperationStateReporter,
  CuaOperationWorkspaceTarget,
} from "./cuaOperationTurnTracker.js";
import type { BrowserAmbientContextExecutor } from "./zcodeAgentBrowserAmbientContext.js";
import type { CodeIntelligenceService, UncensoredSettingsStore } from "../code-intelligence/contract.js";
import type { IAccountRequestAuthService } from "#src/model-provider/accountRequestAuthService.js";
import type { IDisposable } from "@zcode/rpc";
import type { IOffPeakTaskService } from "#src/session/offPeakTask.js";
import type { IOpenCodeAcpRuntime } from "#src/opencode-acp-runtime/contract.js";
import type { OffPeakClientConfig } from "#src/coding-plan-subscription/codingPlanSubscription.js";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import type { ZCodeAgentProcessManagerOptions } from "./zcodeAgentProcessManager.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  MAX_TRACKED_SESSION_EVENT_IDS,
  buildWorkspaceRef,
  logger,
  type SessionCreateCompatField,
  type SessionResumeCompatField,
  type SessionSendCompatField,
} from "./zcodeAgentServiceSupport.js";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type ZCodeAgentCompactParams,
  type ZCodeAgentCreateSessionParams,
  type ZCodeAgentResumeSessionParams,
  type ZCodeAgentSendPromptParams,
  type ZCodeAgentSessionTarget,
  type ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import {
  ZCODE_MODEL_REASONING_SEPARATOR,
  resolveWorkspaceKey,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
  type ModelSelection,
  type SubagentRuntimeConfig,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodePromptAttachment,
  type ZCodeProtocolRequestId,
  type ZCodeProtocolTrace,
  type ZCodeSessionRuntimePreferencesResult,
  type ZCodeSessionRuntimePreferencesScope,
  type ZCodeTopicResourceReadParams,
} from "@zcode/shared";
import {
  completeNewModelSelection,
  type AccountProviderConfigSnapshot,
  type ModelSelectionView,
  type ProviderSource,
  type RuntimeProviderCatalogSnapshot,
} from "@zcode/provider";

export function buildSessionCreateParams(
  params: ZCodeAgentCreateSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionCreateCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    additionalDirectories: params.additionalDirectories,
    workspace: buildWorkspaceRef(params),
    parentSessionId: params.parentSessionId,
    mode: params.mode,
    model: params.model,
    ...(params.persistence !== undefined && !omittedFields.has("persistence")
      ? { persistence: params.persistence }
      : {}),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    ...(params.titleGenerationEnabled !== undefined
      ? { titleGenerationEnabled: params.titleGenerationEnabled }
      : {}),
    // desktop-continuous 首发/恢复走 session service，不经过 legacy task adapter。
    // 之前这里没有把 UI 已解析的 MCP 带进 strict protocol params，runtimeConfig 只能看到空 MCP。
    // MCP 是 runtime 启动期配置，必须在 create/resume 请求边界显式传递，后续 sendPrompt 无法补上。
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // CUA 工具隔离字段是可降级的：旧 app-server 的 .strict() schema 若不认，兼容重试会把它们放进
    // omittedFields 省略后重试（而不是硬失败）。故这里必须同样受 omittedFields 门控。
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    // importedHistory 是导入历史的完整性边界，不能像 thoughtLevel/persistence
    // 那样在旧协议兼容重试里省略，否则会创建一个可切模型但没有历史内容的空 session。
    ...(params.importedHistory !== undefined ? { importedHistory: params.importedHistory } : {}),
    // 只在灰度命中时下发 true（缺省不发字段）；旧 CLI strict schema 不认时经 compat 省略。
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    // 动态工作流灰度：同 Off-Peak 的下发形状，
    // 关闭时不写字段——CLI 的缺省就是不注册那九个工具。
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
    ...buildDynamicWorkflowModeField(params, omittedFields),
  };
}

/**
 * 灰度 mode 与布尔同行（launch.md「On demand: activation」）：只在开启时写，且只在布尔也在写时
 * 写——mode 单独出现对 CLI 没有意义。旧 CLI strict schema 不认时经 compat 省略，按 alwaysOn 行事。
 */
function buildDynamicWorkflowModeField(
  params: {
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionCreateCompatField | SessionResumeCompatField>,
): { dynamicWorkflowMode?: DynamicWorkflowMode } {
  return params.dynamicWorkflowEnabled === true &&
    params.dynamicWorkflowMode !== undefined &&
    !omittedFields.has("dynamicWorkflowEnabled") &&
    !omittedFields.has("dynamicWorkflowMode")
    ? { dynamicWorkflowMode: params.dynamicWorkflowMode }
    : {};
}

export function buildSessionResumeParams(
  params: ZCodeAgentResumeSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionResumeCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    additionalDirectories: params.additionalDirectories,
    workspace: buildWorkspaceRef(params),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    // 冷恢复 session 时 app-server 可能重新创建 runtime；MCP 同样需要随 resume 请求下发。
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // 工具面约束必须和 create 路径一致随 resume 下发，否则冷恢复重建 runtime 后会丢失 allow/deny
    // 隔离（CUA 会话会重新可见 Bash 等被禁工具）。旧 app-server 不认时经 omittedFields 降级。
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    // resume 不带该 flag 会让冷恢复丢 Off-Peak 工具面（与 toolAllowlist 同因）。
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    // 同因：resume 不带该 flag 会让冷恢复丢掉工作流工具簇。
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
    ...buildDynamicWorkflowModeField(params, omittedFields),
  };
}

export function buildSessionSendParams(
  params: ZCodeAgentSendPromptParams,
  omittedFields: ReadonlySet<SessionSendCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    // 执行身份/约束不是可忽略的兼容字段；旧 Worker 不支持时必须失败，不能静默剥掉。
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
    inputId: params.inputId,
    queryId: params.queryId,
    content: params.content,
    attachments: params.attachments,
    ...(params.browserAmbientContext !== undefined && !omittedFields.has("browserAmbientContext")
      ? { browserAmbientContext: params.browserAmbientContext }
      : {}),
    expectedRevision: params.expectedRevision,
    expectedProviderRevision: params.expectedProviderRevision,
    ...(params.automationId !== undefined && !omittedFields.has("automationId")
      ? { automationId: params.automationId }
      : {}),
    ...(params.offPeakTaskId !== undefined && !omittedFields.has("offPeakTaskId")
      ? { offPeakTaskId: params.offPeakTaskId }
      : {}),
    ...(params.offPeakRunType !== undefined && !omittedFields.has("offPeakRunType")
      ? { offPeakRunType: params.offPeakRunType }
      : {}),
    ...(params.botDeliveryTarget !== undefined && !omittedFields.has("botDeliveryTarget")
      ? { botDeliveryTarget: params.botDeliveryTarget }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
  };
}

export function buildSessionCompactParams(params: ZCodeAgentCompactParams) {
  return {
    sessionId: params.sessionId,
    inputId: params.inputId,
    instructions: params.instructions,
    expectedRevision: params.expectedRevision,
  };
}

export function formatModelSelectionForLog(ref: ModelSelection | undefined): string | null {
  if (!ref) {
    return null;
  }

  const base = `${ref.providerId}/${ref.modelId}`;
  const reasoningLevel = ref.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

export function sessionEventKey(params: ZCodeAgentSessionTarget): string {
  return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
}

export function rememberBoundedEventId(
  ids: Set<string>,
  order: string[],
  eventId: string,
): boolean {
  if (ids.has(eventId)) {
    return false;
  }
  ids.add(eventId);
  order.push(eventId);
  while (order.length > MAX_TRACKED_SESSION_EVENT_IDS) {
    const removed = order.shift();
    if (removed) {
      ids.delete(removed);
    }
  }
  return true;
}

export function permissionRequestKey(
  params: ZCodeAgentSessionTarget & { requestId: string },
): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

export function userInputRequestKey(
  params: ZCodeAgentSessionTarget & { requestId: string },
): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

export function providerRuntimeHeadersRequestKey(
  params: ZCodeAgentSessionTarget & { requestId: string },
): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

/**
 * 进程级 Provider Registry 的只读选择投影。
 *
 * 本地 Worker 自己持有完整 Registry；Host 只用这份投影判断模型执行是否可以启动，
 * 不能再把它扩张成 runtimeModel 并覆盖 Worker 的执行事实源。
 */
export interface ModelSelectionReadinessSource {
  getView(): Promise<ModelSelectionView>;
  onDidChange?: (listener: (view: ModelSelectionView) => void) => IDisposable;
}

export interface ZCodeAgentProviderReadinessSnapshot {
  readonly providerCount: number;
  readonly revision: string;
  readonly readiness: {
    readonly ready: boolean;
    readonly providerId?: string;
    readonly modelId?: string;
  };
}

export function createProviderReadinessSnapshotFromSelectionView(
  view: ModelSelectionView,
): ZCodeAgentProviderReadinessSnapshot {
  for (const provider of view.providers) {
    const model = provider.models[0];
    if (!model) continue;
    return {
      providerCount: view.providers.length,
      revision: `model-selection:${view.revision}`,
      readiness: {
        ready: true,
        providerId: provider.providerId,
        modelId: model.modelId,
      },
    };
  }
  return {
    providerCount: view.providers.length,
    revision: `model-selection:${view.revision}`,
    readiness: { ready: false },
  };
}

export interface WaitingWorkspaceStartup {
  cancelled: boolean;
  lastLoggedRevision?: string;
  starting?: Promise<ZCodeProtocolClient>;
  workspace: ZCodeAgentWorkspaceTarget;
}

export interface ActiveWorkspaceClient {
  client: ZCodeProtocolClient;
  interactionPreferencesReady?: Promise<void>;
  /**
   * 只记录该进程生命周期内是否曾通过 provider/model 启动门禁。
   * 只读 topic 可以先启动 CLI，但不能因此让后续 create/command 绕过门禁。
   */
  modelExecutionEnabled: boolean;
  workspace: ZCodeAgentWorkspaceTarget;
  /**
   * 该 CLI 进程当前持有的动态工作流策略（launch.md「The user's choice」）。CLI 启动时缺省关闭，
   * 只在 workspace/updateDynamicWorkflowPolicy 成功后更新；重同步据此跳过没有变化的请求。
   */
  dynamicWorkflowPolicyMode: DynamicWorkflowMode;
}

export type HostOpenCodeRunStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface HostOpenCodeRun {
  client: ZCodeProtocolClient;
  workspaceKey: string;
  zcodeSessionId: string;
  commandId: string;
  runId: string;
  status: HostOpenCodeRunStatus;
  opencodeSessionId?: string;
  stopReason?: string;
  finalText?: string;
  diagnosticCode?: string;
  modelOptionId?: string;
  modelValue?: string;
  cancelRequested?: boolean;
  disconnectRequested?: boolean;
  startupPromise?: Promise<void>;
  startupSettled?: boolean;
  readonly permissions: Map<string, Set<string>>;
  readonly disposables: IDisposable[];
  /** Host owns event order and serializes notification writes for this delegated run. */
  eventSequence: number;
  eventDelivery: Promise<void>;
  terminalPromise?: Promise<void>;
}

export function requiresProviderRegistryRefresh(commandType: string): boolean {
  // Bug 原因：模型切换遗漏刷新屏障，会用存量 Worker 的旧 Registry 校验新下发的 Provider。
  // 复用同一刷新队列，成功后才下发切换命令，失败则直接拒绝本次切换。
  switch (commandType) {
    case "createSession":
    case "createSelectionSideSession":
    case "sendText":
    case "sendGoalCommand":
    case "compact":
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "sendQueuedNow":
    case "switchModelConfig":
      return true;
    default:
      return false;
  }
}

export function createRuntimeUnavailableError(params: ZCodeAgentWorkspaceTarget): Error & {
  code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  workspaceKey: string;
} {
  const error = new Error("ZCode Agent runtime is not running.") as Error & {
    code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
    workspaceKey: string;
  };
  error.code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  error.workspaceKey = resolveWorkspaceKey(params);
  return error;
}

export interface CreateZCodeAgentServiceOptions extends Omit<
  ZCodeAgentProcessManagerOptions,
  "idleTimeoutMs"
> {
  /** 仅供 MCP 状态探测进程使用，不能把空闲回收传给 chat。 */
  mcpStatusIdleTimeoutMs?: number;
  /** ACP remains Host-owned; desktop-attached remotes intentionally do not receive this port. */
  openCodeAcpRuntime?: Pick<
    IOpenCodeAcpRuntime,
    | "startSession"
    | "setConfigOption"
    | "prompt"
    | "cancel"
    | "respondToPermission"
    | "closeSession"
    | "onDynamicSessionUpdate"
    | "onDynamicPermissionEvent"
  >;
  accountProviderConfigSource?: ProviderSource<AccountProviderConfigSnapshot>;
  /** Host-owned, in-memory local CLI providers; never persisted as Personal Provider Config. */
  runtimeProviderCatalogSource?: ProviderSource<RuntimeProviderCatalogSnapshot>;
  accountRequestAuthService?: IAccountRequestAuthService;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  modelSelectionReadinessSource?: ModelSelectionReadinessSource;
  readSubagentRuntimeConfig?: (workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<SubagentRuntimeConfig>;
  /** Host-owned index access; each request is bound to the connected workspace. */
  codeIntelligenceService?: CodeIntelligenceService;
  /**
   * Host-only store for the trusted CLI reverse RPC `uncensored/getConfig`.
   * Never exposed through the renderer channel: only `readTakeoverConfig` is used.
   */
  uncensoredSettingsStore?: UncensoredSettingsStore;
  sessionRuntimePreferencesAuthority?: "local" | "external";
  prepareProjectExecution?: (
    projectId: string,
  ) => Promise<import("@zcode/shared").ProjectExecutionSnapshot>;
  prepareSessionCreation?: (
    target: ZCodeAgentSessionTarget & {
      projectId: string | null;
      additionalDirectories?: string[];
    },
  ) => Promise<string[]>;
  resolveSessionDirectories?: (target: ZCodeAgentSessionTarget) => Promise<string[]>;
  resolveSessionRuntimePreferences?: (
    scope: ZCodeSessionRuntimePreferencesScope,
  ) => Promise<ZCodeSessionRuntimePreferencesResult>;
  /** manual run 落库后由当前 host 直接派发；返回时 prompt 必须已被 session 接受。 */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /**
   * Off-Peak 会话内创建。config 同时承担曝光门（enabled && Selection View 非空 →
   * session create/resume 下发 offPeakToolEnabled）与缺省解析（model=白名单末位 /
   * thoughtLevel=最高档）；service 供 offPeak/create、offPeak/list 协议 handler 调用。
   * 两者任一缺省即整体关闭（纯 CLI / desktop-attached-remote 装配不传）。
   */
  resolveOffPeakClientConfig?: () => Promise<OffPeakClientConfig | undefined>;
  /**
   * 动态工作流灰度快照。Host 是唯一裁决者：
   * 结果既作为 workspace 级事实下发给 CLI，也决定 session create/resume/v4 是否带
   * dynamicWorkflowEnabled。缺省不传（纯 CLI 装配）= 永远关闭，与 CLI 缺省一致。
   */
  resolveDynamicWorkflowClientConfig?: () => Promise<DynamicWorkflowClientConfig | undefined>;
  /**
   * 用户选择的读取点（launch.md「The user's choice」）：拥有设置权威的 Host 注入，每次使用时读取
   * 设置文件。desktop-attached remote Host 不注入，改用 desktop 推来的值（syncDynamicWorkflowUserMode）。
   */
  resolveDynamicWorkflowUserMode?: () => Promise<DynamicWorkflowMode | undefined>;
  /** 用户选择同步后交给装配层转发（Desktop Host 推给本窗口的远程 Host）；值取自本机设置。 */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  resolveOffPeakTaskService?: () =>
    | Pick<IOffPeakTaskService, "createTask" | "list" | "getCodingPlanSupport">
    | undefined;
  /**
   * browser-use 执行桥：把 agent 的 interaction/browserExecute 反向请求转发到 main
   * （WebContentsView+CDP）。desktop host 装配时注入；缺省（纯 CLI/远控无 main）则
   * browser 命令返回 backend_unavailable，不影响其它功能。
   */
  browserControlExecutor?: BrowserAmbientContextExecutor;
  channelReplyExecutor?: (request: ChannelReplyHostRequest) => Promise<ChannelReplyResult>;
  topicResourceExecutor?: (
    request: ZCodeTopicResourceReadParams &
      ZCodeAgentWorkspaceTarget & { trace?: ZCodeProtocolTrace },
    signal: AbortSignal,
  ) => Promise<ZCodePromptAttachment>;
  topicResourceValidator?: (
    request: ZCodeTopicResourceReadParams &
      ZCodeAgentWorkspaceTarget & { trace?: ZCodeProtocolTrace },
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * 官方 Server MCP 身份头解析器。Agent 进程不持有用户身份权威，
   * 经 interaction/requestOfficialMcpAuthHeaders 向 host 索取本次请求的身份头。
   *
   * 缺省时该请求一律返回 official_auth_unavailable，绝不降级为匿名请求——
   * 例如 standalone CLI 没有 host auth port 的场景。
   */
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(request: {
      mcpKey: string;
      pluginId: string;
      targetOrigin: string;
      workspace: {
        workspaceIdentity?: string;
        workspaceKey: string;
        workspacePath: string;
      };
    }): Promise<
      | { ok: true; headers: Record<string, string> }
      | {
          ok: false;
          reason: "official_auth_unavailable" | "official_auth_plan_required";
        }
    >;
  };
  /**
   * 官方 MCP 可信 Origin 校验器。**host 是身份权威边界**，因此
   * targetOrigin 的校验必须在这里执行，不能只依赖 agent adapter 的 fetch wrapper——那等于让
   * 被审查方自己当审查者。desktop-attached remote 场景下 agent 跑在远端而 host 持有本地用户身份。
   *
   * 此校验约束凭据请求的目标 origin，不提供逐插件权限控制。
   * HTTP 鉴权由宿主 fetch wrapper 注入，stdio 鉴权会将凭据交给插件进程；后者
   * 必须按受信任的可执行代码管理。服务端仍须校验每次调用的身份、权限和配额。
   *
   * 缺省时一律拒绝（fail closed），不退化为"只做 schema 校验就发凭据"。
   */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  /** desktop-local Host 注入；只消费已校验、已去重的 live session event。 */
  cuaOperationStateReporter?: CuaOperationStateReporter;
  onCuaPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
}

export function toProtocolAutomation(automation: ZCodeAutomation) {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    modelSelection: automation.modelSelection,
    mode: automation.mode,
    targetTaskId: automation.targetTaskId,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    // 透传权威 scheduleRule；会话卡片必须读到本字段才能展示 cron 无法表达的真实间隔
    // （如每50小时、每40天），否则只能从兼容 cronExpr 推断出「每小时的第00分」等错误展示。
    scheduleRule: automation.scheduleRule,
  };
}

export function toProtocolOffPeakTaskSnapshot(task: {
  offPeakTaskId: string;
  title: string;
  status: "queued" | "paused" | "running" | "completed" | "failed" | "cancelled";
  queuePosition?: number;
  sessionId?: string;
  createdAt: number;
}) {
  // 协议最小面：不暴露 serverTicketId / providerName / workspace 细节。
  return {
    offPeakTaskId: task.offPeakTaskId,
    title: task.title,
    status: task.status,
    ...(typeof task.queuePosition === "number" && task.queuePosition > 0
      ? { queuePosition: task.queuePosition }
      : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    createdAt: task.createdAt,
  };
}

const OFF_PEAK_INTERNAL_ERROR_CODE = "offpeak_internal_error";
const OFF_PEAK_INTERNAL_ERROR_MESSAGE = "Internal off-peak service error";

/**
 * offPeak/create、offPeak/list 的兜底 catch 不得把跨层异常文本（SQLite/文件路径/
 * 上游响应片段）原样回传协议——它会进入 CLI 日志与模型可见错误。原始错误只进服务端日志，
 * 对外固定稳定错误码 + 通用文案；业务失败分类仍走 respond({ok:false}) 不经此处。
 */
export async function respondOffPeakInternalError(
  client: Pick<ZCodeProtocolClient, "respondError">,
  request: { id: ZCodeProtocolRequestId; method: string },
  workspace: ZCodeAgentWorkspaceTarget,
  error: unknown,
): Promise<void> {
  logger.warn(undefined, "Off-peak 协议请求处理失败", {
    method: request.method,
    workspaceKey: resolveWorkspaceKey(workspace),
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  await client.respondError(request.id, {
    code: -32603,
    message: OFF_PEAK_INTERNAL_ERROR_MESSAGE,
    data: { errorCode: OFF_PEAK_INTERNAL_ERROR_CODE },
  });
}

/** D49-8/SG-02：只有灰度有效开启且白名单非空才算"可创建"；其余一律视为关闭（空数组）。 */
export function resolveOffPeakAllowedModels(
  grayConfig: OffPeakClientConfig | undefined,
  providerId?: string,
): readonly string[] {
  if (grayConfig?.enabled !== true) return [];
  return grayConfig.modelSelectionView.providers
    .filter((provider) => providerId === undefined || provider.providerId === providerId)
    .flatMap((provider) => provider.models.map((model) => model.modelId));
}

/**
 * model 解析：省略 → 白名单末位（服务端顺序末位≈最新最强）；显式 → trim + 大小写不敏感匹配，
 * 命中返回白名单原写法，未命中返回 null（调用方回 model_not_allowed）。
 */
export function resolveOffPeakCreateModel(
  allowedModels: readonly string[],
  requested: string | undefined,
): string | null {
  const wanted = requested?.trim();
  if (!wanted) return allowedModels[allowedModels.length - 1] ?? null;
  const lower = wanted.toLowerCase();
  return allowedModels.find((model) => model.trim().toLowerCase() === lower) ?? null;
}

/**
 * 新工具任务复用公共最高档补全；旧 metadata/型号特判会偏离 values 的语义顺序。
 * 显式档位留给 createTask 的现有校验，不在入口擅自换档。
 */
export function resolveOffPeakToolSelection(
  view: ModelSelectionView,
  providerId: string,
  modelId: string,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const selection = completeNewModelSelection(view, { providerId, modelId });
  if (!selection) return undefined;
  return thoughtLevel === undefined
    ? selection
    : { ...selection, options: { reasoningLevel: thoughtLevel } };
}
