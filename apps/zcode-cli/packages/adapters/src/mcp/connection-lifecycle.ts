import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  McpConnectOptions,
  McpServerConfig,
  McpServerStatus,
} from "@zcode/contracts";
import {
  OFFICIAL_MCP_AUTH_META_KEY,
  ZCODE_OFFICIAL_MCP_AUTH_TYPE,
  type McpServerFailureKind,
} from "@zcode/shared";
import { buildMcpAppsClientCapabilities } from "@zcode/shared/mcp-apps";
import { resolve } from "node:path";
import {
  createStatus,
  DEFAULT_MCP_TIMEOUT_MS,
  isCurrentConnection,
  MCP_STDIO_STDERR_LOG_MAX_CHARS,
  nextConnectionGeneration,
  updateCurrentRecord,
  type McpAdapterContext,
  type McpClient,
  type McpServerRecord,
  type McpTransport,
} from "./adapter-context.js";
import {
  createBoundedTextBuffer,
  formatVersionNegotiationMode,
  getStdioTransportExitInfo,
  getStdioTransportPid,
  isProtocolNegotiationFailure,
  isOfficialAuthConfig,
  isStdioTransportProcessAlive,
  resolveAuthorizationCodeOAuthConfig,
  resolveVersionNegotiation,
  sanitizeMcpStdioStderr,
} from "./adapter-helpers.js";
import { closeClientAndTransport, closeRecord } from "./connection-teardown.js";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import { buildMcpStdioEnv, createMcpTransportFetch } from "./network.js";
import { classifyInteractiveAuthorizationTrigger } from "./oauth-errors.js";
import {
  createOfficialAuthFetch,
  createOAuthClientProvider,
  installElicitationHandler,
  resolveOfficialStdioAuthMeta,
  runInteractiveOAuthAuthorization,
} from "./oauth-flow.js";
import { OfficialMcpAuthError } from "./official-auth.js";
import { installNotificationHandlers, replayResourceSubscriptions } from "./resource-notifications.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import { McpTimeoutError, waitWithinMcpDeadline, withTimeout, type McpDeadline } from "./timeout.js";

export async function connectServer(
  ctx: McpAdapterContext,
  name: string,
  config: McpServerConfig,
  options: McpConnectOptions = {},
): Promise<McpServerStatus> {
  const startedAt = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const generation = nextConnectionGeneration(ctx, name);
  ctx.lastOfficialAuthKind.delete(name);
  ctx.connectionDiagnosticByServer.delete(name);
  ctx.logger?.info("MCP server connection started", {
    event: "mcp.server.connect.started",
    mcpServerName: name,
    status: "started",
    timeoutMs,
    transport: config.type,
  });
  await closeRecord(ctx, name);

  if (config.enabled === false) {
    const status = createStatus(config, "disabled");
    ctx.records.set(name, { config, status, tools: [] });
    ctx.logger?.info("MCP server connection skipped", {
      durationMs: Date.now() - startedAt,
      event: "mcp.server.connect.skipped",
      mcpServerName: name,
      status: "completed",
      transport: config.type,
    });
    return status;
  }

  const abortController = new AbortController();
  const abortExternal = () => {
    abortController.abort(options.signal?.reason instanceof Error ? options.signal.reason : undefined);
  };
  if (options.signal?.aborted) {
    abortExternal();
  } else {
    options.signal?.addEventListener("abort", abortExternal, { once: true });
  }

  const connectingStatus = createStatus(config, "connecting");
  const record: McpServerRecord = {
    abortController,
    config,
    status: connectingStatus,
    tools: [],
  };
  ctx.records.set(name, record);
  const connecting = openServerConnection(ctx, {
    config,
    generation,
    name,
    oauthAuthorizationTimeoutMs: options.oauthAuthorizationTimeoutMs,
    signal: abortController.signal,
    timeoutMs,
    workingDirectory: options.workingDirectory,
  }).finally(() => {
    options.signal?.removeEventListener("abort", abortExternal);
  });
  record.connecting = connecting;
  // 过去 `oauthAuthorizationTimeoutMs`（session 的 15 秒）被当成 OAuth 事务寿命，
  // 15 秒后连同 callback listener 一起关掉，真人根本来不及在浏览器里完成授权（现场证据：
  // 一次成功授权耗时约 74 秒）。现在它只作为**本 caller 的等待预算**：到点返回当时的
  // snapshot（含授权 URL），后台连接与 300 秒授权事务继续存活。
  return await waitForSharedConnection(ctx, name, record, options);
}

