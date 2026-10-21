#!/usr/bin/env node
/**
 * Публикует unsigned macOS Preview только как GitHub prerelease на exact commit ветки dev.
 * Apple identity и notarization credentials не читаются и не требуются.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, arch } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAssetHashes,
  assertMacReleaseAssetPair,
  assertReleaseBranch,
  assertReleaseMetadata,
  assertReleaseTargetSha,
  bumpSemver,
  clearExpectedMacReleaseAssets,
  expectedMacReleaseAssetNames,
  macTargetArch,
  preflightMacRelease,
  replacePackageVersion,
  resolveTagCommitSha,
} from "./release-macos-local.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const previewProductName = "ZCode Preview";
const previewBundleId = "dev.zcode.app.preview";
const productionZCodeEndpoint = "https://zcode.z.ai/api/v1";

export function validatePreviewTestEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Для Preview задайте отдельный ZCODE_PREVIEW_TEST_BASE_URL");
  }
  let endpoint;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error("ZCODE_PREVIEW_TEST_BASE_URL должен быть корректным HTTPS URL");
  }
  const normalizedPath = endpoint.pathname.replace(/\/+$/u, "") || "/";
  const production = new URL(productionZCodeEndpoint);
  const isProductionRoute =
    endpoint.origin === production.origin &&
    normalizedPath === (production.pathname.replace(/\/+$/u, "") || "/");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    isProductionRoute
  ) {
    throw new Error(
      "ZCODE_PREVIEW_TEST_BASE_URL должен отличаться от production endpoint и использовать HTTPS без credentials или fragment",
    );
  }
  return endpoint.toString().replace(/\/$/u, "");
}

export function createPreviewBuildEnvironment(sourceEnv = process.env) {
  const testEndpoint = validatePreviewTestEndpoint(sourceEnv.ZCODE_PREVIEW_TEST_BASE_URL);
  const env = { ...sourceEnv };
  // Preview никогда не получает Apple signing credentials и принудительно отключает авто-подпись.
  for (const name of Object.keys(env)) {
    if (
      /^(?:APPLE_|CSC_)/u.test(name) ||
      /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)$/u.test(name) ||
      /^(?:ZCODE_BASE_URL|ZCODE_ENDPOINT_ORIGIN|ZCODE_TEST_BASE_URL|ZCODE_PRODUCTION_BASE_URL)$/u.test(
        name,
      )
    ) {
      delete env[name];
    }
  }
  Object.assign(env, {
    ZCODE_ENV: "test",
    ZCODE_BASE_URL: testEndpoint,
    ZCODE_ENDPOINT_ORIGIN: testEndpoint,
    ZCODE_TEST_BASE_URL: testEndpoint,
    ZCODE_PRODUCTION_BASE_URL: testEndpoint,
    ZCODE_PREVIEW_IDENTITY: "1",
    ZCODE_ENABLE_MAC_SIGN: "0",
    ZCODE_ENABLE_MAC_NOTARIZE: "0",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  });
  return env;
}

export function buildPreviewReleaseCreateArgs({ tag, commitSha, targetArch, assetPaths }) {
  assertReleaseTargetSha(commitSha, commitSha);
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error(`Невалидный release tag: ${tag}`);
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error(`Нужна точная архитектура release asset: ${targetArch}`);
  }
  const expectedNames = expectedMacReleaseAssetNames(
    tag.slice(1),
    targetArch,
    previewProductName,
    "_TEST",
  );
  if (
    !Array.isArray(assetPaths) ||
    assetPaths.length !== expectedNames.length ||
    assetPaths
      .map((asset) => path.basename(asset))
      .sort()
      .some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("Preview Release должен содержать точную пару versioned DMG/ZIP");
  }
  return [
    "gh",
    "release",
    "create",
    tag,
    "--target",
    commitSha,
    "--title",
    `ZCode Preview ${tag.slice(1)} для macOS`,
    "--notes",
    `Preview-сборка macOS (${targetArch}) подключается к тестовому backend ZCode (артефакты с суффиксом _TEST), не к production endpoints. Приложение без Apple-подписи и notarization. При первом запуске macOS может блокировать приложение: откройте его через Finder и подтвердите запуск в системном предупреждении. Это Preview, не production-релиз.`,
    "--prerelease",
    ...assetPaths,
  ];
}

export function assertPreviewReleaseMetadata(release, expectedTag, expectedAssetNames) {
  assertReleaseMetadata(release, expectedTag, expectedAssetNames);
  if (release.isPrerelease !== true) {
    throw new Error(`GitHub не подтвердил prerelease для ${expectedTag}`);
  }
}

export function assertPreviewReleasePreconditions({ platform, branchName, dirty }) {
  if (platform !== "darwin")
    throw new Error("Unsigned macOS Preview release must be built on macOS.");
  assertReleaseBranch(branchName);
  if (dirty) throw new Error("Рабочее дерево не чистое, Preview выпуск остановлен");
}

export function assertPreviewReleaseBaseSha(headSha, originDevSha) {
  assertReleaseTargetSha(originDevSha, headSha);
}

export function assertPreviewReleaseTagAvailable(tag, existingTagSha) {
  if (existingTagSha.trim()) throw new Error(`Удалённый Git tag уже существует: ${tag}`);
}

export function assertPreviewResumeCandidate({
  version,
  branchName,
  dirty,
  headSha,
  originDevSha,
  commitMessage,
}) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Невалидная версия Preview: ${version}`);
  assertPreviewReleasePreconditions({ platform: "darwin", branchName, dirty });
  assertReleaseTargetSha(headSha, originDevSha);
  if (commitMessage !== `Выпустить macOS Preview ${version}.`) {
    throw new Error(`HEAD не является version commit для Preview ${version}`);
  }
}

export function assertPreviewResumeTagTarget(tag, existingTagSha, commitSha) {
  if (existingTagSha) assertReleaseTargetSha(existingTagSha, commitSha);
  return tag;
}

export function isMissingGitHubRelease(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 404: Not Found/u.test(message);
}

function run(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      stdio: "inherit",
      env: options.env ?? process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command[0]} завершился с кодом ${code}`));
    });
  });
}

function capture(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command[0]} завершился с кодом ${code}: ${stderr.trim()}`));
    });
  });
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyPublishedPreview(tag, assets, commitSha, hashes) {
  const metadata = JSON.parse(
    await capture([
      "gh",
      "release",
      "view",
      tag,
      "--json",
      "tagName,isDraft,isPrerelease,assets,url",
    ]),
  );
  assertPreviewReleaseMetadata(metadata, tag, assets);
  assertReleaseTargetSha(
    await resolveTagCommitSha(tag, async (route) =>
      JSON.parse(await capture(["gh", "api", route])),
    ),
    commitSha,
  );

  const verificationDir = await mkdtemp(path.join(tmpdir(), "zcode-preview-release-verify-"));
  try {
    await run(["gh", "release", "download", tag, "--dir", verificationDir]);
    const downloadedHashes = new Map();
    for (const name of await readdir(verificationDir)) {
      downloadedHashes.set(name, await sha256File(path.join(verificationDir, name)));
    }
    assertAssetHashes(hashes, downloadedHashes);
  } finally {
    await rm(verificationDir, { recursive: true, force: true });
  }
  return metadata.url;
}

async function readExistingPreviewRelease(tag) {
  try {
    return JSON.parse(
      await capture([
        "gh",
        "release",
        "view",
        tag,
        "--json",
        "tagName,isDraft,isPrerelease,assets,url",
      ]),
    );
  } catch (error) {
    if (isMissingGitHubRelease(error)) return undefined;
    throw error;
  }
}

export async function createPreviewReleasePlan({ version, targetArch, assetPaths, commitSha }) {
  assertReleaseTargetSha(commitSha, commitSha);
  const tag = `v${version}`;
  const expected = expectedMacReleaseAssetNames(version, targetArch, previewProductName, "_TEST");
  const assetNames = assetPaths.map((assetPath) => path.basename(assetPath));
  assertMacReleaseAssetPair(assetNames, version, targetArch, previewProductName, "_TEST");
  return {
    tag,
    args: buildPreviewReleaseCreateArgs({ tag, commitSha, targetArch, assetPaths }),
    expectedAssetNames: expected,
  };
}

async function main() {
  const mode = process.argv[2];
  const resume = mode === "resume";
  const levelOrVersion = process.argv[resume ? 3 : 2];
  if (!levelOrVersion || mode === "--help") {
    console.log(
      "usage: pnpm release:macos:preview <major|minor|patch>\n       pnpm release:macos:preview:resume <version>",
    );
    return;
  }
  const testEndpoint = validatePreviewTestEndpoint(process.env.ZCODE_PREVIEW_TEST_BASE_URL);
  const baseSha = await capture(["git", "rev-parse", "HEAD"]);
  assertPreviewReleasePreconditions({
    platform: process.platform,
    branchName: await capture(["git", "branch", "--show-current"]),
    dirty: (await capture(["git", "status", "--porcelain"])).length > 0,
  });
  await run(["gh", "auth", "status"]);
  await run(["git", "fetch", "origin", "dev:refs/remotes/origin/dev"]);
  assertPreviewReleaseBaseSha(baseSha, await capture(["git", "rev-parse", "origin/dev"]));

  const packagePath = path.join(root, "package.json");
  const original = await readFile(packagePath, "utf8");
  const manifest = JSON.parse(original);
  const version = resume ? levelOrVersion : bumpSemver(manifest.version, levelOrVersion);
  if (resume && manifest.version !== version) {
    throw new Error(`package.json version ${manifest.version} не совпадает с resume ${version}`);
  }
  const tag = `v${version}`;
  const targetArch = macTargetArch(arch());
  const remoteTagEntry = await capture([
    "git",
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]);
  if (!resume) assertPreviewReleaseTagAvailable(tag, remoteTagEntry);

  const distDir = path.join(root, "packages", "desktop", "dist");
  let committed = resume;
  let commitSha;
  let preflight;
  try {
    if (resume) {
      const commitMessage = await capture(["git", "show", "-s", "--format=%s", "HEAD"]);
      assertPreviewResumeCandidate({
        version,
        branchName: await capture(["git", "branch", "--show-current"]),
        dirty: (await capture(["git", "status", "--porcelain"])).length > 0,
        headSha: baseSha,
        originDevSha: await capture(["git", "rev-parse", "origin/dev"]),
        commitMessage,
      });
      commitSha = baseSha;
      if (remoteTagEntry.trim()) {
        const existingTagSha = await resolveTagCommitSha(tag, async (route) =>
          JSON.parse(await capture(["gh", "api", route])),
        );
        assertPreviewResumeTagTarget(tag, existingTagSha, commitSha);
      }
    } else {
      await clearExpectedMacReleaseAssets({
        distDir,
        version,
        targetArch,
        productName: previewProductName,
        artifactSuffix: "_TEST",
      });
      await writeFile(packagePath, replacePackageVersion(original, version));
      await run(["git", "add", "package.json"]);
      const buildTreeSha = await capture(["git", "write-tree"]);
      const buildEnv = createPreviewBuildEnvironment({
        ...process.env,
        ZCODE_PREVIEW_TEST_BASE_URL: testEndpoint,
      });
      await run(["pnpm", "bundle:desktop", "--", "--os", "mac", "--arch", targetArch], {
        env: buildEnv,
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
      preflight = await preflightMacRelease({
        version,
        targetArch,
        distDir,
        productName: previewProductName,
        artifactSuffix: "_TEST",
        expectedBundleId: previewBundleId,
        requireStaple: false,
        requireUnsigned: true,
        runCommand: run,
      });
      await run(["git", "commit", "-m", `Выпустить macOS Preview ${version}.`]);
      committed = true;
      commitSha = await capture(["git", "rev-parse", "HEAD"]);
      assertReleaseTargetSha(await capture(["git", "rev-parse", "HEAD^{tree}"]), buildTreeSha);
      assertReleaseTargetSha(await capture(["git", "rev-parse", "HEAD^"]), baseSha);
      assertPreviewReleaseBaseSha(baseSha, await capture(["git", "rev-parse", "origin/dev"]));
      await run(["git", "push", "origin", "dev"]);
      const remoteDev = (await capture(["git", "ls-remote", "origin", "refs/heads/dev"])).split(
        /\s+/u,
      )[0];
      assertReleaseTargetSha(remoteDev, commitSha);
      assertPreviewReleaseTagAvailable(
        tag,
        await capture(["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`]),
      );
    }

    if (!preflight) {
      preflight = await preflightMacRelease({
        version,
        targetArch,
        distDir,
        productName: previewProductName,
        artifactSuffix: "_TEST",
        expectedBundleId: previewBundleId,
        requireStaple: false,
        requireUnsigned: true,
        runCommand: run,
      });
    }
    const existingRelease = await readExistingPreviewRelease(tag);
    if (existingRelease) {
      assertPreviewReleaseMetadata(existingRelease, tag, preflight.assetNames);
      assertReleaseTargetSha(
        await resolveTagCommitSha(tag, async (route) =>
          JSON.parse(await capture(["gh", "api", route])),
        ),
        commitSha,
      );
    } else {
      if (resume) {
        const currentTagEntry = await capture([
          "git",
          "ls-remote",
          "--tags",
          "origin",
          `refs/tags/${tag}`,
        ]);
        if (currentTagEntry.trim()) {
          const existingTagSha = await resolveTagCommitSha(tag, async (route) =>
            JSON.parse(await capture(["gh", "api", route])),
          );
          assertPreviewResumeTagTarget(tag, existingTagSha, commitSha);
        }
      }
      const plan = await createPreviewReleasePlan({
        version,
        targetArch,
        assetPaths: preflight.assetPaths,
        commitSha,
      });
      await run(plan.args);
    }
    const releaseUrl = await verifyPublishedPreview(
      tag,
      preflight.assetNames,
      commitSha,
      preflight.assetHashes,
    );
    console.log(`Preview prerelease ${tag} commit ${commitSha}: ${releaseUrl}`);
  } catch (error) {
    if (!resume && !committed) {
      await run(["git", "restore", "--staged", "--", "package.json"]);
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
