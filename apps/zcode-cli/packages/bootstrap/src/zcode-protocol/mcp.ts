import { createConfig, resolvePath } from "@zcode/adapters/config";
import type { Logger, McpConnectionSnapshot, McpPort, McpServerConfig, McpServerStatus } from "@zcode/contracts";
import {
  zcodeMcpConnectParamsSchema,
  zcodeMcpConnectResultSchema,
  zcodeMcpListParamsSchema,
  zcodeMcpListResultSchema,
  type ZCodeMcpConnectResult,
  type ZCodeMcpListResult,
  type ZCodeProtocolMcpServer,
} from "@zcode/shared";
import {
  listMcpServerStatuses,
  omitMcpServers,
  resolveTrustedOfficialCuaServerNames,
} from "../mcp-config.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { getCliStorageRoot } from "../app/paths.js";
import {
  grantProjectMcpServerApproval,
  readMcpProjectTrustRecords,
  resolveMcpTrustIdentity,
  resolveUntrustedProjectMcpServers,
} from "../app/runtime-config.js";
import { resolveStartupPlugins } from "../app/startup-marks.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS = 5_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS = 100;

interface ProtocolMcpProjectionParams {
  workspace: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string | undefined;
  };
  mcpServers?: ZCodeProtocolMcpServer[] | undefined;
}

interface ProtocolMcpProjection {
  configuredMcpServers: Record<string, McpServerConfig>;
  storageRoot: string;
  trustIdentity: string;
  trustedOfficialCuaServerNames: Set<string>;
  untrustedProjectMcpServers: Set<string>;
}

/**
 * `mcp/list` 与 `mcp/connect` 共享同一份配置/信任投影。
 *
 * 两条路径必须看到同一个 `configuredMcpServers` 快照：connect 批准的 digest 和随后
 * 传给 `mcpPort.connectServer` 的 config 必须是同一个对象，避免 UI 下发与本地文件之间
 * 的 TOCTOU；也让设置页显示的状态与实际连接定义一致。
 */
async function resolveProtocolMcpProjection(
  context: ZCodeProtocolAgentServerContext,
  params: ProtocolMcpProjectionParams,
): Promise<ProtocolMcpProjection> {
  const workingDirectory = params.workspace.workspacePath;
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory,
  });
  const cliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
  const startupTimer = new StartupTimer(
    context.logger ?? noopLogger,
    {
      module: "bootstrap.zcode_protocol.mcp",
      workspaceKey: params.workspace.workspaceKey,
      workspacePath: params.workspace.workspacePath,
    },
    startupNow(),
  );
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: context.deps.env,
    logger: context.logger,
    options: {},
    startupTimer,
    workingDirectory,
  });
  const explicitMcpServersProvided = params.mcpServers !== undefined;
  const explicitRuntimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  const configuredMcpServers = {
    ...pluginOutcome.mcpServers,
    // 设置页的本地 MCP 列表由 desktop main 解析 `.zcode` / `.agents` fallback，
    // session runtime 也使用这批 params.mcpServers。mcp/list 不能再只靠 agent createConfig，
    // 否则 `.agents` fallback 行会缺少 status snapshot 并被 UI 误标红。
    ...(explicitMcpServersProvided
      ? (explicitRuntimeMcp?.servers ?? {})
      : configResult.config.mcp.servers),
  };
  const serverSources = configResult.sources.mcp?.serverSources ?? {};
  // project-scope 的授权与执行定义必须以 Agent 本地配置文件为唯一事实源：
  // wire 上的 mcpServers 可以来自 renderer，不能凭它批准/启动一条项目里并不存在的命令。
  // 这同时让 CLI `/mcp connect` 与 Desktop `mcp/connect` 使用同一个 digest 输入
  //（`resolveAppRuntimeConfig` 也使用 configResult.config.mcp.servers）。
  for (const [name, projectConfig] of Object.entries(configResult.config.mcp.servers)) {
    if (serverSources[name] === "project") configuredMcpServers[name] = projectConfig;
  }
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginOutcome.mcpServers,
  );
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const trustIdentity = resolveMcpTrustIdentity({
    workspaceIdentity: params.workspace.workspaceIdentity,
    workspacePath: workingDirectory,
  });
  // project-scope MCP 默认 untrusted：与 app 启动边界使用同一个 approval store 与
  // 同一套 digest 判定。store 缺失/损坏 → 零授权（fail closed），不中断 mcp/list。
  const untrustedProjectMcpServers = resolveUntrustedProjectMcpServers({
    configuredMcpServers,
    serverSources,
    trust: {
      workspaceIdentity: trustIdentity,
      approvals: await readMcpProjectTrustRecords(storageRoot),
    },
  });
  return {
    configuredMcpServers,
    storageRoot,
    trustIdentity,
    trustedOfficialCuaServerNames,
    untrustedProjectMcpServers,
  };
}

