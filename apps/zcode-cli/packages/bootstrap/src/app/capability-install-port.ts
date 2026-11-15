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
import type { ConfigResult } from "@zcode/adapters/config";
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
        const configPath = options.configResult.sources?.user?.path;
        if (configPath) {
          await persistMcpServerConfig(
            configPath,
            request.id,
            request.config as unknown as McpServerConfig,
          );
        }
        await options.mcpPort.connectServer(
          request.id,
          request.config as unknown as McpServerConfig,
        );
        installed.add(key("mcp", request.id));
        return {
          kind: "mcp",
          id: request.id,
          status: "installed",
          requiresReload: true,
          evidence: `MCP server '${request.id}' connected`,
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
      return {
        kind: "plugin",
        id: match.id,
        status: "installed",
        requiresReload: true,
        evidence: `Plugin '${match.id}' installed`,
      };
    },
  };
}
