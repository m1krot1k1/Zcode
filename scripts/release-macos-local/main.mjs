import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { assertPinnedNodeVersionFromMise } from "../assert-node-version.mjs";
import {
  createMacReleaseBuildEnvironment,
  preflightMacReleaseSecurity,
} from "../macos-release-security.mjs";
import { clearExpectedMacReleaseAssets, clearMacAppOutput } from "./assets.mjs";
import { capture, run } from "./commands.mjs";
import { assertReleaseTargetSha, buildReleaseCreateArgs } from "./github-release.mjs";
import { preflightMacRelease } from "./preflight.mjs";
import { verifyPublishedRelease } from "./publish.mjs";
import { repoRoot } from "./repo-root.mjs";
import {
  assertReleaseBranch,
  bumpSemver,
  macTargetArch,
  replacePackageVersion,
} from "./version.mjs";

async function readGitStatusPorcelain() {
  const status = spawn("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  return new Promise((resolve, reject) => {
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
}

export async function main() {
  const level = process.argv[2];
  if (!level || level === "--help") {
    console.log("usage: node scripts/release-macos-local.mjs <major|minor|patch>");
    return;
  }
  await assertPinnedNodeVersionFromMise();
  bumpSemver("0.0.0", level);
  const releaseSecurity = await preflightMacReleaseSecurity({
    env: process.env,
    platform: process.platform,
    captureCommand: capture,
  });
  const releaseBuildEnvironment = createMacReleaseBuildEnvironment(releaseSecurity.identity);
  assertReleaseBranch(await capture(["git", "branch", "--show-current"]));
  if (await readGitStatusPorcelain()) {
    throw new Error("Рабочее дерево не чистое, выпуск остановлен");
  }
  const baseSha = await capture(["git", "rev-parse", "HEAD"]);
  await run(["git", "fetch", "origin", "dev:refs/remotes/origin/dev"]);
  assertReleaseTargetSha(await capture(["git", "rev-parse", "origin/dev"]), baseSha);
  const packagePath = path.join(repoRoot, "package.json");
  const original = await readFile(packagePath, "utf8");
  const manifest = JSON.parse(original);
  const next = bumpSemver(manifest.version, level);
  const targetArch = macTargetArch();
  const tag = `v${next}`;
  const distDir = path.join(repoRoot, "packages", "desktop", "dist");
  if (await capture(["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
    throw new Error(`Удалённый Git tag уже существует: ${tag}`);
  }
  await clearExpectedMacReleaseAssets({ distDir, version: next, targetArch });
  await clearMacAppOutput({ distDir, targetArch });
  await writeFile(packagePath, replacePackageVersion(original, next));
  console.log(`version ${next} arch ${targetArch}`);
  let committed = false;
  try {
    await run(["git", "add", "package.json"]);
    const buildTreeSha = await capture(["git", "write-tree"]);
    await run(["pnpm", "bundle:desktop", "--", "--os", "mac", "--arch", targetArch], {
      env: releaseBuildEnvironment,
    });
    const statusAfterBuild = await capture([
      "git",
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (statusAfterBuild !== "M  package.json") {
      throw new Error(
        `Сборка изменила рабочее дерево неожиданным образом: ${statusAfterBuild || "пусто"}`,
      );
    }
    assertReleaseTargetSha(await capture(["git", "write-tree"]), buildTreeSha);
    const preflight = await preflightMacRelease({
      version: next,
      targetArch,
      distDir,
      runCommand: run,
    });
    const { assetNames, assetPaths: assets, assetHashes } = preflight;
    await run(["git", "commit", "-m", `Выпустить macOS ${next}.`]);
    committed = true;
    const releaseCommitSha = await capture(["git", "rev-parse", "HEAD"]);
    assertReleaseTargetSha(await capture(["git", "rev-parse", "HEAD^{tree}"]), buildTreeSha);
    assertReleaseTargetSha(await capture(["git", "rev-parse", "HEAD^"]), baseSha);
    if (await capture(["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
      throw new Error(`Удалённый Git tag появился во время сборки: ${tag}`);
    }
    assertReleaseTargetSha(await capture(["git", "rev-parse", "origin/dev"]), baseSha);
    await run(["git", "push", "origin", "dev"]);
    const pushedRef = await capture(["git", "ls-remote", "origin", "refs/heads/dev"]);
    const pushedSha = pushedRef.split(/\s+/u)[0] ?? "";
    assertReleaseTargetSha(pushedSha, releaseCommitSha);
    await run(
      buildReleaseCreateArgs({
        tag,
        commitSha: releaseCommitSha,
        targetArch,
        assetPaths: assets,
      }),
    );
    const releaseUrl = await verifyPublishedRelease(tag, assetNames, releaseCommitSha, assetHashes);
    console.log(`release ${tag} commit ${releaseCommitSha}: ${releaseUrl}`);
  } catch (error) {
    if (!committed) {
      await run(["git", "restore", "--staged", "--", "package.json"]);
      await writeFile(packagePath, original);
    }
    throw error;
  }
}