export function waitForSharedConnection(
  ctx: McpAdapterContext,
  name: string,
  record: McpServerRecord,
  options: McpConnectOptions,
): Promise<McpServerStatus> {
  const connecting = record.connecting;
  if (!connecting) return Promise.resolve(record.status);
  if (options.oauthAuthorizationTimeoutMs === undefined && !options.signal) {
    return connecting;
  }

  let abortHandler: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const currentStatus = () => ctx.records.get(name)?.status ?? record.status;
  const waiters: Promise<McpServerStatus>[] = [connecting];

  const timeoutMs = options.oauthAuthorizationTimeoutMs;
  if (timeoutMs !== undefined) {
    waiters.push(
      new Promise((resolvePromise) => {
        timeoutId = setTimeout(() => resolvePromise(currentStatus()), timeoutMs);
      }),
    );
  }
  if (options.signal) {
    waiters.push(
      new Promise((resolvePromise) => {
        if (options.signal?.aborted) {
          resolvePromise(currentStatus());
          return;
        }
        abortHandler = () => resolvePromise(currentStatus());
        options.signal?.addEventListener("abort", abortHandler, {
          once: true,
        });
      }),
    );
  }

  return Promise.race(waiters).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
  });
}

export async function openServerConnection(
  ctx: McpAdapterContext,
  input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationTimeoutMs?: number;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  },
): Promise<McpServerStatus> {
  const {
    config,
    generation,
    name,
    oauthAuthorizationAttempted = false,
    oauthAuthorizationTimeoutMs,
    signal,
    timeoutMs,
    workingDirectory,
  } = input;
  const startedAt = Date.now();
  let client: McpClient | undefined;
  let connectDurationMs: number | undefined;
  let getRecentStderr: (() => string | undefined) | undefined;
  let listToolsDurationMs: number | undefined;
  let transport: McpTransport | undefined;
  let failureKind: McpServerFailureKind =
    config.type === "stdio" ? "process_start_failed" : "network_unreachable";

  try {
    const transportBundle = await createTransport(
      ctx,
      config,
      name,
      generation,
      oauthAuthorizationTimeoutMs,
      workingDirectory,
      signal,
    );
    transport = transportBundle.transport;
    getRecentStderr = attachStdioLogging(ctx, name, transport);
    client = new Client(
      {
        name: ctx.clientName,
        version: ctx.clientVersion,
      },
      {
        versionNegotiation: resolveVersionNegotiation(config, timeoutMs),
        capabilities: {
          // MCP Apps 规范：宿主经 `extensions["io.modelcontextprotocol/ui"]` 宣告能渲染的 UI mimeType，
          // 官方 SDK 的 server 据此决定是否下发 ui 资源（getUiCapability）。
          ...buildMcpAppsClientCapabilities(),
          // 只宣告 form 模式（url 模式不做）；server 据此选择 elicitation 形态。
          ...(ctx.elicitation ? { elicitation: { form: {} } } : {}),
        },
      },
    );
    installElicitationHandler(ctx, client, name);
    installNotificationHandlers(ctx, client, name);
    updateCurrentRecord(ctx, name, generation, {
      client,
      transport,
    });

    const connectStartedAt = Date.now();
    await withTimeout(
      client.connect(transport),
      timeoutMs,
      `MCP server ${name} connection timed out after ${timeoutMs}ms`,
      signal,
    );
    connectDurationMs = Date.now() - connectStartedAt;

    failureKind = "tool_list_failed";
    const listToolsStartedAt = Date.now();
    const listed = await withTimeout(
      client.listTools(),
      timeoutMs,
      `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
      signal,
    );
    listToolsDurationMs = Date.now() - listToolsStartedAt;
    const tools = listed.tools.map((tool) =>
      normalizeMcpToolDescriptor(
        name,
        tool,
        config.timeoutMs,
        // 只有 http 形态置位。这个标记的用途是**信任结果里的结构化标识**
        // （额度耗尽 / 无套餐），因此判据必须是"结果由谁产出"：
        //   - http：结果来自 ZCode 后端。fetch wrapper 对每次请求校验 origin；登录态只在
        //     tools/call 解析，缺失时由同一可信后端返回结构化 coding_plan_required；
        //   - stdio：结果由插件进程自己产出，可以任意伪造 `{"error_code":"quota_exceeded"}`，
        //     从而在用户输入框上方弹出"额度用完 / 请开通 Coding Plan"的误导提示。
        // 原判据是 `type !== "sse"`，把 stdio 一起放了进来，等于这道门槛在 stdio 上为零。
        // 注意这不是在挡凭证外泄（那由 origin 校验负责），而是在挡**结果伪造**。
        config.type === "http" && config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
        config.alwaysLoad,
      ),
    );
    const negotiatedProtocolEra = client.getProtocolEra();
    const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
    const status = createStatus(config, "connected", {
      protocolEra: negotiatedProtocolEra,
      toolCount: tools.length,
    });
    if (!isCurrentConnection(ctx, name, generation)) {
      await closeClientAndTransport(ctx, name, client, transport);
      return ctx.records.get(name)?.status ?? status;
    }
    ctx.connectionDiagnosticByServer.delete(name);
    ctx.records.set(name, {
      client,
      config,
      status,
      tools,
      transport,
    });
    // 直接 connectServer（设置页或 InstallCapability）也会改变工具表，但不会触发
    // notifications/tools/list_changed。Без этого root runtime оставлял старый registry
    // до перезапуска: следующий turn не видел инструменты нового server.
    ctx.toolListRevisionCounter += 1;
    // A3：重连（同一 adapter 实例）后按登记表重放订阅；首次连接登记表为空，直接跳过。
    await replayResourceSubscriptions(ctx, name, client);
    const mcpTransportPid = getStdioTransportPid(transport);
    const mcpProcessIdentity =
      mcpTransportPid != null && ctx.connectionContext
        ? ctx.telemetry?.recordProcessStarted({
            connectionId: ctx.connectionContext.mcpConnectionId,
            pid: mcpTransportPid,
          })
        : undefined;
    // stdio MCP 子进程死亡（如 node_repl 被 REPL cell 的异步错误击穿）不能完全
    // 静默——不记日志、状态停留在 connected，后续调用只会抛裸的 "Not connected"。
    // 挂 onclose 把意外断连显式化；主动关闭路径会先清掉 onclose（见 closeClientAndTransport）。
    client.onclose = () => {
      if (!isCurrentConnection(ctx, name, generation)) return;
      const current = ctx.records.get(name);
      if (!current || current.client !== client) return;
      nextConnectionGeneration(ctx, name);
      const recentStderr = getRecentStderr?.();
      const processExit = getStdioTransportExitInfo(transport);
      current.status = createStatus(current.config, "disconnected", {
        error: "MCP server connection closed unexpectedly",
        failureKind: "unexpected_disconnect",
      });
      ctx.logger?.warn("MCP server connection lost", {
        ...ctx.connectionContext,
        event: "mcp.server.connection_lost",
        mcpServerName: name,
        ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
        ...mcpProcessIdentity,
        ...(processExit
          ? { exitCode: processExit.exitCode, signal: processExit.signal ?? undefined }
          : {}),
        status: "failed",
        transport: current.config.type,
        ...(recentStderr ? { stderr: recentStderr } : {}),
      });
      if (
        current.config.type === "stdio" &&
        ctx.connectionContext &&
        (processExit || !isStdioTransportProcessAlive(transport))
      ) {
        ctx.telemetry?.recordProcessCrashed({
          connectionId: ctx.connectionContext.mcpConnectionId,
          exitCode: processExit?.exitCode ?? null,
          signal: processExit?.signal ?? null,
        });
      }
    };
    // 此前连接日志只记录 transport，auto 协商后无法判断实际走 modern 还是 legacy。
    // 同时记录配置策略和 SDK 握手结果，避免把 `auto` 误当成最终协议版本。
    // 连接池上下文和 stdio transport PID 过去未进入同一事件，无法关联 session、
    // workspace、协议版本和真实子进程；stdio PID 只代表最终会话 transport，不代表 probe child。
    ctx.logger?.info("MCP server connected", {
      ...ctx.connectionContext,
      connectDurationMs,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.connected",
      listToolsDurationMs,
      mcpClientName: ctx.clientName,
      mcpClientVersion: ctx.clientVersion,
      mcpProtocolEra: negotiatedProtocolEra ?? "unknown",
      mcpProtocolVersion: negotiatedProtocolVersion ?? "unknown",
      mcpServerName: name,
      ...mcpProcessIdentity,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      mcpVersionNegotiationMode: formatVersionNegotiationMode(config),
      status: "completed",
      toolCount: tools.length,
      transport: config.type,
    });
    return status;
  } catch (error) {
    // 过去这里等的是旧 provider 自己开的 listener，且用 session 的 15 秒预算做
    // 硬关闭——15 秒是 caller 的等待预算，不是授权事务的寿命。现在按错误类型判定是否需要
    // 交互授权，并把授权交给 Phase 2 独立事务（独立锁、fresh DCR、300 秒事务 TTL）。
    const trigger = oauthAuthorizationAttempted
      ? undefined
      : classifyInteractiveAuthorizationTrigger(error);
    const authorizationCodeOAuthConfig =
      trigger && config.type !== "stdio" ? resolveAuthorizationCodeOAuthConfig(config) : undefined;
    if (trigger && authorizationCodeOAuthConfig && config.type !== "stdio") {
      // negotiation 失败时 SDK 已关闭 transport，不可复用；Phase 2 也不需要 transport。
      await closeClientAndTransport(ctx, name, client, transport);
      const outcome = await runInteractiveOAuthAuthorization(ctx, {
        config,
        generation,
        name,
        oauthConfig: authorizationCodeOAuthConfig,
        serverUrl: config.url,
        signal,
        trigger,
      });
      if (outcome.status === "authorized" || outcome.status === "already-authorized") {
        return await openServerConnection(ctx, {
          ...input,
          oauthAuthorizationAttempted: true,
        });
      }
      // client/transport 已在进入 Phase 2 前关闭，这里不再传入；failureKind 沿用
      // 诊断分类，让设置页把"授权没完成"与网络/进程类失败区分开。
      return failConnection(ctx, {
        config,
        connectDurationMs,
        error:
          outcome.status === "pending"
            ? new Error(
                `MCP server ${name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
              )
            : outcome.error,
        failureKind: "oauth_authorization_failed",
        generation,
        getRecentStderr,
        listToolsDurationMs,
        name,
        startedAt,
      });
    }
    // `protocol_negotiation_failed` 枚举与 UI 文案在 shared/i18n 里早已存在，但 adapter
    // 侧一直没有产出方——auto/pin 模式下 SDK 的 server/discover probe 硬失败（典型：飞书项目
    // MCP 对未知方法回 HTTP 200 + id:null 的非标 JSON-RPC error，body 过不了
    // JSONRPCMessageSchema）会一路落到默认 failureKind "network_unreachable"，设置页因此
    // 显示误导性的"网络不可达"。这里按结构化错误类型（SdkErrorCode / isInstance）识别 SDK
    // 协商失败并产出正确分类，不依赖错误文本；withTimeout 不包装错误（timeout.ts 只透传
    // reject），cause 链仅作防御性兜底。
    const negotiationFailureKind = isProtocolNegotiationFailure(error)
      ? ("protocol_negotiation_failed" as const)
      : undefined;
    return failConnection(ctx, {
      client,
      config,
      connectDurationMs,
      error,
      generation,
      getRecentStderr,
      listToolsDurationMs,
      name,
      startedAt,
      transport,
      failureKind: negotiationFailureKind ?? failureKind,
    });
  }
}

