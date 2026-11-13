import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ENABLE_OVERRIDE_KEY = "enable";
export const HOME_PREFIX = "~/";

export function resolveUserHomeDir() {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export function getUserCliConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readUserCliConfig(): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(getUserCliConfigPath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  const filePath = getUserCliConfigPath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function readCommandEnabledOverrides(config: Record<string, unknown>): Map<string, boolean> {
  const commandConfig = config.command;
  const overrides = new Map<string, boolean>();
  if (!isRecord(commandConfig)) {
    return overrides;
  }

  for (const [filePath, entry] of Object.entries(commandConfig)) {
    if (isRecord(entry) && typeof entry[ENABLE_OVERRIDE_KEY] === "boolean") {
      overrides.set(filePath, entry[ENABLE_OVERRIDE_KEY]);
    }
  }
  return overrides;
}

export async function readCommandEnabledOverridesFromUserConfig(): Promise<Map<string, boolean>> {
  return readCommandEnabledOverrides(await readUserCliConfig());
}

export function getCommandEnabled(
  filePath: string,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  return overrides.get(filePath) ?? true;
}

export function setCommandEnabledOverride(
  config: Record<string, unknown>,
  filePath: string,
  enabled: boolean,
): Record<string, unknown> {
  const commandConfig = isRecord(config.command) ? { ...config.command } : {};

  if (enabled) {
    delete commandConfig[filePath];
  } else {
    commandConfig[filePath] = { [ENABLE_OVERRIDE_KEY]: false };
  }

  const nextConfig: Record<string, unknown> = { ...config };
  if (Object.keys(commandConfig).length > 0) {
    nextConfig.command = commandConfig;
  } else {
    delete nextConfig.command;
  }
  return nextConfig;
}
