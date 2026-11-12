import { createConfig, resolvePath } from "@zcode/adapters/config";
import type { Logger, McpConnectionSnapshot, McpPort, McpServerConfig, McpServerStatus } from "@zcode/contracts";
import {
  zcodeMcpListParamsSchema,
  zcodeMcpListResultSchema,
  type ZCodeMcpListResult,
} from "@zcode/shared";
import {
  listMcpServerStatuses,
  omitMcpServers,
  resolveTrustedOfficialCuaServerNames,
} from "../mcp-config.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { getCliStorageRoot } from "../app/paths.js";
import {
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

export async function listMcpServers(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpListResult> {
  const params = parseParams(zcodeMcpListParamsSchema, rawParams);
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
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginOutcome.mcpServers,
  );
  // project-scope MCP 默认 untrusted：与 app 启动边界使用同一个 approval store 与
  // 同一套 digest 判定。store 缺失/损坏 → 零授权（fail closed），不中断 mcp/list。
  const untrustedProjectMcpServers = resolveUntrustedProjectMcpServers({
    configuredMcpServers,
    serverSources: configResult.sources.mcp?.serverSources ?? {},
    trust: {
      workspaceIdentity: resolveMcpTrustIdentity({
        workspaceIdentity: params.workspace.workspaceIdentity,
        workspacePath: workingDirectory,
      }),
      approvals: await readMcpProjectTrustRecords(
        resolvePath(configResult.config.storage.dir),
      ),
    },
  });
  const mcpPort = context.deps.mcpPort;
  if (mcpPort) {
    if (params.mode === "status") {
      // OAuth 轮询只需要读取当前运行态。传入 pending 子集会落到
      // connectConfiguredServers 的 replace 语义，导致未列出的 MCP 被断开。
      const statuses = await listMcpServerStatuses(
        mcpPort,
        configuredMcpServers,
        untrustedProjectMcpServers,
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
        configuredMcpServers,
        untrustedProjectMcpServers,
        trustedOfficialCuaServerNames,
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
          configuredMcpServers,
          untrustedProjectMcpServers,
        ),
      });
    }

    await connectPromise;
  }
  const statuses = await listMcpServerStatuses(
    mcpPort,
    configuredMcpServers,
    untrustedProjectMcpServers,
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
