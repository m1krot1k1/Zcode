import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readPluginManifestInfo } from "./pluginManifest.js";
import type { UserPluginConfigState } from "./types.js";
import { isRecord, normalizePluginIdKey, readStringArray } from "./utils.js";

const USER_CONFIG_FILE_MODE = 0o600;

function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function getUserZcodeConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

export function getUserZcodePluginRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "plugins");
}

export async function readUserPluginConfigState(): Promise<UserPluginConfigState> {
  const parsed = await readJsonFileOrEmpty(getUserZcodeConfigPath());
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const enabledOverrides = new Map<string, boolean>();
  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (typeof enabled === "boolean") {
      enabledOverrides.set(normalizePluginIdKey(pluginId), enabled);
    }
  }
  return {
    dirs: readStringArray(plugins.dirs),
    enabledOverrides,
  };
}

export async function collectConfiguredInlinePluginPathById(): Promise<Map<string, string>> {
  const config = await readUserPluginConfigState();
  const result = new Map<string, string>();
  for (const rawDir of config.dirs) {
    const pluginRoot = resolve(rawDir);
    const canonicalRoot = await realpath(pluginRoot).catch(() => pluginRoot);
    const manifest = await readPluginManifestInfo(canonicalRoot);
    if (!manifest) {
      continue;
    }
    const pluginIdKey = normalizePluginIdKey(manifest.pluginId);
    if (!result.has(pluginIdKey)) {
      result.set(pluginIdKey, canonicalRoot);
    }
  }
  return result;
}

export async function addPluginDirToUserConfig(
  pluginPath: string,
  pluginId: string,
  enabledOverride: boolean | undefined,
): Promise<void> {
  const filePath = getUserZcodeConfigPath();
  const parsed = await readJsonFileOrEmpty(filePath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const resolvedPluginPath = resolve(pluginPath);
  const dirs = readStringArray(plugins.dirs);
  const nextDirs = dirs.map((item) => resolve(item)).includes(resolvedPluginPath)
    ? dirs
    : [...dirs, resolvedPluginPath];
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  await writeJsonFileAtomic(filePath, {
    ...parsed,
    plugins: {
      ...plugins,
      dirs: nextDirs,
      ...(enabledOverride !== undefined
        ? {
            enabledPlugins: {
              ...enabledPlugins,
              [pluginId]: enabledOverride,
            },
          }
        : Object.keys(enabledPlugins).length > 0
          ? { enabledPlugins }
          : {}),
    },
  });
}

async function readJsonFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`invalid json object: ${filePath}`);
  }
  return parsed;
}

async function writeJsonFileAtomic(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.tmp-${basename(filePath)}-${randomUUID()}`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: USER_CONFIG_FILE_MODE,
  });
  await rename(tempPath, filePath);
}
