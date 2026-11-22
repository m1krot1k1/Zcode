import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { shouldReuseBundledRelease } from "./bundled-remote-assets-reuse.mjs";

/**
 * Fork-local Source Server release.
 *
 * Форк публикует собственные версии, которых нет на upstream CDN. Чтобы SSH/WSL
 * подключение работало без CDN, bundled-архив Source Server кладётся в ресурсы
 * приложения и затем загружается на remote host существующим транспортом.
 *
 * Скрипт строит release только для текущей платформы (host → server target) и
 * складывает его в packages/desktop/bundled-remote-assets/releases/<version>.
 */
const desktopPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopPackageRoot, "../..");
const targetByPlatform = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
};

const target = targetByPlatform[`${process.platform}-${process.arch}`];
if (!target) {
  console.log(
    `[bundled-remote-assets] no Source Server target for ${process.platform}-${process.arch}; skipping`,
  );
  process.exit(0);
}

const version = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).version;
const sourceReleaseDir = join(desktopPackageRoot, "mock-cdn", "releases", version);
const bundledRoot = join(desktopPackageRoot, "bundled-remote-assets");
const bundledReleaseDir = join(bundledRoot, "releases", version);
const bundledRevisionFile = join(bundledReleaseDir, "source-revision.txt");

function resolveSourceRevision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

const sourceRevision = resolveSourceRevision();

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function reusedRelease() {
  const descriptorFile = join(bundledReleaseDir, "source-server-release.json");
  const text = await readFile(descriptorFile, "utf8").catch(() => null);
  if (!text) return false;
  try {
    const descriptor = JSON.parse(text);
    const recordedRevision = (await readFile(bundledRevisionFile, "utf8").catch(() => "")).trim();
    const archive = descriptor.archives?.find((entry) => entry.target === target);
    if (!archive) return false;
    const archivePath = join(bundledReleaseDir, archive.fileName);
    const fileStat = await stat(archivePath).catch(() => null);
    if (!fileStat?.isFile()) return false;
    return shouldReuseBundledRelease({
      descriptor,
      target,
      expectedRevision: sourceRevision,
      recordedRevision,
      archiveSizeBytes: fileStat.size,
      archiveSha256: await sha256File(archivePath),
    });
  } catch {
    return false;
  }
}

if (await reusedRelease()) {
  console.log(`[bundled-remote-assets] reuse ${bundledReleaseDir}`);
  process.exit(0);
}

console.log(`[bundled-remote-assets] staging Source Server ${version} for ${target}`);
const stage = spawnSync(
  "pnpm",
  [
    "--filter",
    "@zcode/server-cli",
    "exec",
    "tsx",
    "src/packaging/stageRemoteAssetsCli.ts",
    "--target",
    target,
  ],
  { cwd: repoRoot, stdio: "inherit", env: process.env },
);
if (stage.error) throw stage.error;
if (stage.status !== 0) {
  throw new Error(`stage:remote-assets failed with code ${stage.status ?? "null"}`);
}

const descriptorPath = join(sourceReleaseDir, "source-server-release.json");
if (!(await stat(descriptorPath).catch(() => null))?.isFile()) {
  throw new Error(`Source Server descriptor was not produced: ${descriptorPath}`);
}

await rm(bundledRoot, { recursive: true, force: true });
await mkdir(dirname(bundledReleaseDir), { recursive: true });
await cp(sourceReleaseDir, bundledReleaseDir, { recursive: true });
// Bundled-release без commit-маркера нельзя отличить от архива, собранного из другого
// состояния исходников при том же version. Маркер делает повторную пересборку явной.
if (sourceRevision) await writeFile(bundledRevisionFile, `${sourceRevision}\n`, "utf8");
console.log(`[bundled-remote-assets] ${bundledReleaseDir}`);
