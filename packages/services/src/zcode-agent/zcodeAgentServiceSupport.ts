import type {
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentSessionRuntimePreferencesRequest,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import {
  ZCodeProtocolRequestTimeoutError,
  type ZCodeProtocolClient,
} from "./zcodeProtocolClient.js";
import {
  resolveWorkspaceKey,
  type ZCodeProtocolRequestId,
  type ZCodeProviderRuntimeHeadersRequestParams,
  type ZCodeSavedWorkflowScope,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS, utf8JsonByteLength } from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getDataBaseDir } from "../paths.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const logger = createServiceLogger("zcode-agent-service");
export const cuaOperationLogger = createServiceLogger("cua-operation-turn");
const PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME = "plugin-workspace";
// 状态探测完成后释放闲置的 MCP 子进程；只作用于控制面，不回收会话进程。
export const MCP_STATUS_LANE_IDLE_TIMEOUT_MS = 5 * 60_000;
// 官方 Claude marketplace 首次接入需要 clone/copy GitHub 仓库，30s 默认协议超时会杀掉健康 agent。
// 插件市场管理属于低频网络 I/O 操作，单独放宽超时，不影响普通会话消息的实时失败边界。
export const PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** 资源管理器每秒刷新；子进程映射是纯内存请求，超时就当本轮无映射，不能拖慢采样节拍。 */
export const CHILD_PROCESSES_REQUEST_TIMEOUT_MS = 800;
export const PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS = 5_000;
export const SESSION_COMPACT_REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface PendingPermissionRequest {
  client: ZCodeProtocolClient;
  protocolRequestId: ZCodeProtocolRequestId;
}

export interface PendingProviderRuntimeHeadersRequest extends PendingPermissionRequest {
  request: ZCodeProviderRuntimeHeadersRequestParams;
  responding?: boolean;
}

export interface PendingSessionRuntimePreferencesRequest extends PendingPermissionRequest {
  workspace: ZCodeAgentWorkspaceTarget;
  request: ZCodeAgentSessionRuntimePreferencesRequest;
  timeout: ReturnType<typeof setTimeout>;
  workspaceKey: string;
}

export type SessionCreateCompatField =
  | "persistence"
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled"
  | "dynamicWorkflowMode";
export type SessionResumeCompatField =
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled"
  | "dynamicWorkflowMode";
export type SessionSendCompatField =
  | "browserAmbientContext"
  | "automationId"
  | "offPeakTaskId"
  | "offPeakRunType"
  | "botDeliveryTarget"
  | "toolDenylist";

const SESSION_CREATE_OPTIONAL_COMPAT_FIELDS = new Set<SessionCreateCompatField>([
  "persistence",
  "thoughtLevel",
  "mcpServers",
  // CUA 工具隔离新增：buildSessionCreateParams 会带 toolAllowlist/toolDenylist。若旧 app-server
  // 的 .strict() schema 不认，需可降级重试而不是整个 createSession 硬失败。
  "toolAllowlist",
  "toolDenylist",
  // Off-Peak 工具面 flag 同为可降级字段；旧 app-server 不认时省略重试（工具随之不注册，fail-closed）。
  "offPeakToolEnabled",
  // 动态工作流灰度 flag 同理：旧 CLI 不认时
  // 省略重试，工作流工具簇随之不注册，绝不让整个 create 硬失败。
  "dynamicWorkflowEnabled",
  // 灰度 mode（launch.md「On demand: activation」）：只认布尔的 CLI 省略它后按 alwaysOn 行事。
  "dynamicWorkflowMode",
]);
const SESSION_RESUME_OPTIONAL_COMPAT_FIELDS = new Set<SessionResumeCompatField>([
  "thoughtLevel",
  "mcpServers",
  // 冷恢复也带工具面约束；旧 app-server 不认时降级重试而不是硬失败（与 create 一致）。
  "toolAllowlist",
  "toolDenylist",
  "offPeakToolEnabled",
  "dynamicWorkflowEnabled",
  "dynamicWorkflowMode",
]);
const SESSION_SEND_OPTIONAL_COMPAT_FIELDS = new Set<SessionSendCompatField>([
  "browserAmbientContext",
  "automationId",
  "offPeakTaskId",
  "offPeakRunType",
  "botDeliveryTarget",
  "toolDenylist",
]);
// onDynamicSessionEvent 建立上游订阅时若 getClient / sessionSubscribe 瞬时失败
// （agent 进程刚启动、runtime 抛 "Session is not active" 竞态、transport 抖动），
// 直接 .catch(() => {}) 静默吞掉且不重试的话，调用方（含 syncer shadow 订阅）会把
// emitter.event 当作"订阅成功"缓存，永不重建——这条 session 的终态事件再也到不了，
// sqlite 停在旧状态、侧边栏 spinner 转不停。这里改为有限次指数退避重试，覆盖瞬时失败窗口。
export const SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS = 500;
export const SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS = 5_000;
export const SESSION_SUBSCRIBE_MAX_ATTEMPTS = 8;
export const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;
const SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:ssh:";
const WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:wsl:";

export function supportsLegacyRemoteTaskAllowlist(workspaceIdentity: string | undefined): boolean {
  return Boolean(
    workspaceIdentity?.startsWith(SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX) ||
    workspaceIdentity?.startsWith(WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX),
  );
}

export function isClosedStdioTransportError(error: unknown): boolean {
  return error instanceof Error && error.message === "ZCode agent stdio transport is closed";
}

