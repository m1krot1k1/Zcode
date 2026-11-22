import type { McpServerConfig, McpSyncSource, SettingsDirectorySource } from "@zcode/shared";
import type { IMcpSyncService } from "../mcpSync.js";

export type McpConfigKeyName = "mcp.servers" | "mcpServers";

export interface DirectoryMcpDescriptor {
  source: McpSyncSource;
  directorySource: SettingsDirectorySource;
  userConfigDirSegments: string[];
  workspaceConfigDirSegments: string[];
  fileName: string;
  configKeyName: McpConfigKeyName;
}

export interface UserMcpRecord {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

export interface McpSyncServiceDependencies {
  /**
   * MCP server 运行态状态检查的执行面。真实 connect/listTools 必须发生在
   * agent 进程（workspace 的 PATH/cwd 环境），host 侧没有可替代实现；无该依赖的
   * 构造（纯目录同步用途/单测）调用 listWorkspaceMcpServerStatuses 会显式抛错。
   */
  listMcpServerStatuses?: IMcpSyncService["listWorkspaceMcpServerStatuses"];
  /** `mcp/connect` 的执行面；与状态列表一样必须发生在 agent 进程。 */
  connectMcpServer?: IMcpSyncService["connectWorkspaceMcpServer"];
  /** Test seam for the fixed external discovery feed; production always uses the fixed URL. */
  fetchClineMcpMarketplace?: typeof fetch;
  /** Test seam for the Official MCP Registry; production always uses the fixed URL. */
  fetchOfficialMcpRegistry?: typeof fetch;
}
