import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "@zcode/shared";
import { readInstalledPluginRoots } from "#src/plugins/installedPluginRoots.js";
import { HOME_PREFIX, isRecord, readUserCliConfig, resolveUserHomeDir } from "./userConfig.js";

const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
const ZCODE_PLUGIN_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_PLUGIN_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_PLUGIN_MANIFEST_PATH = join(".codex-plugin", "plugin.json");

interface PluginConfigSummary {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  storageDir: string;
  suppressedBuiltins: string[];
}

interface PluginRootCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
}

interface PluginManifestSummary {
  commands?: unknown;
  name: string;
}

export interface PluginCommandRootDescriptor {
  pluginEnabled: boolean;
  pluginMarketplace: string;
  pluginName: string;
  rootPath: string;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readBooleanRecord(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") {
      result[key] = enabled;
    }
  }
  return result;
}

function readStorageDirFromConfig(config: Record<string, unknown>): string {
  const storage = isRecord(config.storage) ? config.storage : {};
  return typeof storage.dir === "string" && storage.dir.trim().length > 0
    ? storage.dir
    : "~/.zcode";
}

function readPluginConfigFromConfig(config: Record<string, unknown>): PluginConfigSummary {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  return {
    dirs: readStringArray(plugins.dirs),
    enabled: typeof plugins.enabled === "boolean" ? plugins.enabled : true,
    enabledPlugins: readBooleanRecord(plugins.enabledPlugins),
    storageDir: readStorageDirFromConfig(config),
    suppressedBuiltins: readStringArray(plugins.suppressedBuiltins),
  };
}

function resolveConfigPath(path: string): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function resolveCliStorageRoot(storageDir: string): string {
  const storageRoot = resolveConfigPath(storageDir);
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

function resolvePluginStorageRoot(storageDir: string): string {
  return join(resolveCliStorageRoot(storageDir), "plugins");
}

function parsePathList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return readStringArray(value);
}

function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) {
    return null;
  }
  const resolved = resolve(rootPath, rawPath);
  const relativePath = relative(rootPath, resolved);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`))
  ) {
    return resolved;
  }
  return null;
}

async function scanOfficialPluginCacheRoots(pluginStorageRoot: string): Promise<string[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries: string[] = [];
  try {
    pluginEntries = await readdir(cacheRoot);
  } catch {
    return [];
  }

  const roots: string[] = [];
  for (const pluginEntry of pluginEntries) {
    const pluginDir = join(cacheRoot, pluginEntry);
    let versionEntries: string[] = [];
    try {
      versionEntries = await readdir(pluginDir);
    } catch {
      continue;
    }
    for (const versionEntry of versionEntries) {
      const rootPath = join(pluginDir, versionEntry);
      try {
        if ((await lstat(rootPath)).isDirectory()) {
          roots.push(rootPath);
        }
      } catch {
        // ignore inaccessible plugin cache entries
      }
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

async function readPluginManifest(rootPath: string): Promise<PluginManifestSummary | null> {
  const manifestPath = await findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
      return null;
    }
    return { commands: parsed.commands, name };
  } catch {
    return null;
  }
}

async function findPluginManifestPath(rootPath: string): Promise<string | null> {
  for (const manifestPath of [
    join(rootPath, ZCODE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CLAUDE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CODEX_PLUGIN_MANIFEST_PATH),
  ]) {
    if (existsSync(manifestPath)) {
      return manifestPath;
    }
  }
  return null;
}

function resolvePluginCommandRoots(params: {
  manifest: PluginManifestSummary;
  rootPath: string;
}): string[] {
  const roots: string[] = [];
  for (const rawPath of parsePathList(params.manifest.commands)) {
    const rootPath = resolveInside(params.rootPath, rawPath);
    if (rootPath) {
      roots.push(rootPath);
    }
  }
  if (roots.length === 0 && params.manifest.commands === undefined) {
    const defaultRoot = join(params.rootPath, "commands");
    if (existsSync(defaultRoot)) {
      roots.push(defaultRoot);
    }
  }
  return roots;
}

export async function resolvePluginCommandRootDescriptors(): Promise<
  PluginCommandRootDescriptor[]
> {
  const config = readPluginConfigFromConfig(await readUserCliConfig());
  if (!config.enabled) {
    return [];
  }

  const pluginStorageRoot = resolvePluginStorageRoot(config.storageDir);
  const officialCacheRoots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
  const installedRoots = await readInstalledPluginRoots(pluginStorageRoot);
  const candidates: PluginRootCandidate[] = [
    ...config.dirs.map((dir) => ({
      defaultEnabled: true,
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      rootPath: resolveConfigPath(dir),
    })),
    ...officialCacheRoots.map((rootPath) => ({
      defaultEnabled: false,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath,
    })),
    ...installedRoots,
  ];
  const descriptors: PluginCommandRootDescriptor[] = [];
  const seenPluginIds = new Set<string>();

  for (const candidate of candidates) {
    const manifest = await readPluginManifest(candidate.rootPath);
    if (!manifest) {
      continue;
    }
    const pluginId = `${manifest.name}@${candidate.marketplace}`;
    // 内置官方插件被「卸载」后只在 CLI config 写入 suppressedBuiltins；desktop 直接扫
    // 官方 cache 时不经过 CLI resolve 的过滤，需要在这里同样跳过，否则被卸载的内置插件
    // 仍会从 cache 贡献命令。
    if (
      candidate.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      config.suppressedBuiltins.includes(pluginId)
    ) {
      continue;
    }
    if (seenPluginIds.has(pluginId)) {
      continue;
    }
    seenPluginIds.add(pluginId);
    const defaultEnabled =
      candidate.defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId);
    const enabled = config.enabledPlugins[pluginId] ?? defaultEnabled;
    if (!enabled) {
      continue;
    }

    // 命令管理页过去只展示本地命令，且插件扫描只覆盖内置官方 cache。
    // marketplace installed_plugins.json 里的官方/自建市场插件也要纳入只读命令来源。
    for (const rootPath of resolvePluginCommandRoots({
      manifest,
      rootPath: candidate.rootPath,
    })) {
      descriptors.push({
        pluginEnabled: enabled,
        pluginMarketplace: candidate.marketplace,
        pluginName: manifest.name,
        rootPath,
      });
    }
  }

  return descriptors;
}
