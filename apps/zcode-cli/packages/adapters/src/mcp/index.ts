import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpElicitationPort,
  McpElicitationTrace,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpNotificationPort,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpResourceSubscriptionRequest,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";
import {
  ZCODE_OFFICIAL_MCP_AUTH_TYPE,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  createStatus,
  DEFAULT_MCP_TIMEOUT_MS,
  isCurrentConnection,
  MCP_PING_TIMEOUT_MS,
  nextConnectionGeneration,
  type McpClient,
  type McpServerRecord,
  type OfficialMcpAuthAdapterOptions,
} from "./adapter-context.js";
import { isPeerAnsweredError, isRecord } from "./adapter-helpers.js";
import {
  connectServer,
  reconnectForCall,
  resolveConnectedRecord,
  waitForSharedConnection,
} from "./connection-lifecycle.js";
import { closeRecord } from "./connection-teardown.js";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import type { NetworkEgressEnvPolicy } from "./network.js";
import { classifyInteractiveAuthorizationTrigger } from "./oauth-errors.js";
import type { McpOAuthRuntimeOptions } from "./oauth.js";
import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";
import {
  listResourceTemplates,
  listResources,
  resourceSubscriptionCounts,
  subscribeResource,
  unsubscribeResource,
  unsubscribeResourcesBySubscriber,
} from "./resource-operations.js";
import { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import { createMcpDeadline, remainingMcpDeadlineMs, waitWithinMcpDeadline } from "./timeout.js";
import { callToolOnClient, recoverToolCallAuthorization } from "./tool-authorization.js";

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  /**
   * 官方 Server MCP 鉴权依赖。trustedOrigins 缺失时仍 fail closed；authHeadersPort
   * 可缺省，此时各请求匿名降级并交给服务端做权威判定。
   */
  officialMcpAuth?: OfficialMcpAuthAdapterOptions;
  workingDirectory?: string;
  /** 有此端口才向 server 宣告 elicitation 能力；缺省时 server 的 elicitation/create 收到 method not found。 */
  elicitation?: McpElicitationPort;
  /** server → client 通知（资源更新 / 列表变化 / 工具列表变化 / 日志）的出口；缺省只记 debug。 */
  notifications?: McpNotificationPort;
}

export {
  MCP_NOTIFICATION_MESSAGE,
  MCP_NOTIFICATION_RESOURCES_LIST_CHANGED,
  MCP_NOTIFICATION_RESOURCES_UPDATED,
  MCP_NOTIFICATION_TOOLS_LIST_CHANGED,
} from "./adapter-context.js";

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionContext, workingDirectory }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";

