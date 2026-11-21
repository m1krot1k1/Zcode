import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { registerMcpTools, traceContextToLogContext } from "../deps.js";
import type { McpConnectionSnapshot, McpServerConfig, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { McpToolDescriptor, PluginReferenceCatalog } from "@zcode/contracts";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

const LAZY_MCP_INPUT_HINTS: Record<string, RegExp> = {
  "documents@zcode-plugins-official": /(?:\.docx\b|\bdocx?\b|\bword\b|документ|ворд|文档)/iu,
  "pdf@zcode-plugins-official": /(?:\.pdf\b|\bpdf\b|пдф)/iu,
  "presentations@zcode-plugins-official":
    /(?:\.pptx?\b|\bpptx?\b|\bpresentation\b|\bslides?\b|презентац|слайд|演示)/iu,
  "spreadsheets@zcode-plugins-official":
    /(?:\.xlsx?\b|\bxlsx?\b|\bxls\b|\bexcel\b|\bspreadsheet\b|таблиц|эксель|表格)/iu,
};

/**
 * Lazy plugin MCP activation is deliberately deterministic: a turn only pays for
 * a document server when the user's own words or file extension name that format.
 * A missed hint is safe (no process starts); the next turn can activate it.
 */
export function resolveLazyMcpServerNamesForInput(
  lazyServers: Record<string, McpServerConfig>,
  input: string,
): string[] {
  if (!input.trim()) return [];
  const names: string[] = [];
  for (const [name, config] of Object.entries(lazyServers)) {
    const pluginId =
      "env" in config ? config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() : undefined;
    const pattern = pluginId ? LAZY_MCP_INPUT_HINTS[pluginId] : undefined;
    if (pattern?.test(input)) names.push(name);
  }
  return names;
}

/**
 * 只有同时携带 resolver 注入的官方 plugin id 和本进程私有 authority 的 server 才能共享
 * Computer Use 项目授权。server 名、tool 名和 manifest env 都可被第三方仿造，不能单独作为信任依据。
 */
export function computeOfficialCuaServerNames(
  servers: Record<string, McpServerConfig>,
  trustedServerNames: ReadonlySet<string>,
): Set<string> {
  const expectedAuthority = getCapturedZCodeCuaBrokerCredentials().pluginAuthority;
  const names = new Set<string>();
  if (!expectedAuthority) return names;

  for (const [name, config] of Object.entries(servers)) {
    if (!trustedServerNames.has(name)) continue;
    if (config.type !== "stdio") continue;
    if (
      config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() !==
        ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
      config.env?.[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim() !== expectedAuthority
    ) {
      continue;
    }
    names.add(name);
  }
  return names;
}

export function startMcpStartup(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<McpConnectionSnapshot> | undefined {
  if (this.mcpInitialized) return this.mcpStartupPromise;
  this.mcpInitialized = true;

  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    this.mcpToolsRegistered = true;
    return undefined;
  }

  const servers = this.config.mcp?.servers ?? {};
  if (Object.keys(servers).length === 0) {
    const startup = Promise.all([this.mcpPort.status(), this.mcpPort.listTools()])
      .then(([statuses, tools]) => ({ statuses, tools }))
      .catch((error) => {
        this.logger?.warn("MCP existing tool discovery failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.existing_tools.failed",
          module: "core.runtime",
          status: "failed",
        });
        return { statuses: {}, tools: [] };
      });
    this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
    return this.mcpStartupPromise;
  }

  const startedAt = Date.now();
  const startup = this.mcpPort
    .connectConfiguredServers(servers, {
      // authorization_code MCP 无人完成浏览器授权时，session 启动过去会等默认 5 分钟，
      // 导致模型请求迟迟不发出；session 只等 15s，授权入口由设置页 mcp/list 展示。
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: traceContext,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    })
    .then((snapshot) => {
      const statusCounts = Object.values(snapshot.statuses).reduce<Record<string, number>>(
        (counts, status) => {
          counts[status.status] = (counts[status.status] ?? 0) + 1;
          return counts;
        },
        {},
      );
      this.logger?.info("MCP startup completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "mcp.startup.completed",
        module: "core.runtime",
        serverCount: Object.keys(servers).length,
        status: "completed",
        statusCounts,
        toolCount: snapshot.tools.length,
      });
      return snapshot;
    })
    .catch((error) => {
      this.logger?.warn("MCP startup failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.startup.failed",
        module: "core.runtime",
        status: "failed",
      });
      return { statuses: {}, tools: [] };
    });
  this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
  this.logger?.debug("MCP startup scheduled", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.startup.scheduled",
    module: "core.runtime",
    serverCount: Object.keys(servers).length,
    status: "started",
  });
  return this.mcpStartupPromise;
}

