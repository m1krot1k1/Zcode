import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { PluginSyncCandidate } from "@zcode/shared";
import { readPluginManifestInfo } from "./pluginManifest.js";
import { readUserPluginConfigState } from "./userConfig.js";
import {
  computeRecursiveSize,
  createCandidateId,
  createShortHash,
  normalizePluginIdKey,
  toSafeDirectoryName,
} from "./utils.js";

export async function collectLocalUserPluginCandidates(): Promise<PluginSyncCandidate[]> {
  const config = await readUserPluginConfigState();
  const candidates: PluginSyncCandidate[] = [];
  const seenRealpaths = new Set<string>();
  const usedDirectoryNames = new Set<string>();

  for (const rawDir of config.dirs) {
    const pluginRoot = resolve(rawDir);
    const canonicalRoot = await realpath(pluginRoot).catch(() => pluginRoot);
    if (seenRealpaths.has(canonicalRoot)) {
      continue;
    }
    seenRealpaths.add(canonicalRoot);
    const manifest = await readPluginManifestInfo(canonicalRoot);
    if (!manifest) {
      continue;
    }
    const enabledOverride = config.enabledOverrides.get(normalizePluginIdKey(manifest.pluginId));
    const directoryName = createUniqueDirectoryName(
      basename(canonicalRoot),
      manifest.name,
      canonicalRoot,
      usedDirectoryNames,
    );
    candidates.push({
      id: createCandidateId(manifest.pluginId, canonicalRoot),
      name: manifest.name,
      pluginId: manifest.pluginId,
      directoryName,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
      path: canonicalRoot,
      sizeBytes: await computeRecursiveSize(canonicalRoot),
      enabled: enabledOverride ?? true,
      ...(enabledOverride !== undefined ? { enabledOverride } : {}),
      componentTypes: manifest.componentTypes,
    });
  }

  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

function createUniqueDirectoryName(
  directoryBasename: string,
  pluginName: string,
  pluginRoot: string,
  usedDirectoryNames: Set<string>,
): string {
  const baseName = toSafeDirectoryName(directoryBasename || pluginName);
  if (!usedDirectoryNames.has(baseName)) {
    usedDirectoryNames.add(baseName);
    return baseName;
  }
  const dedupedName = toSafeDirectoryName(`${baseName}-${createShortHash(pluginRoot).slice(0, 8)}`);
  usedDirectoryNames.add(dedupedName);
  return dedupedName;
}
