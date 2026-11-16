/** Заимствование parent MCP-снапшота и preflight требований профиля child. */
import { createCoreError, CoreErrorType, traceContextToLogContext } from "../../deps.js";
import type {
  ExploreSubagentRuntimeRequest,
  McpConnectionSnapshot,
  McpPort,
} from "../../deps.js";
import type { AgentRuntimeInternal } from "../../internal.js";
import { toMcpToolName } from "../../../mcp/index.js";
import { createBorrowedSubagentMcpAccess } from "../../../subagent/borrowed-mcp-port.js";
import {
  extractRequiredMcpServerNames,
  matchesRequiredMcpServer,
} from "../../../subagent/mcp-config.js";

interface ResolvedSubagentMcpAccess {
  config: { enabled?: boolean } | undefined;
  port: McpPort | undefined;
  parentSnapshot: McpConnectionSnapshot | undefined;
  snapshot: McpConnectionSnapshot | undefined;
}

export async function resolveSubagentMcpAccess(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  officialCuaServerNames: ReadonlySet<string>,
): Promise<ResolvedSubagentMcpAccess> {
  if (!shouldBorrowParentMcp(request)) {
    return {
      config: undefined,
      parentSnapshot: undefined,
      port: undefined,
      snapshot: undefined,
    };
  }

  const scopedServerNames = resolveScopedMcpServerNames(request);
  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return {
      config: this.config.mcp?.enabled === false ? { enabled: false } : undefined,
      parentSnapshot: undefined,
      port: undefined,
      snapshot: undefined,
    };
  }

  // child не владеет жизненным циклом соединений, но снимок берём live: MCP,
  // подключённый через InstallCapability после старта сессии, должен быть виден
  // следующей дочерней задаче без reload. Startup promise остаётся barrier'ом
  // первичной инициализации; порты без currentSnapshot сохраняют прежний снимок.
  const parentStartupSnapshot = await this.mcpStartupPromise;
  if (!parentStartupSnapshot) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return {
      config: undefined,
      parentSnapshot: undefined,
      port: undefined,
      snapshot: undefined,
    };
  }
  let parentSnapshot = parentStartupSnapshot;
  if (this.mcpPort.currentSnapshot) {
    try {
      parentSnapshot = await this.mcpPort.currentSnapshot();
    } catch (error) {
      this.logger?.warn("MCP current snapshot failed during subagent spawn", {
        ...traceContextToLogContext(request.traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.subagent_snapshot.failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  }

  const unavailableScopedServerNames = (scopedServerNames ?? []).filter(
    (serverName) => parentSnapshot.statuses[serverName]?.status !== "connected",
  );
  if (unavailableScopedServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableScopedServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableScopedServerNames,
        },
        recoverable: true,
      },
    );
  }

  const borrowed = createBorrowedSubagentMcpAccess(
    this.mcpPort,
    parentSnapshot,
    scopedServerNames,
    officialCuaServerNames,
  );
  return {
    config: { enabled: true },
    parentSnapshot,
    port: borrowed.port,
    snapshot: borrowed.snapshot,
  };
}

function shouldBorrowParentMcp(request: ExploreSubagentRuntimeRequest): boolean {
  if (extractRequiredCapabilityMcpServers(request.requiredCapabilities).length > 0) return true;
  if ((request.profile.mcpServers?.length ?? 0) > 0) return true;
  if (request.allowedTools.length === 0 || request.allowedTools.includes("*")) return true;
  return request.allowedTools.some((toolName) => {
    const normalized = toolName.trim();
    return isConcreteMcpToolName(normalized) || isMcpServerSelector(normalized);
  });
}

function extractRequiredCapabilityMcpServers(
  requiredCapabilities: readonly string[] | undefined,
): string[] {
  const names = new Set<string>();
  for (const capability of requiredCapabilities ?? []) {
    const trimmed = capability.trim();
    if (!trimmed.startsWith("mcp:")) continue;
    const serverName = trimmed.slice("mcp:".length).trim();
    if (serverName.length > 0) names.add(serverName);
  }
  return [...names];
}

function resolveScopedMcpServerNames(
  request: ExploreSubagentRuntimeRequest,
): readonly string[] | undefined {
  const names = new Set<string>(request.profile.mcpServers ?? []);
  for (const serverName of extractRequiredCapabilityMcpServers(request.requiredCapabilities)) {
    names.add(serverName);
  }
  return names.size > 0 ? [...names] : undefined;
}

export function validateSubagentMcpRequirements(
  request: ExploreSubagentRuntimeRequest,
  effectiveAllowedTools: readonly string[],
  access: ResolvedSubagentMcpAccess,
): void {
  const requiredCapabilityServers = extractRequiredCapabilityMcpServers(
    request.requiredCapabilities,
  );
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools && requiredCapabilityServers.length === 0) return;

  const normalizedAllowedTools = effectiveAllowedTools.map((toolName) => toolName.trim());
  const requiredToolNames = normalizedAllowedTools.filter(isConcreteMcpToolName);
  const requiredServerNames = [
    ...new Set([
      ...extractRequiredMcpServerNames(normalizedAllowedTools.filter(isMcpServerSelector)),
      ...requiredCapabilityServers,
    ]),
  ];
  if (requiredToolNames.length === 0 && requiredServerNames.length === 0) return;
  if (!access.port || !access.snapshot) {
    throw createSubagentMcpUnavailableError(request, requiredToolNames);
  }
  const snapshot = access.snapshot;

  const unavailableServerNames = requiredServerNames.filter(
    (serverName) => !matchesRequiredMcpServer(serverName, snapshot.statuses),
  );
  if (unavailableServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableServerNames,
        },
        recoverable: true,
      },
    );
  }

  const visibleToolNames = new Set(snapshot.tools.map((descriptor) => toMcpToolName(descriptor)));
  const missingToolNames = requiredToolNames.filter((toolName) => !visibleToolNames.has(toolName));
  if (missingToolNames.length === 0) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `Required MCP tool is not available in the parent MCP snapshot: ${missingToolNames.join(", ")}`,
    {
      context: {
        agentType: request.agentType,
        missingMcpTools: missingToolNames,
      },
      recoverable: true,
    },
  );
}

export function isModelVisibleMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function isConcreteMcpToolName(toolName: string): boolean {
  return isModelVisibleMcpToolName(toolName) && !isMcpServerSelector(toolName);
}

function isMcpServerSelector(toolName: string): boolean {
  return toolName === "mcp" || (toolName.startsWith("mcp__") && toolName.endsWith("__*"));
}

function createSubagentMcpUnavailableError(
  request: ExploreSubagentRuntimeRequest,
  requiredToolNames: readonly string[] = [],
) {
  return createCoreError(
    CoreErrorType.ConfigurationError,
    "Subagent MCP is unavailable because the parent MCP snapshot is unavailable",
    {
      context: {
        agentType: request.agentType,
        requiredMcpTools: requiredToolNames,
      },
      recoverable: true,
    },
  );
}