function registerRuntimeMcpTools(
  this: AgentRuntimeInternal,
  tools: readonly McpToolDescriptor[],
): string[] {
  const mcpPort = this.mcpPort;
  if (!mcpPort) return [];
  const previous = this.registeredMcpToolNames ?? [];
  for (const name of previous) this.registry.unregister(name);
  const registered = registerMcpTools(this.registry, mcpPort, tools, {
    allowedTools: this.config.toolAllowlist,
    disallowedTools: this.config.toolDisallowlist,
    officialCuaServerNames: computeOfficialCuaServerNames(
      this.config.mcp?.servers ?? {},
      new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
    ),
    // 插件 UI：display.ui 需要 server → pluginId 的归属；catalog 是 session 冻结的唯一权威。
    pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
  });
  this.registeredMcpToolNames = registered;
  this.mcpToolsSignature = mcpToolsSignature(tools);
  this.mcpToolListRevision = mcpPort.toolListRevision?.();
  this.invalidateToolCache();
  return registered;
}

/**
 * Connect lazy plugin servers selected by the current turn, then re-register the
 * full live tool set. Successful servers move from `lazyServers` to `servers`, so
 * later turns and children see them as normal connected capabilities.
 */
export async function activateLazyMcpServers(
  this: AgentRuntimeInternal,
  names: readonly string[],
  traceContext: TraceContext,
): Promise<{ activated: string[]; failed: Array<{ name: string; error: string }> }> {
  const mcpPort = this.mcpPort;
  const lazyServers = this.config.mcp?.lazyServers ?? {};
  const unique = [...new Set(names)].filter(
    (name) => lazyServers[name] !== undefined && this.config.mcp?.servers?.[name] === undefined,
  );
  if (!mcpPort || unique.length === 0) return { activated: [], failed: [] };

  // Eager startup may still be in flight; activation must not race registration.
  if (this.mcpStartupPromise) await this.mcpStartupPromise.catch(() => undefined);

  const startedAt = Date.now();
  const activated: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const name of unique) {
    const config = lazyServers[name];
    if (!config) continue;
    try {
      const status = await mcpPort.connectServer(name, config, {
        oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
        trace: traceContext,
        workingDirectory: this.workingDirectory,
        ...(this.config.workspaceIdentity
          ? { workspaceIdentity: this.config.workspaceIdentity.toString() }
          : {}),
      });
      if (status.status === "connected") activated.push(name);
      else failed.push({ name, error: status.error ?? `status=${status.status}` });
    } catch (error) {
      failed.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (activated.length > 0) {
    const servers = { ...this.config.mcp?.servers };
    const nextLazy = { ...lazyServers };
    for (const name of activated) {
      servers[name] = nextLazy[name]!;
      delete nextLazy[name];
    }
    this.config.mcp = { ...this.config.mcp, servers, lazyServers: nextLazy };
    try {
      const tools = await mcpPort.listTools();
      const registered = registerRuntimeMcpTools.call(this, tools);
      this.logger?.info("Lazy MCP servers activated", {
        ...traceContextToLogContext(traceContext),
        activatedCount: activated.length,
        durationMs: Date.now() - startedAt,
        event: "mcp.lazy.activated",
        module: "core.runtime",
        registeredToolCount: registered.length,
        status: "completed",
      });
    } catch (error) {
      // The connection is real even if listTools failed; keep the server connected
      // and let the next turn's refresh retry registration.
      this.logger?.warn("Lazy MCP tool registration failed after activation", {
        ...traceContextToLogContext(traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.lazy.registration.failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
  if (failed.length > 0) {
    this.logger?.warn("Lazy MCP activation failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "mcp.lazy.failed",
      failedCount: failed.length,
      module: "core.runtime",
      status: "failed",
    });
  }
  return { activated, failed };
}

export async function activateLazyMcpServersForInput(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  const lazyServers = this.config.mcp?.lazyServers;
  if (!lazyServers || Object.keys(lazyServers).length === 0) return;
  const names = resolveLazyMcpServerNamesForInput(lazyServers, input);
  if (names.length === 0) return;
  await this.activateLazyMcpServers(names, traceContext);
}

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) return;

  const startup = this.startMcpStartup(traceContext);
  const mcpPort = this.mcpPort;
  if (!startup || !mcpPort) {
    this.mcpToolsRegistered = true;
    return;
  }
  const serverCount = Object.keys(this.config.mcp?.servers ?? {}).length;

  try {
    const snapshot = await startup;
    // Keep the eager startup snapshot even when a mock/static port cannot enumerate
    // again; merge live tools so a lazy server activated before this point survives.
    const liveTools = await mcpPort.listTools().catch(() => []);
    const tools = mergeMcpToolDescriptors(snapshot.tools, liveTools);
    const registered = registerRuntimeMcpTools.call(this, tools);
    this.logger?.info("MCP tools registered", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.tools.registered",
      module: "core.runtime",
      registeredToolCount: registered.length,
      serverCount,
      status: "completed",
    });
  } catch (error) {
    this.mcpToolsRegistered = true;
    this.logger?.warn("MCP initialization failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.initialization.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  this.mcpToolsRegistered = true;
}

/**
 * server 名 → 插件稳定 id。catalog 里 disabled 插件的 mcpServerNames 为空，天然不参与；
 * 同名冲突插件的 server 名互不相同（带插件名前缀），不需要额外去重。
 */
function buildPluginIdByServerName(
  catalog: PluginReferenceCatalog | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const plugin of catalog?.plugins ?? []) {
    for (const serverName of plugin.mcpServerNames) map.set(serverName, plugin.pluginId);
  }
  return map;
}

function mergeMcpToolDescriptors(
  base: readonly McpToolDescriptor[],
  extra: readonly McpToolDescriptor[],
): McpToolDescriptor[] {
  const byIdentity = new Map<string, McpToolDescriptor>();
  for (const tool of [...base, ...extra]) {
    byIdentity.set(`${tool.serverName}\u0000${tool.toolName}`, tool);
  }
  return [...byIdentity.values()];
}

function mcpToolsSignature(descriptors: readonly McpToolDescriptor[]): string {
  return descriptors
    .map((tool) => `${tool.serverName}\u0001${tool.toolName}\u0001${tool.description ?? ""}`)
    .sort()
    .join("\n");
}

/**
 * 回合开始前刷新 MCP 工具表。只有端口报告 tools/list_changed 计数变化时才重新 listTools
 * （adapter 对收到通知的 server 重拉），再比较工具签名，变了就注销旧的、注册新的并失效工具缓存。
 * 不实现 toolListRevision 的端口（mock / 静态 server）永远不刷新；回合内也不刷新（已拍板）。
 */
export async function refreshMcpToolsIfChanged(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const mcpPort = this.mcpPort;
  if (!mcpPort || !this.mcpToolsRegistered) return;
  const revision = mcpPort.toolListRevision?.();
  if (revision === undefined || revision === this.mcpToolListRevision) return;
  let descriptors: McpToolDescriptor[];
  try {
    descriptors = await mcpPort.listTools();
  } catch {
    return;
  }
  this.mcpToolListRevision = revision;
  const signature = mcpToolsSignature(descriptors);
  if (this.mcpToolsSignature === signature) return;
  const previous = new Set(this.registeredMcpToolNames ?? []);
  const registered = registerRuntimeMcpTools.call(this, descriptors);
  this.logger?.info("MCP tools re-registered after list_changed", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.tools.reregistered",
    module: "core.runtime",
    removedToolCount: previous.size,
    registeredToolCount: registered.length,
    status: "completed",
  });
}
