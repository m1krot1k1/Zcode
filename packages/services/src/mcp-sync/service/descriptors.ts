import type { DirectoryMcpDescriptor } from "./types.js";

export const ZCODE_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcode",
  directorySource: "zcode",
  userConfigDirSegments: [".zcode", "cli"],
  workspaceConfigDirSegments: [".zcode"],
  fileName: "config.json",
  configKeyName: "mcp.servers",
};

export const AGENTS_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "agents",
  directorySource: "agents",
  userConfigDirSegments: [".agents"],
  workspaceConfigDirSegments: [".agents"],
  fileName: "mcp.json",
  configKeyName: "mcpServers",
};

export const ENABLED_KEY = "enabled";
// 历史遗留：桌面端早期把停用状态写成 enable，而 CLI 契约字段（contracts McpServerConfigBase）
// 一直是 enabled，导致同一条 server 出现两套口径、停用后仍被 agent 拉起。
// 现在读写逻辑一律只认 enabled，这里只保留一次性迁移；存量配置清空后整块删除。
export const LEGACY_ENABLE_KEY = "enable";

export const DIRECTORY_MCP_DESCRIPTORS: readonly DirectoryMcpDescriptor[] = [
  ZCODE_MCP_DESCRIPTOR,
  AGENTS_MCP_DESCRIPTOR,
];
