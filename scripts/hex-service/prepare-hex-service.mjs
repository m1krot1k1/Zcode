#!/usr/bin/env node

/**
 * Builds the bundled Hex voice engine (`hex-service`) for the target platform.
 *
 * Hex is MIT-licensed; the pinned commit and the two local patches live under
 * `scripts/hex-service/patches/`. A release build can supply a prebuilt binary
 * through `ZCODE_HEX_SERVICE_BINARY` instead of compiling Rust on the packaging
 * host. Models are never downloaded here; the app downloads them at runtime.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { getTargetPlatform } from "../../packages/desktop/scripts/target-platform.mjs";

const HEX_REPOSITORY = "https://github.com/anomalyco/hex.git";
const HEX_COMMIT = "36b26f2564e0bcc2668e73165c72c2b739daa7d5";
const HEX_VERSION = "3.4.0";
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PATCH_DIR = join(REPO_ROOT, "scripts", "hex-service", "patches");
const PATCHES = ["0001-embedded-shared-engine.patch", "0002-apple-intelligence-stub.patch"];
const target = getTargetPlatform();
const outputDir = join(REPO_ROOT, "packages", "desktop", "bundled-voice", target.key);
const binaryName = target.os === "win32" ? "hex-service.exe" : "hex-service";
const outputPath = join(outputDir, binaryName);
const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

function log(message) {
  console.log(`[prepare-hex-service] ${message}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: "inherit",
    ...options,
  });
}

function patchApplied(worktree, patchName) {
  try {
    run("git", ["apply", "--reverse", "--check", join(PATCH_DIR, patchName)], { cwd: worktree });
    return true;
  } catch {
    return false;
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeManifest(commit, patches) {
  const manifest = {
    schemaVersion: 1,
    engine: "hex",
    version: HEX_VERSION,
    commit,
    platform: target.key,
    binary: binaryName,
    sha256: sha256(outputPath),
    patches,
  };
  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.env.ZCODE_HEX_SERVICE_BINARY) {
  if (checkOnly) {
    log(`prebuilt binary configured: ${process.env.ZCODE_HEX_SERVICE_BINARY}`);
    process.exit(0);
  }
  const source = resolve(process.env.ZCODE_HEX_SERVICE_BINARY);
  if (!existsSync(source)) {
    throw new Error(`ZCODE_HEX_SERVICE_BINARY does not exist: ${source}`);
  }
  mkdirSync(outputDir, { recursive: true });
  cpSync(source, outputPath);
  if (target.os !== "win32") chmodSync(outputPath, 0o755);
  cpSync(join(REPO_ROOT, "scripts", "hex-service", "LICENSE"), join(outputDir, "LICENSE"));
  writeManifest(HEX_COMMIT, []);
  log(`copied prebuilt engine to ${outputPath}`);
  process.exit(0);
}

if (existsSync(outputPath) && !force) {
  log(`engine already present: ${outputPath}`);
  process.exit(0);
}
if (checkOnly) {
  log(`engine missing: ${outputPath}`);
  process.exit(1);
}

const worktree =
  process.env.ZCODE_HEX_WORKTREE ?? join(REPO_ROOT, ".zcode-runtime", "hex", HEX_COMMIT);
if (!existsSync(join(worktree, ".git"))) {
  mkdirSync(join(worktree, ".."), { recursive: true });
  log(`cloning Hex ${HEX_COMMIT}`);
  run("git", ["clone", "--filter=blob:none", HEX_REPOSITORY, worktree]);
}
run("git", ["fetch", "--depth", "1", "origin", HEX_COMMIT], { cwd: worktree });
run("git", ["checkout", "--force", HEX_COMMIT], { cwd: worktree });
run("git", ["clean", "-fdx"], { cwd: worktree });

const appliedPatches = [];
for (const patch of PATCHES) {
  if (patchApplied(worktree, patch)) {
    appliedPatches.push(patch);
    continue;
  }
  log(`applying ${patch}`);
  run("git", ["apply", join(PATCH_DIR, patch)], { cwd: worktree });
  appliedPatches.push(patch);
}

const env = { ...process.env };
if (target.os === "darwin") {
  // Command Line Tools installs swiftrt libraries outside the default linker search path.
  const swiftLib = "/Library/Developer/CommandLineTools/usr/lib/swift/macosx";
  env.LIBRARY_PATH = env.LIBRARY_PATH ? `${swiftLib}:${env.LIBRARY_PATH}` : swiftLib;
}
log(`building hex-service for ${target.key}`);
run("cargo", ["build", "--release", "--bin", "hex"], { cwd: worktree, env });

const built = join(worktree, "target", "release", target.os === "win32" ? "hex.exe" : "hex");
mkdirSync(outputDir, { recursive: true });
cpSync(built, outputPath);
if (target.os !== "win32") chmodSync(outputPath, 0o755);

if (target.os === "darwin") {
  const identity = process.env.ZCODE_HEX_CODESIGN_IDENTITY;
  if (identity) {
    log(`signing with ${identity}`);
    run("codesign", ["--force", "--options", "runtime", "--sign", identity, outputPath]);
  } else {
    // Local dev only: the upstream Hex signature cannot survive extraction/re-sign.
    run("codesign", ["--force", "--sign", "-", outputPath]);
  }
}

cpSync(join(REPO_ROOT, "scripts", "hex-service", "LICENSE"), join(outputDir, "LICENSE"));
writeManifest(HEX_COMMIT, appliedPatches);
log(`wrote ${outputPath}`);
