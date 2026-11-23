import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { BUNDLED_SOURCE_SERVER_TARGETS } from "./bundled-remote-assets-targets.mjs";
import { shouldReuseBundledRelease } from "./bundled-remote-assets-reuse.mjs";

/**
 * Fork-local Source Server release.
 *
 * Форк публикует собственные версии, которых нет на upstream CDN. Чтобы SSH/WSL
 * подключение работало без CDN, bundled-архив Source Server кладётся в ресурсы
 * приложения и затем загружается на remote host существующим транспортом.
 *
 * Скрипт строит release для ВСЕХ удалённых целей (linux/darwin × x64/arm64),
 * независимо от платформы сборки. Иначе macOS-приложение несёт только
 * darwin-arm64 и падает на подключении к Linux с
 * "Source Server descriptor is missing target: linux-x64".
 */
const desktopPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopPackageRoot, "../..");

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

async function archiveFingerprint(path) {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile()) return null;
  return { sizeBytes: fileStat.size, sha256: await sha256File(path) };
}

async function reusedRelease() {
  const descriptorFile = join(bundledReleaseDir, "source-server-release.json");
  const text = await readFile(descriptorFile, "utf8").catch(() => null);
  if (!text) return false;
  try {
    const descriptor = JSON.parse(text);
    const recordedRevision = (await readFile(bundledRevisionFile, "utf8").catch(() => "")).trim();
    const archives = {};
    for (const target of BUNDLED_SOURCE_SERVER_TARGETS) {
      const archive = descriptor.archives?.find((entry) => entry.target === target);
      if (!archive) return false;
      const fingerprint = await archiveFingerprint(join(bundledReleaseDir, archive.fileName));
      if (!fingerprint) return false;
      archives[target] = fingerprint;
    }
    return shouldReuseBundledRelease({
      descriptor,
      targets: BUNDLED_SOURCE_SERVER_TARGETS,
      expectedRevision: sourceRevision,
      recordedRevision,
      archives,
    });
  } catch {
    return false;
  }
}

if (await reusedRelease()) {
  console.log(`[bundled-remote-assets] reuse ${bundledReleaseDir}`);
  process.exit(0);
}

console.log(
  `[bundled-remote-assets] staging Source Server ${version} for ${BUNDLED_SOURCE_SERVER_TARGETS.join(", ")}`,
);
const stage = spawnSync(
  "pnpm",
  ["--filter", "@zcode/server-cli", "exec", "tsx", "src/packaging/stageRemoteAssetsCli.ts"],
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
