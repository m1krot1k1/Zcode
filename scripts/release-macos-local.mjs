#!/usr/bin/env node
/**
 * Локальный выпуск macOS на этой машине.
 * Поднимает версию корня, собирает dmg и zip и создаёт GitHub Release на ветке dev.
 * В main не сливает и секрет не печатает.
 */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { arch } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMacReleaseBuildEnvironment,
  preflightMacReleaseSecurity,
} from "./macos-release-security.mjs";
import { assertPinnedNodeVersionFromMise } from "./assert-node-version.mjs";

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

export function assertReleaseBranch(branchName) {
  if (branchName !== "dev") {
    throw new Error(
      `Локальный выпуск разрешён только из dev, сейчас: ${branchName || "неизвестно"}`,
    );
  }
}

export function selectMacReleaseAssets(
  fileNames,
  version,
  targetArch,
  productName = "ZCode",
  artifactSuffix = "",
) {
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error(`Нужна точная архитектура release asset: ${targetArch}`);
  }
  const expectedName = new RegExp(
    `^${productName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-${version.replaceAll(".", "\\.")}-mac-${targetArch}${artifactSuffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.(?:dmg|zip)$`,
  );
  return fileNames
    .filter((fileName) => {
      const base = path.basename(fileName);
      return expectedName.test(base);
    })
    .sort();
}

export function assertMacReleaseAssetPair(
  assetNames,
  version,
  targetArch,
  productName = "ZCode",
  artifactSuffix = "",
) {
  const expected = expectedMacReleaseAssetNames(version, targetArch, productName, artifactSuffix);
  const actual = [...assetNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(
      `Нужна ровно пара ${expected.join(" и ")}; найдено: ${actual.join(", ") || "ничего"}`,
    );
  }
}

export function expectedMacReleaseAssetNames(
  version,
  targetArch,
  productName = "ZCode",
  artifactSuffix = "",
) {
  bumpSemver(version, "patch");
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error(`Нужна точная архитектура release asset: ${targetArch}`);
  }
  return [
    `${productName}-${version}-mac-${targetArch}${artifactSuffix}.dmg`,
    `${productName}-${version}-mac-${targetArch}${artifactSuffix}.zip`,
  ].sort();
}

export async function clearExpectedMacReleaseAssets({
  distDir,
  version,
  targetArch,
  productName = "ZCode",
  artifactSuffix = "",
  removeFile = (filePath) => rm(filePath, { force: true }),
}) {
  const paths = expectedMacReleaseAssetNames(version, targetArch, productName, artifactSuffix).map(
    (name) => path.join(distDir, name),
  );
  for (const filePath of paths) await removeFile(filePath);
  return paths;
}

export function selectMacReleaseAppBundle(appEntries, expectedName = "ZCode.app") {
  const appNames = appEntries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => entry.name);
  if (appNames.length !== 1 || appNames[0] !== expectedName) {
    const requirement =
      expectedName === "ZCode.app"
        ? "Для стабильного macOS релиза нужна ровно одна production-сборка ZCode.app"
        : `Для macOS релиза нужна ровно одна сборка ${expectedName}`;
    throw new Error(`${requirement}; найдено: ${appNames.join(", ") || "ничего"}`);
  }
  return appNames[0];
}

export function assertReleaseTargetSha(actualSha, expectedSha) {
  const actual = typeof actualSha === "string" ? actualSha.trim().toLowerCase() : "";
  const expected = typeof expectedSha === "string" ? expectedSha.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(expected) || actual !== expected) {
    throw new Error(
      `SHA ${actual || "отсутствует"} не совпадает с ожидаемым ${expected || "невалиден"}`,
    );
  }
}

export function buildReleaseCreateArgs({ tag, commitSha, targetArch, assetPaths }) {
  assertReleaseTargetSha(commitSha, commitSha);
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error(`Невалидный release tag: ${tag}`);
  if (!Array.isArray(assetPaths) || assetPaths.length !== 2) {
    throw new Error("GitHub Release должен содержать ровно два macOS assets");
  }
  return [
    "gh",
    "release",
    "create",
    tag,
    "--target",
    commitSha,
    "--title",
    `Zcode ${tag.slice(1)} для macOS`,
    "--notes",
    `Локальная сборка macOS ${targetArch}: dmg и zip.`,
    ...assetPaths,
  ];
}