export interface SessionEventSequenceState {
  assignedSeqByEventId: Map<string, number>;
  assignedSeqEventIds: string[];
  liveEventIds: Set<string>;
  liveEventIdOrder: string[];
  lastAssignedSeq: number;
}

export function isProtocolMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

export function buildWorkspaceRef(params: ZCodeAgentWorkspaceTarget): ZCodeWorkspaceRef {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    remoteSessionId: params.remoteSessionId,
    workspaceKey: resolveWorkspaceKey(params),
  };
}

// 已保存工作流的 target 是否带 workspace：项目档、以及
// GUI 项目组里明说 `scope:"global"` 的动作都带 workspacePath；只给 `{ scope: "global" }` 的
// 全局组动作不带，交给 services 自选载体。
export function savedWorkflowTargetHasWorkspace(
  params: ZCodeAgentSavedWorkflowTarget,
): params is ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope } {
  return typeof (params as Partial<ZCodeAgentWorkspaceTarget>).workspacePath === "string";
}

// 只在 `scope` 有定义时下推到 RPC params：不给 scope 的项目档保持与今天逐字一致的线上形状。
export function savedWorkflowScopeParam(params: ZCodeAgentSavedWorkflowTarget): {
  scope?: ZCodeSavedWorkflowScope;
} {
  return params.scope === undefined ? {} : { scope: params.scope };
}

export function ensurePluginManagementWorkspacePath(): string {
  const workspacePath = join(getDataBaseDir(), ".zcode", PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME);
  // 插件管理是控制面能力，不能复用可能因真实 workspace 被删而 EPIPE 的会话进程。
  // 这里给它固定一个内部 cwd；真实 workspace 仍通过协议参数传给 CLI 做 workspace-scope 判定。
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

// NOTE: this counts ONLY the per-session MCP servers passed through the ZCode Protocol
// session/create params (the app→protocol channel). It is deliberately independent of the
// CLI/bootstrap MCP servers configured in ~/.zcode/cli/config.json (mcp.servers), which the agent
// runtime connects separately and reports via the `mcp.server.connected`/toolCount events. So a
// createSession log line with mcpServerCount:0 is EXPECTED when zcode-cua is a CLI-config MCP server
// (e.g. the product Helper broker path injected through the gated bootstrap env): the model still receives those
// tools — the two numbers describe different channels, not a missing tool set. Verified on-machine:
// real kimi-k2.6 turns call mcp__zcode-cua__* tools (get_app_state/type/open_application, status
// completed) in sessions whose createSession logged mcpServerCount:0.
export function getMcpServerCount(params: { mcpServers?: readonly unknown[] }): number {
  return params.mcpServers?.length ?? 0;
}

export function getMcpServerNames(params: { mcpServers?: readonly { name: string }[] }): string[] {
  return params.mcpServers?.map((server) => server.name) ?? [];
}

function parseInvalidParamsIssues(error: unknown): unknown[] {
  const errorLike = error as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  const message = errorLike.message;
  if (
    errorLike.code !== -32602 ||
    typeof message !== "string" ||
    (message !== "Invalid params" && !message.startsWith("Invalid params — "))
  ) {
    return [];
  }
  const data = errorLike.data;
  if (!data || typeof data !== "object") {
    return [];
  }
  // 新版 Agent 会把 Zod 摘要附加到顶层 message，旧兼容解析却只接受严格等于
  // "Invalid params"，导致 App/Agent 版本错位时无法省略新增字段重试。字段判断仍只信任
  // data 中的结构化 issues，不能从可变的人类可读摘要里猜字段名。
  const serializedIssues = (data as { message?: unknown }).message;
  if (typeof serializedIssues !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(serializedIssues) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getUnrecognizedTopLevelKeys(error: unknown): string[] {
  const keys = new Set<string>();
  for (const issue of parseInvalidParamsIssues(error)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const issueLike = issue as {
      code?: unknown;
      keys?: unknown;
      path?: unknown;
    };
    if (
      issueLike.code !== "unrecognized_keys" ||
      (Array.isArray(issueLike.path) && issueLike.path.length > 0) ||
      !Array.isArray(issueLike.keys)
    ) {
      continue;
    }
    for (const key of issueLike.keys) {
      if (typeof key === "string") {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

export function getSessionCreateCompatFields(error: unknown): SessionCreateCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionCreateCompatField =>
      SESSION_CREATE_OPTIONAL_COMPAT_FIELDS.has(key as SessionCreateCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

export function getSessionResumeCompatFields(error: unknown): SessionResumeCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionResumeCompatField =>
      SESSION_RESUME_OPTIONAL_COMPAT_FIELDS.has(key as SessionResumeCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

export function getSessionSendCompatFields(error: unknown): SessionSendCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionSendCompatField =>
      SESSION_SEND_OPTIONAL_COMPAT_FIELDS.has(key as SessionSendCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

export function isProtocolRequestTimeout(error: unknown, method: string): boolean {
  if (error instanceof ZCodeProtocolRequestTimeoutError) {
    return error.method === method;
  }
  return error instanceof Error && error.message === `ZCode Protocol request timed out: ${method}`;
}

export function assertV4AttachmentNdjsonEnvelope(method: string, params: unknown): void {
  // 实际 CLI request id 是递增整数；这里用更宽的 32-char id 做保守 exact-JSON meter。
  const bytes = utf8JsonByteLength({ id: "9".repeat(32), method, params }) + 1; // NDJSON newline
  if (bytes > PROTOCOL_V4_LIMITS.maxFrameBytes) {
    throw new Error("proto.frameTooLarge");
  }
}
