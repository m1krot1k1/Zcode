import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSyncComponentType } from "@zcode/shared";
import type { PluginManifestInfo } from "./types.js";
import { isRecord, pathExists } from "./utils.js";

const INLINE_PLUGIN_MARKETPLACE = "inline";
const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  [".zcode-plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
  [".codex-plugin", "plugin.json"],
] as const;

export async function readPluginManifestInfo(
  pluginRoot: string,
): Promise<PluginManifestInfo | null> {
  for (const segments of PLUGIN_MANIFEST_RELATIVE_PATHS) {
    const manifestPath = join(pluginRoot, ...segments);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) {
      return null;
    }
    return {
      name,
      pluginId: `${name}@${INLINE_PLUGIN_MARKETPLACE}`,
      ...(typeof parsed.description === "string" && parsed.description.trim()
        ? { description: parsed.description.trim() }
        : {}),
      ...(typeof parsed.version === "string" && parsed.version.trim()
        ? { version: parsed.version.trim() }
        : {}),
      componentTypes: await resolvePluginComponentTypes(pluginRoot, parsed),
    };
  }
  return null;
}

async function resolvePluginComponentTypes(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<PluginSyncComponentType[]> {
  const componentTypes: PluginSyncComponentType[] = [];
  if ("skills" in manifest || (await pathExists(join(pluginRoot, "skills")))) {
    componentTypes.push("skills");
  }
  if ("commands" in manifest || (await pathExists(join(pluginRoot, "commands")))) {
    componentTypes.push("commands");
  }
  if ("hooks" in manifest || (await pathExists(join(pluginRoot, "hooks", "hooks.json")))) {
    componentTypes.push("hooks");
  }
  if ("mcpServers" in manifest || (await pathExists(join(pluginRoot, ".mcp.json")))) {
    componentTypes.push("mcp");
  }
  return componentTypes;
}
