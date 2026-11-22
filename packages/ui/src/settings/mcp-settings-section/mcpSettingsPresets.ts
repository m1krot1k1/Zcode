/**
 * MCP Settings — shared preset/source helpers.
 *
 * The MCP source and preset install flow are used by both the section shell and
 * its handlers, so they live here instead of the section module.
 */
import {
  communityMcpPresetConfig,
  type CommunityMcpPreset,
  type McpServerConfig,
  type ZCodeMcpServer,
} from "@zcode/shared";
import type { ServerScope } from "@/settings/mcpSettingsShared.js";

export const DEFAULT_MCP_SOURCE: ServerScope = "zcodeagentmcp";

export interface AddCommunityMcpPresetInput {
  addServer: (name: string, config: McpServerConfig, projectPath?: string) => Promise<void>;
  listSavedServers: () => readonly ZCodeMcpServer[];
  loadCurrentScope: () => Promise<boolean>;
  preset: CommunityMcpPreset;
  scopeKey: string;
  workspacePath: string | undefined;
}

export async function addCommunityMcpPresetToScope({
  addServer,
  listSavedServers,
  loadCurrentScope,
  preset,
  scopeKey,
  workspacePath,
}: AddCommunityMcpPresetInput): Promise<"added" | "already-added" | "unavailable"> {
  if (!workspacePath || !(await loadCurrentScope())) return "unavailable";

  const projectPath = scopeKey === "user" ? undefined : workspacePath;
  const alreadyAdded = listSavedServers().some(
    (server) =>
      server.source === DEFAULT_MCP_SOURCE &&
      server.name === preset.id &&
      server.projectPath === projectPath,
  );
  if (alreadyAdded) return "already-added";

  // Store action persists before publishing state; the preset's command and credentials stay local.
  await addServer(preset.id, communityMcpPresetConfig(preset), projectPath);
  return "added";
}

export function registryServerName(id: string): string {
  const base = id.split("/").at(-1) ?? id;
  const normalized = base
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 80);
  return normalized || "mcp-server";
}