class NodeMcpAdapter implements McpPort {
  readonly adapterInstanceId = randomUUID();
  readonly clientName: string;
  readonly clientVersion: string;
  readonly connectionContext?: McpConnectionContext;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly mcpOAuth?: McpOAuthRuntimeOptions;
  readonly network?: NetworkEgressEnvPolicy;
  readonly officialMcpAuth?: OfficialMcpAuthAdapterOptions;
  readonly telemetry?: McpTelemetryTracker;
  readonly connectionGenerations = new Map<string, number>();
  credentialStore?: SharedZCodeCredentialStore;
  /**
   * 官方鉴权失败分类的暂存槽。不能从 error 对象读——SDK 的 version
   * negotiation 会把 OfficialMcpAuthError 重新包装成普通 Error，instanceof 失效；
   * 也不允许按错误文本反解。因此在抛出点写入，failConnection 取用后立即清除。
   */
  readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();
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
  readonly serverRequestIdBySpan = new Map<string, string>();
  readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();
  readonly records = new Map<string, McpServerRecord>();
  readonly workingDirectory?: string;
  readonly elicitation?: McpElicitationPort;
  readonly notifications?: McpNotificationPort;
  /** 资源订阅登记表 serverName → uri → subscriberKey；唯一 owner，连接层计数。 */
  readonly resourceSubscriptions = new McpResourceSubscriptionRegistry();
  /** tools/list_changed 累计次数，runtime 按此判断是否需要重注册。 */
  toolListRevisionCounter = 0;
  /** 每个 server 当前正在执行的工具调用 trace；elicitation 借此归属到会话 / 工具行。 */
  readonly activeCallTraces = new Map<string, McpElicitationTrace>();
  readonly appConnectionListeners = new Map<string, Set<() => void>>();

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "zcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
    this.elicitation = options.elicitation;
    this.notifications = options.notifications;
  }

  async connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options: McpConnectOptions = {},
  ): Promise<McpConnectionSnapshot> {
    const startedAt = Date.now();
    const serverNames = Object.keys(servers);
    this.logger?.info("MCP configured servers connection started", {
      event: "mcp.configured_servers.connect.started",
      serverCount: serverNames.length,
      serverNames,
      status: "started",
    });
    const configuredNames = new Set(Object.keys(servers));
    await Promise.all(
      Array.from(this.records.keys())
        .filter((name) => !configuredNames.has(name))
        .map((name) => this.disconnectServer(name)),
    );

    await Promise.all(
      Object.entries(servers).map(([name, config]) => {
        const record = this.records.get(name);
        if (
          record?.connecting &&
          record.status.status === "connecting" &&
          record.status.authorization &&
          isDeepStrictEqual(record.config, config)
        ) {
          // 相同配置的全量收敛可能与 OAuth callback 等待重叠；重新 connect
          // 会关闭原 session，使浏览器中已打开的授权 URL、PKCE/state 和 callback 一并失效。
          // 连接生命周期可以共享，但 Session 的 15 秒等待预算和 AbortSignal 不能继承设置页的 5 分钟预算。
          return waitForSharedConnection(this, name, record, options);
        }
        return connectServer(this, name, config, options);
      }),
    );

    const statuses = await this.status();
    const tools = await this.listTools();
    const statusCounts = Object.values(statuses).reduce<Record<string, number>>(
      (counts, status) => {
        counts[status.status] = (counts[status.status] ?? 0) + 1;
        return counts;
      },
      {},
    );
    this.logger?.info("MCP configured servers connection completed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.configured_servers.connect.completed",
      serverCount: serverNames.length,
      status: "completed",
      statusCounts,
      toolCount: tools.length,
    });
    return {
      statuses,
      tools,
    };
  }

  async connectServer(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpServerStatus> {
    return await connectServer(this, name, config, options);
  }

  async disconnectServer(name: string): Promise<McpServerStatus | undefined> {
    const record = this.records.get(name);
    if (!record) return undefined;

    nextConnectionGeneration(this, name);
    await closeRecord(this, name);
    const status = createStatus(record.config, "disconnected");
    this.records.set(name, {
      config: record.config,
      status,
      tools: [],
    });
    return status;
  }

  async status(): Promise<Record<string, McpServerStatus>> {
    return Object.fromEntries(
      Array.from(this.records.entries()).map(([name, record]) => [name, record.status]),
    );
  }

  // HTTP/SSE MCP 服务被停掉时不会派发 onclose（没有常驻流可断），record 会长期停在
  // connected；设置页刷新读到的就是这份"无声死亡"的旧快照，看起来像刷新按钮没生效。
  // ping 是 MCP 基础协议方法，用它把 transport 存活性显式化。
  async pingServer(name: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") {
      return false;
    }
    const timeoutMs = Math.min(
      options.timeoutMs ?? MCP_PING_TIMEOUT_MS,
      record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );
    const generation = this.connectionGenerations.get(name) ?? 0;
    try {
      await record.client.ping({ timeout: timeoutMs });
      return true;
    } catch (error) {
      // server 回了 JSON-RPC 错误（例如未实现 ping）说明连接本身是活的，不能据此拆连接。
      if (isPeerAnsweredError(error)) {
        return true;
      }
      if (!isCurrentConnection(this, name, generation)) return false;
      const current = this.records.get(name);
      if (current && current.client === record.client) {
        current.status = createStatus(current.config, "disconnected", {
          error: "MCP server did not answer ping",
          failureKind: "unexpected_disconnect",
        });
      }
      this.logger?.warn("MCP server ping failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.server.ping.failed",
        mcpServerName: name,
        status: "failed",
        transport: record.config.type,
      });
      return false;
    }
  }

  toolListRevision(): number {
    return this.toolListRevisionCounter;
  }

  async currentSnapshot(): Promise<McpConnectionSnapshot> {
    const [statuses, tools] = await Promise.all([this.status(), this.listTools()]);
    return { statuses, tools };
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    // 收到 notifications/tools/list_changed 的 server 在下一次 listTools 时重新拉取
    // （runtime 只在回合开始前调用，回合内工具表不变）。
    for (const [name, record] of this.records) {
      if (!record.toolsStale || !record.client || record.status.status !== "connected") continue;
      try {
        const listed = await record.client.listTools();
        record.tools = listed.tools.map((tool) =>
          normalizeMcpToolDescriptor(
            name,
            tool,
            record.config.timeoutMs,
            record.config.type === "http" &&
              record.config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
          ),
        );
        record.status = { ...record.status, toolCount: record.tools.length };
        record.toolsStale = false;
        this.logger?.info("MCP tool list refreshed after list_changed", {
          event: "mcp.tools.refreshed",
          mcpServerName: name,
          toolCount: record.tools.length,
        });
      } catch (error) {
        this.logger?.warn("MCP tool list refresh failed", {
          event: "mcp.tools.refresh_failed",
          mcpServerName: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return Array.from(this.records.values()).flatMap((record) => record.tools);
  }

  async listResources(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourcesResult> {
    return await listResources(this, request, options);
  }

  async listResourceTemplates(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourceTemplatesResult> {
    return await listResourceTemplates(this, request, options);
  }

  async subscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    await subscribeResource(this, request, options);
  }

  async unsubscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    await unsubscribeResource(this, request, options);
  }

  async unsubscribeResourcesBySubscriber(subscriberKeyPrefix: string): Promise<number> {
    return await unsubscribeResourcesBySubscriber(this, subscriberKeyPrefix);
  }

  resourceSubscriptionCounts(): Record<string, Record<string, number>> {
    return resourceSubscriptionCounts(this);
  }

  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
    let record: McpServerRecord & { client: McpClient };
    if (options.appConnection) {
      const snapshot = this.appConnectionSnapshot(request.serverName);
      const current = this.records.get(request.serverName);
      if (
        !snapshot ||
        snapshot.identity !== options.appConnection.identity ||
        snapshot.generation !== options.appConnection.generation ||
        !current?.client
      )
        throw new Error("MCP App connection changed");
      options.signal?.throwIfAborted();
      record = current as McpServerRecord & { client: McpClient };
    } else {
      record = await resolveConnectedRecord(
        this,
        request.serverName,
        deadline,
        timeoutMessage,
        options.signal,
      );
    }

    try {
      return await callToolOnClient(
        this,
        record.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    } catch (error) {
      if (options.appConnection) throw error;
      // 连接建立后 token 过期、被撤销或 scope 不足时，
      // 过去这些认证错误原样冒泡，用户看到裸错误且永远不会自愈——OAuth 自愈只存在于
      // startup connect 路径。现在运行期与建连期共用同一套 Phase 2 → Phase 1 编排。
      const trigger = classifyInteractiveAuthorizationTrigger(error);
      if (trigger && record.config.type !== "stdio") {
        return await recoverToolCallAuthorization(this, {
          error,
          record,
          request,
          deadline,
          timeoutMessage,
          trigger,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
      }
      // 防 onclose 尚未派发的竞态：SDK 在 transport 已断时抛裸 "Not connected"。
      // 只对这一种确定的断连错误重连重试一次，其余错误原样冒泡。
      if (!(error instanceof Error) || error.message !== "Not connected") throw error;
      try {
        await waitWithinMcpDeadline(
          reconnectForCall(this, request.serverName, record.config),
          deadline,
          timeoutMessage,
          options.signal,
        );
      } catch (reconnectError) {
        this.logger?.warn("MCP server reconnect failed", {
          error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
          event: "mcp.server.reconnect.failed",
          mcpServerName: request.serverName,
          status: "failed",
        });
        throw error;
      }
      const revived = this.records.get(request.serverName);
      if (!revived?.client || revived.status.status !== "connected") throw error;
      return await callToolOnClient(
        this,
        revived.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    }
  }

  /**
   * 插件 UI 的 `ui://` 资源读取。与 callTool 共用连接等待 / 断连重连骨架（resolveConnectedRecord），
   * 保证走同一条连接与 OAuth 恢复路径；不做 tool 级 OAuth 二次恢复——资源读取失败直接冒泡，
   * 由 UI 回退到普通卡片。
   */
  async readResource(
    request: McpReadResourceRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpReadResourceResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP resource ${request.serverName} ${request.uri} timed out after ${timeoutMs}ms`;
    const record = await resolveConnectedRecord(
      this,
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    const result = await record.client.readResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      contents: (result.contents ?? []).map((content) => {
        const item = content as Record<string, unknown>;
        return {
          uri: typeof item.uri === "string" ? item.uri : request.uri,
          ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
          ...(typeof item.text === "string" ? { text: item.text } : {}),
          ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
          ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
        };
      }),
    };
  }

  async close(): Promise<void> {
    const startedAt = Date.now();
    const serverCount = this.records.size;
    for (const name of this.records.keys()) {
      nextConnectionGeneration(this, name);
    }
    await Promise.all(Array.from(this.records.keys()).map((name) => closeRecord(this, name)));
    this.records.clear();
    this.connectionDiagnosticByServer.clear();
    this.logger?.info("MCP adapter closed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.adapter.closed",
      serverCount,
      status: "completed",
    });
  }

  onAppConnectionInvalidated(name: string, listener: () => void): () => void {
    const listeners = this.appConnectionListeners.get(name) ?? new Set();
    listeners.add(listener);
    this.appConnectionListeners.set(name, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.appConnectionListeners.delete(name);
    };
  }
  async waitForAppConnection(
    name: string,
  ): Promise<{ identity: string; generation: number } | null> {
    const record = this.records.get(name);
    if (!record) return null;
    const generation = this.connectionGenerations.get(name) ?? 0;
    // 会话恢复先于 MCP 握手完成；复用已有连接任务，避免首次打开把 connecting 误判为失败。
    await record.connecting;
    return isCurrentConnection(this, name, generation) ? this.appConnectionSnapshot(name) : null;
  }

  appConnectionSnapshot(name: string): { identity: string; generation: number } | null {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") return null;
    // 只向宿主输出摘要；配置中的凭据不进入协议或日志。属性排序避免配置序列化次序造成换源。
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        );
      return value;
    };
    return {
      identity: createHash("sha256")
        .update(
          JSON.stringify([
            process.platform,
            process.execPath,
            this.workingDirectory ?? "",
            name,
            canonical(record.config),
          ]),
        )
        .digest("hex"),
      generation: this.connectionGenerations.get(name) ?? 0,
    };
  }
}
