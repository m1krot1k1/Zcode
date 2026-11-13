import { dirname } from "node:path";
import type { McpSyncExportedServer, McpSyncRemoteStatus } from "@zcode/shared";
import type { IMcpSyncService } from "../mcpSync.js";
import { checkRemoteSyncDirectoryWriteAccess } from "../../remote-sync/remoteSyncWriteAccess.js";
import {
  loadMcpFromUserDirectory as loadMcpFromUserDirectoryFromDisk,
  saveMcpToUserDirectory as saveMcpToUserDirectoryToDisk,
} from "./directorySync.js";
import { importMcpServers } from "./importServers.js";
import { loadClineMcpMarketplaceCatalog, searchOfficialMcpRegistry } from "./marketplace.js";
import { getUserZcodeMcpConfigPath, resolveUserHomeDir } from "./paths.js";
import type { McpSyncServiceDependencies } from "./types.js";
import {
  collectEffectiveUserMcpRecordByName,
  collectEffectiveUserMcpRecords,
  normalizeMcpNameKey,
  recordToCandidate,
} from "./userRecords.js";
import { cloneMcpConfig } from "./utils.js";

export function createMcpSyncService(
  dependencies: McpSyncServiceDependencies = {},
): IMcpSyncService {
  return {
    async loadMarketplaceCatalog() {
      return loadClineMcpMarketplaceCatalog(dependencies.fetchClineMcpMarketplace);
    },
    async searchMarketplace(query) {
      return searchOfficialMcpRegistry(dependencies.fetchOfficialMcpRegistry ?? fetch, query);
    },
    async loadMcpFromUserDirectory(request) {
      return loadMcpFromUserDirectoryFromDisk(request);
    },
    async listWorkspaceMcpServerStatuses(params) {
      if (!dependencies.listMcpServerStatuses) {
        throw new Error("MCP server status listing is unavailable in this runtime");
      }
      return dependencies.listMcpServerStatuses(params);
    },
    async connectWorkspaceMcpServer(params) {
      if (!dependencies.connectMcpServer) {
        throw new Error("MCP server connection is unavailable in this runtime");
      }
      return dependencies.connectMcpServer(params);
    },
    async saveMcpToUserDirectory(payload) {
      await saveMcpToUserDirectoryToDisk(payload);
    },
    async listLocalUserMcpCandidates() {
      const localHomeDir = resolveUserHomeDir();
      return {
        candidates: (await collectEffectiveUserMcpRecords()).map(recordToCandidate),
        localHomeDir,
      };
    },
    async listRemoteUserMcpStatuses(params) {
      const remoteHomeDir = resolveUserHomeDir();
      const existingByName = await collectEffectiveUserMcpRecordByName();
      return {
        remoteHomeDir,
        statuses: params.names.map((name): McpSyncRemoteStatus => {
          const existing = existingByName.get(normalizeMcpNameKey(name));
          return existing ? { name, exists: true, path: existing.path } : { name, exists: false };
        }),
      };
    },
    async exportMcpServers(params) {
      const candidates = (await collectEffectiveUserMcpRecords()).map(recordToCandidate);
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      return {
        localHomeDir: resolveUserHomeDir(),
        servers: params.serverIds.map((id): McpSyncExportedServer => {
          const candidate = candidateById.get(id);
          if (!candidate) {
            throw new Error(`mcp sync candidate not found: ${id}`);
          }
          return {
            id: candidate.id,
            name: candidate.name,
            config: cloneMcpConfig(candidate.config),
            enabled: candidate.enabled,
            source: candidate.source,
            path: candidate.path,
          };
        }),
      };
    },
    async checkRemoteUserMcpWriteAccess() {
      return checkRemoteSyncDirectoryWriteAccess(dirname(getUserZcodeMcpConfigPath()));
    },
    async importMcpServers(params) {
      if (params.overwrite) {
        throw new Error("mcp sync overwrite is not supported");
      }
      return await importMcpServers(params);
    },
  };
}