export async function failConnection(
  ctx: McpAdapterContext,
  input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  },
): Promise<McpServerStatus> {
  const {
    client,
    config,
    connectDurationMs,
    error,
    failureKind: fallbackFailureKind,
    generation,
    getRecentStderr,
    listToolsDurationMs,
    name,
    startedAt,
    transport,
  } = input;
  const message = error instanceof Error ? error.message : String(error);
  // 官方 MCP 鉴权失败的稳定分类必须落进日志：failConnection 原先只记
  // error.message，而多数分类并不出现在 message 文本里（只有 auth-port 那条带上了），
  // 导致 official_mcp_origin_untrusted / official_auth_rejected 等在生产日志里 grep 不到。
  const officialAuthKind =
    (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
    ctx.lastOfficialAuthKind.get(name);
  ctx.lastOfficialAuthKind.delete(name);
  const responseDiagnostic = ctx.connectionDiagnosticByServer.get(name);
  ctx.connectionDiagnosticByServer.delete(name);
  const failureKind =
    (officialAuthKind === "official_mcp_origin_untrusted"
      ? "official_origin_untrusted"
      : undefined) ??
    responseDiagnostic?.failureKind ??
    (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
      ? "connection_timeout"
      : undefined) ??
    fallbackFailureKind ??
    "connection_failed";
  const displayMessage = responseDiagnostic?.serverRequestId
    ? `${message} - ${responseDiagnostic.serverRequestId}`
    : message;
  const status = createStatus(config, "failed", {
    error: displayMessage,
    failureKind,
    ...(responseDiagnostic?.serverRequestId
      ? { serverRequestId: responseDiagnostic.serverRequestId }
      : {}),
  });
  const recentStderr = getRecentStderr?.();
  const mcpTransportPid = getStdioTransportPid(transport);
  await closeClientAndTransport(ctx, name, client, transport);
  if (!isCurrentConnection(ctx, name, generation)) {
    return ctx.records.get(name)?.status ?? status;
  }
  ctx.records.set(name, { config, status, tools: [] });
  ctx.logger?.warn("MCP server connection failed", {
    ...ctx.connectionContext,
    connectDurationMs,
    durationMs: Date.now() - startedAt,
    error: displayMessage,
    event: "mcp.server.failed",
    listToolsDurationMs,
    mcpServerName: name,
    ...(officialAuthKind ? { officialAuthKind } : {}),
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "failed",
    ...(recentStderr ? { stderr: recentStderr } : {}),
    transport: config.type,
  });
  return status;
}

export async function createTransport(
  ctx: McpAdapterContext,
  config: McpServerConfig,
  serverName: string,
  generation: number,
  _oauthAuthorizationTimeoutMs?: number,
  workingDirectory?: string,
  signal?: AbortSignal,
): Promise<{ transport: McpTransport }> {
  if (config.type === "stdio") {
    return {
      transport: new ProcessTreeStdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd
          ? resolve(workingDirectory ?? ctx.workingDirectory ?? process.cwd(), config.cwd)
          : (workingDirectory ?? ctx.workingDirectory),
        env: {
          ...buildMcpStdioEnv({ env: ctx.env, network: ctx.network }),
          ...config.env,
        },
        stderr: "pipe",
        ...(isOfficialAuthConfig(config) && config.official
          ? {
              requestMetaProvider: async () => {
                const authMeta = await resolveOfficialStdioAuthMeta(ctx, serverName, config, signal);
                return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
              },
            }
          : {}),
      }),
    };
  }

  const fetch = createMcpTransportFetch({
    env: ctx.env,
    network: ctx.network,
  });
  if (config.type === "http") {
    const officialAuthFetch = createOfficialAuthFetch(ctx, config, serverName, generation);
    return {
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        // 官方鉴权路径下 authProvider 必为 undefined：不落 OAuth 凭据、
        // 不起 localhost 回调 server、401/403 不转授权流程。
        authProvider: createOAuthClientProvider(ctx, serverName, config),
        fetch: officialAuthFetch ?? fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  return {
    transport: new SSEClientTransport(new URL(config.url), {
      authProvider: createOAuthClientProvider(ctx, serverName, config),
      fetch,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    }),
  };
}

export function attachStdioLogging(
  ctx: McpAdapterContext,
  name: string,
  transport: McpTransport,
): () => string | undefined {
  const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
  const stderr = (
    transport as {
      stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
    }
  ).stderr;
  stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBuffer.append(text);
    ctx.logger?.debug("MCP stdio stderr", {
      event: "mcp.stdio.stderr",
      mcpServerName: name,
      stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
    });
  });
  return () => {
    const text = stderrBuffer.read();
    if (!text) return undefined;
    // 生产日志里单独的 Connection closed 无法定位 stdio MCP 子进程退出原因。
    // 只在失败事件附带尾部 stderr，并先脱敏，避免把凭据或高频输出写入生产日志。
    return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
  };
}

