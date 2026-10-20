#!/usr/bin/env node
/**
 * Локальный выпуск macOS на этой машине.
 * Поднимает версию корня, собирает dmg и zip и создаёт GitHub Release на ветке dev.
 * В main не сливает и секрет не печатает.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { arch } from "node:os";
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

export function replacePackageVersion(source, next) {
  bumpSemver(next, "patch");
  const pattern = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  if (!pattern.test(source)) {
    throw new Error("В package.json нет поля version");
  }
  return source.replace(pattern, `$1${next}$3`);
}

export function macTargetArch(machineArch = arch()) {
  if (machineArch === "arm64" || machineArch === "x64") return machineArch;
  throw new Error(`Сборка macOS не поддерживает архитектуру ${machineArch}`);
}

export function selectMacReleaseAssets(fileNames, version) {
  return fileNames.filter((fileName) => {
    const base = path.basename(fileName);
    return (
      base.includes(version) &&
      base.includes("-mac-") &&
      (base.endsWith(".dmg") || base.endsWith(".zip"))
    );
  });
}

function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command[0]} завершился с кодом ${code}`));
    });
  });
}

async function main() {
  const level = process.argv[2];
  if (!level || level === "--help") {
    console.log("usage: node scripts/release-macos-local.mjs <major|minor|patch>");
    return;
  }
  const status = spawn("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const dirty = await new Promise((resolve, reject) => {
    let output = "";
    status.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    status.on("error", reject);
    status.on("exit", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`git status завершился с кодом ${code}`));
    });
  });
  if (dirty) {
    throw new Error("Рабочее дерево не чистое, выпуск остановлен");
  }
  const packagePath = path.join(root, "package.json");
  const original = await readFile(packagePath, "utf8");
  const manifest = JSON.parse(original);
  const next = bumpSemver(manifest.version, level);
  const targetArch = macTargetArch();
  await writeFile(packagePath, replacePackageVersion(original, next));
  console.log(`version ${next} arch ${targetArch}`);
  let committed = false;
  try {
    await run(["pnpm", "bundle:desktop", "--", "--os", "mac", "--arch", targetArch]);
    const distDir = path.join(root, "packages", "desktop", "dist");
    const assets = selectMacReleaseAssets(await readdir(distDir), next).map((name) =>
      path.join(distDir, name),
    );
    if (assets.length === 0) {
      throw new Error("Сборка не оставила dmg или zip для macOS");
    }
    await run(["git", "add", "package.json"]);
    await run(["git", "commit", "-m", `Выпустить macOS ${next}.`]);
    committed = true;
    await run(["git", "push", "origin", "dev"]);
    await run([
      "gh",
      "release",
      "create",
      `v${next}`,
      "--target",
      "dev",
      "--title",
      `Zcode ${next} для macOS`,
      "--notes",
      `Локальная сборка macOS ${targetArch}: dmg и zip.`,
      ...assets,
    ]);
    console.log(`release v${next}`);
  } catch (error) {
    if (!committed) {
      await writeFile(packagePath, original);
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