export async function resolveTagCommitSha(tagName, readApiJson) {
  let route = `repos/{owner}/{repo}/git/ref/tags/${tagName}`;
  let response = await readApiJson(route);
  let object = response?.object;
  const seen = new Set();
  while (object?.type === "tag") {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(object.sha ?? "") || seen.has(object.sha)) {
      throw new Error(`GitHub tag ${tagName} содержит невалидную или циклическую цепочку`);
    }
    seen.add(object.sha);
    route = `repos/{owner}/{repo}/git/tags/${object.sha}`;
    response = await readApiJson(route);
    object = response?.object;
    if (seen.size > 8) throw new Error(`GitHub tag ${tagName} слишком глубоко вложен`);
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(object.sha ?? "")) {
    throw new Error(`GitHub tag ${tagName} не разрешается напрямую в commit`);
  }
  return object.sha.toLowerCase();
}

export function assertReleaseMetadata(release, expectedTag, expectedAssetNames) {
  if (!release || release.tagName !== expectedTag || release.isDraft !== false) {
    throw new Error(`GitHub не подтвердил опубликованный release ${expectedTag}`);
  }
  const actualAssetNames = Array.isArray(release.assets)
    ? release.assets
        .map((asset) => asset?.name)
        .filter((name) => typeof name === "string")
        .sort()
    : [];
  const expected = expectedAssetNames.map(normalizeGitHubReleaseAssetName).sort();
  if (
    actualAssetNames.length !== expected.length ||
    actualAssetNames.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `GitHub release ${expectedTag} имеет неверный набор файлов: ${actualAssetNames.join(", ") || "пусто"}`,
    );
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertAssetHashes(expectedHashes, downloadedHashes) {
  const localNameByGitHubName = new Map(
    [...expectedHashes.keys()].map((name) => [normalizeGitHubReleaseAssetName(name), name]),
  );
  for (const [githubName, downloadedHash] of downloadedHashes) {
    const localName = localNameByGitHubName.get(githubName);
    if (!localName) {
      throw new Error(`Неожиданный GitHub asset: ${githubName}`);
    }
    const expectedHash = expectedHashes.get(localName);
    if (!downloadedHash || downloadedHash !== expectedHash) {
      throw new Error(`GitHub asset ${localName} не совпадает с локальной сборкой`);
    }
  }
  if (downloadedHashes.size !== expectedHashes.size) {
    throw new Error("Набор скачанных GitHub assets не совпадает с локальной сборкой");
  }
}

export function normalizeGitHubReleaseAssetName(localName) {
  return localName.replaceAll(" ", ".");
}

export function assertZipContainsOnlyReleaseApp(entries, appName = "ZCode.app") {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("macOS ZIP не содержит записей приложения");
  }
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.startsWith("/") ||
      entry.includes("\\")
    ) {
      throw new Error("macOS ZIP содержит небезопасный путь");
    }
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const parts = normalized.split("/");
    if (
      parts.some((part) => part === "" || part === "." || part === "..") ||
      (normalized !== appName && !normalized.startsWith(`${appName}/`))
    ) {
      throw new Error(`macOS ZIP должен содержать только ${appName} и его файлы`);
    }
  }
}

export async function assertUnsignedMacApp(appRoot) {
  for (const relativePath of ["Contents/_CodeSignature", "Contents/CodeResources"]) {
    try {
      await lstat(path.join(appRoot, relativePath));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Preview app содержит подпись ${relativePath}; ожидается unsigned сборка`);
  }
}

function parseMacArchs(output) {
  const text = String(output).trim();
  const architectureList = text.split(/\b(?:are|architecture):\s*/u).at(-1) ?? text;
  return architectureList
    .split(/\s+/u)
    .map((value) => value.replace(/[^a-z0-9_]/giu, ""))
    .filter((value) => ["arm64", "x86_64", "i386"].includes(value));
}

function assertPathWithin(parentPath, candidatePath, label) {
  const relative = path.relative(parentPath, candidatePath);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} находится вне app bundle`);
  }
}

