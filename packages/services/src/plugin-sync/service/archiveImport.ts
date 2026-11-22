import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginSyncImportResult } from "@zcode/shared";
import {
  extractPluginSyncArchive,
  PLUGIN_SYNC_METADATA_ARCHIVE_PATH,
  type PluginSyncArchiveMetadata,
} from "../pluginSyncArchive.js";
import { normalizePluginSyncRelativePath, resolvePluginSyncPathWithin } from "../pluginSyncPath.js";
import { readMarketplaceManifest } from "./marketplaceSource.js";
import { readPluginManifestInfo } from "./pluginManifest.js";
import {
  addPluginDirToUserConfig,
  collectConfiguredInlinePluginPathById,
  getUserZcodePluginRoot,
} from "./userConfig.js";
import {
  isRecord,
  normalizeMarketplaceId,
  normalizePluginId,
  normalizePluginIdKey,
  readRequiredString,
  toSafeDirectoryName,
} from "./utils.js";

const MARKETPLACE_SOURCE_ROOT_DIRECTORY = "marketplace-sources";

export async function importPluginsArchive(
  archive: Uint8Array,
  maxArchiveBytes: number,
): Promise<PluginSyncImportResult> {
  const tempRoot = join(tmpdir(), `zcode-plugin-sync-${randomUUID()}`);
  try {
    await extractPluginSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
    const metadata = await readArchiveMetadata(tempRoot);
    const targetRoot = getUserZcodePluginRoot();
    const existingPluginPathById = await collectConfiguredInlinePluginPathById();
    const results: PluginSyncImportResult["results"] = [];

    for (const plugin of metadata.plugins) {
      const directoryName = normalizePluginSyncRelativePath(plugin.directoryName);
      const pluginId = normalizePluginId(plugin.pluginId);
      const extractedPath = resolvePluginSyncPathWithin(tempRoot, directoryName);
      const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
      let stagingPath: string | undefined;
      try {
        const manifest = await readPluginManifestInfo(extractedPath);
        if (!manifest) {
          throw new Error(`plugin manifest not found: ${directoryName}`);
        }
        if (normalizePluginIdKey(manifest.pluginId) !== normalizePluginIdKey(pluginId)) {
          throw new Error(`plugin manifest id mismatch: ${manifest.pluginId} !== ${pluginId}`);
        }
        if (existsSync(targetPath)) {
          results.push({
            name: manifest.name,
            pluginId,
            directoryName,
            status: "skipped",
            path: targetPath,
          });
          continue;
        }
        const existingPath = existingPluginPathById.get(normalizePluginIdKey(pluginId));
        if (existingPath) {
          results.push({
            name: manifest.name,
            pluginId,
            directoryName,
            status: "skipped",
            path: existingPath,
          });
          continue;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        stagingPath = resolvePluginSyncPathWithin(
          targetRoot,
          `.importing-${toSafeDirectoryName(directoryName)}-${randomUUID()}`,
        );
        await cp(extractedPath, stagingPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        if (existsSync(targetPath)) {
          throw new Error(`plugin target already exists: ${targetPath}`);
        }
        await rename(stagingPath, targetPath);
        stagingPath = undefined;
        // 远端 plugin 只有目录落盘还不会被 Agent runtime 发现；
        // 必须在同一个远端服务里追加远端绝对路径，避免写回本机 plugins.dirs。
        try {
          await addPluginDirToUserConfig(targetPath, pluginId, plugin.enabled);
        } catch (error) {
          // inline plugin 目录落盘但 config 写失败会形成半同步状态；
          // 重试会把目录误判为远端已有，所以必须回滚本次刚创建的目标目录。
          await rm(targetPath, { recursive: true, force: true });
          throw error;
        }
        existingPluginPathById.set(normalizePluginIdKey(pluginId), targetPath);
        results.push({
          name: manifest.name,
          pluginId,
          directoryName,
          status: "synced",
          path: targetPath,
        });
      } catch (error) {
        if (stagingPath) {
          await rm(stagingPath, { recursive: true, force: true });
        }
        results.push({
          name: plugin.name,
          pluginId,
          directoryName,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { results };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function importMarketplaceSourceArchiveInternal(
  archive: Uint8Array,
  maxArchiveBytes: number,
) {
  const tempRoot = join(tmpdir(), `zcode-plugin-marketplace-source-${randomUUID()}`);
  try {
    await extractPluginSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
    const metadata = await readMarketplaceSourceArchiveMetadata(tempRoot);
    const directoryName = normalizePluginSyncRelativePath(metadata.directoryName);
    const extractedPath = resolvePluginSyncPathWithin(tempRoot, directoryName);
    const manifest = await readMarketplaceManifest(join(extractedPath, "marketplace.json"));
    if (manifest.name !== metadata.marketplaceId) {
      throw new Error(
        `marketplace source archive id mismatch: ${manifest.name} !== ${metadata.marketplaceId}`,
      );
    }
    const targetRoot = join(getUserZcodePluginRoot(), MARKETPLACE_SOURCE_ROOT_DIRECTORY);
    const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
    if (existsSync(targetPath)) {
      return {
        marketplaceId: metadata.marketplaceId,
        path: targetPath,
        status: "skipped" as const,
      };
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(extractedPath, targetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return {
      marketplaceId: metadata.marketplaceId,
      path: targetPath,
      status: "synced" as const,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function readArchiveMetadata(tempRoot: string): Promise<PluginSyncArchiveMetadata> {
  const raw = await readFile(join(tempRoot, PLUGIN_SYNC_METADATA_ARCHIVE_PATH), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new Error("invalid plugin sync archive metadata");
  }
  const plugins: PluginSyncArchiveMetadata["plugins"] = [];
  for (const item of parsed.plugins) {
    if (!isRecord(item)) {
      throw new Error("invalid plugin sync archive plugin metadata");
    }
    const name = readRequiredString(item.name, "plugin metadata name");
    const pluginId = normalizePluginId(readRequiredString(item.pluginId, "plugin metadata id"));
    const directoryName = normalizePluginSyncRelativePath(
      readRequiredString(item.directoryName, "plugin metadata directory"),
    );
    plugins.push({
      name,
      pluginId,
      directoryName,
      ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
    });
  }
  return { plugins };
}

async function readMarketplaceSourceArchiveMetadata(tempRoot: string): Promise<{
  directoryName: string;
  marketplaceId: string;
}> {
  const raw = await readFile(join(tempRoot, PLUGIN_SYNC_METADATA_ARCHIVE_PATH), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.marketplaceSources)) {
    throw new Error("invalid plugin marketplace source archive metadata");
  }
  if (parsed.marketplaceSources.length !== 1) {
    throw new Error("plugin marketplace source archive must contain one marketplace");
  }
  const item = parsed.marketplaceSources[0];
  if (!isRecord(item)) {
    throw new Error("invalid plugin marketplace source metadata");
  }
  return {
    marketplaceId: normalizeMarketplaceId(
      readRequiredString(item.marketplaceId, "marketplace source id"),
    ),
    directoryName: normalizePluginSyncRelativePath(
      readRequiredString(item.directoryName, "marketplace source directory"),
    ),
  };
}
