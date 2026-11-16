import type {
  CapabilityInstallPort,
  CapabilityInstallRequest,
  CapabilityInstallResult,
  Logger,
  McpPort,
  McpServerConfig,
} from "@zcode/contracts";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseMcpServerConfig, type ConfigResult } from "@zcode/adapters/config";
import { installZCodeMarketplacePlugin, resolveZCodePlugins } from "../plugins.js";


/**
 * Bootstrap не зависит от @zcode/services, поэтому повторяет узкую форму записи
 * addMcpServerToZcodeConfig: mcp.servers, private file. Один write-path для install.
 */
async function persistMcpServerConfig(
  filePath: string,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
  const currentMcp =
    parsed.mcp && typeof parsed.mcp === "object" && !Array.isArray(parsed.mcp)
      ? (parsed.mcp as Record<string, unknown>)
      : {};
  const servers =
    currentMcp.servers &&
    typeof currentMcp.servers === "object" &&
    !Array.isArray(currentMcp.servers)
      ? (currentMcp.servers as Record<string, unknown>)
      : {};
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      { ...parsed, mcp: { ...currentMcp, servers: { ...servers, [name]: config } } },
      null,
      2,
    )}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
  await chmod(filePath, 0o600).catch(() => undefined);
}

export interface CapabilityInstallPortOptions {
  configResult: ConfigResult;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  mcpPort?: McpPort;
  officialPluginRoots?: string[];
  /** Live plugin data-plane refresh в текущем runtime. */
  onPluginInstalled?: () => Promise<{
    connected: string[];
    disconnected: string[];
    failed: Array<{ name: string; error: string }>;
  }>;
  pluginStorageRoot: string;
  workingDirectory: string;
}

/**
 * Host-side installer for MCP servers and plugins. The agent-facing tool is
 * alwaysAsk; this port only performs the approved operation and reports evidence.
 */
export function createCapabilityInstallPort(
  options: CapabilityInstallPortOptions,
): CapabilityInstallPort {
  const installed = new Set<string>();
  const key = (kind: string, id: string) => `${kind}:${id}`;
  const pluginOptions = () => ({
    configResult: options.configResult,
    env: options.env,
    logger: options.logger,
    officialPluginRoots: options.officialPluginRoots,
    pluginStorageRoot: options.pluginStorageRoot,
    workingDirectory: options.workingDirectory,
  });

  return {
    async isInstalled(kind, id) {
      if (installed.has(key(kind, id))) return true;
      if (kind === "mcp") {
        if (!options.mcpPort) return false;
        const statuses = await options.mcpPort.status();
        return statuses[id]?.status === "connected";
      }
      const outcome = resolveZCodePlugins(pluginOptions());
      return outcome.plugins.some((plugin) => plugin.id === id && plugin.enabled);
    },

    async install(request: CapabilityInstallRequest): Promise<CapabilityInstallResult> {
      if (installed.has(key(request.kind, request.id))) {
        return { kind: request.kind, id: request.id, status: "already_installed" };
      }
      if (request.kind === "mcp") {
        if (!options.mcpPort) throw new Error("MCP port is unavailable in this runtime");
        if (!request.config) throw new Error("MCP install requires a server config");
        const config = parseMcpServerConfig(request.config);
        const status = await options.mcpPort.connectServer(request.id, config);
        if (status.status !== "connected") {
          throw new Error(
            `MCP server '${request.id}' did not connect (status=${status.status})${
              status.error ? `: ${status.error}` : ""
            }`,
          );
        }
        const configPath = options.configResult.sources?.user?.path;
        if (configPath) {
          try {
            await persistMcpServerConfig(configPath, request.id, config);
          } catch (error) {
            // Durable install is part of success: без записи следующий старт потеряет
            // уже подключённый сервер, поэтому не оставляем частично установленное состояние.
            await options.mcpPort.disconnectServer(request.id).catch(() => undefined);
            throw error;
          }
        }
        installed.add(key("mcp", request.id));
        return {
          kind: "mcp",
          id: request.id,
          status: "installed",
          // Новый сервер сразу попадает в live-снимок, который получает следующий
          // child/Task; полный reload приложения не нужен. Текущий turn модели
          // увидит инструменты со следующего turn boundary.
          requiresReload: false,
          evidence: `MCP server '${request.id}' connected; its tools are available to the next Task`,
        };
      }

      const marketplace = request.marketplace?.trim() ||
        (request.id.includes("@") ? request.id.split("@")[1] : "");
      const pluginName = request.pluginName?.trim() ||
        (request.id.includes("@") ? request.id.split("@")[0] : request.id);
      if (!marketplace) {
        throw new Error("Plugin install requires marketplace or id in '<name>@<marketplace>' form");
      }
      const result = await installZCodeMarketplacePlugin({
        ...pluginOptions(),
        marketplace,
        pluginName,
        ...(request.scope ? { scope: request.scope } : {}),
      });
      const match = result.installedPlugins.find(
        (plugin) =>
          plugin.id === request.id ||
          (plugin.name === pluginName && plugin.marketplace === marketplace),
      );
      if (!match) {
        throw new Error(
          `Plugin install did not produce an installed plugin: ${
            result.diagnostics.map((diagnostic) => diagnostic.message).join("; ") ||
            "no diagnostics"
          }`,
        );
      }
      installed.add(key("plugin", match.id));
      if (!options.onPluginInstalled) {
        return {
          kind: "plugin",
          id: match.id,
          status: "installed",
          requiresReload: true,
          evidence: `Plugin '${match.id}' installed; runtime activation is unavailable, reload required`,
        };
      }
      let activation:
        | {
            connected: string[];
            disconnected: string[];
            failed: Array<{ name: string; error: string }>;
          }
        | undefined;
      let activationError: string | undefined;
      if (options.onPluginInstalled) {
        try {
          activation = await options.onPluginInstalled();
        } catch (error) {
          activationError = error instanceof Error ? error.message : String(error);
        }
      }
      const failed = activation?.failed ?? [];
      if (activationError) {
        return {
          kind: "plugin",
          id: match.id,
          status: "installed",
          requiresReload: true,
          evidence: `Plugin '${match.id}' installed, but live activation failed: ${activationError}`,
        };
      }
      if (failed.length > 0) {
        return {
          kind: "plugin",
          id: match.id,
          status: "installed",
          requiresReload: true,
          evidence: `Plugin '${match.id}' installed; live activation failed for ${failed
            .map((entry) => `${entry.name}: ${entry.error}`)
            .join("; ")}`,
        };
      }
      const activatedMcp = activation?.connected.length
        ? `connected MCP: ${activation.connected.join(", ")}; `
        : "";
      return {
        kind: "plugin",
        id: match.id,
        status: "installed",
        // Data-plane (MCP/skills/agents) уже в живом runtime. Hooks/commands/UI
        // по-прежнему применяются в следующей сессии, но для agent-работы reload не нужен.
        requiresReload: false,
        evidence: `Plugin '${match.id}' installed; ${activatedMcp}skills and agent profiles are active without reload`,
      };
    },
  };
}
