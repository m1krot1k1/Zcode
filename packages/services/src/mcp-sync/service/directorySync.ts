import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpScope,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import { ZCODE_MCP_DESCRIPTOR } from "./descriptors.js";
import { buildDirectoryMcpLocation, findDescriptorByLocation } from "./paths.js";
import {
  cleanupLegacyMcpEnabledOverride,
  writeServerEnabledToFile,
  writeZCodeServersToFile,
} from "./serverMapConfig.js";
import {
  readDirectoryServersFromFile,
  readDirectoryServersFromPreferredSources,
} from "./userRecords.js";

export async function loadMcpFromUserDirectory(
  request?: LoadCliMcpFromUserDirectoryRequest,
): Promise<LoadCliMcpFromUserDirectoryResult> {
  const servers: NativeMcpServerRecord[] = [];
  if (request?.workspacePath) {
    servers.push(
      ...(await readDirectoryServersFromPreferredSources("workspace", request.workspacePath)),
    );
  }
  servers.push(...(await readDirectoryServersFromPreferredSources("user", request?.workspacePath)));
  return { servers };
}

export async function saveMcpToUserDirectory(
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  if (payload.action === "set-enabled") {
    if (typeof payload.enabled !== "boolean") {
      throw new Error("Missing enabled value for MCP set-enabled action");
    }
    const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
    const location =
      payload.location ??
      buildDirectoryMcpLocation(ZCODE_MCP_DESCRIPTOR, scope, payload.projectPath);
    await writeServerEnabledToFile(
      findDescriptorByLocation(location),
      location,
      payload.name,
      payload.enabled,
    );
    await cleanupLegacyMcpEnabledOverride(location, payload.name);
    return;
  }

  const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
  const existingServers = await readDirectoryServersFromFile(
    ZCODE_MCP_DESCRIPTOR,
    scope,
    payload.projectPath,
  );
  const nextServers = Object.fromEntries(
    existingServers.map((server) => [server.name, server.config as Record<string, unknown>]),
  );

  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    nextServers[payload.name] = payload.config as Record<string, unknown>;
  } else {
    delete nextServers[payload.name];
  }

  await writeZCodeServersToFile(scope, nextServers, payload.projectPath);
}
