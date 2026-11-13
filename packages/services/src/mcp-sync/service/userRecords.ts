import { createHash } from "node:crypto";
import type {
  McpScope,
  McpServerConfig,
  McpSyncCandidate,
  NativeMcpServerRecord,
} from "@zcode/shared";
import { AGENTS_MCP_DESCRIPTOR, ZCODE_MCP_DESCRIPTOR } from "./descriptors.js";
import { readJsonObject } from "./fileAccess.js";
import {
  buildDirectoryConfigPath,
  buildDirectoryMcpLocation,
  buildUserConfigPath,
} from "./paths.js";
import { readServerEnabled, readServerMapWithLegacyMigration } from "./serverMapConfig.js";
import type { DirectoryMcpDescriptor, UserMcpRecord } from "./types.js";
import { cloneMcpConfig } from "./utils.js";

export function normalizeMcpNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function sortMcpRecords(records: UserMcpRecord[]): UserMcpRecord[] {
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

export async function collectEffectiveUserMcpRecords(): Promise<UserMcpRecord[]> {
  const zcodeRecords = await readUserMcpRecordsFromFile(ZCODE_MCP_DESCRIPTOR);
  if (zcodeRecords.length > 0) {
    return sortMcpRecords(zcodeRecords);
  }
  return sortMcpRecords(await readUserMcpRecordsFromFile(AGENTS_MCP_DESCRIPTOR));
}

export async function collectEffectiveUserMcpRecordByName(): Promise<Map<string, UserMcpRecord>> {
  const result = new Map<string, UserMcpRecord>();
  for (const record of await collectEffectiveUserMcpRecords()) {
    const nameKey = normalizeMcpNameKey(record.name);
    if (!result.has(nameKey)) {
      result.set(nameKey, record);
    }
  }
  return result;
}

export async function readDirectoryServersFromPreferredSources(
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const zcodeServers = await readDirectoryServersFromFile(
    ZCODE_MCP_DESCRIPTOR,
    scope,
    workspacePath,
  );
  if (zcodeServers.length > 0) {
    return zcodeServers;
  }
  return readDirectoryServersFromFile(AGENTS_MCP_DESCRIPTOR, scope, workspacePath);
}

export async function readDirectoryServersFromFile(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const parsed = await readJsonObject(filePath);
  if (!parsed) {
    return [];
  }
  const serverMap = await readServerMapWithLegacyMigration(
    filePath,
    parsed,
    descriptor.configKeyName,
  );
  const location = buildDirectoryMcpLocation(descriptor, scope, workspacePath);
  return Object.entries(serverMap).map(([name, config]) => ({
    source: "zcodeagentmcp",
    scope,
    name,
    config: config as McpServerConfig,
    enabled: readServerEnabled(config),
    projectPath: scope === "workspace" ? workspacePath : undefined,
    location,
    file: {
      format: "json",
      filePath,
    },
  }));
}

export function recordToCandidate(record: UserMcpRecord): McpSyncCandidate {
  return {
    id: createCandidateId(record),
    name: record.name,
    config: cloneMcpConfig(record.config),
    enabled: record.enabled,
    source: record.source,
    path: record.path,
  };
}

function createCandidateId(record: UserMcpRecord): string {
  return createHash("sha256")
    .update(`${record.source}:${record.path}:${record.name}`)
    .digest("hex");
}

async function readUserMcpRecordsFromFile(
  descriptor: DirectoryMcpDescriptor,
): Promise<UserMcpRecord[]> {
  const filePath = buildUserConfigPath(descriptor);
  const parsed = await readJsonObject(filePath);
  if (!parsed) {
    return [];
  }
  const serverMap = await readServerMapWithLegacyMigration(
    filePath,
    parsed,
    descriptor.configKeyName,
  );
  return Object.entries(serverMap).map(([name, config]) => ({
    name,
    config: config as McpServerConfig,
    enabled: readServerEnabled(config),
    source: descriptor.source,
    path: filePath,
  }));
}
