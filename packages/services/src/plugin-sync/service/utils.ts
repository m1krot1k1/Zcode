import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizePluginSyncRelativePath } from "../pluginSyncPath.js";

export async function computeRecursiveSize(path: string): Promise<number> {
  const pathStat = await lstat(path);
  if (pathStat.isFile()) {
    return pathStat.size;
  }
  if (!pathStat.isDirectory()) {
    return 0;
  }
  let total = 0;
  for (const entry of await readdir(path)) {
    total += await computeRecursiveSize(join(path, entry));
  }
  return total;
}

export async function computeRecursiveContentFingerprint(path: string): Promise<string> {
  const pathStat = await lstat(path);
  const hash = createHash("sha256");
  if (pathStat.isFile()) {
    hash.update("file\0");
    hash.update(await readFile(path));
    return hash.digest("hex");
  }
  if (!pathStat.isDirectory()) {
    throw new Error(`unsupported plugin archive source: ${path}`);
  }
  hash.update("dir\0");
  const children = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const child of children) {
    hash.update(child.name);
    hash.update("\0");
    hash.update(await computeRecursiveContentFingerprint(join(path, child.name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function toSafeDirectoryName(value: string): string {
  const sanitized = value.trim().replace(/[\\/:]/gu, "-") || "plugin";
  try {
    return normalizePluginSyncRelativePath(sanitized);
  } catch {
    return `plugin-${createShortHash(value).slice(0, 8)}`;
  }
}

export function createCandidateId(pluginId: string, pluginRoot: string): string {
  return createShortHash(`${pluginId}:${pluginRoot}`);
}

export function createShortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(`invalid plugin id: ${pluginId}`);
  }
  return normalized;
}

export function normalizeMarketplaceId(marketplaceId: string): string {
  return normalizePluginId(marketplaceId);
}

export function normalizePluginIdKey(pluginId: string): string {
  return normalizePluginId(pluginId).toLowerCase();
}

export function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing ${label}`);
  }
  return value.trim();
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