export async function reconnectForCall(
  ctx: McpAdapterContext,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  ctx.logger?.warn("MCP server reconnecting after lost connection", {
    event: "mcp.server.reconnect.started",
    mcpServerName: name,
    status: "started",
    transport: config.type,
  });
  await connectServer(ctx, name, config);
}

/**
 * callTool / readResource 共用：等待共享 connecting 任务、对已断连 record 重连一次、
 * 返回处于 connected 的 record。抽出来是为了让资源读取与工具调用走完全相同的恢复路径。
 */
export async function resolveConnectedRecord(
  ctx: McpAdapterContext,
  serverName: string,
  deadline: McpDeadline,
  timeoutMessage: string,
  signal: AbortSignal | undefined,
): Promise<McpServerRecord & { client: McpClient }> {
  const pending = ctx.records.get(serverName)?.connecting;
  if (pending) {
    // 修复原因：connecting 是 adapter 持有的共享连接/OAuth 恢复任务。过去这里裸 await，
    // tool caller 的 timeout/abort 完全失效；但直接 abort 底层任务又会关闭其他 caller 共用的
    // callback listener。这里只限制当前 waiter，共享任务继续由 record 生命周期持有。
    await waitWithinMcpDeadline(pending, deadline, timeoutMessage, signal);
  }

  // Bugfix：stdio MCP 子进程死亡后（如 node_repl 被异步错误击穿），此前没有任何恢复路径：
  // 连接只在 session 创建时建立一次，session resume 也不重建，该会话的工具从此永远失败。
  // 这里在调用前对已断连的 record 重连一次；server 进程内状态（如 REPL 变量）不可恢复，
  // 但工具本身恢复可用。
  const disconnected = ctx.records.get(serverName);
  if (disconnected && disconnected.status.status === "disconnected") {
    await waitWithinMcpDeadline(
      reconnectForCall(ctx, serverName, disconnected.config),
      deadline,
      timeoutMessage,
      signal,
    );
  }

  const record = ctx.records.get(serverName);
  if (!record?.client || record.status.status !== "connected") {
    throw new Error(`MCP server is not connected: ${serverName}`);
  }
  return record as McpServerRecord & { client: McpClient };
}
