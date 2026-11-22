import { existsSync } from "node:fs";
import { join } from "node:path";
import { getE2EAppDataPaths } from "../desktop-app.js";
import { PLUGIN_LIFECYCLE_ID } from "./constants.js";
import { isRecord, readJsonRecord } from "./json-io.js";

export async function readPluginConfigOptions(): Promise<Record<string, unknown>> {
  const config = await readJsonRecord(
    join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "config.json"),
  );
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  return isRecord(options[PLUGIN_LIFECYCLE_ID]) ? options[PLUGIN_LIFECYCLE_ID] : {};
}

export function pluginStoragePath(...segments: string[]): string {
  return join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "plugins", ...segments);
}

export function pluginDataPath(pluginId: string): string {
  return pluginStoragePath("data", pluginId);
}

export function pluginPathExists(path: string): boolean {
  return existsSync(path);
}
