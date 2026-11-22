import type { McpScope, McpServerConfig, SettingsDirectoryLocation } from "@zcode/shared";
import { ENABLED_KEY, LEGACY_ENABLE_KEY, ZCODE_MCP_DESCRIPTOR } from "./descriptors.js";
import { readJsonObject, writeTextAtomic } from "./fileAccess.js";
import { buildDirectoryConfigPath, getUserZcodeMcpConfigPath } from "./paths.js";
import type { DirectoryMcpDescriptor, McpConfigKeyName } from "./types.js";
import { formatErrorMessage, isRecord } from "./utils.js";

export function readServerEnabled(config: Record<string, unknown>): boolean {
  return config[ENABLED_KEY] !== false;
}

export function setServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  // 启用是默认态，不落盘冗余字段；同时清掉可能残留的 legacy enable，
  // 避免再产出 enable:false + enabled:true 这类自相矛盾的配置。
  const { [LEGACY_ENABLE_KEY]: _legacyEnable, [ENABLED_KEY]: _enabled, ...rest } = config;
  if (enabled) {
    return rest;
  }
  return { ...rest, [ENABLED_KEY]: false };
}

export function migrateLegacyEnableFlag(serverMap: Record<string, Record<string, unknown>>): {
  servers: Record<string, Record<string, unknown>>;
  changed: boolean;
} {
  let changed = false;
  const migrated: Record<string, Record<string, unknown>> = {};

  for (const [name, config] of Object.entries(serverMap)) {
    if (!isRecord(config) || !(LEGACY_ENABLE_KEY in config)) {
      migrated[name] = config;
      continue;
    }
    changed = true;
    // 两个字段冲突时以「停用」为准：桌面端写 enable:false 时不会清理外部导入残留的
    // enabled:true，若按 enabled 取值会把用户关掉的 server 重新拉起。
    const disabled = config[LEGACY_ENABLE_KEY] === false || config[ENABLED_KEY] === false;
    migrated[name] = setServerEnabled(config as McpServerConfig, !disabled) as Record<
      string,
      unknown
    >;
  }

  return { servers: migrated, changed };
}

/**
 * 读取 server map，顺带把存量 enable 就地折叠成 enabled 并落盘。
 * 没有残留字段时不写文件，保证幂等；写盘失败不阻断读取，内存结果已是正确口径，下次加载会重试。
 */
export async function readServerMapWithLegacyMigration(
  filePath: string,
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Promise<Record<string, Record<string, unknown>>> {
  const migration = migrateLegacyEnableFlag(readServerMapFromJson(parsed, configKeyName));
  if (!migration.changed) {
    return migration.servers;
  }

  try {
    const next = writeServerMapToJson(parsed, configKeyName, migration.servers);
    await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    console.warn("[mcp-sync] legacy enable migration failed:", filePath, formatErrorMessage(error));
  }
  return migration.servers;
}

export function readServerMapFromJson(
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Record<string, Record<string, unknown>> {
  if (configKeyName === "mcp.servers") {
    const mcp = parsed.mcp;
    if (!isRecord(mcp)) {
      return {};
    }
    const servers = mcp.servers;
    return isRecord(servers) ? (servers as Record<string, Record<string, unknown>>) : {};
  }

  const rawServerMap = parsed[configKeyName];
  return isRecord(rawServerMap) ? (rawServerMap as Record<string, Record<string, unknown>>) : {};
}

export function writeServerMapToJson(
  current: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
  servers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (configKeyName !== "mcp.servers") {
    return {
      ...current,
      [configKeyName]: servers,
    };
  }

  const currentMcp = isRecord(current.mcp) ? current.mcp : {};
  return {
    ...current,
    mcp: {
      ...currentMcp,
      servers,
    },
  };
}

async function readUserCliConfig(): Promise<Record<string, unknown>> {
  return (await readJsonObject(getUserZcodeMcpConfigPath())) ?? {};
}

async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  await writeTextAtomic(getUserZcodeMcpConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function removeLegacyMcpEnabledOverride(
  config: Record<string, unknown>,
  location: SettingsDirectoryLocation,
  name: string,
): { config: Record<string, unknown>; changed: boolean } {
  if (!isRecord(config.mcp) || !isRecord(config.mcp[location.directoryPath])) {
    return { config, changed: false };
  }

  const mcpConfig = { ...config.mcp };
  const pathConfig = {
    ...(mcpConfig[location.directoryPath] as Record<string, unknown>),
  };
  if (!(name in pathConfig)) {
    return { config, changed: false };
  }

  delete pathConfig[name];
  if (Object.keys(pathConfig).length > 0) {
    mcpConfig[location.directoryPath] = pathConfig;
  } else {
    delete mcpConfig[location.directoryPath];
  }

  return {
    config: {
      ...config,
      mcp: mcpConfig,
    },
    changed: true,
  };
}

export async function cleanupLegacyMcpEnabledOverride(
  location: SettingsDirectoryLocation,
  name: string,
): Promise<void> {
  const userConfig = await readUserCliConfig();
  const result = removeLegacyMcpEnabledOverride(userConfig, location, name);
  if (result.changed) {
    await writeUserCliConfig(result.config);
  }
}

export async function writeServerEnabledToFile(
  descriptor: DirectoryMcpDescriptor,
  location: SettingsDirectoryLocation,
  name: string,
  enabled: boolean,
): Promise<void> {
  const scope: Exclude<McpScope, "common"> = location.scope === "project" ? "workspace" : "user";
  const workspacePath = scope === "workspace" ? location.projectPath : undefined;
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const serverMap = readServerMapFromJson(current, descriptor.configKeyName);
  const currentServer = serverMap[name];
  if (!isRecord(currentServer)) {
    return;
  }
  // MCP 自身已有 mcp.servers/mcpServers 结构；禁用状态写在 server 配置对象内，
  // 避免把目录路径写到 mcp 顶层后和真实 MCP 配置混在一起。
  const nextServerMap = {
    ...serverMap,
    [name]: setServerEnabled(currentServer as McpServerConfig, enabled) as Record<string, unknown>,
  };
  let next = writeServerMapToJson(current, descriptor.configKeyName, nextServerMap);
  const legacyCleanup = removeLegacyMcpEnabledOverride(next, location, name);
  if (legacyCleanup.changed) {
    next = legacyCleanup.config;
  }
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

export async function writeZCodeServersToFile(
  scope: Exclude<McpScope, "common">,
  servers: Record<string, Record<string, unknown>>,
  workspacePath?: string,
): Promise<void> {
  const filePath = buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const next = writeServerMapToJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName, servers);
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}
