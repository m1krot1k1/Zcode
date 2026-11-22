import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { PluginSyncRemoteStatus } from "@zcode/shared";
import type { IPluginSyncService } from "../pluginSync.js";
import { createPluginSyncArchive } from "../pluginSyncArchive.js";
import { normalizePluginSyncRelativePath, resolvePluginSyncPathWithin } from "../pluginSyncPath.js";
import { importMarketplaceSourceArchiveInternal, importPluginsArchive } from "./archiveImport.js";
import { collectLocalUserPluginCandidates } from "./localCandidates.js";
import { exportMarketplaceSourceArchiveInternal } from "./marketplaceSource.js";
import {
  collectConfiguredInlinePluginPathById,
  getUserZcodeConfigPath,
  getUserZcodePluginRoot,
} from "./userConfig.js";
import { normalizePluginId, normalizePluginIdKey } from "./utils.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "../../remote-sync/remoteSyncWriteAccess.js";

const DEFAULT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export function createPluginSyncService(options?: {
  maxArchiveBytes?: number;
}): IPluginSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  return {
    async listLocalUserPluginCandidates() {
      return {
        candidates: await collectLocalUserPluginCandidates(),
        maxArchiveBytes,
      };
    },
    async listRemoteUserPluginStatuses(params) {
      const targetRoot = getUserZcodePluginRoot();
      const existingPluginPathById = await collectConfiguredInlinePluginPathById();
      return {
        statuses: params.plugins.map((plugin): PluginSyncRemoteStatus => {
          const directoryName = normalizePluginSyncRelativePath(plugin.directoryName);
          const pluginId = normalizePluginId(plugin.pluginId);
          const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
          if (existsSync(targetPath)) {
            return {
              pluginId,
              directoryName,
              exists: true,
              path: targetPath,
              reason: "targetExists",
            };
          }
          const existingPath = existingPluginPathById.get(normalizePluginIdKey(pluginId));
          return existingPath
            ? {
                pluginId,
                directoryName,
                exists: true,
                path: existingPath,
                reason: "samePluginId",
              }
            : { pluginId, directoryName, exists: false };
        }),
      };
    },
    async exportPluginsArchive(params) {
      const candidates = await collectLocalUserPluginCandidates();
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const selected = params.pluginIds.map((id) => {
        const candidate = candidateById.get(id);
        if (!candidate) {
          throw new Error(`plugin sync candidate not found: ${id}`);
        }
        return candidate;
      });
      const selectedBytes = selected.reduce((total, candidate) => total + candidate.sizeBytes, 0);
      if (selectedBytes > maxArchiveBytes) {
        throw new Error(`plugin sync archive exceeds limit: ${selectedBytes}/${maxArchiveBytes}`);
      }
      const archive = await createPluginSyncArchive({
        entries: await Promise.all(
          selected.map(async (candidate) => ({
            sourcePath: await realpath(candidate.path),
            archivePath: candidate.directoryName,
          })),
        ),
        metadata: {
          plugins: selected.map((candidate) => ({
            name: candidate.name,
            pluginId: candidate.pluginId,
            directoryName: candidate.directoryName,
            ...(candidate.enabledOverride !== undefined
              ? { enabled: candidate.enabledOverride }
              : {}),
          })),
        },
      });
      if (archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return {
        archive,
        archiveBytes: archive.byteLength,
        plugins: selected.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          pluginId: candidate.pluginId,
          directoryName: candidate.directoryName,
          ...(candidate.enabledOverride !== undefined
            ? { enabled: candidate.enabledOverride }
            : {}),
        })),
      };
    },
    async exportMarketplaceSourceArchive(params) {
      const result = await exportMarketplaceSourceArchiveInternal(params, maxArchiveBytes);
      if (result.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin marketplace source archive exceeds limit: ${result.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return result;
    },
    async importPluginsArchive(params) {
      if (params.overwrite) {
        throw new Error("plugin sync overwrite is not supported");
      }
      if (params.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${params.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return await importPluginsArchive(params.archive, maxArchiveBytes);
    },
    async checkRemoteUserPluginWriteAccess() {
      return checkRemoteSyncDirectoriesWriteAccess([
        getUserZcodePluginRoot(),
        dirname(getUserZcodeConfigPath()),
      ]);
    },
    async importMarketplaceSourceArchive(params) {
      if (params.overwrite) {
        throw new Error("plugin marketplace source overwrite is not supported");
      }
      if (params.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin marketplace source archive exceeds limit: ${params.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return await importMarketplaceSourceArchiveInternal(params.archive, maxArchiveBytes);
    },
  };
}
