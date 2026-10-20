#!/usr/bin/env node
/**
 * Локальный выпуск macOS на этой машине.
 * Поднимает версию корневого package.json и собирает desktop bundle.
 * Тег, commit и push не делает: их ставит человек или вторая машина после проверки.
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function bumpSemver(version, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Версия должна быть X.Y.Z, получено ${version}`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (level === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === "minor") {
    minor += 1;
    patch = 0;
  } else if (level === "patch") {
    patch += 1;
  } else {
    throw new Error("Уровень: major, minor или patch");
  }
  return `${major}.${minor}.${patch}`;
}

async function main() {
  const level = process.argv[2];
  if (!level || level === "--help") {
    console.log("usage: node scripts/release-macos-local.mjs <major|minor|patch>");
    return;
  }
  const packagePath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  const next = bumpSemver(manifest.version, level);
  manifest.version = next;
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`version ${next}`);
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["bundle:desktop"], { cwd: root, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bundle:desktop завершился с кодом ${code}`));
    });
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