/**
 * 桌面端显式连接入口（`mcp/connect`）。
 *
 * 与 CLI `/mcp connect` 使用同一个 approval 写入路径（`grantProjectMcpServerApproval`
 * → digest 绑定）。没有 `approveProjectScope: true` 时不写 approval、不连接，只返回
 * `requiresApproval` 投影，保持 project-scope 默认拒绝。
 */
export async function connectMcpServer(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpConnectResult> {
  const params = parseParams(zcodeMcpConnectParamsSchema, rawParams);
  const projection = await resolveProtocolMcpProjection(context, params);
  const serverName = params.serverName;
  const config = projection.configuredMcpServers[serverName];
  if (!config) {
    throw new Error(`MCP server is not configured: ${serverName}`);
  }
  const mcpPort = context.deps.mcpPort;
  if (!mcpPort) {
    throw new Error("MCP is disabled");
  }

  const requiresApproval = projection.untrustedProjectMcpServers.has(serverName);
  if (requiresApproval && !params.approveProjectScope) {
    // 显式同意缺失：只投影 untrusted 状态给 UI 打开确认框，绝不隐式授权。
    const status = await projectUntrustedStatus(serverName, config);
    return zcodeMcpConnectResultSchema.parse({
      approval: "not_requested",
      connected: false,
      requiresApproval: true,
      status,
    });
  }

  const approval: ZCodeMcpConnectResult["approval"] = requiresApproval
    ? "granted"
    : "not_required";
  if (requiresApproval) {
    try {
      await grantProjectMcpServerApproval({
        config,
        serverName,
        storageRoot: projection.storageRoot,
        workspaceIdentity: projection.trustIdentity,
      });
    } catch (error) {
      // 失败即不连接（fail closed）；日志只带 serverName/workspaceKey 与 errno 码，
      // 不转写底层 message，避免把 approval 文件路径或定义内容带进协议/日志。
      context.logger?.warn("Project MCP server approval could not be recorded", {
        errorCode: readErrorCode(error),
        event: "mcp.project.approval.failed",
        module: "bootstrap.zcode_protocol.mcp",
        serverName,
        workspaceKey: params.workspace.workspaceKey,
      });
      throw new Error(`Project MCP server approval could not be recorded: ${serverName}`);
    }
    projection.untrustedProjectMcpServers.delete(serverName);
  }

  let status: McpServerStatus;
  try {
    status = await mcpPort.connectServer(serverName, config, {
      workingDirectory: params.workspace.workspacePath,
    });
  } catch (error) {
    // 连接失败的底层 message 可能包含 spawn 命令行等定义片段；协议只返回状态投影，
    // 由 UI 按 failureKind 呈现稳定文案。
    context.logger?.warn("MCP server connection failed", {
      errorCode: readErrorCode(error),
      event: "mcp.connect.failed",
      module: "bootstrap.zcode_protocol.mcp",
      serverName,
      workspaceKey: params.workspace.workspaceKey,
    });
    status = await projectConnectFailureStatus(mcpPort, serverName, config);
  }

  return zcodeMcpConnectResultSchema.parse({
    approval,
    connected: status.status === "connected",
    requiresApproval: false,
    status,
  });
}

async function projectUntrustedStatus(
  serverName: string,
  config: McpServerConfig,
): Promise<McpServerStatus> {
  const statuses = await listMcpServerStatuses(
    undefined,
    { [serverName]: config },
    new Set([serverName]),
  );
  return (
    statuses[serverName] ?? {
      status: "untrusted",
      transport: config.type,
      toolCount: 0,
      updatedAt: new Date().toISOString(),
      error: "Project MCP server requires explicit connection before use.",
      failureKind: "status_unavailable",
    }
  );
}

async function projectConnectFailureStatus(
  mcpPort: McpPort,
  serverName: string,
  config: McpServerConfig,
): Promise<McpServerStatus> {
  const status = (await listMcpServerStatuses(mcpPort, { [serverName]: config }))[serverName];
  if (status && status.status !== "disconnected") return status;
  return {
    status: "failed",
    transport: config.type,
    toolCount: 0,
    updatedAt: new Date().toISOString(),
    failureKind: "connection_failed",
  };
}

function readErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

export async function listMcpServers(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpListResult> {
  const params = parseParams(zcodeMcpListParamsSchema, rawParams);
  const projection = await resolveProtocolMcpProjection(context, params);
  const workingDirectory = params.workspace.workspacePath;
  const mcpPort = context.deps.mcpPort;
  if (mcpPort) {
    if (params.mode === "status") {
      // OAuth 轮询只需要读取当前运行态。传入 pending 子集会落到
      // connectConfiguredServers 的 replace 语义，导致未列出的 MCP 被断开。
      const statuses = await listMcpServerStatuses(
        mcpPort,
        projection.configuredMcpServers,
        projection.untrustedProjectMcpServers,
      );
      return zcodeMcpListResultSchema.parse({ statuses });
    }

    // OAuth 轮询已由 mode=status 隔离；默认/connect 必须继续执行 replace 收敛，
    // 否则任一 server 待授权时，配置新增/删除和 stale MCP 清理都会被跳过。
    // 默认/connect 模式服务的是设置页刷新这类"重新探测"诉求，而 mcpPort 是进程级
    // `protocol-settings` lease；不带 revalidate 时连接池会直接复用旧 entry 并返回陈旧快照，
    // 停掉的 HTTP MCP 会永远显示已连接（见 adapters/src/mcp/pool.ts revalidateEntry）。
    const connectPromise = mcpPort.connectConfiguredServers(
      omitMcpServers(
        projection.configuredMcpServers,
        projection.untrustedProjectMcpServers,
        projection.trustedOfficialCuaServerNames,
      ),
      {
        revalidate: true,
        workingDirectory,
      },
    );
    const pendingAuthorizationSnapshot = await waitForOAuthAuthorizationSnapshot(
      mcpPort,
      connectPromise,
    );
    if (pendingAuthorizationSnapshot) {
      void connectPromise.catch((error) => {
        context.logger?.warn("MCP background authorization connection failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.authorization.background.failed",
          workspaceKey: params.workspace.workspaceKey,
          workspacePath: params.workspace.workspacePath,
        });
      });
      return zcodeMcpListResultSchema.parse({
        statuses: await withUntrustedProjectStatuses(
          pendingAuthorizationSnapshot.statuses,
          projection.configuredMcpServers,
          projection.untrustedProjectMcpServers,
        ),
      });
    }

    await connectPromise;
  }
  const statuses = await listMcpServerStatuses(
    mcpPort,
    projection.configuredMcpServers,
    projection.untrustedProjectMcpServers,
  );
  return zcodeMcpListResultSchema.parse({ statuses });
}

/**
 * OAuth pending 早退时 `mcpPort.status()` 只包含已建立连接的 server；未授权的
 * project-scope server 必须继续投影为 untrusted，不能被从这个快照里静默丢掉。
 */
async function withUntrustedProjectStatuses(
  statuses: Record<string, McpServerStatus>,
  configuredMcpServers: Record<string, McpServerConfig>,
  untrustedProjectMcpServers: ReadonlySet<string>,
): Promise<Record<string, McpServerStatus>> {
  if (untrustedProjectMcpServers.size === 0) return statuses;
  const missing: Record<string, McpServerConfig> = {};
  for (const name of untrustedProjectMcpServers) {
    const config = configuredMcpServers[name];
    if (config && statuses[name] === undefined) missing[name] = config;
  }
  if (Object.keys(missing).length === 0) return statuses;
  const projected = await listMcpServerStatuses(
    undefined,
    missing,
    new Set(Object.keys(missing)),
  );
  return { ...statuses, ...projected };
}

async function waitForOAuthAuthorizationSnapshot(
  mcpPort: McpPort,
  connectPromise: Promise<McpConnectionSnapshot>,
): Promise<McpConnectionSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS) {
    const race = await Promise.race([
      connectPromise.then(
        (snapshot) => ({ kind: "completed" as const, snapshot }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      delay(MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS).then(() => ({ kind: "poll" as const })),
    ]);

    if (race.kind === "completed") {
      return undefined;
    }
    if (race.kind === "failed") {
      throw race.error;
    }

    const statuses = await mcpPort.status();
    if (hasPendingOAuthAuthorization(statuses)) {
      return {
        statuses,
        tools: await mcpPort.listTools(),
      };
    }
  }

  return undefined;
}

function hasPendingOAuthAuthorization(statuses: Record<string, McpServerStatus>): boolean {
  return Object.values(statuses).some((status) => Boolean(status.authorization?.authorizationUrl));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
