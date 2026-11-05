#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const miseTomlPath = path.join(root, "mise.toml");

function stripTomlComment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

function normalizeNodeVersion(version) {
  const text = typeof version === "string" ? version.trim().replace(/^v/u, "") : "";
  if (!/^\d+\.\d+\.\d+$/u.test(text)) {
    throw new Error(`Невалидная версия Node: ${text || "пусто"}`);
  }
  return text;
}

function displayMisePath(misePath) {
  if (!path.isAbsolute(misePath)) return misePath;
  const relative = path.relative(root, misePath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? misePath : relative;
}

export function parsePinnedNodeVersion(source) {
  let inToolsTable = false;
  for (const rawLine of String(source).split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const table = /^\[([^\]]+)\]$/u.exec(line);
    if (table) {
      inToolsTable = table[1].trim() === "tools";
      continue;
    }
    if (!inToolsTable) continue;
    const assignment = /^node\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/u.exec(line);
    if (!assignment) continue;
    const value = (assignment[1] ?? assignment[2] ?? assignment[3] ?? "").trim().replace(/^v/u, "");
    if (!/^\d+\.\d+\.\d+$/u.test(value)) {
      throw new Error(
        `В mise.toml пин [tools] node должен быть точной версией вида X.Y.Z, получено: ${value || "пусто"}`,
      );
    }
    return value;
  }
  throw new Error("В mise.toml не найден пин [tools] node");
}

export async function readPinnedNodeVersion({ misePath = miseTomlPath } = {}) {
  return parsePinnedNodeVersion(await readFile(misePath, "utf8"));
}

export function assertPinnedNodeVersion({
  actual = process.versions.node,
  pinned,
  misePath = "mise.toml",
} = {}) {
  const actualVersion = normalizeNodeVersion(actual);
  const pinnedVersion = normalizeNodeVersion(pinned);
  if (actualVersion !== pinnedVersion) {
    throw new Error(
      `Версия Node ${actualVersion} не совпадает с пином [tools] node в ${displayMisePath(misePath)}: ${pinnedVersion}. ` +
        "Локальный выпуск macOS запускайте через mise: " +
        "`mise exec -- pnpm release:macos:preview <major|minor|patch>` или `mise exec -- pnpm release:macos <major|minor|patch>`.",
    );
  }
  return { actual: actualVersion, pinned: pinnedVersion };
}

export async function assertPinnedNodeVersionFromMise({
  actual = process.versions.node,
  pinned,
  misePath = miseTomlPath,
} = {}) {
  return assertPinnedNodeVersion({
    actual,
    pinned: pinned ?? (await readPinnedNodeVersion({ misePath })),
    misePath,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

  if (!Number.isFinite(major) || major < 24) {
    console.error(`[ci] Node.js 24+ is required, current=${process.versions.node}`);
    process.exit(1);
  }

  console.log(`[ci] Node.js version OK: ${process.versions.node}`);
}