async function hashMacAppBundle(appPath) {
  const hash = createHash("sha256");
  const rootInfo = await lstat(appPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Release app bundle должен быть обычной директорией: ${appPath}`);
  }

  async function visit(directoryPath, relativePath) {
    const entries = (await readdir(directoryPath)).sort((left, right) => left.localeCompare(right));
    for (const name of entries) {
      const entryPath = path.join(directoryPath, name);
      const entryRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const info = await lstat(entryPath);
      const kind = info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other";
      hash.update(`${entryRelativePath}\0${kind}\0${info.mode & 0o7777}\0`);
      if (kind === "symlink") {
        const target = await readlink(entryPath);
        hash.update(`${Buffer.byteLength(target)}\0${target}`);
      } else if (kind === "directory") {
        await visit(entryPath, entryRelativePath);
      } else if (kind === "file") {
        hash.update(`${info.size}\0`);
        for await (const chunk of createReadStream(entryPath)) hash.update(chunk);
      } else {
        throw new Error(`Неподдерживаемый тип файла в release app: ${entryRelativePath}`);
      }
    }
  }

  hash.update(`ZCode.app\0directory\0${rootInfo.mode & 0o7777}\0`);
  await visit(appPath, "");
  return hash.digest("hex");
}

async function verifyMacReleaseAppBundle({
  appPath,
  appBundleName = path.basename(appPath),
  version,
  targetArch,
  productName = "ZCode",
  expectedBundleId = "dev.zcode.app",
  requireStaple = true,
  requireUnsigned = false,
  runCommand,
  captureCommand,
  hashDirectory,
}) {
  const appEntry = await lstat(appPath);
  if (!appEntry.isDirectory() || appEntry.isSymbolicLink()) {
    throw new Error(`Release app bundle должен быть обычной директорией: ${appPath}`);
  }
  const appRoot = await realpath(appPath);
  const infoPlistPath = path.join(appRoot, "Contents", "Info.plist");
  const infoPlistRealPath = await realpath(infoPlistPath);
  assertPathWithin(appRoot, infoPlistRealPath, "Info.plist");
  const bundleVersion = await captureCommand([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleShortVersionString",
    infoPlistPath,
  ]);
  if (bundleVersion.trim() !== version) {
    throw new Error(
      `Release app version ${bundleVersion.trim() || "отсутствует"} не совпадает с ${version}`,
    );
  }

  const bundleId = await captureCommand([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleIdentifier",
    infoPlistPath,
  ]);
  if (bundleId.trim() !== expectedBundleId) {
    throw new Error(
      `Release app identity ${bundleId.trim() || "отсутствует"} не совпадает с ${expectedBundleId}`,
    );
  }
  if (requireUnsigned) await assertUnsignedMacApp(appRoot);

  const executableName = await captureCommand([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :CFBundleExecutable",
    infoPlistPath,
  ]);
  const safeExecutableName = executableName.trim();
  if (!/^[a-z0-9._-]+$/iu.test(safeExecutableName)) {
    throw new Error("CFBundleExecutable содержит невалидное имя");
  }
  const executablePath = path.join(appRoot, "Contents", "MacOS", safeExecutableName);
  const executableRealPath = await realpath(executablePath);
  assertPathWithin(appRoot, executableRealPath, "CFBundleExecutable");
  const archOutput = await captureCommand(["lipo", "-archs", executablePath]);
  const actualArchs = parseMacArchs(archOutput);
  const expectedArch = targetArch === "x64" ? "x86_64" : targetArch;
  if (actualArchs.length !== 1 || actualArchs[0] !== expectedArch) {
    throw new Error(
      `Release app architecture ${actualArchs.join(", ") || "отсутствует"} не совпадает с ${expectedArch}`,
    );
  }

  if (requireStaple) {
    await runCommand(["bash", path.join(root, "scripts", "doctor-macos-release-app.sh"), appRoot], {
      env: { ZCODE_MACOS_REQUIRE_APP_STAPLE: "1" },
    });
  }
  return {
    version: bundleVersion.trim(),
    architecture: actualArchs[0],
    productName,
    appBundleName,
    bundleId: bundleId.trim(),
    requireStaple,
    treeSha256: await hashDirectory(appRoot),
  };
}

function assertPackagedAppMatchesSource(sourceApp, packagedApp, label) {
  if (
    sourceApp.version !== packagedApp.version ||
    sourceApp.architecture !== packagedApp.architecture ||
    sourceApp.productName !== packagedApp.productName ||
    sourceApp.appBundleName !== packagedApp.appBundleName ||
    sourceApp.bundleId !== packagedApp.bundleId
  ) {
    throw new Error(`${label} app version/architecture отличается от проверенной сборки`);
  }
  if (sourceApp.treeSha256 !== packagedApp.treeSha256) {
    throw new Error(
      `${label} app payload/signature/staple отличается от проверенного source bundle (устаревший или изменённый app)`,
    );
  }
}

async function verifyZipPayload({
  zipPath,
  sourceApp,
  version,
  targetArch,
  runCommand,
  captureCommand,
  hashDirectory,
  createTemporaryDirectory,
  removeTemporaryDirectory,
}) {
  const appDirectoryName = sourceApp.appBundleName;
  const listing = await captureCommand(["unzip", "-Z1", zipPath]);
  const entries = listing.split(/\r?\n/u).filter((entry) => entry.length > 0);
  assertZipContainsOnlyReleaseApp(entries, appDirectoryName);
  const extractionDir = await createTemporaryDirectory("zcode-release-zip-");
  try {
    await runCommand(["ditto", "-x", "-k", zipPath, extractionDir]);
    const extractionRoot = await realpath(extractionDir);
    const appPath = path.join(extractionRoot, appDirectoryName);
    const appRealPath = await realpath(appPath);
    assertPathWithin(extractionRoot, appRealPath, "ZIP app bundle");
    const packagedApp = await verifyMacReleaseAppBundle({
      appPath,
      version,
      targetArch,
      productName: sourceApp.productName,
      appBundleName: appDirectoryName,
      expectedBundleId: sourceApp.bundleId,
      requireStaple: sourceApp.requireStaple,
      requireUnsigned: !sourceApp.requireStaple,
      runCommand,
      captureCommand,
      hashDirectory,
    });
    assertPackagedAppMatchesSource(sourceApp, packagedApp, "ZIP");
  } finally {
    await removeTemporaryDirectory(extractionDir);
  }
}

async function verifyDmgPayload({
  dmgPath,
  sourceApp,
  version,
  targetArch,
  runCommand,
  captureCommand,
  hashDirectory,
  createTemporaryDirectory,
  removeTemporaryDirectory,
}) {
  const mountPoint = await createTemporaryDirectory("zcode-release-dmg-");
  let mounted = false;
  let result;
  let failure;
  try {
    await runCommand([
      "hdiutil",
      "attach",
      "-readonly",
      "-nobrowse",
      "-quiet",
      "-mountpoint",
      mountPoint,
      dmgPath,
    ]);
    mounted = true;
    const appName = selectMacReleaseAppBundle(
      await readdir(mountPoint, { withFileTypes: true }),
      sourceApp.appBundleName,
    );
    const appPath = path.join(mountPoint, appName);
    const packagedApp = await verifyMacReleaseAppBundle({
      appPath,
      version,
      targetArch,
      productName: sourceApp.productName,
      appBundleName: sourceApp.appBundleName,
      expectedBundleId: sourceApp.bundleId,
      requireStaple: sourceApp.requireStaple,
      requireUnsigned: !sourceApp.requireStaple,
      runCommand,
      captureCommand,
      hashDirectory,
    });
    assertPackagedAppMatchesSource(sourceApp, packagedApp, "DMG");
    result = packagedApp;
  } catch (error) {
    failure = error;
  }
  if (mounted) {
    try {
      await runCommand(["hdiutil", "detach", "-quiet", mountPoint]);
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await removeTemporaryDirectory(mountPoint);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return result;
}

export async function preflightMacRelease({
  version,
  targetArch,
  productName = "ZCode",
  appBundleName = `${productName}.app`,
  artifactSuffix = "",
  expectedBundleId = "dev.zcode.app",
  requireStaple = true,
  requireUnsigned = false,
  distDir,
  runCommand,
  captureCommand = capture,
  hashFile = sha256File,
  hashDirectory = hashMacAppBundle,
  createTemporaryDirectory = (prefix) => mkdtemp(path.join(tmpdir(), prefix)),
  removeTemporaryDirectory = (directoryPath) => rm(directoryPath, { recursive: true, force: true }),
  nodeVersion = process.versions.node,
  pinnedNodeVersion,
  misePath,
}) {
  // Fail-fast до чтения dist и временных каталогов: выпуск допустим только на Node из mise.toml.
  await assertPinnedNodeVersionFromMise({
    actual: nodeVersion,
    pinned: pinnedNodeVersion,
    misePath,
  });
  const assetNames = selectMacReleaseAssets(
    await readdir(distDir),
    version,
    targetArch,
    productName,
    artifactSuffix,
  );
  assertMacReleaseAssetPair(assetNames, version, targetArch, productName, artifactSuffix);
  const appDir = path.join(distDir, `mac-${targetArch}`);
  const selectedAppBundleName = selectMacReleaseAppBundle(
    await readdir(appDir, { withFileTypes: true }),
    appBundleName,
  );
  const appPath = path.join(appDir, selectedAppBundleName);
  const sourceApp = await verifyMacReleaseAppBundle({
    appPath,
    appBundleName: selectedAppBundleName,
    version,
    targetArch,
    productName,
    expectedBundleId,
    requireStaple,
    requireUnsigned,
    runCommand,
    captureCommand,
    hashDirectory,
  });
  const assetPaths = assetNames.map((name) => path.join(distDir, name));
  const zipPath = assetPaths.find((assetPath) => assetPath.endsWith(".zip"));
  const dmgPath = assetPaths.find((assetPath) => assetPath.endsWith(".dmg"));
  await verifyZipPayload({
    zipPath,
    sourceApp,
    version,
    targetArch,
    runCommand,
    captureCommand,
    hashDirectory,
    createTemporaryDirectory,
    removeTemporaryDirectory,
  });
  await verifyDmgPayload({
    dmgPath,
    sourceApp,
    version,
    targetArch,
    runCommand,
    captureCommand,
    hashDirectory,
    createTemporaryDirectory,
    removeTemporaryDirectory,
  });
  const assetHashes = new Map();
  for (let index = 0; index < assetPaths.length; index += 1) {
    assetHashes.set(assetNames[index], await hashFile(assetPaths[index]));
  }
  return { appPath, assetNames, assetPaths, assetHashes };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...options.env },
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
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command[0]} завершился с кодом ${code}: ${stderr.trim()}`));
    });
  });
}

