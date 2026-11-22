import type {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpElicitationPort,
  McpElicitationTrace,
  McpNotificationPort,
  McpOAuthConfig,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import type { OfficialMcpAuthFailureKind } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import type { NetworkEgressEnvPolicy } from "./network.js";
import type { McpOAuthRuntimeOptions } from "./oauth.js";
import type { McpConnectionContext } from "./pool.js";
import type { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import type { McpTelemetryTracker } from "./telemetry.js";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
// 存活探测只允许占用很短的时间：它挂在设置页刷新的同步路径上，超时即判死并触发重连。
export const MCP_PING_TIMEOUT_MS = 5_000;
export const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
export const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;
/**
 * span → request id 的暂存条数上限。正常情况下每条都会在同一次 tool call 结束时被取走，
 * 留下的只有无人认领的（如连接期请求），几十条足够，纯为防止长会话下无界增长。
 */
export const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

/** 订阅的 server → client 通知方法名（MCP 规范）。 */
export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = "notifications/tools/list_changed";
export const MCP_NOTIFICATION_RESOURCES_UPDATED = "notifications/resources/updated";
export const MCP_NOTIFICATION_RESOURCES_LIST_CHANGED = "notifications/resources/list_changed";
export const MCP_NOTIFICATION_MESSAGE = "notifications/message";

export interface OfficialMcpAuthAdapterOptions {
  authHeadersPort?: OfficialMcpAuthHeadersPort;
  trustedOrigins: OfficialMcpTrustedOriginRegistry;
  /**
   * 当前 ZCode API origin。stdio 形态没有 `url` 可供校验，targetOrigin 只能由宿主给出
   * ——插件因此无法把身份头导向别的 origin。
   * 与 trustedOrigins 的 `resolveZCodeApiOrigin` 必须同源，否则两侧判定会分叉。
   */
  resolveZCodeApiOrigin?: () => string;
  workspaceIdentity?: string;
}

export type McpClient = Client;
export type McpTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;
export type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/**
 * stdio 官方 MCP 的身份头载荷，随每条出站协议消息的 `_meta` 下发。
 *
 * 失败也下发（`ok: false` + 枚举 reason）；stdio 插件拿不到头时不会去打官方端点。HTTP 路径则
 * 由 adapter 发起无身份的 tools/call，让 ZCode server 返回权威结构化错误。把 reason 交给 stdio
 * 插件才能让它把"未登录"与"无 Coding Plan
 * 套餐"如实呈现给用户，而不是静默降级成一句莫名其妙的失败。
 */
export type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

export interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  /** 收到 tools/list_changed 后置位，下一次 listTools 重拉。 */
  toolsStale?: boolean;
  transport?: McpTransport;
}

/**
 * adapter 的显式状态上下文。
 *
 * 连接生命周期 / 资源订阅 / OAuth / 工具调用恢复拆成独立模块后，这些模块不再依赖 `this`，
 * 而是统一读写同一份 adapter 实例状态；字段类型即各模块共享的唯一契约。
 */
export interface McpAdapterContext {
  readonly adapterInstanceId: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly connectionContext?: McpConnectionContext;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly mcpOAuth?: McpOAuthRuntimeOptions;
  readonly network?: NetworkEgressEnvPolicy;
  readonly officialMcpAuth?: OfficialMcpAuthAdapterOptions;
  readonly telemetry?: McpTelemetryTracker;
  readonly connectionGenerations: Map<string, number>;
  credentialStore?: SharedZCodeCredentialStore;
  /**
   * 官方鉴权失败分类的暂存槽。不能从 error 对象读——SDK 的 version
   * negotiation 会把 OfficialMcpAuthError 重新包装成普通 Error，instanceof 失效；
   * 也不允许按错误文本反解。因此在抛出点写入，failConnection 取用后立即清除。
   */
  readonly lastOfficialAuthKind: Map<string, OfficialMcpAuthFailureKind>;
  /**
   * span → 服务端 request id。只有官方 MCP 会写入（唯一能看到响应头的地方是 auth fetch
   * wrapper），供 in-band 失败（HTTP 200 + `isError`）把 id 带回 tool result。
   *
   * 用 span 而不是 traceId 作键：traceId 覆盖整个顶层 session，同一 session 的多次调用
   * 共用它，关联会串号；span 是一次 tool call 的粒度。
   *
   * 有界并即取即删：拿不到匹配的 span（如 initialize / tools/list，它们没有 `_meta`）
   * 就让条目自然被挤出，绝不"取最近一次"兜底——那会把上一次调用的 id 贴到这一次的失败上。
   */
  readonly serverRequestIdBySpan: Map<string, string>;
  readonly connectionDiagnosticByServer: Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >;
  readonly records: Map<string, McpServerRecord>;
  readonly workingDirectory?: string;
  readonly elicitation?: McpElicitationPort;
  readonly notifications?: McpNotificationPort;
  /** 资源订阅登记表 serverName → uri → subscriberKey；唯一 owner，连接层计数。 */
  readonly resourceSubscriptions: McpResourceSubscriptionRegistry;
  /** tools/list_changed 累计次数，runtime 按此判断是否需要重注册。 */
  toolListRevisionCounter: number;
  /** 每个 server 当前正在执行的工具调用 trace；elicitation 借此归属到会话 / 工具行。 */
  readonly activeCallTraces: Map<string, McpElicitationTrace>;
  readonly appConnectionListeners: Map<string, Set<() => void>>;
}

export function nextConnectionGeneration(ctx: McpAdapterContext, name: string): number {
  const generation = (ctx.connectionGenerations.get(name) ?? 0) + 1;
  ctx.connectionGenerations.set(name, generation);
  // eslint-disable-next-line unicorn/no-useless-spread -- 回调可能增删监听器，本次通知必须固定接收者。
  for (const listener of [...(ctx.appConnectionListeners.get(name) ?? [])]) listener();
  return generation;
}

export function isCurrentConnection(
  ctx: McpAdapterContext,
  name: string,
  generation: number,
): boolean {
  return ctx.connectionGenerations.get(name) === generation;
}

export function updateCurrentRecord(
  ctx: McpAdapterContext,
  name: string,
  generation: number,
  patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
): void {
  if (!isCurrentConnection(ctx, name, generation)) return;
  const record = ctx.records.get(name);
  if (!record) return;
  Object.assign(record, patch);
}

export function updateCurrentRecordStatus(
  ctx: McpAdapterContext,
  name: string,
  generation: number,
  patch: Partial<McpServerStatus>,
): void {
  if (!isCurrentConnection(ctx, name, generation)) return;
  const record = ctx.records.get(name);
  if (!record) return;
  record.status = {
    ...record.status,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function createStatus(
  config: McpServerConfig,
  status: McpServerStatus["status"],
  extra: {
    authorization?: McpServerStatus["authorization"];
    error?: string;
    failureKind?: McpServerStatus["failureKind"];
    protocolEra?: McpServerStatus["protocolEra"];
    serverRequestId?: string;
    toolCount?: number;
  } = {},
): McpServerStatus {
  return {
    status,
    transport: config.type,
    toolCount: extra.toolCount ?? 0,
    updatedAt: new Date().toISOString(),
    authorization: extra.authorization,
    error: extra.error,
    failureKind: extra.failureKind,
    protocolEra: extra.protocolEra,
    serverRequestId: extra.serverRequestId,
  };
}
