import type { McpSyncExportedServer, McpSyncImportResult } from "@zcode/shared";
import { ZCODE_MCP_DESCRIPTOR } from "./descriptors.js";
import { readJsonObject, writeTextAtomic } from "./fileAccess.js";
import { rewriteFilesystemMcpConfig } from "./filesystemRewrite.js";
import { getUserZcodeMcpConfigPath, resolveUserHomeDir } from "./paths.js";
import {
  readServerMapFromJson,
  setServerEnabled,
  writeServerMapToJson,
} from "./serverMapConfig.js";
import { collectEffectiveUserMcpRecordByName, normalizeMcpNameKey } from "./userRecords.js";
import { cloneMcpConfig } from "./utils.js";

export async function importMcpServers(params: {
  servers: McpSyncExportedServer[];
  localHomeDir: string;
  localWorkspacePath?: string;
  remoteWorkspacePath?: string;
}): Promise<McpSyncImportResult> {
  const targetPath = getUserZcodeMcpConfigPath();
  const current = (await readJsonObject(targetPath)) ?? {};
  const targetServers = readServerMapFromJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName);
  const existingByName = await collectEffectiveUserMcpRecordByName();
  const results: McpSyncImportResult["results"] = [];
  let changed = false;

  for (const server of params.servers) {
    const nameKey = normalizeMcpNameKey(server.name);
    const existingTarget = targetServers[server.name];
    if (existingTarget) {
      results.push({ name: server.name, status: "skipped", path: targetPath });
      continue;
    }

    const existing = existingByName.get(nameKey);
    if (existing) {
      results.push({
        name: server.name,
        status: "skipped",
        path: existing.path,
      });
      continue;
    }

    try {
      const rewrittenConfig = rewriteFilesystemMcpConfig(
        server.name,
        setServerEnabled(cloneMcpConfig(server.config), server.enabled),
        {
          localHomeDir: params.localHomeDir,
          localWorkspacePath: params.localWorkspacePath,
          remoteHomeDir: resolveUserHomeDir(),
          remoteWorkspacePath: params.remoteWorkspacePath,
        },
      );
      targetServers[server.name] = rewrittenConfig as Record<string, unknown>;
      existingByName.set(nameKey, {
        name: server.name,
        config: rewrittenConfig,
        enabled: server.enabled,
        source: "zcode",
        path: targetPath,
      });
      results.push({ name: server.name, status: "synced", path: targetPath });
      changed = true;
    } catch (error) {
      results.push({
        name: server.name,
        status: "failed",
        path: targetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (changed) {
    await writeTextAtomic(
      targetPath,
      `${JSON.stringify(writeServerMapToJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName, targetServers), null, 2)}\n`,
    );
  }

  return { results };
}