async function verifyPublishedRelease(tag, assetNames, expectedCommitSha, expectedHashes) {
  const metadataText = await capture([
    "gh",
    "release",
    "view",
    tag,
    "--json",
    "tagName,isDraft,assets,url",
  ]);
  const metadata = JSON.parse(metadataText);
  assertReleaseMetadata(metadata, tag, assetNames);
  assertReleaseTargetSha(
    await resolveTagCommitSha(tag, async (route) => {
      const response = await capture(["gh", "api", route]);
      return JSON.parse(response);
    }),
    expectedCommitSha,
  );

  const verificationDir = await mkdtemp(path.join(tmpdir(), "zcode-release-verify-"));
  try {
    await run(["gh", "release", "download", tag, "--dir", verificationDir]);
    const downloadedNames = await readdir(verificationDir);
    const downloadedHashes = new Map();
    for (const name of downloadedNames) {
      downloadedHashes.set(name, await sha256File(path.join(verificationDir, name)));
    }
    assertAssetHashes(expectedHashes, downloadedHashes);
  } finally {
    await rm(verificationDir, { recursive: true, force: true });
  }
  return metadata.url;
}

async function main() {
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
  const baseSha = await capture(["git", "rev-parse", "HEAD"]);
  await run(["git", "fetch", "origin", "dev:refs/remotes/origin/dev"]);
  assertReleaseTargetSha(await capture(["git", "rev-parse", "origin/dev"]), baseSha);
  const packagePath = path.join(root, "package.json");
  const original = await readFile(packagePath, "utf8");
  const manifest = JSON.parse(original);
  const next = bumpSemver(manifest.version, level);
  const targetArch = macTargetArch();
  const tag = `v${next}`;
  const distDir = path.join(root, "packages", "desktop", "dist");
  if (await capture(["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
    throw new Error(`Удалённый Git tag уже существует: ${tag}`);
  }
  await clearExpectedMacReleaseAssets({ distDir, version: next, targetArch });
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

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
